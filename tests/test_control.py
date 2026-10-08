"""Pruebas de la consola de Control sin tocar VirtualBox, Active Directory ni servicios reales.
Ejecutar desde la carpeta del proyecto:  python -m unittest tests.test_control -v
"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import control  # noqa: E402

DC = "1c09a879-9c6e-4dd6-9c2b-ad2dea21a0fa"
PC = "2c09a879-9c6e-4dd6-9c2b-ad2dea21a0fb"
OUT = "3c09a879-9c6e-4dd6-9c2b-ad2dea21a0fc"
STATES = {DC: "running", PC: "poweroff", OUT: "poweroff"}
CFG = {"maquinas": ["DC01", "PC01"],
       "activeDirectory": {"vm": "DC01", "servidor": None, "credencial": "NexoLab:AD", "ouPermitidas": ["OU=Lab,DC=lab,DC=local"]},
       "correcciones": {"DC01": {"metodo": "winrm", "credencial": "NexoLab:WinRM", "servicios": {"3389": "TermService"}}}}


def fake_vbox(*args):
    if args[:2] == ("list", "vms"):
        return f'"DC01" {{{DC}}}\n"PC01" {{{PC}}}\n"Ajena" {{{OUT}}}\n'
    if args[0] == "showvminfo":
        return f'VMState="{STATES[args[1]]}"\n'
    return ""


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = os.path.join(self.tmp.name, "control.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(CFG, f)
        estado = lambda force=False: {"vms": [{"id": DC, "name": "DC01", "state": "running", "checkedIp": "192.168.56.10", "services": []},  # noqa: E731
                                              {"id": PC, "name": "PC01", "state": "poweroff", "services": []}], "alerts": []}
        control.configure(fake_vbox, "VBoxManage.exe", estado, self.tmp.name)
        self.patches = [mock.patch.object(control, "CONTROL_PATH", path),
                        mock.patch.object(control, "credential_info", lambda t: {"exists": True, "user": "LAB\\nexo-helpdesk"}),
                        mock.patch.object(control, "run", side_effect=AssertionError("no debe ejecutarse ningún programa"))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()


class Origen(Base):
    def escribir(self, *entradas):
        os.makedirs(self.tmp.name, exist_ok=True)
        with open(control.audit_path(), "w", encoding="utf-8") as f:
            for e in entradas:
                f.write(json.dumps(e) + chr(10))

    def test_accion_cercana_solo_si_coincide_vm_hora_y_no_es_simulada(self):
        base = {"evento": "confirmada", "accion": "vm.pause", "objetivo": "DC01", "usuario": "usuario-prueba",
                "ts": "2026-10-07T00:50:00+00:00", "simulado": False}
        self.escribir(base, {**base, "objetivo": "PC01"}, {**base, "simulado": True, "ts": "2026-10-07T01:00:00+00:00"})
        self.assertEqual(control.accion_cercana("DC01", "2026-10-07T00:50:20+00:00")["usuario"], "usuario-prueba")
        self.assertIsNone(control.accion_cercana("DC01", "2026-10-07T00:56:00+00:00"))   # demasiado lejos
        self.assertIsNone(control.accion_cercana("Kali", "2026-10-07T00:50:20+00:00"))   # otra VM
        self.assertIsNone(control.accion_cercana("DC01", "2026-10-07T01:00:05+00:00"))   # la acción era simulada
        self.assertIsNone(control.accion_cercana("DC01", "no es una fecha"))


class Catalogo(Base):
    def test_accion_fuera_del_catalogo(self):
        with self.assertRaises(control.ActionError):
            control.plan("shell.run", {"vm": "DC01"}, {"cmd": "whoami"})

    def test_parametros_extra_rechazados(self):
        with self.assertRaisesRegex(control.ActionError, "no permitidos"):
            control.plan("vm.shutdown", {"vm": "DC01"}, {"force": True})

    def test_vm_fuera_del_laboratorio(self):
        with self.assertRaisesRegex(control.ActionError, "laboratorio"):
            control.plan("vm.start", {"vm": "Ajena"}, {})

    def test_accion_que_no_corresponde_al_estado(self):
        with self.assertRaisesRegex(control.ActionError, "Ya está encendida"):
            control.plan("vm.start", {"vm": "DC01"}, {})
        with self.assertRaisesRegex(control.ActionError, "encendida"):
            control.plan("vm.shutdown", {"vm": "PC01"}, {})

    def test_pausar_solo_vm_encendida_y_reanudar_solo_en_pausa(self):
        p = control.plan("vm.pause", {"vm": "DC01"}, {})
        self.assertEqual(p["operacion"], 'VBoxManage controlvm "DC01" pause')
        with self.assertRaisesRegex(control.ActionError, "encendida"):
            control.plan("vm.pause", {"vm": "PC01"}, {})
        with self.assertRaisesRegex(control.ActionError, "en pausa"):
            control.plan("vm.resume", {"vm": "DC01"}, {})
        with mock.patch.dict(STATES, {PC: "paused"}):
            r = control.plan("vm.resume", {"vm": "PC01"}, {})
            self.assertEqual(r["operacion"], 'VBoxManage controlvm "PC01" resume')
            with self.assertRaisesRegex(control.ActionError, "Ya está en pausa"):
                control.plan("vm.pause", {"vm": "PC01"}, {})
            with self.assertRaisesRegex(control.ActionError, "Reanudar"):
                control.plan("vm.start", {"vm": "PC01"}, {})

    def test_guardar_estado_solo_encendida_o_en_pausa(self):
        p = control.plan("vm.savestate", {"vm": "DC01"}, {})
        self.assertEqual(p["operacion"], 'VBoxManage controlvm "DC01" savestate')
        self.assertTrue(any("disco" in w for w in p["advertencias"]))
        with self.assertRaisesRegex(control.ActionError, "encendida o en pausa"):
            control.plan("vm.savestate", {"vm": "PC01"}, {})
        with mock.patch.dict(STATES, {PC: "saved"}):
            with self.assertRaisesRegex(control.ActionError, "Ya tiene"):
                control.plan("vm.savestate", {"vm": "PC01"}, {})

    def test_guardar_estado_comprueba_el_espacio_en_disco(self):
        with mock.patch.object(control, "savestate_space", return_value=(4096, 1000)):
            with self.assertRaisesRegex(control.ActionError, "no hay espacio suficiente"):
                control.plan("vm.savestate", {"vm": "DC01"}, {})
        with mock.patch.object(control, "savestate_space", return_value=(4096, 50000)):
            p = control.plan("vm.savestate", {"vm": "DC01"}, {})
            self.assertTrue(any("4096 MB" in w and "50000 MB" in w for w in p["advertencias"]))

    def test_encender_vm_interrumpida_con_estado_guardado(self):
        for st in ("aborted-saved", "aborted_saved"):
            self.assertIsNone(control.vm_rules(st)["vm.start"])

    def test_servicio_debe_estar_en_la_lista(self):
        for bad in ("NTDS", "TermService; shutdown /s", "TermService & net user"):
            with self.assertRaises(control.ActionError):
                control.plan("svc.restart", {"vm": "DC01"}, {"servicio": bad})

    def test_plan_no_ejecuta_y_da_ticket(self):
        p = control.plan("vm.start", {"vm": "PC01"}, {"modo": "headless"})
        self.assertEqual(p["operacion"], 'VBoxManage startvm "PC01" --type headless')
        self.assertTrue(p["ticket"])

    def test_ticket_de_un_solo_uso(self):
        with self.assertRaises(control.ActionError):
            control.execute("ticket-inventado")


class Asistente(Base):
    def test_propuesta_valida(self):
        p = control.parse_proposal('Texto previo {"action_id":"svc.restart","vm":"DC01","motivo":"x","parametros":{"servicio":"TermService"}}')
        self.assertEqual((p["action_id"], p["vmName"], p["parametros"]), ("svc.restart", "DC01", {"servicio": "TermService"}))

    def test_propuesta_con_comando_libre(self):
        with self.assertRaises(control.ActionError):
            control.parse_proposal('{"action_id":"run","vm":"DC01","parametros":{"cmd":"rm -rf /"}}')

    def test_asistente_no_puede_tocar_ad(self):
        with self.assertRaises(control.ActionError):
            control.parse_proposal('{"action_id":"ad.reset_password","vm":"DC01","parametros":{"cuenta":"Administrator"}}')


class ActiveDirectory(Base):
    def user(self, **kw):
        return {"kind": "user", "sam": "ana", "dn": "CN=Ana,OU=Lab,DC=lab,DC=local", "enabled": True, "locked": True,
                "privileged": False, "rid": 1105, **kw}

    def test_reglas_cuenta_normal(self):
        r = control.ad_rules(self.user())
        self.assertIsNone(r["ad.unlock"])
        self.assertIsNotNone(r["ad.enable"])          # ya habilitada
        self.assertIsNone(r["ad.reset_password"])

    def test_fuera_de_ou_permitida(self):
        r = control.ad_rules(self.user(dn="CN=Ana,CN=Users,DC=lab,DC=local"))
        self.assertTrue(all(r.values()))

    def test_privilegiada_limitada(self):
        r = control.ad_rules(self.user(privileged=True, privilegedBy=["Domain Admins"]))
        self.assertIsNone(r["ad.unlock"])
        self.assertIsNotNone(r["ad.disable"])
        self.assertIsNotNone(r["ad.reset_password"])

    def test_cuentas_integradas_bloqueadas(self):
        for rid in (500, 502):
            self.assertTrue(all(control.ad_rules(self.user(rid=rid)).values()))

    def test_contrasena_temporal(self):
        pw = {control.temp_password() for _ in range(50)}
        self.assertEqual(len(pw), 50)
        for p in pw:
            self.assertEqual(len(p), 16)
            self.assertTrue(any(c.isupper() for c in p) and any(c.islower() for c in p) and any(c.isdigit() for c in p))

    def test_auditoria_nunca_guarda_contrasenas(self):
        control.audit({"accion": "ad.reset_password", "objetivo": "ana", "password": "Secreta-123456"})
        with open(control.audit_path(), encoding="utf-8") as f:
            text = f.read()
        self.assertNotIn("Secreta-123456", text)
        self.assertIn("ad.reset_password", text)

    def test_busqueda_valida_texto(self):
        with self.assertRaises(control.ActionError):
            control.ad_search("users", "*)(objectClass=*")


if __name__ == "__main__":
    unittest.main()
