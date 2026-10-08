"""Nexo Lab: servidor local del panel.

La lectura (todo este archivo) y las acciones que cambian algo (control.py) están separadas:
este archivo nunca enciende, apaga ni modifica máquinas; las acciones de la sección «Control» viven en
control.py, con un catálogo fijo, confirmación en dos pasos y registro de auditoría.

Lectura:

- Sirve el panel (sin caché) y la ruta /api/estado.
- Lee VirtualBox con VBoxManage (list vms, showvminfo, guestproperty get). Nunca enciende,
  apaga, pausa ni modifica máquinas, y no cambia la configuración de VirtualBox.
- Si una VM no informa su IP, la busca por su MAC en las concesiones DHCP de VirtualBox y en la
  tabla ARP del equipo (arp -a). Ambas son lecturas.
- Lee CPU, memoria y disco del equipo anfitrión.
- Comprueba los servicios de servicios.json con una conexión TCP simple (sin enviar datos), solo en
  los puertos listados y solo en IPs de VMs encendidas que estén en una red local de este equipo.
- Opcionalmente hace una petición HTTP/HTTPS GET (sin credenciales) para confirmar que la aplicación contesta.
- Genera alertas de salud que indican qué se comprobó y cuándo; los umbrales se editan en servicios.json.
- Guarda un historial local en SQLite (data/nexo-historial.db): cambios de estado, servicios, alertas y
  una muestra de CPU/memoria por minuto. Lo registra mientras este servidor esté abierto; los periodos con
  el servidor cerrado quedan marcados como "sin datos".
- Su única escritura fuera de data/ es guardar notas en la bóveda de Obsidian configurada en nexo.local.json,
  siempre como archivos nuevos y tras confirmación en el panel.
- Solo escucha en 127.0.0.1 y rechaza peticiones con otro Host (protección contra DNS rebinding).

Uso:  python server.py [puerto]      (por defecto 8770)
      NEXO_SIMULAR=1 simula las acciones de Control (no ejecuta nada); NEXO_DATA cambia la carpeta de datos.
"""
import ctypes
import functools
import http.server
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

PORT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8770
ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_SECONDS = 3


def find_vboxmanage():
    candidates = [
        os.environ.get("NEXO_VBOXMANAGE"),
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Oracle", "VirtualBox", "VBoxManage.exe"),
        shutil.which("VBoxManage"),
    ]
    return next((c for c in candidates if c and os.path.isfile(c)), None)


VBOX = find_vboxmanage()
NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # evita abrir consolas en Windows


