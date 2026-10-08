"""Pruebas de la lógica de servicios y avisos (sin VirtualBox ni red). Ejecutar: python -m unittest tests.test_server -v"""
import os
import socket
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import server  # noqa: E402

AJ = {"tiempoLimiteSegundos": 1.5, "avisoMemoriaEquipo": 90, "minutosMemoriaAlta": 5, "avisoCpuEquipo": 90,
      "minutosCpuAlta": 5, "avisarInterrumpidaTrasDias": 2, "graciaArranqueSegundos": 120}
CFG = {"ajustes": AJ, "maquinas": {}}
HOST_OK = {"mem": 50, "cpu": 10}


def vm(name="vm1", state="running", age=3600, ips=(), ips_host=(), booting=False, services=()):
    since = (datetime.now(timezone.utc) - timedelta(seconds=age)).strftime("%Y-%m-%dT%H:%M:%S.000000000")
    return {"id": name, "name": name, "state": state, "since": since, "ips": list(ips),
            "ipsHost": [{"ip": i, "origin": "dhcp"} for i in ips_host], "booting": booting, "services": list(services)}


def svc(status, method="tcp", code=None):
    return {"name": "SSH", "port": 22, "status": status, "method": method, "ip": "192.168.56.5", "httpStatus": code,
            "reason": "x", "checkedAt": "2026-10-05T18:00:00+00:00"}


class Alertas(unittest.TestCase):
    def setUp(self):
        server._high_since.clear()

    def alerts(self, vms, host=HOST_OK, cfg_error=None):
        return server.health_alerts(host, vms, CFG, cfg_error)

    def test_interrumpida_poco_tiempo_no_avisa(self):
        self.assertEqual(self.alerts([vm(state="aborted", age=3600)]), [])

    def test_interrumpida_mucho_tiempo_avisa(self):
        a = self.alerts([vm(state="aborted", age=3 * 86400)])
        self.assertEqual([x["cat"] for x in a], ["vm"])

    def test_encendida_sin_ip_avisa(self):
        a = self.alerts([vm()])
        self.assertEqual([x["cat"] for x in a], ["noip"])

    def test_encendida_con_ip_de_anfitrion_no_avisa(self):
        self.assertEqual(self.alerts([vm(ips_host=("192.168.56.5",))]), [])

    def test_recien_arrancada_no_avisa(self):
        self.assertEqual(self.alerts([vm(age=30, booting=True, ips=("192.168.56.5",), services=[svc("down")])]), [])

    def test_servicio_caido_avisa_con_lo_comprobado(self):
        a = self.alerts([vm(ips=("192.168.56.5",), services=[svc("down")])])
        self.assertEqual([x["cat"] for x in a], ["noresponse"])
        self.assertIn("192.168.56.5:22", a[0]["check"])  # dice qué se comprobó
        self.assertTrue(a[0]["at"])  # y cuándo

    def test_servicio_http_5xx_se_clasifica_aparte(self):
        a = self.alerts([vm(ips=("192.168.56.5",), services=[svc("down", "http", 503)])])
        self.assertEqual([x["cat"] for x in a], ["http5xx"])

    def test_servicio_ok_o_sin_comprobar_no_avisa(self):
        for status in ("up", "unchecked"):
            self.assertEqual(self.alerts([vm(ips=("192.168.56.5",), services=[svc(status)])]), [])

    def test_vm_apagada_no_genera_avisos_de_servicio(self):
        self.assertEqual(self.alerts([vm(state="poweroff", services=[svc("unchecked")])]), [])

    def test_memoria_alta_solo_avisa_si_se_sostiene(self):
        host = {"mem": 93, "cpu": 10}
        self.assertEqual(self.alerts([], host), [])  # acaba de superar el umbral
        server._high_since["mem"] = datetime.now(timezone.utc) - timedelta(minutes=6)
        self.assertEqual([x["cat"] for x in self.alerts([], host)], ["resources"])

    def test_error_de_configuracion_avisa(self):
        self.assertEqual([x["cat"] for x in self.alerts([], cfg_error="JSON inválido")], ["config"])


