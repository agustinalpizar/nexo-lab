"""Nexo Lab · consola de Control: acciones que CAMBIAN el laboratorio.

Separado de server.py (que sigue siendo de lectura) para que sea fácil revisar qué puede cambiar algo.

Reglas:
- Solo se ejecutan acciones del catálogo ACTIONS (identificadores fijos). Nunca texto libre de la interfaz
  ni de un modelo. Los parámetros son tipados y se validan contra listas cerradas.
- Los programas se lanzan con listas de argumentos (sin shell). Los valores variables que llegan al
  sistema (UUID de VM, nombre de servicio, cuenta) se validan con expresiones estrictas antes.
- Toda acción pasa por dos pasos: «preparar» (devuelve qué se hará y un ticket de un solo uso, 2 min) y
  «ejecutar» (requiere ese ticket). La interfaz muestra la confirmación entre ambos.
- Las credenciales viven en el Administrador de credenciales de Windows. Este módulo solo comprueba si
  existen (y su usuario); el secreto lo lee el script de PowerShell dentro de su propio proceso.
- Las contraseñas temporales se generan aquí, viajan al script por la entrada estándar (no en argumentos
  visibles), se devuelven una sola vez y no se guardan ni se registran.
- Cada acción queda en data/acciones-auditoria.jsonl: quién (usuario local y sesión), qué, objetivo, hora y
  resultado. Sin secretos.
- NEXO_SIMULAR=1 simula todo (VirtualBox, AD, servicios) sin ejecutar nada: sirve para probar la interfaz.
"""
import ctypes
import getpass
import ipaddress
import json
import os
import re
import secrets
import shutil
import string
import subprocess
import threading
import time
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
CONTROL_PATH = os.environ.get("NEXO_CONTROL") or os.path.join(ROOT, "control.json")  # NEXO_CONTROL: solo para pruebas
OPS_DIR = os.path.join(ROOT, "ops")
SIMULATE = os.environ.get("NEXO_SIMULAR") == "1"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
TOKEN = secrets.token_urlsafe(32)        # antifalsificación: solo lo conoce la página servida por este servidor
SESSION = secrets.token_hex(4)           # identifica esta ejecución del servidor en la auditoría
LOCAL_USER = getpass.getuser()
TICKET_SECONDS = 120

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
UNIT_RE = re.compile(r"^[A-Za-z0-9@._-]{1,64}$")
SAM_RE = re.compile(r"^[\w.\- ]{1,64}\$?$")
QUERY_RE = re.compile(r"^[\w .@'\-]{1,64}$")
CRED_RE = re.compile(r"^[\w:.\- ]{1,80}$")

_env = {"vbox": None, "vbox_path": None, "estado": None, "data_dir": os.path.join(ROOT, "data")}


def configure(vbox, vbox_path, estado, data_dir):
    """server.py entrega sus funciones de lectura (evita importaciones circulares)."""
    _env.update(vbox=vbox, vbox_path=vbox_path, estado=estado, data_dir=data_dir)


def _data(force=False):
    """Último estado leído por el panel; {} si VirtualBox no responde (las acciones quedan deshabilitadas)."""
    try:
        return _env["estado"](force=force) or {}
    except Exception:  # noqa: BLE001
        return {}


class ActionError(Exception):
    """Error que se puede mostrar tal cual en el panel."""


# ---------- configuración (sin secretos) ----------
DEFAULT_CONTROL = {"maquinas": [], "activeDirectory": {"vm": "DC01", "servidor": None, "credencial": "NexoLab:AD",
                                                       "ouPermitidas": []}, "correcciones": {}}


def load_control():
    """(config, error). Si control.json falta o no es válido, no se permite ninguna acción."""
    try:
        with open(CONTROL_PATH, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return DEFAULT_CONTROL, "No existe control.json: no hay máquinas habilitadas para acciones."
    except (json.JSONDecodeError, OSError) as exc:
        return DEFAULT_CONTROL, f"control.json no es válido ({exc}); las acciones quedan deshabilitadas."
    ad = {**DEFAULT_CONTROL["activeDirectory"], **(raw.get("activeDirectory") or {})}
    cfg = {"maquinas": [m for m in raw.get("maquinas") or [] if isinstance(m, str)],
           "activeDirectory": ad, "correcciones": {}}
    for vm, c in (raw.get("correcciones") or {}).items():
        if vm.startswith("_") or not isinstance(c, dict):
            continue
        svcs = {str(p): u for p, u in (c.get("servicios") or {}).items()
                if str(p).isdigit() and isinstance(u, str) and UNIT_RE.match(u)}
        cfg["correcciones"][vm] = {"metodo": c.get("metodo"), "usuario": c.get("usuario"),
                                   "credencial": c.get("credencial"), "servicios": svcs}
    return cfg, None


# ---------- Administrador de credenciales de Windows: solo se comprueba que exista ----------
class _CREDENTIAL(ctypes.Structure):
    _fields_ = [("Flags", ctypes.c_uint32), ("Type", ctypes.c_uint32), ("TargetName", ctypes.c_wchar_p),
                ("Comment", ctypes.c_wchar_p), ("LastWritten", ctypes.c_uint64), ("CredentialBlobSize", ctypes.c_uint32),
                ("CredentialBlob", ctypes.c_void_p), ("Persist", ctypes.c_uint32), ("AttributeCount", ctypes.c_uint32),
                ("Attributes", ctypes.c_void_p), ("TargetAlias", ctypes.c_wchar_p), ("UserName", ctypes.c_wchar_p)]


def credential_info(target):
    """{'exists': bool, 'user': str|None}. No lee ni devuelve la contraseña."""
    if SIMULATE:
        return {"exists": True, "user": "LAB\\nexo-helpdesk (simulado)"}
    if os.name != "nt" or not target or not CRED_RE.match(target):
        return {"exists": False, "user": None}
    ptr = ctypes.POINTER(_CREDENTIAL)()
    adv = ctypes.windll.advapi32
    if not adv.CredReadW(ctypes.c_wchar_p(target), 1, 0, ctypes.byref(ptr)):  # 1 = CRED_TYPE_GENERIC
        return {"exists": False, "user": None}
    try:
        return {"exists": True, "user": ptr.contents.UserName}
    finally:
        adv.CredFree(ptr)


BROAD_ADMIN_NAMES = re.compile(r"(^|\\)(administrator|administrador|admin)$", re.I)


# ---------- ejecución de programas (sin shell) ----------
def run(args, payload=None, timeout=60):
    """Lanza un programa con argumentos separados. 'payload' (dict) va por la entrada estándar,
    no por la línea de comandos: así no aparece en la lista de procesos ni en errores."""
    try:
        out = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                             capture_output=True, text=True, timeout=timeout, encoding="utf-8",
                             errors="replace", creationflags=NO_WINDOW)
    except subprocess.TimeoutExpired:
        raise ActionError(f"El programa no terminó en {timeout} s y se canceló.")
    except OSError as exc:
        raise ActionError(f"No se pudo ejecutar {os.path.basename(args[0])}: {exc.strerror or exc}")
    return out.returncode, out.stdout, out.stderr