def vbox(*args):
    """Ejecuta VBoxManage con argumentos fijos (sin shell) y devuelve la salida."""
    out = subprocess.run([VBOX, *args], capture_output=True, text=True, timeout=20,
                         encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    return out.stdout


def parse_machinereadable(text):
    data = {}
    for line in text.splitlines():
        m = re.match(r'^"?([^"=]+)"?=(.*)$', line)
        if m:
            data[m.group(1)] = m.group(2).strip().strip('"')
    return data


def vm_ips(uuid):
    ips = []
    for i in range(4):
        out = vbox("guestproperty", "get", uuid, f"/VirtualBox/GuestInfo/Net/{i}/V4/IP")
        m = re.search(r"Value:\s*([0-9.]+)", out)
        if m and not m.group(1).startswith("127."):
            ips.append(m.group(1))
    return ips


def norm_mac(mac):
    return re.sub(r"[^0-9a-f]", "", (mac or "").lower())


def dhcp_leases():
    """MAC -> IP de las concesiones vigentes del servidor DHCP de VirtualBox (archivos .leases, solo lectura)."""
    import glob
    import xml.etree.ElementTree as ET
    found, now = {}, time.time()
    folder = os.path.join(os.path.expanduser("~"), ".VirtualBox")
    for path in glob.glob(os.path.join(folder, "*.leases")):
        try:
            for lease in ET.parse(path).getroot().iter("Lease"):
                addr, when = lease.find("Address"), lease.find("Time")
                if lease.get("state") != "acked" or addr is None or when is None:
                    continue
                if int(when.get("issued", 0)) + int(when.get("expiration", 0)) >= now:
                    found[norm_mac(lease.get("mac"))] = addr.get("value")
        except (ET.ParseError, OSError, ValueError):
            continue
    return found


def arp_table():
    """MAC -> IP vistos recientemente por este equipo (arp -a, solo lectura)."""
    try:
        out = subprocess.run(["arp", "-a"], capture_output=True, text=True, timeout=10,
                             errors="replace", creationflags=NO_WINDOW).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    table = {}
    for ip, mac in re.findall(r"(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})", out):
        m = norm_mac(mac)
        if m != "ffffffffffff" and not m.startswith("01005e"):
            table[m] = ip
    return table


def read_vms():
    vms = []
    leases, arp = None, None
    for line in vbox("list", "vms").splitlines():
        m = re.match(r'^"(.*)" \{([0-9a-fA-F-]+)\}$', line.strip())
        if not m:
            continue
        name, uuid = m.groups()
        info = parse_machinereadable(vbox("showvminfo", uuid, "--machinereadable"))
        nics = []
        for i in range(1, 9):
            kind = info.get(f"nic{i}")
            if kind and kind != "none":
                target = (info.get(f"hostonlyadapter{i}") or info.get(f"bridgeadapter{i}")
                          or info.get(f"intnet{i}") or info.get(f"natnet{i}") or "")
                nics.append({"slot": i, "type": kind, "target": target, "mac": norm_mac(info.get(f"macaddress{i}"))})
        state = info.get("VMState", "unknown")
        ips = vm_ips(uuid) if state == "running" else []
        # Sin Guest Additions completas VirtualBox no conoce la IP: se busca la MAC del adaptador
        # en las concesiones DHCP de VirtualBox y, si no, en la tabla ARP del equipo.
        ips_host = []
        if state == "running" and not ips:
            if leases is None:
                leases, arp = dhcp_leases(), arp_table()
            for n in nics:
                if n["type"] == "nat":
                    continue  # la IP NAT es interna de VirtualBox y no se ve desde el equipo
                if n["mac"] in leases:
                    ips_host.append({"ip": leases[n["mac"]], "origin": "dhcp"})
                elif n["mac"] in arp:
                    ips_host.append({"ip": arp[n["mac"]], "origin": "arp"})
        vms.append({
            "id": uuid,
            "name": name,
            "os": info.get("ostype", ""),
            "state": state,
            "since": info.get("VMStateChangeTime"),
            "vcpu": int(info.get("cpus", 0) or 0),
            "ramMB": int(info.get("memory", 0) or 0),
            "nics": nics,
            "ips": ips,
            "ipsHost": ips_host,
        })
    return vms


# ---------- equipo anfitrión ----------
class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


def host_cpu_percent():
    if os.name != "nt":
        return None
    ft = lambda: ctypes.c_ulonglong()  # noqa: E731

    def sample():
        idle, kernel, user = ft(), ft(), ft()
        ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
        return idle.value, kernel.value + user.value

    i1, t1 = sample()
    time.sleep(0.3)
    i2, t2 = sample()
    total = t2 - t1
    return round(100 * (1 - (i2 - i1) / total)) if total else None


def read_host():
    mem, ram_gb = None, None
    if os.name == "nt":
        st = MEMORYSTATUSEX()
        st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            mem = int(st.dwMemoryLoad)
            ram_gb = round(st.ullTotalPhys / 1024 ** 3)
    drive = os.environ.get("SystemDrive", "C:") + "\\" if os.name == "nt" else "/"
    du = shutil.disk_usage(drive)
    os_name = f"{platform.system()} {platform.release()}"
    build = platform.version().split(".")[-1]
    if os.name == "nt" and platform.release() == "10" and build.isdigit() and int(build) >= 22000:
        os_name = "Windows 11"  # Python informa "10" también en Windows 11
    return {
        "id": "host",
        "name": socket.gethostname(),
        "os": f"{os_name} (compilación {build})",
        "cpu": host_cpu_percent(),
        "mem": mem,
        "disk": round(100 * du.used / du.total),
        "vcpu": os.cpu_count(),
        "ramGB": ram_gb,
        "diskGB": round(du.total / 1024 ** 3),
    }


# ---------- configuración, servicios y alertas ----------
CONFIG_PATH = os.path.join(ROOT, "servicios.json")
DEFAULTS = {"tiempoLimiteSegundos": 1.5, "avisarInterrumpidaTrasDias": 2, "graciaArranqueSegundos": 120,
            "avisoMemoriaEquipo": 90, "minutosMemoriaAlta": 5, "avisoCpuEquipo": 90, "minutosCpuAlta": 5,
            "intervaloRegistroSegundos": 30, "diasRetencion": 30}


def load_config():
    """Devuelve (config, error). Un error de formato no detiene el panel: se informa como alerta."""
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg = json.load(f)
        cfg.setdefault("maquinas", {})
        cfg["ajustes"] = {**DEFAULTS, **cfg.get("ajustes", {})}
        return cfg, None
    except FileNotFoundError:
        return {"maquinas": {}, "ajustes": dict(DEFAULTS)}, None
    except (json.JSONDecodeError, OSError) as exc:
        return {"maquinas": {}, "ajustes": dict(DEFAULTS)}, f"servicios.json no es válido: {exc}"


def local_ipv4s():
    try:
        return {ip for ip in socket.gethostbyname_ex(socket.gethostname())[2] if not ip.startswith("127.")}
    except OSError:
        return set()


def reachable_ips(vm, local):
    """IPs de la VM que están en la misma red /24 que alguna IP de este equipo (p. ej. solo anfitrión).
    La IP NAT de VirtualBox (10.0.2.x) no es alcanzable desde el equipo y se descarta."""
    cands = vm["ips"] + [x["ip"] for x in vm["ipsHost"]]
    return [ip for ip in dict.fromkeys(cands)
            if not ip.startswith("10.0.2.") and any(ip.rsplit(".", 1)[0] == l.rsplit(".", 1)[0] for l in local)]


def tcp_check(ip, port, timeout):
    """Abre y cierra una conexión TCP. No envía datos."""
    started = time.time()
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return "up", "Respondió (conexión TCP aceptada)", round((time.time() - started) * 1000)
    except ConnectionRefusedError:
        return "down", "Conexión rechazada: no hay nada escuchando en ese puerto", None
    except socket.timeout:
        return "down", f"Sin respuesta en {timeout} s (puerto filtrado o máquina inaccesible)", None
    except OSError as exc:
        return "down", f"Error de red: {exc.strerror or exc}", None


def http_check(ip, port, scheme, path, timeout):
    """GET sin credenciales ni cuerpo. Solo lee la línea de estado: confirma que la aplicación responde.
    No verifica el certificado TLS porque los servicios de un laboratorio suelen usar certificados autofirmados;
    la petición va solo a la IP de tu propia VM."""
    import http.client
    import ssl
    started = time.time()
    try:
        if scheme == "https":
            conn = http.client.HTTPSConnection(ip, port, timeout=timeout, context=ssl._create_unverified_context())
        else:
            conn = http.client.HTTPConnection(ip, port, timeout=timeout)
        try:
            conn.request("GET", path or "/", headers={"User-Agent": "NexoLab (comprobacion de solo lectura)"})
            resp = conn.getresponse()
            code, reason = resp.status, resp.reason
        finally:
            conn.close()
        ms = round((time.time() - started) * 1000)
        if code >= 500:
            return "down", f"{scheme.upper()} GET {path or '/'} respondió {code} {reason} (error del servidor)", ms, code
        note = " (normal: no se envían credenciales)" if code in (401, 403) else ""
        return "up", f"{scheme.upper()} GET {path or '/'} respondió {code} {reason}{note}", ms, code
    except ConnectionRefusedError:
        return "down", "Conexión rechazada: no hay nada escuchando en ese puerto", None, None
    except socket.timeout:
        return "down", f"Sin respuesta en {timeout} s", None, None
    except ssl.SSLError as exc:
        return "down", f"Error TLS: {exc.reason or exc}", None, None
    except (OSError, http.client.HTTPException) as exc:
        return "down", f"Sin respuesta HTTP válida: {exc}", None, None


def run_check(svc, ip, timeout):
    if svc["method"] in ("http", "https"):
        return http_check(ip, svc["port"], svc["method"], svc.get("path"), timeout)
    status, reason, ms = tcp_check(ip, svc["port"], timeout)
    return status, reason, ms, None


def parse_since(text):
    if not text:
        return None
    try:
        return datetime.fromisoformat(text[:26].rstrip("0").rstrip(".") if "." in text else text).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def check_services(vms, cfg):
    from concurrent.futures import ThreadPoolExecutor
    aj, local, now = cfg["ajustes"], local_ipv4s(), datetime.now(timezone.utc)
    jobs = []
    for vm in vms:
        conf = cfg["maquinas"].get(vm["name"], {})
        vm["group"] = conf.get("grupo")
        vm["tags"] = conf.get("etiquetas", [])
        since = parse_since(vm.get("since"))
        vm["booting"] = bool(vm["state"] == "running" and since and (now - since).total_seconds() < aj["graciaArranqueSegundos"])
        targets = reachable_ips(vm, local) if vm["state"] == "running" else []
        vm["checkedIp"] = targets[0] if targets else None
        vm["services"] = []
        for s in conf.get("servicios", []):
            method = str(s.get("tipo", "tcp")).lower()
            svc = {"name": s.get("nombre", "?"), "port": int(s.get("puerto", 0)), "status": "unchecked", "checkedAt": None,
                   "method": method if method in ("tcp", "http", "https") else "tcp", "path": s.get("ruta", "/")}
            if vm["state"] != "running":
                svc["reason"] = ("No se comprobó: la máquina está en pausa" if vm["state"] == "paused" else
                                 "No se comprobó: la máquina tiene su estado guardado" if vm["state"] in ("saved", "aborted-saved", "aborted_saved") else
                                 "No se comprobó: la máquina no está encendida")
            elif not targets:
                svc["reason"] = "No se comprobó: la VM no tiene una IP alcanzable desde este equipo"
            elif not 0 < svc["port"] < 65536:
                svc["reason"] = "Puerto no válido en servicios.json"
            else:
                jobs.append((svc, targets[0]))
            vm["services"].append(svc)
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = pool.map(lambda j: run_check(j[0], j[1], float(aj["tiempoLimiteSegundos"])), jobs)
        for (svc, ip), (status, reason, ms, code) in zip(jobs, results):
            svc.update(status=status, reason=reason, ms=ms, ip=ip, httpStatus=code,
                       checkedAt=datetime.now(timezone.utc).isoformat())


_high_since = {}  # "mem"/"cpu" -> desde cuándo el equipo supera el umbral (para avisar solo si se sostiene)


def sustained(kind, value, threshold, minutes, now):
    if value is None or value < threshold:
        _high_since.pop(kind, None)
        return None
    start = _high_since.setdefault(kind, now)
    return start if (now - start).total_seconds() >= minutes * 60 else None


def health_alerts(host, vms, cfg, cfg_error):
    aj, now = cfg["ajustes"], datetime.now(timezone.utc)
    at = now.isoformat()
    alerts = []
    if cfg_error:
        alerts.append({"key": "cfg", "cat": "config", "level": "warn", "machine": None, "text": cfg_error, "check": "Lectura de servicios.json", "at": at})
    for vm in vms:
        since = parse_since(vm.get("since"))
        if vm["state"] in ("aborted", "aborted_saved", "aborted-saved", "stuck", "gurumeditation") and since:
            days = (now - since).total_seconds() / 86400
            if days >= aj["avisarInterrumpidaTrasDias"]:
                alerts.append({"key": f"aborted:{vm['id']}", "cat": "vm", "level": "warn", "machine": vm["id"],
                               "text": f"{vm['name']} lleva {int(days)} días en estado «{vm['state']}» en VirtualBox",
                               "check": "Estado y fecha del último cambio leídos con VBoxManage showvminfo", "at": at})
        if vm["state"] == "running" and not vm["ips"] and not vm["ipsHost"] and not vm["booting"]:
            alerts.append({"key": f"noip:{vm['id']}", "cat": "noip", "level": "warn", "machine": vm["id"], "text": f"{vm['name']} está encendida pero no tiene IP visible",
                           "check": "Guest Additions, concesiones DHCP de VirtualBox y tabla ARP del equipo", "at": at})
        for s in vm.get("services", []):
            if s["status"] == "down":
                if vm["booting"]:
                    s["status"], s["reason"] = "pending", "Aún arrancando: se volverá a comprobar. " + s["reason"]
                    continue
                how = "Petición " + s["method"].upper() if s["method"] != "tcp" else "Conexión TCP"
                cat = "http5xx" if (s.get("httpStatus") or 0) >= 500 else "noresponse"
                alerts.append({"key": f"svc:{vm['id']}:{s['port']}", "cat": cat, "level": "warn", "machine": vm["id"],
                               "text": f"{s['name']} ({s['port']}) no responde en {vm['name']}",
                               "check": f"{how} a {s['ip']}:{s['port']}. {s['reason']}", "at": s["checkedAt"]})
    for kind, label, value, limit, minutes, check in (
            ("mem", "La memoria", host.get("mem"), aj["avisoMemoriaEquipo"], aj["minutosMemoriaAlta"], "Memoria del sistema (GlobalMemoryStatusEx)"),
            ("cpu", "La CPU", host.get("cpu"), aj["avisoCpuEquipo"], aj["minutosCpuAlta"], "Tiempos de CPU del sistema (GetSystemTimes)")):
        start = sustained(kind, value, limit, minutes, now)
        if start:
            alerts.append({"key": f"host{kind}", "cat": "resources", "level": "warn", "machine": "host",
                           "text": f"{label} del equipo principal está al {value} % desde hace {int((now - start).total_seconds() // 60)} min",
                           "check": f"{check}. Umbral: {limit} % sostenido {minutes} min (servicios.json)", "at": at})
    return alerts


# ---------- métricas en tiempo real (procesos de las VM en este equipo) ----------
class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t), ("PrivateUsage", ctypes.c_size_t)]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                  "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