class Red(unittest.TestCase):
    LOCAL = {"192.168.56.1"}

    def test_ips_alcanzables_descartan_nat_y_publicas(self):
        self.assertEqual(server.reachable_ips(vm(ips=("10.0.2.15", "192.168.56.113")), self.LOCAL), ["192.168.56.113"])
        self.assertEqual(server.reachable_ips(vm(ips=("10.0.2.15",)), self.LOCAL), [])
        self.assertEqual(server.reachable_ips(vm(ips=("8.8.8.8",)), self.LOCAL), [])  # nunca a IP fuera de las redes del equipo
        self.assertEqual(server.reachable_ips(vm(ips=("192.168.56.113",)), set()), [])

    def test_ips_alcanzables_incluyen_las_de_dhcp_sin_repetir(self):
        v = vm(ips=("192.168.56.113",), ips_host=("192.168.56.113", "192.168.56.114"))
        self.assertEqual(server.reachable_ips(v, self.LOCAL), ["192.168.56.113", "192.168.56.114"])

    def test_parse_since(self):
        d = server.parse_since("2026-10-05T23:47:28.417000000")
        self.assertEqual((d.hour, d.minute, d.tzinfo is not None), (23, 47, True))
        self.assertIsNone(server.parse_since(None))

    def test_servicios_de_vm_detenida_se_marcan_sin_comprobar_con_su_motivo(self):
        cfg = {"ajustes": AJ, "maquinas": {"vm1": {"servicios": [{"nombre": "SSH", "puerto": 22}]}}}
        for state, texto in (("paused", "en pausa"), ("saved", "estado guardado"), ("poweroff", "no está encendida")):
            v = vm(state=state)
            server.check_services([v], cfg)
            self.assertEqual(v["services"][0]["status"], "unchecked")
            self.assertIn(texto, v["services"][0]["reason"])
            self.assertEqual(server.health_alerts(HOST_OK, [v], cfg, None), [])  # pausar o guardar no genera alertas

    def test_origen_del_cambio_de_estado(self):
        with mock.patch.object(server.control, "accion_cercana", return_value={"accion": "vm.pause", "usuario": "usuario-prueba", "ts": "2026-10-07T00:50:09+00:00"}):
            self.assertIn("Pedido desde el panel: «Pausar la VM» por usuario-prueba a las 00:50:09 UTC", server.origin_note("DC01", "x", False))
        with mock.patch.object(server.control, "accion_cercana", return_value=None):
            self.assertIn("No hay ninguna acción registrada", server.origin_note("DC01", "x", False))
            self.assertEqual(server.origin_note("DC01", "x", True), "")  # tras un cierre no se afirma nada

    def test_puerto_cerrado_se_marca_caido(self):
        with socket.socket() as s:  # puerto local libre y sin servicio
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        status, _reason, _ms = server.tcp_check("127.0.0.1", port, 1.5)
        self.assertEqual(status, "down")

    def test_puerto_abierto_se_marca_activo(self):
        with socket.socket() as srv:
            srv.bind(("127.0.0.1", 0))
            srv.listen(1)
            status, _reason, ms = server.tcp_check("127.0.0.1", srv.getsockname()[1], 1.5)
        self.assertEqual(status, "up")
        self.assertIsNotNone(ms)

    def test_run_check_tcp_devuelve_cuatro_valores(self):
        with socket.socket() as srv:
            srv.bind(("127.0.0.1", 0))
            srv.listen(1)
            status, _reason, _ms, code = server.run_check({"method": "tcp", "port": srv.getsockname()[1]}, "127.0.0.1", 1.5)
        self.assertEqual((status, code), ("up", None))


if __name__ == "__main__":
    unittest.main()