def run_ps(script, payload, timeout=60):
    """Ejecuta un script fijo de ops/ y devuelve su respuesta JSON."""
    path = os.path.join(OPS_DIR, script)
    code, out, err = run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                          "-File", path], payload, timeout)
    line = next((ln for ln in reversed(out.strip().splitlines()) if ln.startswith("{")), None)
    if not line:
        raise ActionError("El script no devolvió una respuesta válida." + (f" {err.strip()[:300]}" if err.strip() else ""))
    data = json.loads(line)
    if not data.get("ok"):
        raise ActionError(data.get("error") or "Error desconocido")
    return data


# ---------- catálogo de acciones permitidas (fijo en el código) ----------
ACTIONS = {
    "vm.start": {"label": "Encender la VM", "kind": "vm", "changes": True,
                 "params": {"modo": {"type": "enum", "values": ["gui", "headless"], "default": "gui"}}},
    "vm.shutdown": {"label": "Solicitar apagado normal", "kind": "vm", "changes": True, "params": {}},
    "vm.pause": {"label": "Pausar la VM", "kind": "vm", "changes": True, "params": {}},
    "vm.resume": {"label": "Reanudar la VM", "kind": "vm", "changes": True, "params": {}},
    "vm.savestate": {"label": "Guardar el estado de la VM", "kind": "vm", "changes": True, "params": {}},
    "svc.recheck": {"label": "Reintentar la comprobación", "kind": "vm", "changes": False, "params": {}},
    "svc.start": {"label": "Iniciar servicio", "kind": "svc", "changes": True,
                  "params": {"servicio": {"type": "allowlist"}}},
    "svc.restart": {"label": "Reiniciar servicio", "kind": "svc", "changes": True,
                    "params": {"servicio": {"type": "allowlist"}}},
    "ad.unlock": {"label": "Desbloquear cuenta", "kind": "ad", "changes": True, "params": {"cuenta": {"type": "sam"}}},
    "ad.enable": {"label": "Habilitar cuenta", "kind": "ad", "changes": True, "params": {"cuenta": {"type": "sam"}}},
    "ad.disable": {"label": "Deshabilitar cuenta", "kind": "ad", "changes": True, "params": {"cuenta": {"type": "sam"}}},
    "ad.reset_password": {"label": "Restablecer con contraseña temporal", "kind": "ad", "changes": True,
                          "params": {"cuenta": {"type": "sam"}}},
}


def catalog():
    return {k: {"label": v["label"], "kind": v["kind"], "changes": v["changes"],
                "params": {p: {kk: vv for kk, vv in s.items()} for p, s in v["params"].items()}}
            for k, v in ACTIONS.items()}


def validate_params(action_id, params, allowed_services=()):
    spec = ACTIONS[action_id]["params"]
    params = params or {}
    if not isinstance(params, dict):
        raise ActionError("Los parámetros deben ser un objeto.")
    extra = set(params) - set(spec)
    if extra:
        raise ActionError(f"Parámetros no permitidos para {action_id}: {', '.join(sorted(extra))}.")
    out = {}
    for name, s in spec.items():
        val = params.get(name, s.get("default"))
        if s["type"] == "enum":
            if val not in s["values"]:
                raise ActionError(f"«{name}» debe ser uno de: {', '.join(s['values'])}.")
        elif s["type"] == "allowlist":
            if not isinstance(val, str) or val not in allowed_services:
                raise ActionError(f"El servicio «{val}» no está en la lista permitida de control.json para esta VM.")
        elif s["type"] == "sam":
            if not isinstance(val, str) or not SAM_RE.match(val.strip()):
                raise ActionError("Nombre de cuenta no válido.")
            val = val.strip()
        out[name] = val
    return out


# ---------- VirtualBox ----------
_sim_vms = {}


def vbox_vms():
    """{uuid: nombre} leído de VirtualBox ahora mismo."""
    out = {}
    for line in _env["vbox"]("list", "vms").splitlines():
        m = re.match(r'^"(.*)" \{([0-9a-fA-F-]+)\}$', line.strip())
        if m:
            out[m.group(2).lower()] = m.group(1)
    return out


def vbox_state(uuid):
    if SIMULATE and uuid in _sim_vms:
        st, until, final = _sim_vms[uuid]
        if time.time() >= until:
            _sim_vms[uuid] = (final, 0, final)
            return final
        return st
    m = re.search(r'^VMState="([^"]+)"', _env["vbox"]("showvminfo", uuid, "--machinereadable"), re.M)
    return m.group(1) if m else None


def savestate_space(uuid):
    """(MB que ocupará el estado guardado, MB libres en el disco de la VM) o None si VirtualBox no lo informa."""
    try:
        info = _env["vbox"]("showvminfo", uuid, "--machinereadable")
        mem = re.search(r"^memory=(\d+)", info, re.M)
        cfg = re.search(r'^CfgFile="(.+)"', info, re.M)
        if not (mem and cfg):
            return None
        folder = os.path.dirname(cfg.group(1).replace("\\\\", "\\"))
        return int(mem.group(1)), shutil.disk_usage(folder).free // (1024 * 1024)
    except Exception:  # noqa: BLE001 - es una comprobación previa: si falla, no se bloquea la acción
        return None


def resolve_vm(ref, cfg):
    """Acepta UUID o nombre exacto. Comprueba que la VM existe en VirtualBox y pertenece al laboratorio."""
    if not isinstance(ref, str) or not ref.strip():
        raise ActionError("Falta la VM objetivo.")
    vms = vbox_vms()
    ref = ref.strip()
    if UUID_RE.match(ref):
        uuid = ref.lower()
        if uuid not in vms:
            raise ActionError("Esa VM ya no existe en VirtualBox.")
    else:
        found = [u for u, n in vms.items() if n == ref]
        if len(found) != 1:
            raise ActionError(f"No hay una única VM llamada «{ref}» en VirtualBox.")
        uuid = found[0]
    name = vms[uuid]
    if name not in cfg["maquinas"]:
        raise ActionError(f"«{name}» no está en la lista de máquinas del laboratorio (control.json). No se permiten acciones sobre ella.")
    return uuid, name