def proc_stats(pid):
    """(tiempo de CPU en unidades de 100 ns, memoria en uso en bytes, bytes de E/S acumulados) o None.
    Solo pide permiso de consulta limitada (PROCESS_QUERY_LIMITED_INFORMATION)."""
    k32 = ctypes.windll.kernel32
    hnd = k32.OpenProcess(0x1000, False, pid)
    if not hnd:
        return None
    try:
        c, e, kt, ut = (ctypes.c_ulonglong() for _ in range(4))
        if not k32.GetProcessTimes(hnd, ctypes.byref(c), ctypes.byref(e), ctypes.byref(kt), ctypes.byref(ut)):
            return None
        pmc = PROCESS_MEMORY_COUNTERS_EX()
        pmc.cb = ctypes.sizeof(pmc)
        ws = pmc.WorkingSetSize if k32.K32GetProcessMemoryInfo(hnd, ctypes.byref(pmc), pmc.cb) else 0
        io = IO_COUNTERS()
        io_total = io.ReadTransferCount + io.WriteTransferCount if k32.GetProcessIoCounters(hnd, ctypes.byref(io)) else None
        return kt.value + ut.value, ws, io_total
    finally:
        k32.CloseHandle(hnd)


class Realtime:
    """Asocia cada proceso VirtualBoxVM.exe/VBoxHeadless.exe con su VM (por el UUID de --startvm)
    y calcula CPU, memoria y E/S por diferencia entre lecturas, como el Administrador de tareas."""

    def __init__(self):
        self.lock = threading.Lock()
        self.pids = {}          # pid -> uuid
        self.prev = {}          # uuid -> (cpu_100ns, io_bytes, reloj)
        self.host_prev = None   # (idle, total)
        threading.Thread(target=self._map_loop, daemon=True).start()

    def _map_loop(self):
        while True:
            try:
                out = subprocess.run(
                    ["powershell", "-NoProfile", "-Command",
                     "Get-CimInstance Win32_Process -Filter \"Name='VirtualBoxVM.exe' OR Name='VBoxHeadless.exe'\""
                     " | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
                    capture_output=True, text=True, timeout=20, creationflags=NO_WINDOW).stdout.strip()
                items = json.loads(out) if out else []
                items = items if isinstance(items, list) else [items]
                pids = {}
                for it in items:
                    m = re.search(r"--startvm\s+\"?([0-9a-fA-F-]{36})", it.get("CommandLine") or "")
                    if m:
                        pids[int(it["ProcessId"])] = m.group(1).lower()
                with self.lock:
                    self.pids = pids
            except (OSError, subprocess.SubprocessError, ValueError):
                pass
            time.sleep(5)

    def sample(self):
        with self.lock:
            now, ncpu = time.monotonic(), os.cpu_count() or 1
            acc = {}
            for pid, uuid in list(self.pids.items()):
                st = proc_stats(pid)
                if st is None:
                    continue
                a = acc.setdefault(uuid, [0, 0, 0, True])
                a[0] += st[0]
                a[1] += st[1]
                if st[2] is None:
                    a[3] = False
                else:
                    a[2] += st[2]
            vms = {}
            for uuid, (cpu_t, ws, io_b, io_ok) in acc.items():
                prev = self.prev.get(uuid)
                cpu = io = None
                if prev and now > prev[2]:
                    dt = now - prev[2]
                    cpu = max(0.0, min(100.0, (cpu_t - prev[0]) / 1e7 / dt / ncpu * 100))
                    io = max(0, (io_b - prev[1]) / dt) if io_ok else None
                self.prev[uuid] = (cpu_t, io_b, now)
                vms[uuid] = {"cpu": None if cpu is None else round(cpu, 1), "memMB": round(ws / 2 ** 20),
                             "ioBps": None if io is None else round(io)}
            idle, kernel, user = ctypes.c_ulonglong(), ctypes.c_ulonglong(), ctypes.c_ulonglong()
            ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
            total = kernel.value + user.value
            host_cpu = None
            if self.host_prev and total > self.host_prev[1]:
                host_cpu = round(100 * (1 - (idle.value - self.host_prev[0]) / (total - self.host_prev[1])), 1)
            self.host_prev = (idle.value, total)
            st = MEMORYSTATUSEX()
            st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
            return {
                "at": datetime.now(timezone.utc).isoformat(),
                "host": {"cpu": host_cpu, "mem": int(st.dwMemoryLoad),
                         "memUsedGB": round((st.ullTotalPhys - st.ullAvailPhys) / 2 ** 30, 1),
                         "memTotalGB": round(st.ullTotalPhys / 2 ** 30, 1)},
                "vms": vms,
            }


REALTIME = Realtime() if os.name == "nt" else None


# ---------- historial local (SQLite) ----------
import sqlite3

DATA_DIR = os.environ.get("NEXO_DATA") or os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA_DIR, "nexo-historial.db")
MARKER_PATH = os.path.join(DATA_DIR, ".historial-creado")
rel = lambda p: os.path.relpath(p, ROOT)  # noqa: E731


