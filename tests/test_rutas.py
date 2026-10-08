"""Pruebas de las rutas HTTP de Control: token, origen, host, tipo de contenido y tickets.
Levanta el servidor real en un puerto libre, con VirtualBox y los programas externos falsos.
Ejecutar desde la carpeta del proyecto:  python -m unittest tests.test_rutas -v
"""
import functools
import http.client
import http.server
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import control  # noqa: E402
import server  # noqa: E402
from test_control import CFG, STATES, fake_vbox  # noqa: E402


class Rutas(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cfg_path = os.path.join(cls.tmp.name, "control.json")
        with open(cls.cfg_path, "w", encoding="utf-8") as f:
            json.dump(CFG, f)
        estado = lambda force=False: {"vms": [], "alerts": []}  # noqa: E731
        control.configure(fake_vbox, "VBoxManage.exe", estado, cls.tmp.name)
        cls.patches = [mock.patch.object(control, "CONTROL_PATH", cls.cfg_path),
                       mock.patch.object(control, "credential_info", lambda t: {"exists": True, "user": "LAB\\nexo"}),
                       mock.patch.object(control, "run", side_effect=AssertionError("no debe ejecutarse ningún programa"))]
        for p in cls.patches:
            p.start()
        handler = functools.partial(server.Handler, directory=server.ROOT)
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.httpd.server_address[1]
        cls.port_patch = mock.patch.object(server, "PORT", cls.port)
        cls.port_patch.start()
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.port_patch.stop()
        for p in cls.patches:
            p.stop()
        cls.tmp.cleanup()

    def setUp(self):
        control._tickets.clear()

    def request(self, method, path, body=None, headers=None, raw=None, length=None):
        h = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}",
             "X-Nexo-Token": control.TOKEN}
        h.update(headers or {})
        h = {k: v for k, v in h.items() if v is not None}
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest(method, path, skip_host="Host" in h)
            for k, v in h.items():
                conn.putheader(k, v)
            conn.putheader("Content-Length", str(len(data) if length is None else length))
            conn.endheaders(data)
            r = conn.getresponse()
            payload = r.read()
            try:
                return r.status, json.loads(payload)
            except ValueError:
                return r.status, payload
        finally:
            conn.close()

    def preparar(self, **kw):
        return self.request("POST", "/api/control/preparar",
                            {"action_id": "vm.pause", "objetivo": {"vm": "DC01"}, "parametros": {}}, **kw)


class Autenticacion(Rutas):
    def test_sin_token_se_rechaza(self):
        self.assertEqual(self.preparar(headers={"X-Nexo-Token": None})[0], 403)

    def test_token_incorrecto_se_rechaza(self):
        self.assertEqual(self.preparar(headers={"X-Nexo-Token": "falso"})[0], 403)

    def test_peticion_de_otro_sitio_se_rechaza_aunque_lleve_token(self):
        self.assertEqual(self.preparar(headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.preparar(headers={"Sec-Fetch-Site": "same-site"})[0], 403)

    def test_mismo_origen_se_acepta(self):
        self.assertEqual(self.preparar(headers={"Sec-Fetch-Site": "same-origin"})[0], 200)

    def test_origen_de_otra_web_se_rechaza(self):
        self.assertEqual(self.preparar(headers={"Origin": "https://malo.example"})[0], 403)
        self.assertEqual(self.preparar(headers={"Origin": None})[0], 403)

    def test_host_distinto_se_rechaza(self):
        self.assertEqual(self.preparar(headers={"Host": "malo.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/control", headers={"Host": "malo.example"})[0], 403)

    def test_no_json_se_rechaza(self):
        self.assertEqual(self.preparar(headers={"Content-Type": "text/plain"})[0], 415)

    def test_cuerpo_demasiado_grande_o_vacio(self):
        self.assertEqual(self.request("POST", "/api/control/preparar", raw=b"")[0], 413)
        # se declara un cuerpo enorme sin enviarlo: el servidor debe rechazarlo sin leerlo
        self.assertEqual(self.request("POST", "/api/control/preparar", raw=b"x", length=server.Handler.MAX_BODY + 1)[0], 413)

    def test_cuerpo_que_no_es_objeto(self):
        self.assertEqual(self.request("POST", "/api/control/preparar", body=[1, 2])[0], 400)

    def test_rutas_sensibles_tambien_exigen_token(self):
        for ruta in ("/api/control/ejecutar", "/api/ad/probar", "/api/asistente/validar"):
            self.assertEqual(self.request("POST", ruta, {}, headers={"X-Nexo-Token": None})[0], 403, ruta)

    def test_ruta_desconocida(self):
        self.assertEqual(self.request("POST", "/api/control/otra", {})[0], 404)


class Tickets(Rutas):
    def test_accion_fuera_del_catalogo(self):
        code, out = self.request("POST", "/api/control/preparar",
                                 {"action_id": "shell.run", "objetivo": {"vm": "DC01"}, "parametros": {"cmd": "whoami"}})
        self.assertEqual(code, 409)
        self.assertIn("error", out)

    def test_ticket_inventado(self):
        code, _ = self.request("POST", "/api/control/ejecutar", {"ticket": "inventado"})
        self.assertEqual(code, 409)

    def test_ejecutar_sin_ticket(self):
        self.assertEqual(self.request("POST", "/api/control/ejecutar", {})[0], 409)

    def test_ticket_de_un_solo_uso(self):
        code, plan = self.preparar()
        self.assertEqual(code, 200)
        self.assertEqual(self.request("POST", "/api/control/ejecutar", {"ticket": plan["ticket"]})[0], 200)
        code, out = self.request("POST", "/api/control/ejecutar", {"ticket": plan["ticket"]})
        self.assertEqual(code, 409)
        self.assertIn("ya se usó", out["error"])

    def test_ticket_caducado(self):
        _, plan = self.preparar()
        control._tickets[plan["ticket"]]["exp"] = 0
        code, out = self.request("POST", "/api/control/ejecutar", {"ticket": plan["ticket"]})
        self.assertEqual(code, 409)
        self.assertIn("caducó", out["error"])

    def test_el_estado_se_revalida_al_ejecutar(self):
        _, plan = self.preparar()
        with mock.patch.dict(STATES, {"1c09a879-9c6e-4dd6-9c2b-ad2dea21a0fa": "poweroff"}):
            code, out = self.request("POST", "/api/control/ejecutar", {"ticket": plan["ticket"]})
        self.assertEqual(code, 409)
        self.assertIn("encendida", out["error"])


class ArchivosPrivados(Rutas):
    def test_codigo_y_datos_no_se_sirven(self):
        for ruta in ("/server.py", "/control.py", "/control.json", "/nexo.local.json", "/data/nexo-historial.db",
                     "/data/acciones-auditoria.jsonl", "/ops/ad.ps1", "/tests/test_rutas.py"):
            self.assertEqual(self.request("GET", ruta)[0], 404, ruta)

    def test_la_interfaz_si_se_sirve(self):
        self.assertEqual(self.request("GET", "/index.html")[0], 200)


if __name__ == "__main__":
    unittest.main()