VM_STATES_START = ("poweroff", "saved", "aborted", "aborted-saved", "aborted_saved")


def vm_rules(state):
    """Qué acciones de VM corresponden a un estado. Devuelve {acción: motivo si NO se permite}."""
    return {
        "vm.start": None if state in VM_STATES_START else
        ("Ya está encendida." if state == "running" else
         "Está en pausa: usa «Reanudar»." if state == "paused" else
         f"No se puede encender en estado «{state}»."),
        "vm.shutdown": None if state == "running" else "Solo se puede apagar una VM encendida.",
        "vm.pause": None if state == "running" else
        ("Ya está en pausa." if state == "paused" else "Solo se puede pausar una VM encendida."),
        "vm.resume": None if state == "paused" else "Solo se puede reanudar una VM en pausa.",
        "vm.savestate": None if state in ("running", "paused") else
        ("Ya tiene su estado guardado." if state == "saved" else "Solo se puede guardar el estado de una VM encendida o en pausa."),
    }


# ---------- servicios dentro de las VM ----------
def _vm_snapshot(uuid):
    data = _data()
    return next((v for v in data.get("vms", []) if v["id"].lower() == uuid), None)


def lab_ip(vm):
    """IP de la VM comprobada por el panel (privada, de la red del equipo). Nunca otra."""
    ip = vm and vm.get("checkedIp")
    if not ip:
        return None
    try:
        return ip if ipaddress.ip_address(ip).is_private else None
    except ValueError:
        return None


def _service_running():
    code, out, _ = run(["sc.exe", "query", "ssh-agent"], timeout=10)
    return "RUNNING" in out


def mechanism(vm_name, cfg):
    """(disponible, motivo, detalle) del método para corregir servicios en esa VM."""
    c = cfg["correcciones"].get(vm_name)
    if not c or not c["servicios"]:
        return False, "No hay servicios corregibles definidos para esta VM en control.json.", None
    if c["metodo"] == "winrm":
        cred = credential_info(c.get("credencial"))
        if not cred["exists"]:
            return False, (f"Falta la credencial de Windows «{c.get('credencial')}» para WinRM. "
                           "Créala con cmdkey (ver README); el panel nunca pide ni guarda contraseñas."), None
        return True, None, f"WinRM con la credencial «{c.get('credencial')}» ({cred['user']})"
    if c["metodo"] == "ssh":
        user = c.get("usuario")
        if not user or not re.match(r"^[a-z_][a-z0-9_-]{0,31}$", str(user)):
            return False, ("No hay usuario SSH configurado en control.json. Requiere un usuario con sudo limitado "
                           "a esos servicios y su clave cargada en el agente SSH de Windows (ver README)."), None
        if not SIMULATE and not shutil.which("ssh"):
            return False, "No se encontró ssh.exe en este equipo.", None
        if not SIMULATE and not _service_running():
            return False, ("El servicio «OpenSSH Authentication Agent» (ssh-agent) está detenido. Sin él no hay clave "
                           "protegida por Windows que usar; el panel no usa contraseñas SSH."), None
        return True, None, f"SSH como {user} con la clave del agente de Windows (ssh-agent)"
    return False, f"Método «{c['metodo']}» no admitido (usa winrm o ssh).", None


def svc_status(vm_name, cfg, ip, unit):
    c = cfg["correcciones"][vm_name]
    if SIMULATE:
        return "active" if _sim_units.get(unit) else "inactive"
    if c["metodo"] == "winrm":
        return run_ps("winsvc.ps1", {"credencial": c["credencial"], "equipo": ip, "op": "status", "nombre": unit})["estado"]
    code, out, err = run(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
                          f"{c['usuario']}@{ip}", f"systemctl is-active {unit}"], timeout=30)
    if code not in (0, 3) or not out.strip():
        raise ActionError("No se pudo consultar el servicio por SSH: " + (err.strip()[:300] or f"código {code}"))
    return out.strip().splitlines()[-1]


_sim_units = {}


def svc_change(vm_name, cfg, ip, op, unit):
    c = cfg["correcciones"][vm_name]
    if SIMULATE:
        time.sleep(1.5)
        _sim_units[unit] = True
        return
    if c["metodo"] == "winrm":
        run_ps("winsvc.ps1", {"credencial": c["credencial"], "equipo": ip, "op": op, "nombre": unit}, timeout=120)
        return
    # La unidad ya se validó contra la lista de control.json y contra UNIT_RE: no puede contener espacios ni ; | & $.
    code, out, err = run(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
                          f"{c['usuario']}@{ip}", f"sudo -n systemctl {op} {unit}"], timeout=120)
    if code != 0:
        raise ActionError("systemctl devolvió un error: " + (err.strip()[:400] or f"código {code}"))


# ---------- Active Directory ----------
SIM_AD = {
    "ana.lopez": {"sam": "ana.lopez", "name": "Ana López", "kind": "user", "dn": "CN=Ana López,OU=Usuarios,OU=Laboratorio,DC=lab,DC=local",
                  "enabled": True, "locked": True, "groups": ["Ventas", "Usuarios del dominio"], "privileged": False, "rid": 1105},
    "carlos.ruiz": {"sam": "carlos.ruiz", "name": "Carlos Ruiz", "kind": "user", "dn": "CN=Carlos Ruiz,OU=Usuarios,OU=Laboratorio,DC=lab,DC=local",
                    "enabled": False, "locked": False, "groups": ["Usuarios del dominio"], "privileged": False, "rid": 1106},
    "it.admin": {"sam": "it.admin", "name": "Admin de TI", "kind": "user", "dn": "CN=Admin de TI,OU=Usuarios,OU=Laboratorio,DC=lab,DC=local",
                 "enabled": True, "locked": True, "groups": ["Domain Admins", "Usuarios del dominio"], "privileged": True,
                 "privilegedBy": ["Domain Admins"], "rid": 1107},
    "Administrator": {"sam": "Administrator", "name": "Administrator", "kind": "user", "dn": "CN=Administrator,CN=Users,DC=lab,DC=local",
                      "enabled": True, "locked": False, "groups": ["Domain Admins", "Enterprise Admins"], "privileged": True,
                      "privilegedBy": ["cuenta integrada de administrador"], "rid": 500},
    "Ventas": {"sam": "Ventas", "name": "Ventas", "kind": "group", "dn": "CN=Ventas,OU=Grupos,OU=Laboratorio,DC=lab,DC=local",
               "members": ["Ana López"], "privileged": False},
    "PC01$": {"sam": "PC01$", "name": "PC01", "kind": "computer", "dn": "CN=PC01,CN=Computers,DC=lab,DC=local",
              "enabled": True, "os": "Windows 10 Pro"},
}