class HistoryError(Exception):
    pass


def origin_note(vm_name, ts, resumed):
    """Frase para el historial: ¿el cambio de estado lo pidió el panel? Tras un cierre del servidor no se afirma que no."""
    a = control.accion_cercana(vm_name, ts)
    if a:
        label = control.ACTIONS.get(a.get("accion"), {}).get("label", a.get("accion"))
        return f" Pedido desde el panel: «{label}» por {a.get('usuario', '?')} a las {str(a.get('ts', ''))[11:19]} UTC."
    if resumed:
        return ""
    return " No hay ninguna acción registrada en el panel para este cambio: pudo hacerse en VirtualBox, dentro de la VM o por un fallo."


class Store:
    """Historial persistente en SQLite.

    - Guarda una fila solo cuando algo cambia (estado de VM, resultado de un servicio, alerta) y una muestra
      de recursos por minuto.
    - Registra cada sesión del servidor; los huecos entre sesiones son periodos SIN DATOS: no se inventa
      qué pasó en ellos.
    - Si el archivo falta (habiendo existido) o está dañado, el historial queda desactivado con un mensaje
      claro. Nunca se reemplaza ni se borra el archivo.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.db = None
        self.error = None
        self.session_id = None
        self.resumed_from = None   # fin de la sesión anterior, si la hubo
        self.first_record = True
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            exists = os.path.exists(DB_PATH)
            if not exists and os.path.exists(MARKER_PATH):
                raise HistoryError(
                    f"No se encuentra el archivo de historial {rel(DB_PATH)}, aunque ya existía antes "
                    f"(según {rel(MARKER_PATH)}). No se creó uno nuevo para no ocultar la pérdida. "
                    f"Si lo moviste, devuélvelo a su sitio. Si quieres empezar un historial nuevo, borra {rel(MARKER_PATH)} y reinicia el servidor.")
            # mode=rw no crea el archivo si no existe; solo se crea (rwc) en el primer uso.
            self.db = sqlite3.connect(f"file:{DB_PATH}?mode={'rw' if exists else 'rwc'}", uri=True, check_same_thread=False)
            if exists:
                check = self.db.execute("PRAGMA quick_check").fetchone()[0]
                if check != "ok":
                    raise HistoryError(f"El archivo de historial está dañado (comprobación de SQLite: {check}).")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS eventos (id INTEGER PRIMARY KEY, ts TEXT, tipo TEXT, maquina_id TEXT, maquina TEXT,
                    antes TEXT, despues TEXT, detalle TEXT, duracion_s INTEGER);
                CREATE TABLE IF NOT EXISTS muestras (ts TEXT, maquina_id TEXT, cpu REAL, mem REAL, mem_mb REAL, origen TEXT);
                CREATE TABLE IF NOT EXISTS ultimo (clave TEXT PRIMARY KEY, valor TEXT, desde TEXT);
                CREATE TABLE IF NOT EXISTS sesiones (id INTEGER PRIMARY KEY, inicio TEXT, ultimo TEXT);
                CREATE INDEX IF NOT EXISTS i_eventos_ts ON eventos (ts);
                CREATE INDEX IF NOT EXISTS i_muestras ON muestras (maquina_id, ts);
            """)
            if not os.path.exists(MARKER_PATH):
                with open(MARKER_PATH, "w", encoding="utf-8") as f:
                    f.write(f"Historial de Nexo Lab creado el {datetime.now(timezone.utc).isoformat()}\n"
                            "No borres este archivo: permite detectar si el historial desaparece.\n")
            self._start_session()
            self.db.commit()
        except (sqlite3.DatabaseError, OSError, HistoryError) as exc:
            self._fail(exc)

    def _fail(self, exc):
        if isinstance(exc, HistoryError) and not os.path.exists(DB_PATH):
            self.error = f"El historial no está disponible. {exc}"
        else:
            detail = str(exc) if isinstance(exc, HistoryError) else f"No se pudo leer ({type(exc).__name__}: {exc})."
            self.error = (f"El historial no está disponible. {detail} El archivo no se ha modificado ni borrado. "
                          f"Para empezar uno nuevo: cierra el servidor, mueve o renombra {rel(DB_PATH)} y vuelve a abrirlo.")
        if self.db is not None:
            try:
                self.db.close()
            except sqlite3.Error:
                pass
        self.db = None
        print("AVISO:", self.error)

    def _safe(self, fn, default=None):
        """Ejecuta una operación de base de datos; si falla, desactiva el historial con un mensaje claro."""
        if self.db is None:
            return default
        with self.lock:
            try:
                return fn()
            except sqlite3.DatabaseError as exc:
                self._fail(exc)
                return default

    def _start_session(self):
        now = datetime.now(timezone.utc).isoformat()
        prev = self.db.execute("SELECT ultimo FROM sesiones ORDER BY id DESC LIMIT 1").fetchone()
        cur = self.db.execute("INSERT INTO sesiones (inicio, ultimo) VALUES (?, ?)", (now, now))
        self.session_id = cur.lastrowid
        if prev and prev[0]:
            self.resumed_from = prev[0]
            secs = int((datetime.fromisoformat(now) - datetime.fromisoformat(prev[0])).total_seconds())
            if secs > 90:
                self._event(prev[0], "sin_datos", None, None, None,
                            "Sin datos: el servidor estuvo cerrado y no comprobó nada en este periodo",
                            f"Desde {prev[0]} hasta {now}. Lo ocurrido en este intervalo no se conoce.", secs)

    def heartbeat(self):
        def run():
            self.db.execute("UPDATE sesiones SET ultimo=? WHERE id=?", (datetime.now(timezone.utc).isoformat(), self.session_id))
            self.db.commit()
        self._safe(run)

    def _event(self, ts, tipo, mid, name, before, after, detail, dur=None):
        self.db.execute("INSERT INTO eventos (ts, tipo, maquina_id, maquina, antes, despues, detalle, duracion_s) VALUES (?,?,?,?,?,?,?,?)",
                        (ts, tipo, mid, name, before, after, detail, dur))

    def _observe(self, key, value, ts):
        """Devuelve (valor_anterior, desde_anterior) si cambió; None si es igual o es la primera vez."""
        row = self.db.execute("SELECT valor, desde FROM ultimo WHERE clave=?", (key,)).fetchone()
        if row and row[0] == value:
            return None
        self.db.execute("INSERT OR REPLACE INTO ultimo (clave, valor, desde) VALUES (?,?,?)", (key, value, ts))
        return row

    def record(self, data):
        def run():
            now = datetime.now(timezone.utc)
            nowiso = now.isoformat()
            # En la primera lectura tras reabrir el servidor, los cambios pudieron ocurrir mientras estaba cerrado.
            resumed = self.first_record and self.resumed_from
            gap_note = (f" Detectado al reabrir el servidor: ocurrió en algún momento entre {self.resumed_from} y {nowiso}."
                        if resumed else "")

            def dur(prev_since, ts):
                try:
                    return max(0, int((datetime.fromisoformat(ts) - datetime.fromisoformat(prev_since)).total_seconds()))
                except (TypeError, ValueError):
                    return None

            for vm in data["vms"]:
                since = parse_since(vm.get("since"))
                ts = since.isoformat() if since else nowiso
                prev = self._observe("vm:" + vm["id"], vm["state"], ts)
                if prev:
                    self._event(ts, "estado", vm["id"], vm["name"], prev[0], vm["state"],
                                ("Hora del cambio según VirtualBox." if since else "Hora en que lo detectó el panel." + gap_note)
                                + origin_note(vm["name"], ts, bool(resumed)),
                                dur(prev[1], ts))
                for svc in vm.get("services", []):
                    if svc["status"] == "pending":
                        continue
                    prev = self._observe(f"svc:{vm['id']}:{svc['port']}", svc["status"], nowiso)
                    if prev:
                        self._event(nowiso, "servicio", vm["id"], vm["name"], prev[0], svc["status"],
                                    f"{svc['name']} ({svc['port']}): {svc.get('reason') or ''}{gap_note}", dur(prev[1], nowiso))
            active = {a["key"]: a for a in data["alerts"]}
            known = {k: (v, d) for k, v, d in self.db.execute("SELECT clave, valor, desde FROM ultimo WHERE clave LIKE 'alerta:%'").fetchall()}
            names = {v["id"]: v["name"] for v in data["vms"]}
            names["host"] = data["host"]["name"]
            for key, a in active.items():
                if "alerta:" + key not in known:
                    self.db.execute("INSERT OR REPLACE INTO ultimo (clave, valor, desde) VALUES (?,?,?)", ("alerta:" + key, a["text"], nowiso))
                    self._event(nowiso, "alerta", a["machine"], names.get(a["machine"]), None, a["text"], a["check"] + gap_note)
            aj = data.get("ajustes", {})
            host = data["host"]
            # Las alertas sostenidas del equipo solo se resuelven si el valor medido bajó del umbral; si sigue alto,
            # su ausencia solo significa que el contador de minutos se reinició (p. ej. al reabrir el servidor).
            still_high = {"alerta:hostmem": host.get("mem") is not None and host["mem"] >= aj.get("avisoMemoriaEquipo", 90),
                          "alerta:hostcpu": host.get("cpu") is not None and host["cpu"] >= aj.get("avisoCpuEquipo", 90)}
            for key, (text, since) in known.items():
                if key[7:] not in active and not still_high.get(key):
                    self.db.execute("DELETE FROM ultimo WHERE clave=?", (key,))
                    mid = key.split(":")[2] if key.count(":") >= 2 else ("host" if key.startswith("alerta:host") else None)
                    self._event(nowiso, "alerta_resuelta", mid, names.get(mid), None, "Resuelta: " + (text if text != "activa" else key[7:]),
                                "Dejó de cumplirse la condición en la última comprobación." + gap_note, dur(since, nowiso))
            self.db.execute("UPDATE sesiones SET ultimo=? WHERE id=?", (nowiso, self.session_id))
            self.db.commit()
            self.first_record = False
        self._safe(run)

    def add_samples(self, rt, vms):
        ts = datetime.now(timezone.utc).isoformat()
        rows = [(ts, "host", rt["host"]["cpu"], rt["host"]["mem"], rt["host"]["memUsedGB"] * 1024,
                 "Sistema operativo del equipo (GetSystemTimes y GlobalMemoryStatusEx)")]
        ram = {v["id"].lower(): v["ramMB"] for v in vms}
        for uuid, m in rt["vms"].items():
            if m["cpu"] is None:
                continue
            mem = min(100, m["memMB"] / ram[uuid] * 100) if ram.get(uuid) else None
            rows.append((ts, uuid, m["cpu"], mem, m["memMB"], "Proceso de la VM en este equipo (VirtualBoxVM.exe)"))

        def run():
            self.db.executemany("INSERT INTO muestras VALUES (?,?,?,?,?,?)", rows)
            self.db.commit()
        self._safe(run)

    def prune(self, days):
        limit = datetime.fromtimestamp(time.time() - days * 86400, timezone.utc).isoformat()

        def run():
            self.db.execute("DELETE FROM muestras WHERE ts < ?", (limit,))
            self.db.execute("DELETE FROM eventos WHERE ts < ?", (limit,))
            self.db.execute("DELETE FROM sesiones WHERE ultimo < ? AND id <> ?", (limit, self.session_id))
            self.db.commit()
        self._safe(run)

    def events(self, limit=100, machine=None, kind=None, since=None):
        q = "SELECT ts, tipo, maquina_id, maquina, antes, despues, detalle, duracion_s FROM eventos"
        where, args = [], []
        if machine:
            where.append("lower(maquina_id) = lower(?)")
            args.append(machine)
        if kind:
            where.append("tipo = ?")
            args.append(kind)
        if since:
            where.append("ts >= ?")
            args.append(since)
        if where:
            q += " WHERE " + " AND ".join(where)
        q += " ORDER BY ts DESC, id DESC LIMIT ?"
        args.append(int(limit))
        rows = self._safe(lambda: self.db.execute(q, args).fetchall(), [])
        keys = ("ts", "tipo", "machine", "name", "before", "after", "detail", "durationS")
        return [dict(zip(keys, r)) for r in rows]

    def gaps(self, since_iso):
        """Periodos sin datos (servidor cerrado) desde 'since_iso', a partir de las sesiones registradas."""
        rows = self._safe(lambda: self.db.execute("SELECT inicio, ultimo FROM sesiones ORDER BY id").fetchall(), [])
        out = []
        for (_, end), (start, _) in zip(rows, rows[1:]):
            if end and start and end >= since_iso and (datetime.fromisoformat(start) - datetime.fromisoformat(end)).total_seconds() > 90:
                out.append({"from": end, "to": start})
        return out

    def samples(self, machine, hours):
        since = datetime.fromtimestamp(time.time() - hours * 3600, timezone.utc).isoformat()
        rows = self._safe(lambda: self.db.execute(
            "SELECT ts, cpu, mem, mem_mb, origen FROM muestras WHERE lower(maquina_id) = lower(?) AND ts >= ? ORDER BY ts",
            (machine, since)).fetchall(), [])
        first = self._safe(lambda: self.db.execute("SELECT min(inicio) FROM sesiones").fetchone()[0])
        return {"machine": machine, "hours": hours, "origin": rows[-1][4] if rows else None, "historySince": first,
                "gaps": self.gaps(since), "error": self.error,
                "points": [{"ts": r[0], "cpu": r[1], "mem": r[2], "memMB": r[3]} for r in rows]}

    def summary(self):
        first = self._safe(lambda: self.db.execute("SELECT min(inicio) FROM sesiones").fetchone()[0])
        n = self._safe(lambda: self.db.execute("SELECT count(*) FROM eventos").fetchone()[0], 0)
        return {"since": first, "eventCount": n, "file": rel(DB_PATH), "error": self.error}


STORE = Store()


# ---------- notas en una bóveda de Obsidian (configuración local) ----------
LOCAL_CONFIG = os.path.join(ROOT, "nexo.local.json")
WIN_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def safe_name(text, limit=80):
    """Nombre válido de archivo o carpeta en Windows (sin separadores ni caracteres reservados)."""
    t = re.sub(r'[<>:"/\\|?*\x00-\x1f#^\[\]]', " ", str(text or "")).strip().strip(".")
    t = re.sub(r"\.{2,}", " ", t)
    t = re.sub(r"\s+", " ", t).strip(" .")[:limit].strip(" .") or "sin-nombre"
    return "_" + t if t.split(".")[0].upper() in WIN_RESERVED else t


def obsidian_status():
    base = {"configured": False, "available": False, "vault": None, "folder": None,
            "configFile": rel(LOCAL_CONFIG), "exampleFile": "nexo.local.ejemplo.json"}
    if not os.path.exists(LOCAL_CONFIG):
        return {**base, "message": "No hay bóveda configurada. Copia nexo.local.ejemplo.json como nexo.local.json, "
                                   "escribe en «boveda» la ruta de tu bóveda de Obsidian y vuelve a abrir esta ventana."}
    try:
        with open(LOCAL_CONFIG, encoding="utf-8") as f:
            conf = json.load(f).get("obsidian", {})
    except (json.JSONDecodeError, OSError) as exc:
        return {**base, "message": f"nexo.local.json no es válido: {exc}. Revisa comillas y barras (en JSON, cada \\ se escribe \\\\)."}
    vault, folder = (conf.get("boveda") or "").strip(), safe_name(conf.get("carpeta") or "Nexo Lab")
    base.update(configured=bool(vault), vault=vault or None, folder=folder)
    if not vault:
        return {**base, "message": "En nexo.local.json falta la ruta de la bóveda («boveda»)."}
    if not os.path.isdir(vault):
        return {**base, "message": f"La ruta configurada no existe o no está disponible: {vault}"}
    if not os.path.isdir(os.path.join(vault, ".obsidian")):
        return {**base, "message": f"La carpeta {vault} existe pero no parece una bóveda de Obsidian (no tiene la carpeta .obsidian). "
                                   "Ábrela como bóveda en Obsidian o corrige la ruta."}
    return {**base, "available": True, "message": f"Bóveda disponible. Las notas se guardan en «{folder}», por máquina y fecha."}