def ad_settings():
    """Estado de la integración con AD: (config, motivo si no está disponible, servidor)."""
    cfg, err = load_control()
    ad = cfg["activeDirectory"]
    if err:
        return ad, err, None
    cred = credential_info(ad.get("credencial"))
    if not cred["exists"]:
        return ad, (f"No existe la credencial de Windows «{ad.get('credencial')}». Créala con cmdkey usando una "
                    "cuenta delegada (no Domain Admin); ver README. El panel nunca pide ni guarda la contraseña."), None
    server = ad.get("servidor")
    data = _data()
    dc = next((v for v in data.get("vms", []) if v["name"] == ad.get("vm")), None)
    if not dc:
        return ad, f"No se encuentra la VM «{ad.get('vm')}» en VirtualBox.", None
    if dc["state"] != "running":
        return ad, f"{dc['name']} no está encendida (estado en VirtualBox: {dc['state']}).", None
    if not server:
        server = lab_ip(dc)
        if not server:
            return ad, f"{dc['name']} está encendida pero el panel no encuentra su IP.", None
    if not re.match(r"^[A-Za-z0-9.\-]{1,253}$", str(server)):
        return ad, "El servidor de AD en control.json no es válido.", None
    return {**ad, "_cred": cred}, None, server


def _ad_call(op, **extra):
    ad, why, server = ad_settings()
    if why:
        raise ActionError(why)
    if SIMULATE:
        return _sim_ad(op, **extra)
    return run_ps("ad.ps1", {"op": op, "servidor": server, "credencial": ad["credencial"], **extra}, timeout=60)


def _sim_ad(op, **kw):
    time.sleep(0.4)
    if op == "probe":
        return {"ok": True, "dominio": "DC=lab,DC=local", "dc": "DC01.lab.local", "usuario": "LAB\\nexo-helpdesk (simulado)"}
    if op == "search":
        q = kw["q"].lower()
        kinds = {"users": "user", "groups": "group", "computers": "computer"}[kw["tipo"]]
        return {"ok": True, "items": [dict(v) for v in SIM_AD.values() if v["kind"] == kinds and
                                      (q in v["sam"].lower() or q in v["name"].lower())]}
    acct = SIM_AD.get(kw.get("cuenta"))
    if not acct:
        raise ActionError("La cuenta no existe en el directorio.")
    if op == "get":
        return {"ok": True, "item": dict(acct)}
    if op == "unlock":
        acct["locked"] = False
    elif op in ("enable", "disable"):
        acct["enabled"] = op == "enable"
    elif op == "reset":
        acct["mustChange"] = True
    return {"ok": True, "item": dict(acct)}


def ad_search(tipo, q):
    if tipo not in ("users", "groups", "computers"):
        raise ActionError("Tipo de búsqueda no válido.")
    if not QUERY_RE.match(q or ""):
        raise ActionError("Escribe entre 1 y 64 caracteres (letras, números, espacio, punto, guion, @ o apóstrofo).")
    return _ad_call("search", tipo=tipo, q=q.strip())["items"]


def ad_get(sam):
    if not SAM_RE.match(sam or ""):
        raise ActionError("Nombre de cuenta no válido.")
    item = _ad_call("get", cuenta=sam)["item"]
    return {**item, "actions": ad_rules(item)}


def in_allowed_ou(dn, ous):
    dn_l = (dn or "").lower()
    return any(dn_l.endswith("," + ou.lower()) for ou in ous if isinstance(ou, str) and ou.strip())


def ad_rules(item):
    """{acción: motivo si no se permite}. Las cuentas privilegiadas solo admiten desbloquear/habilitar con
    confirmación reforzada; deshabilitar y restablecer quedan bloqueadas en esta versión."""
    ad, _, _ = ad_settings()
    rules = {a: None for a in ("ad.unlock", "ad.enable", "ad.disable", "ad.reset_password")}
    if item.get("kind") != "user":
        return {a: "Solo se pueden modificar cuentas de usuario; grupos y equipos son de consulta." for a in rules}
    block = None
    if item.get("rid") in (500, 502):
        block = "Cuenta integrada del dominio (Administrator o krbtgt): no se modifica desde el panel."
    elif not ad.get("ouPermitidas"):
        block = "No hay OU permitidas en control.json (activeDirectory.ouPermitidas): solo se permite consultar."
    elif not in_allowed_ou(item.get("dn"), ad["ouPermitidas"]):
        block = "La cuenta está fuera de las OU permitidas en control.json."
    elif ad.get("_cred") and str(ad["_cred"].get("user") or "").split("\\")[-1].lower() == item["sam"].lower():
        block = "Es la cuenta que usa el propio panel."
    if block:
        return {a: block for a in rules}
    rules["ad.unlock"] = None if item.get("locked") else "La cuenta no está bloqueada."
    rules["ad.enable"] = None if not item.get("enabled") else "La cuenta ya está habilitada."
    rules["ad.disable"] = None if item.get("enabled") else "La cuenta ya está deshabilitada."
    if item.get("privileged"):
        msg = "Cuenta privilegiada: esta versión no permite deshabilitarla ni restablecer su contraseña desde el panel."
        rules["ad.disable"] = rules["ad.disable"] or msg
        rules["ad.reset_password"] = msg
    return rules


def temp_password(n=16):
    """Contraseña temporal aleatoria con mayúsculas, minúsculas, números y símbolos (sin caracteres ambiguos)."""
    sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+-=?@_"]
    while True:
        chars = [secrets.choice(s) for s in sets] + [secrets.choice("".join(sets)) for _ in range(n - len(sets))]
        secrets.SystemRandom().shuffle(chars)
        pw = "".join(chars)
        if all(any(c in s for c in pw) for s in sets):
            return pw


# ---------- auditoría ----------
_audit_lock = threading.Lock()


def audit_path():
    return os.path.join(_env["data_dir"], "acciones-auditoria.jsonl")