def plan_note(st, machine, when_iso, title):
    """Ruta de la nota: <bóveda>/<carpeta>/<máquina>/<AAAA-MM-DD>/<HHmm - título>.md, con nombre único."""
    try:
        when = datetime.fromisoformat(when_iso)
    except (TypeError, ValueError):
        when = datetime.now()
    folder = os.path.join(st["vault"], st["folder"], safe_name(machine or "Laboratorio"), when.strftime("%Y-%m-%d"))
    stem = safe_name(f"{when.strftime('%H%M')} - {title}", 100)
    root = os.path.realpath(st["vault"])
    for n in range(1, 200):
        path = os.path.join(folder, stem + (f" ({n})" if n > 1 else "") + ".md")
        if os.path.commonpath([root, os.path.realpath(path)]) != root:
            raise ValueError("La ruta calculada queda fuera de la bóveda.")
        if not os.path.exists(path):
            return path
    raise ValueError("Hay demasiadas notas con el mismo nombre en esa carpeta.")


def save_note(machine, when_iso, title, content):
    st = obsidian_status()
    if not st["available"]:
        raise ValueError(st["message"])
    if not content.strip():
        raise ValueError("La nota está vacía.")
    for _ in range(5):
        path = plan_note(st, machine, when_iso, title)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            # "x": crea el archivo y falla si ya existe, así nunca se sobrescribe una nota.
            with open(path, "x", encoding="utf-8", newline="\n") as f:
                f.write(content)
            return path
        except FileExistsError:
            continue
    raise ValueError("No se pudo crear un nombre único para la nota.")


# ---------- edición de servicios.json desde el panel (con validación y copia de seguridad) ----------
BACKUP_DIR = os.path.join(DATA_DIR, "copias-config")
LIMITS = {  # ajuste: (mínimo, máximo)
    "tiempoLimiteSegundos": (0.2, 10), "avisoMemoriaEquipo": (50, 100), "minutosMemoriaAlta": (0, 120),
    "avisoCpuEquipo": (50, 100), "minutosCpuAlta": (0, 120), "avisarInterrumpidaTrasDias": (0, 365),
    "graciaArranqueSegundos": (0, 1800), "intervaloRegistroSegundos": (10, 3600), "diasRetencion": (1, 3650),
}


def validate_config(new):
    """Devuelve una configuración limpia o lanza ValueError con un mensaje claro."""
    if not isinstance(new, dict):
        raise ValueError("La configuración debe ser un objeto.")
    aj_in, out_aj = new.get("ajustes", {}), {}
    for key, (lo, hi) in LIMITS.items():
        val = aj_in.get(key, DEFAULTS[key])
        try:
            val = float(val)
        except (TypeError, ValueError):
            raise ValueError(f"«{key}» debe ser un número.")
        if not lo <= val <= hi:
            raise ValueError(f"«{key}» debe estar entre {lo} y {hi}.")
        out_aj[key] = int(val) if val.is_integer() else val
    machines = {}
    for name, conf in (new.get("maquinas") or {}).items():
        if not isinstance(name, str) or not name.strip() or name.startswith("_"):
            raise ValueError("Hay una máquina sin nombre válido.")
        conf = conf or {}
        item = {}
        if str(conf.get("grupo") or "").strip():
            item["grupo"] = str(conf["grupo"]).strip()[:40]
        tags = [str(t).strip()[:30] for t in conf.get("etiquetas") or [] if str(t).strip()]
        if tags:
            item["etiquetas"] = tags[:10]
        svcs = []
        for sv in conf.get("servicios") or []:
            nombre = str(sv.get("nombre") or "").strip()[:40]
            try:
                puerto = int(sv.get("puerto"))
            except (TypeError, ValueError):
                raise ValueError(f"{name}: el puerto de «{nombre or '?'}» no es un número.")
            if not nombre:
                raise ValueError(f"{name}: hay un servicio sin nombre.")
            if not 0 < puerto < 65536:
                raise ValueError(f"{name}: el puerto de «{nombre}» debe estar entre 1 y 65535.")
            tipo = str(sv.get("tipo") or "tcp").lower()
            if tipo not in ("tcp", "http", "https"):
                raise ValueError(f"{name}: el tipo de «{nombre}» debe ser tcp, http o https.")
            entry = {"nombre": nombre, "puerto": puerto, "tipo": tipo}
            if tipo != "tcp":
                ruta = str(sv.get("ruta") or "/").strip()
                if not ruta.startswith("/") or any(c in ruta for c in " \r\n\t"):
                    raise ValueError(f"{name}: la ruta de «{nombre}» debe empezar por / y no tener espacios.")
                entry["ruta"] = ruta[:200]
            svcs.append(entry)
        if svcs:
            item["servicios"] = svcs[:20]
        machines[name.strip()] = item
    return {"ajustes": out_aj, "maquinas": machines}


def save_config(new):
    clean = validate_config(new)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            old_text = f.read()
        old = json.loads(old_text)
    except FileNotFoundError:
        old_text, old = None, {}
    except json.JSONDecodeError:
        raise ValueError("El servicios.json actual no es JSON válido; corrígelo a mano antes de guardar desde el panel "
                         "(no se sobrescribe para no perder lo que tenga).")
    # Conserva los textos de ayuda del archivo original.
    out = {k: v for k, v in old.items() if k.startswith("_")}
    out["ajustes"] = {**{k: v for k, v in old.get("ajustes", {}).items() if k.startswith("_")}, **clean["ajustes"]}
    out["maquinas"] = clean["maquinas"]
    backup = None
    if old_text is not None:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        backup = os.path.join(BACKUP_DIR, "servicios-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".json")
        with open(backup, "x", encoding="utf-8") as f:
            f.write(old_text)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, CONFIG_PATH)   # escritura atómica: o queda el archivo nuevo completo o el anterior
    with _lock:
        _cache["t"] = 0            # la próxima lectura usa la configuración nueva
    return {"backup": rel(backup) if backup else None, "file": rel(CONFIG_PATH)}


def recorder_loop():
    """Registra estado y muestras aunque el panel esté cerrado (mientras el servidor siga abierto)."""
    last_sample = last_prune = 0
    while True:
        cfg, _ = load_config()
        aj = cfg["ajustes"]
        try:
            estado(force=True)
        except Exception:
            pass
        STORE.heartbeat()
        if REALTIME and time.time() - last_sample >= 60:
            try:
                REALTIME.sample()          # referencia para medir el siguiente intervalo
                time.sleep(1)
                rt = REALTIME.sample()
                STORE.add_samples(rt, (_cache["data"] or {}).get("vms", []))
                last_sample = time.time()
            except Exception:
                pass
        if time.time() - last_prune > 3600:
            STORE.prune(float(aj["diasRetencion"]))
            last_prune = time.time()
        time.sleep(max(10, float(aj["intervaloRegistroSegundos"])))


_cache = {"t": 0, "data": None}
_lock = threading.Lock()


def assets_version():
    """Versión (parámetro ?v=) que index.html pide para sus archivos. Si la página abierta en el navegador
    cargó otra, el panel avisa de que está viendo una interfaz antigua."""
    try:
        with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
            m = re.search(r"js/app\.js\?v=(\d+)", f.read())
        return m.group(1) if m else None
    except OSError:
        return None


def estado(force=False):
    with _lock:
        if not force and _cache["data"] and time.time() - _cache["t"] < CACHE_SECONDS:
            return _cache["data"]
        if not VBOX:
            raise RuntimeError("No se encontró VBoxManage. Define NEXO_VBOXMANAGE con su ruta.")
        cfg, cfg_error = load_config()
        host, vms = read_host(), read_vms()
        host_conf = cfg["maquinas"].get("host", {})
        host["group"], host["tags"] = host_conf.get("grupo"), host_conf.get("etiquetas", [])
        check_services(vms, cfg)
        data = {
            "source": "virtualbox",
            "vboxVersion": vbox("--version").strip(),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "localIps": sorted(local_ipv4s()),
            "host": host,
            "vms": vms,
            "alerts": health_alerts(host, vms, cfg, cfg_error),
            "ajustes": cfg["ajustes"],
            "assets": {"version": assets_version()},
        }
        STORE.record(data)
        data["events"] = STORE.events(60)
        data["history"] = STORE.summary()
        _cache.update(t=time.time(), data=data)
        return data


import control  # noqa: E402  (acciones que cambian el laboratorio; ver control.py)

control.configure(vbox, VBOX, estado, DATA_DIR)