def audit(entry):
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "usuario": LOCAL_USER, "sesion": SESSION,
             "simulado": SIMULATE, **entry}
    entry.pop("password", None)  # por si acaso: nunca se registra una contraseña
    with _audit_lock:
        os.makedirs(_env["data_dir"], exist_ok=True)
        with open(audit_path(), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def audit_tail(n=60):
    try:
        with open(audit_path(), encoding="utf-8") as f:
            lines = f.readlines()[-n:]
    except FileNotFoundError:
        return []
    out = []
    for ln in reversed(lines):
        try:
            out.append(json.loads(ln))
        except ValueError:
            continue
    return out


def accion_cercana(vm_name, ts_iso, margen=180):
    """Acción real (no simulada) confirmada desde el panel sobre esa VM a menos de `margen` s de `ts_iso`, o None.
    Sirve para decir en el historial si un cambio de estado lo pidió el panel o no."""
    try:
        t0 = datetime.fromisoformat(ts_iso)
        if t0.tzinfo is None:
            t0 = t0.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None
    for e in audit_tail(300):
        if e.get("evento") != "confirmada" or e.get("simulado") or e.get("objetivo") != vm_name:
            continue
        try:
            if abs((datetime.fromisoformat(e["ts"]) - t0).total_seconds()) <= margen:
                return e
        except (KeyError, ValueError):
            continue
    return None


# ---------- preparar / ejecutar ----------
_tickets = {}
_jobs = {}
_busy = set()
_state_lock = threading.Lock()


def _target_label(a, t):
    return t.get("vmName") or t.get("cuenta") or "?"


def plan(action_id, target, params, origin="panel", motivo=None):
    """Valida y describe la acción sin ejecutar nada. Devuelve el resumen y un ticket de un solo uso."""
    if action_id not in ACTIONS:
        raise ActionError(f"La acción «{action_id}» no está en el catálogo permitido.")
    spec = ACTIONS[action_id]
    cfg, err = load_control()
    if err:
        raise ActionError(err)
    info = {"accion": action_id, "titulo": spec["label"], "cambia": spec["changes"], "origen": origin,
            "motivo": (str(motivo)[:500] if motivo else None), "advertencias": [], "confirmarTexto": None}
    if spec["kind"] in ("vm", "svc"):
        uuid, name = resolve_vm((target or {}).get("vm"), cfg)
        state = vbox_state(uuid)
        info.update(objetivo=name, target={"vm": uuid, "vmName": name}, estadoActual=state)
        if spec["kind"] == "vm" and action_id != "svc.recheck":
            why = vm_rules(state)[action_id]
            if why:
                raise ActionError(f"{name}: {why}")
            p = validate_params(action_id, params)
            if action_id == "vm.start":
                info.update(operacion=f"VBoxManage startvm \"{name}\" --type {p['modo']}",
                            efecto=f"VirtualBox arrancará {name}" + (" sin ventana (en segundo plano)." if p["modo"] == "headless" else " en una ventana."),
                            verificacion="El panel consultará VirtualBox cada 2 s (hasta 90 s) hasta ver el estado «running».")
            elif action_id == "vm.pause":
                info.update(operacion=f"VBoxManage controlvm \"{name}\" pause",
                            efecto=f"{name} queda congelada en memoria: no ejecuta nada ni responde a la red hasta que la reanudes. No se apaga ni se pierde su estado.",
                            verificacion="El panel consultará VirtualBox cada 1 s (hasta 20 s) hasta ver el estado «paused».")
                info["advertencias"].append("Mientras esté en pausa, sus servicios no responden; el panel los mostrará como «sin comprobar» y no generará alertas. Los relojes y las conexiones abiertas dentro de la VM pueden desfasarse.")
            elif action_id == "vm.savestate":
                space = savestate_space(uuid)
                if space and space[1] < space[0] * 1.1 + 512:
                    raise ActionError(f"{name}: no hay espacio suficiente para guardar su estado (necesita unos {space[0]} MB y hay {space[1]} MB libres en el disco de la VM).")
                info.update(operacion=f"VBoxManage controlvm \"{name}\" savestate",
                            efecto=f"El contenido de la memoria de {name} se escribe en disco y la VM se detiene. Al encenderla vuelve justo donde estaba.",
                            verificacion="El panel consultará VirtualBox cada 2 s (hasta 2 min) hasta ver el estado «saved».")
                if space:
                    info["advertencias"].append(f"Necesita unos {space[0]} MB en disco y hay {space[1]} MB libres.")
                info["advertencias"].append("Ocupa en disco tanto como la RAM asignada a la VM. Sus servicios no responderán; el panel los mostrará como «sin comprobar» y no generará alertas. "
                                            "No cambies la configuración de la VM en VirtualBox mientras esté guardada.")
            elif action_id == "vm.resume":
                info.update(operacion=f"VBoxManage controlvm \"{name}\" resume",
                            efecto=f"{name} continúa justo donde se quedó.",
                            verificacion="El panel consultará VirtualBox cada 1 s (hasta 20 s) hasta ver el estado «running».")
            else:
                info.update(operacion=f"VBoxManage controlvm \"{name}\" acpipowerbutton",
                            efecto=f"Equivale a pulsar el botón de encendido: el sistema de {name} cierra sus programas y se apaga por sí mismo.",
                            verificacion="El panel consultará VirtualBox cada 3 s (hasta 3 min) hasta ver «poweroff». No se fuerza el apagado si el sistema no responde.")
                info["advertencias"].append("Los programas abiertos dentro de la VM se cerrarán. Si hay trabajo sin guardar, el sistema puede bloquear el apagado.")
        elif action_id == "svc.recheck":
            p = validate_params(action_id, params)
            info.update(operacion="Nueva lectura de VirtualBox y de los servicios de servicios.json (solo lectura)",
                        efecto="No cambia nada en la VM.", verificacion="Se muestra el resultado de la comprobación.")
        else:
            if state != "running":
                raise ActionError(f"{name} no está encendida.")
            c = cfg["correcciones"].get(name) or {"servicios": {}}
            p = validate_params(action_id, params, tuple(c["servicios"].values()))
            ok, why, how = mechanism(name, cfg)
            if not ok:
                raise ActionError(why)
            ip = lab_ip(_vm_snapshot(uuid))
            if not ip:
                raise ActionError(f"No hay una IP verificada de {name}: no se puede confirmar el objetivo.")
            op = "start" if action_id == "svc.start" else "restart"
            ports = [port for port, u in c["servicios"].items() if u == p["servicio"]]
            cmd = (f"Restart-Service / Start-Service -Name {p['servicio']} (Invoke-Command a {ip})" if c["metodo"] == "winrm"
                   else f"ssh {c['usuario']}@{ip} sudo -n systemctl {op} {p['servicio']}")
            info.update(operacion=cmd, via=how, ip=ip,
                        efecto=f"{'Inicia' if op == 'start' else 'Reinicia'} el servicio {p['servicio']} en {name}."
                               + (" Reiniciar corta las conexiones activas de ese servicio." if op == "restart" else ""),
                        verificacion=f"Se consulta el estado del servicio en la VM y se repite la comprobación del panel"
                                     f"{' en el puerto ' + ', '.join(ports) if ports else ''}.")
            info["advertencias"].append("Hazlo solo si el diagnóstico de la guía confirma que este servicio está caído o con errores.")
        info["parametros"] = p
    else:  # Active Directory
        p = validate_params(action_id, params)
        item = ad_get(p["cuenta"])
        why = item["actions"].get(action_id)
        if why:
            raise ActionError(f"{item['sam']}: {why}")
        info.update(objetivo=item["sam"], target={"cuenta": item["sam"]}, parametros=p, cuenta=item,
                    via=f"LDAP firmado y cifrado con la credencial «{ad_settings()[0].get('credencial')}»")
        desc = {"ad.unlock": ("Pone lockoutTime = 0: la cuenta puede volver a iniciar sesión. No cambia la contraseña.",
                              "Se vuelve a leer la cuenta y debe aparecer como no bloqueada."),
                "ad.enable": ("Quita la marca «cuenta deshabilitada» (userAccountControl).", "Se vuelve a leer la cuenta y debe aparecer habilitada."),
                "ad.disable": ("Marca la cuenta como deshabilitada: no podrá iniciar sesión hasta que se habilite. No borra nada.",
                               "Se vuelve a leer la cuenta y debe aparecer deshabilitada."),
                "ad.reset_password": ("Asigna una contraseña temporal aleatoria y obliga a cambiarla en el próximo inicio de sesión (pwdLastSet = 0).",
                                      "Se vuelve a leer la cuenta y debe indicar «debe cambiar la contraseña». La contraseña se muestra una sola vez.")}[action_id]
        info.update(operacion=f"{spec['label']}: {item['dn']}", efecto=desc[0], verificacion=desc[1])
        if item.get("privileged"):
            info["confirmarTexto"] = item["sam"]
            info["advertencias"].append("CUENTA PRIVILEGIADA (" + ", ".join(item.get("privilegedBy") or ["grupo privilegiado"]) +
                                        "). Afecta al control del dominio. Escribe el nombre exacto de la cuenta para confirmar.")
    ticket = secrets.token_urlsafe(18)
    with _state_lock:
        now = time.time()
        for k in [k for k, v in _tickets.items() if v["exp"] < now]:
            _tickets.pop(k, None)
        _tickets[ticket] = {"exp": now + TICKET_SECONDS, "info": info}
    return {**{k: v for k, v in info.items() if k != "target"}, "ticket": ticket, "caduca": TICKET_SECONDS}


def execute(ticket, typed=None):
    with _state_lock:
        t = _tickets.pop(ticket or "", None)
    if not t or t["exp"] < time.time():
        raise ActionError("La confirmación caducó o ya se usó. Vuelve a preparar la acción.")
    info = t["info"]
    if info.get("confirmarTexto") and (typed or "").strip() != info["confirmarTexto"]:
        raise ActionError("El texto de confirmación no coincide con el nombre de la cuenta. No se hizo nada.")
    # Se vuelve a validar todo: el estado pudo cambiar desde la confirmación.
    fresh = plan(info["accion"], info["target"], info["parametros"], info["origen"], info["motivo"])
    with _state_lock:
        _tickets.pop(fresh["ticket"], None)
    key = info["accion"].split(".")[0] + ":" + _target_label(info["accion"], info["target"]).lower()
    with _state_lock:
        if key in _busy:
            raise ActionError("Ya hay una acción en curso sobre este objetivo. Espera a que termine.")
        _busy.add(key)
    base = {"accion": info["accion"], "objetivo": info["objetivo"], "origen": info["origen"],
            "parametros": {k: v for k, v in info["parametros"].items()}, "motivo": info.get("motivo")}
    audit({**base, "evento": "confirmada"})
    if ACTIONS[info["accion"]]["kind"] == "ad":
        try:
            return _run_ad(info, base)
        finally:
            with _state_lock:
                _busy.discard(key)
    job = {"id": secrets.token_hex(6), **base, "estado": "en_curso", "pasos": [], "inicio": datetime.now(timezone.utc).isoformat()}
    with _state_lock:
        _jobs[job["id"]] = job
    threading.Thread(target=_run_job, args=(job, info, key, base), daemon=True).start()
    return {"job": job["id"]}


def _step(job, text):
    job["pasos"].append({"t": datetime.now(timezone.utc).isoformat(), "texto": text})


def _finish(job, estado, texto, base):
    job.update(estado=estado, resultado=texto, fin=datetime.now(timezone.utc).isoformat())
    audit({**base, "evento": "resultado", "resultado": estado, "detalle": texto})


def _run_job(job, info, key, base):
    try:
        a, uuid, name = info["accion"], info["target"]["vm"], info["target"]["vmName"]
        if a == "vm.start":
            _step(job, f"Pidiendo a VirtualBox que encienda {name}…")
            if SIMULATE:
                _sim_vms[uuid] = ("starting", time.time() + 4, "running")
            else:
                code, out, err = run([_vbox_path(), "startvm", uuid, "--type", info["parametros"]["modo"]], timeout=90)
                if code != 0:
                    raise ActionError("VirtualBox no pudo encenderla: " + (err.strip()[:400] or f"código {code}"))
            _wait_state(job, uuid, name, "running", 90, 2, base)
        elif a == "vm.shutdown":
            _step(job, f"Enviando la señal de apagado (ACPI) a {name}…")
            if SIMULATE:
                _sim_vms[uuid] = ("running", time.time() + 6, "poweroff")
            else:
                code, out, err = run([_vbox_path(), "controlvm", uuid, "acpipowerbutton"], timeout=30)
                if code != 0:
                    raise ActionError("VirtualBox rechazó la señal de apagado: " + (err.strip()[:400] or f"código {code}"))
            _wait_state(job, uuid, name, "poweroff", 180, 3, base)
        elif a == "vm.savestate":
            _step(job, f"Pidiendo a VirtualBox que guarde el estado de {name} (puede tardar según su RAM)…")
            if SIMULATE:
                _sim_vms[uuid] = ("saving", time.time() + 5, "saved")
            else:
                code, out, err = run([_vbox_path(), "controlvm", uuid, "savestate"], timeout=150)
                if code != 0:
                    raise ActionError("VirtualBox no pudo guardar el estado: " + (err.strip()[:400] or f"código {code}"))
            _wait_state(job, uuid, name, "saved", 120, 2, base)
        elif a in ("vm.pause", "vm.resume"):
            verb, want, now = ("pause", "paused", "running") if a == "vm.pause" else ("resume", "running", "paused")
            _step(job, f"Pidiendo a VirtualBox que {'pause' if verb == 'pause' else 'reanude'} {name}…")
            if SIMULATE:
                _sim_vms[uuid] = (now, time.time() + 2, want)
            else:
                code, out, err = run([_vbox_path(), "controlvm", uuid, verb], timeout=30)
                if code != 0:
                    raise ActionError(f"VirtualBox no pudo {'pausarla' if verb == 'pause' else 'reanudarla'}: " + (err.strip()[:400] or f"código {code}"))
            _wait_state(job, uuid, name, want, 20, 1, base)
        elif a == "svc.recheck":
            _step(job, "Repitiendo la lectura de VirtualBox y las comprobaciones de servicios…")
            vm = _recheck(uuid)
            bad = [f"{s['name']} ({s['port']})" for s in (vm or {}).get("services", []) if s["status"] == "down"]
            _finish(job, "ok", ("Siguen sin responder: " + ", ".join(bad)) if bad else "Todos los servicios comprobados responden.", base)
        else:
            cfg, _ = load_control()
            unit, ip = info["parametros"]["servicio"], info["ip"]
            op = "start" if a == "svc.start" else "restart"
            _step(job, f"Estado previo de {unit}: {svc_status(name, cfg, ip, unit)}")
            _step(job, f"Ejecutando {op} de {unit} en {name}…")
            svc_change(name, cfg, ip, op, unit)
            time.sleep(3)
            after = svc_status(name, cfg, ip, unit)
            _step(job, f"Estado en la VM tras la acción: {after}")
            _step(job, "Repitiendo la comprobación del panel…")
            vm = _recheck(uuid)
            checks = [s for s in (vm or {}).get("services", []) if str(s["port"]) in
                      [p for p, u in cfg["correcciones"][name]["servicios"].items() if u == unit]]
            summary = "; ".join(f"{s['name']} ({s['port']}): {s['status']} — {s.get('reason') or ''}" for s in checks)
            good = after in ("active", "Running") and all(s["status"] == "up" for s in checks)
            _finish(job, "ok" if good else "sin_confirmar",
                    (f"{unit} está {after}. " + (summary or "No hay comprobación del panel asociada a este servicio."))
                    + ("" if good else " No se puede confirmar que el problema esté resuelto: revisa la guía."), base)
    except ActionError as exc:
        _finish(job, "error", str(exc), base)
    except Exception as exc:  # noqa: BLE001 - se informa al panel; nunca incluye secretos
        _finish(job, "error", f"Error inesperado: {type(exc).__name__}", base)
    finally:
        with _state_lock:
            _busy.discard(key)


def _vbox_path():
    if not _env["vbox_path"]:
        raise ActionError("No se encontró VBoxManage.")
    return _env["vbox_path"]


def _recheck(uuid):
    data = _data(force=True)
    return next((v for v in data.get("vms", []) if v["id"].lower() == uuid), None)


def _wait_state(job, uuid, name, want, limit, every, base):
    start = time.time()
    while time.time() - start < limit:
        st = vbox_state(uuid)
        if st == want:
            _step(job, f"VirtualBox confirma: {name} está «{want}».")
            _recheck(uuid)
            _finish(job, "ok", f"{name} está {({'running': 'encendida', 'paused': 'en pausa', 'saved': 'guardada (estado guardado en disco)'}).get(want, 'apagada')} (confirmado en VirtualBox).", base)
            return
        if st in ("aborted", "gurumeditation", "stuck"):
            _finish(job, "error", f"VirtualBox informa el estado «{st}». Revisa la VM en VirtualBox.", base)
            return
        time.sleep(every)
    _recheck(uuid)
    st = vbox_state(uuid)
    msg = (f"Pasados {limit} s, {name} sigue en «{st}». " +
           ("El sistema invitado puede haber ignorado el apagado (sesión bloqueada, cambios sin guardar o sin soporte ACPI). "
            "No se forzó el apagado; revísalo dentro de la VM." if want == "poweroff" else "Revisa la ventana de la VM en VirtualBox."))
    _finish(job, "sin_confirmar", msg, base)


def _run_ad(info, base):
    a, sam = info["accion"], info["target"]["cuenta"]
    op = {"ad.unlock": "unlock", "ad.enable": "enable", "ad.disable": "disable", "ad.reset_password": "reset"}[a]
    pw = temp_password() if op == "reset" else None
    try:
        res = _ad_call(op, cuenta=sam, **({"password": pw} if pw else {}))
    except ActionError as exc:
        audit({**base, "evento": "resultado", "resultado": "error", "detalle": str(exc)})
        raise
    item = res["item"]
    checks = {"unlock": not item.get("locked"), "enable": item.get("enabled") is True,
              "disable": item.get("enabled") is False, "reset": bool(item.get("mustChange"))}
    ok = checks[op]
    detail = (f"{sam}: " + ("verificado tras releer la cuenta." if ok else "la cuenta releída no refleja el cambio; revísala en DC01.")
              + (" Contraseña temporal generada y mostrada una vez; no se guarda." if pw else ""))
    audit({**base, "evento": "resultado", "resultado": "ok" if ok else "sin_confirmar", "detalle": detail})
    out = {"estado": "ok" if ok else "sin_confirmar", "resultado": detail, "cuenta": {**item, "actions": ad_rules(item)}}
    if pw:
        out["password"] = pw  # solo en esta respuesta; no se guarda en ningún sitio
    return out


def job(job_id):
    with _state_lock:
        j = _jobs.get(job_id or "")
        return json.loads(json.dumps(j)) if j else None


# ---------- vista general para el panel ----------
def overview():
    cfg, err = load_control()
    data = _data()
    vms = []
    for v in data.get("vms", []):
        in_lab = v["name"] in cfg["maquinas"]
        st = vbox_state(v["id"].lower()) if SIMULATE and v["id"].lower() in _sim_vms else v["state"]
        rules = vm_rules(st) if in_lab else {a: "Fuera del laboratorio definido en control.json." for a in ("vm.start", "vm.shutdown", "vm.pause", "vm.resume", "vm.savestate")}
        busy = any(k.endswith(":" + v["name"].lower()) for k in _busy)
        vms.append({"id": v["id"], "name": v["name"], "state": st, "inLab": in_lab, "busy": busy,
                    "rules": {k: ("Hay una acción en curso." if busy and not r else r) for k, r in rules.items()}})
    ad, ad_why, server = ad_settings()
    fixes = []
    for a in data.get("alerts", []):
        key = a.get("key") or ""
        if not key.startswith("svc:"):
            continue
        _, vmid, port = key.split(":")
        vm = next((v for v in data.get("vms", []) if v["id"] == vmid), None)
        if not vm:
            continue
        c = cfg["correcciones"].get(vm["name"])
        unit = c and c["servicios"].get(port)
        svc = next((s for s in vm.get("services", []) if str(s["port"]) == port), {})
        entry = {"alertKey": key, "vm": vm["id"], "vmName": vm["name"], "port": int(port), "service": svc.get("name"),
                 "detected": a.get("check"), "unit": unit, "actions": []}
        if vm["name"] not in cfg["maquinas"]:
            entry["why"] = "La VM está fuera del laboratorio definido en control.json."
        elif not unit:
            entry["why"] = f"control.json no asocia el puerto {port} de {vm['name']} con ningún servicio corregible."
        else:
            ok, why, how = mechanism(vm["name"], cfg)
            entry.update(why=None if ok else why, via=how,
                         actions=[{"action_id": x, "params": {"servicio": unit}} for x in ("svc.start", "svc.restart")])
        fixes.append(entry)
    corr = {}
    for name, c in cfg["correcciones"].items():
        ok, why, how = mechanism(name, cfg)
        corr[name] = {"metodo": c["metodo"], "servicios": c["servicios"], "disponible": ok, "motivo": why, "via": how}
    return {
        "token": TOKEN, "simulado": SIMULATE, "usuario": LOCAL_USER, "sesion": SESSION, "configError": err,
        "catalogo": catalog(), "vms": vms, "fixes": fixes, "correcciones": corr,
        "ad": {"disponible": not ad_why, "motivo": ad_why, "servidor": server, "vm": ad.get("vm"),
               "credencial": ad.get("credencial"), "usuarioCredencial": (ad.get("_cred") or {}).get("user"),
               "ouPermitidas": ad.get("ouPermitidas") or [],
               "avisoCuenta": ("La credencial parece una cuenta de administrador. Usa una cuenta delegada con permisos mínimos."
                               if BROAD_ADMIN_NAMES.search(str((ad.get("_cred") or {}).get("user") or "")) else None)},
    }


# ---------- asistente (Hermes / OpenCode) por intercambio manual ----------
IP_RE = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")


def assistant_packet(alert_key):
    """Texto para pegar en Hermes u OpenCode: solo datos de la alerta (IPs ocultas, sin credenciales)
    y el catálogo permitido. Nexo Lab no lo envía a ningún sitio."""
    data = _data()
    a = next((x for x in data.get("alerts", []) if x.get("key") == alert_key), None)
    if not a:
        raise ActionError("Esa alerta ya no está activa.")
    vm = next((v for v in data.get("vms", []) if v["id"] == a.get("machine")), None)
    cfg, _ = load_control()
    c = cfg["correcciones"].get(vm["name"]) if vm else None
    mask = lambda s: IP_RE.sub("[IP]", str(s or ""))  # noqa: E731
    facts = {
        "alerta": {"texto": mask(a.get("text")), "categoria": a.get("cat"), "evidencia": mask(a.get("check")), "hora": a.get("at")},
        "vm": vm and {"nombre": vm["name"], "sistema": vm.get("os"), "estado": vm["state"],
                      "servicios": [{"nombre": s["name"], "puerto": s["port"], "estado": s["status"], "detalle": mask(s.get("reason"))}
                                    for s in vm.get("services", [])]},
        "acciones_permitidas": [
            {"action_id": "svc.recheck", "parametros": {}},
            *([{"action_id": x, "parametros": {"servicio": sorted(set(c["servicios"].values()))}} for x in ("svc.start", "svc.restart")] if c else []),
            *([{"action_id": "vm.start", "parametros": {"modo": ["gui", "headless"]}}, {"action_id": "vm.shutdown", "parametros": {}}] if vm else []),
        ],
    }
    prompt = ("Eres un asistente de diagnóstico para un laboratorio doméstico. No ejecutes comandos ni uses herramientas: "
              "solo razona con estos datos.\n"
              "Devuelve ÚNICAMENTE un objeto JSON con esta forma, sin texto adicional:\n"
              '{"action_id": "<uno de acciones_permitidas>", "vm": "<nombre de la VM>", "motivo": "<por qué, 1-3 frases>", '
              '"parametros": {<solo los indicados para esa acción>}, "diagnostico_previo": ["<comprobaciones de solo lectura que el usuario debería hacer antes>"]}\n'
              "Si ninguna acción es adecuada sin más diagnóstico, usa \"action_id\": \"svc.recheck\" y explica qué revisar.\n\n"
              "Datos:\n" + json.dumps(facts, ensure_ascii=False, indent=2))
    return {"texto": prompt, "datos": facts}


def parse_proposal(text):
    """Extrae y valida la propuesta del asistente. No ejecuta nada: devuelve lo que el panel mostrará."""
    text = str(text or "")[:20000]
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ActionError("La respuesta no contiene un objeto JSON.")
    try:
        obj = json.loads(text[start:end + 1])
    except ValueError as exc:
        raise ActionError(f"El JSON de la respuesta no es válido: {exc}")
    if not isinstance(obj, dict):
        raise ActionError("La propuesta debe ser un objeto JSON.")
    aid = obj.get("action_id")
    if aid not in ACTIONS:
        raise ActionError(f"«{aid}» no está en el catálogo de acciones permitidas. Se descarta la propuesta.")
    if ACTIONS[aid]["kind"] == "ad":
        raise ActionError("El asistente no puede proponer acciones de Active Directory; hazlas desde la sección de AD.")
    cfg, _ = load_control()
    uuid, name = resolve_vm(obj.get("vm"), cfg)
    c = cfg["correcciones"].get(name) or {"servicios": {}}
    params = validate_params(aid, obj.get("parametros"), tuple(c["servicios"].values()))
    diag = [str(x)[:300] for x in (obj.get("diagnostico_previo") or []) if isinstance(x, (str, int, float))][:8]
    return {"action_id": aid, "titulo": ACTIONS[aid]["label"], "vm": uuid, "vmName": name, "parametros": params,
            "motivo": str(obj.get("motivo") or "")[:500], "diagnostico_previo": diag}