class Handler(http.server.SimpleHTTPRequestHandler):
    MAX_BODY = 256 * 1024
    PRIVATE = ("/data/", "/datos/", "/ops/", "/tests/")
    PRIVATE_FILES = (".db", ".py", ".ps1", ".jsonl", "nexo.local.json", "control.json")

    def _token_ok(self):
        """Rutas de Control: además del Host, exigen el token que solo conoce la página servida aquí
        (una web externa no puede leerlo ni enviar esta cabecera sin permiso CORS) y, si el navegador
        lo informa, que la petición venga del mismo origen."""
        site = self.headers.get("Sec-Fetch-Site")
        if site and site not in ("same-origin", "none"):
            return False
        import hmac
        return hmac.compare_digest(self.headers.get("X-Nexo-Token") or "", control.TOKEN)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _host_ok(self):
        return self.headers.get("Host", "") in (f"127.0.0.1:{PORT}", f"localhost:{PORT}")

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._host_ok():
            self.send_error(403, "Host no permitido")
            return
        route = self.path.split("?")[0]
        if route.startswith(self.PRIVATE) or route.endswith(self.PRIVATE_FILES):
            self.send_error(404)
            return
        if not route.startswith("/api/"):
            super().do_GET()
            return
        from urllib.parse import parse_qs, urlparse
        q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
        try:
            if route == "/api/estado":
                payload = estado(force=bool(q.get("forzar")))
            elif route == "/api/metricas":
                if not REALTIME:
                    raise RuntimeError("Las métricas en tiempo real solo están disponibles en Windows.")
                payload = REALTIME.sample()
            elif route == "/api/historial":
                since = None
                if q.get("horas"):
                    since = datetime.fromtimestamp(time.time() - float(q["horas"]) * 3600, timezone.utc).isoformat()
                tipo = q.get("tipo") if q.get("tipo") in ("estado", "servicio", "alerta", "alerta_resuelta", "sin_datos") else None
                payload = {"events": STORE.events(min(int(q.get("limite", 200)), 1000), q.get("maquina"), tipo, since), **STORE.summary()}
            elif route == "/api/tendencias":
                payload = STORE.samples(q.get("maquina", "host"), min(float(q.get("horas", 24)), 24 * 30))
            elif route == "/api/obsidian":
                payload = obsidian_status()
            elif route == "/api/control":
                payload = control.overview()
            elif route.startswith(("/api/control/", "/api/ad/", "/api/asistente/")):
                if not self._token_ok():
                    self._json(403, {"error": "Petición no autorizada (falta el token del panel)."})
                    return
                try:
                    if route == "/api/control/trabajo":
                        payload = control.job(q.get("id")) or {"error": "No existe ese trabajo."}
                    elif route == "/api/control/registro":
                        payload = {"items": control.audit_tail(80), "file": rel(control.audit_path())}
                    elif route == "/api/ad/buscar":
                        payload = {"items": control.ad_search(q.get("tipo", "users"), q.get("q", ""))}
                    elif route == "/api/ad/cuenta":
                        payload = {"item": control.ad_get(q.get("cuenta", ""))}
                    elif route == "/api/asistente/paquete":
                        payload = control.assistant_packet(q.get("alerta", ""))
                    else:
                        self._json(404, {"error": "Ruta no encontrada"})
                        return
                except control.ActionError as exc:
                    self._json(409, {"error": str(exc)})
                    return
            elif route == "/api/config":
                cfg, err = load_config()
                payload = {"config": {"ajustes": {k: v for k, v in cfg["ajustes"].items() if not k.startswith("_")},
                                      "maquinas": cfg["maquinas"]},
                           "limits": LIMITS, "error": err, "file": rel(CONFIG_PATH)}
            else:
                self._json(404, {"error": "Ruta no encontrada"})
                return
            self._json(200, payload)
        except Exception as exc:  # se informa al panel, que vuelve al modo demo
            self._json(503, {"error": str(exc)})

    def do_POST(self):
        """Peticiones que cambian algo: notas en la bóveda de Obsidian, servicios.json (con copia previa)
        y las acciones de Control (/api/control/, /api/ad/, /api/asistente/), que se delegan en
        _control_post y control.py (catálogo fijo, ticket de un solo uso, token y registro de auditoría).
        Las lecturas de VirtualBox de este archivo nunca escriben en él; solo Control puede encender o apagar VM."""
        if not self._host_ok():
            self._json(403, {"error": "Host no permitido"})
            return
        # Solo el propio panel puede escribir: mismo origen y JSON (otra web no puede enviar esto sin permiso CORS).
        if self.headers.get("Origin") not in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
            self._json(403, {"error": "Origen no permitido"})
            return
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            self._json(415, {"error": "Se esperaba JSON"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if not 0 < length <= self.MAX_BODY:
            self._json(413, {"error": "Petición vacía o demasiado grande"})
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            route = self.path.split("?")[0]
            if route.startswith(("/api/control/", "/api/ad/", "/api/asistente/")):
                self._control_post(route, body)
                return
            if route == "/api/config":
                self._json(200, save_config(body.get("config")))
                return
            st = obsidian_status()
            if route == "/api/obsidian/plan":
                if not st["available"]:
                    raise ValueError(st["message"])
                path = plan_note(st, body.get("maquina"), body.get("fecha"), body.get("titulo") or "Nota")
            elif route == "/api/obsidian/guardar":
                path = save_note(body.get("maquina"), body.get("fecha"), body.get("titulo") or "Nota", str(body.get("contenido") or ""))
            else:
                self._json(404, {"error": "Ruta no encontrada"})
                return
            self._json(200, {"path": path, "relative": os.path.relpath(path, st["vault"])})
        except (ValueError, json.JSONDecodeError) as exc:
            self._json(409, {"error": str(exc)})
        except OSError as exc:
            self._json(500, {"error": f"No se pudo escribir en la bóveda: {exc}"})

    def _control_post(self, route, body):
        if not self._token_ok():
            self._json(403, {"error": "Petición no autorizada (falta el token del panel)."})
            return
        if not isinstance(body, dict):
            self._json(400, {"error": "Se esperaba un objeto JSON."})
            return
        try:
            if route == "/api/control/preparar":
                origin = "asistente" if body.get("origen") == "asistente" else "panel"
                payload = control.plan(body.get("action_id"), body.get("objetivo"), body.get("parametros"),
                                       origin, body.get("motivo"))
            elif route == "/api/control/ejecutar":
                payload = control.execute(body.get("ticket"), body.get("confirmacion"))
            elif route == "/api/ad/probar":
                payload = control._ad_call("probe")
            elif route == "/api/asistente/validar":
                payload = control.parse_proposal(body.get("respuesta"))
            else:
                self._json(404, {"error": "Ruta no encontrada"})
                return
            self._json(200, payload)
        except control.ActionError as exc:
            self._json(409, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - nunca se devuelven datos de la petición (pueden ser sensibles)
            self._json(500, {"error": f"Error interno ({type(exc).__name__})."})

    def log_message(self, fmt, *args):  # consola limpia: solo errores
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as srv:
        print(f"Nexo Lab en http://127.0.0.1:{PORT}/index.html  (Ctrl+C para detener)")
        print("Control:", "SIMULACIÓN (no se ejecuta nada)" if control.SIMULATE else
              "acciones habilitadas solo tras confirmación en el panel; registro en " + rel(control.audit_path()))
        print("VirtualBox:", VBOX or "NO ENCONTRADO")
        print("Historial:", DB_PATH if not STORE.error else STORE.error)
        print("Obsidian:", obsidian_status()["message"])
        threading.Thread(target=recorder_loop, daemon=True).start()
        srv.serve_forever()
