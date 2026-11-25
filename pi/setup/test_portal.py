"""The setup hotspot's page (portal.py) and the editor calls the setup makes (editor.py): forms read as a network takes
them, names escaped, the pairing code shown before the box leaves the hotspot, and a request that goes when setup does."""

import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import editor
import portal
from improv import Network

NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Forms(unittest.TestCase):
    def test_a_listed_network_comes_back_by_its_bytes_and_another_by_its_name(self):
        ssid = "Café 5G".encode("utf-8") + b"\xff"  # not even UTF-8: still the same network
        choice = portal.parse(f"network={ssid.hex()}&password=correct+horse".encode())
        self.assertEqual((choice.ssid, choice.password), (ssid, b"correct horse"))
        other = portal.parse("network=other&other=+Hidden+one+&password=".encode())
        self.assertEqual((other.ssid, other.password), (b"Hidden one", b""))

    def test_what_a_network_cannot_take_is_refused_with_why(self):
        cases = {
            "network=zz": "Choose a network from the list.",
            "network=other&other=": "Choose a network",
            "network=other&other=" + "x" * 33: "up to 32 bytes",
            "network=6e6574&password=short": "8 to 63 characters",
            "network=6e6574&password=" + "p" * 64: "8 to 63 characters",
        }
        for body, message in cases.items():
            with self.assertRaises(portal.FormError) as raised:
                portal.parse(body.encode())
            self.assertIn(message, str(raised.exception), body)
        self.assertEqual(portal.parse(("network=6e6574&password=" + "ab" * 32).encode()).password, b"ab" * 32)
        with self.assertRaises(portal.FormError):
            portal.parse(b"x" * (portal.FORM_BYTES + 1))

    def test_names_from_nearby_networks_are_escaped(self):
        page = portal.choose_page("Zirbel-3456", [Network(b"<script>alert(1)</script>", -50, "NO")],
                                  "<b>bad</b>").decode()
        self.assertNotIn("<script>", page)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", page)
        self.assertIn("&lt;b&gt;bad&lt;/b&gt;", page)
        self.assertIn("value=" + b"<script>alert(1)</script>".hex(), page)

    def test_joining_shows_the_pairing_code_and_link_first(self):
        page = portal.joining_page("Zirbel-3456", "Home <5G>",
                                   portal.Pairing("ABCD-EFGH", "http://zirbel.local/pair?code=ABCD-EFGH&x='y'")).decode()
        self.assertIn("ABCD-EFGH", page)
        self.assertIn("href='http://zirbel.local/pair?code=ABCD-EFGH&amp;x=&#x27;y&#x27;'", page)
        self.assertIn("Home &lt;5G&gt;", page)
        self.assertIn("http://zirbel/pair", page)
        self.assertIn("http://zirbel.local", portal.joining_page("Zirbel-3456", "Home", None).decode())

    def test_an_unclaimed_box_is_claimed_with_no_code_and_no_hurry(self):
        page = portal.joining_page("Zirbel-3456", "Home",
                                   portal.Pairing("ABCD-EFGH", "http://zirbel.local/pair", claim=True)).decode()
        self.assertIn("Claim this box", page)
        self.assertIn("href='http://zirbel.local/pair'", page)
        self.assertNotIn("ABCD-EFGH", page)
        self.assertNotIn("10 minutes", page)

    def test_a_link_moves_to_the_boxs_own_address(self):
        self.assertEqual(editor.at("http://zirbel.local/pair?code=ABCD-EFGH", "192.168.1.20"),
                         "http://192.168.1.20/pair?code=ABCD-EFGH")
        self.assertEqual(editor.at("http://zirbel.local:8080/pair", "fd00::5"), "http://[fd00::5]:8080/pair")
        self.assertEqual(editor.at("http://zirbel.local/pair", None), "http://zirbel.local/pair")


class Server(unittest.TestCase):
    def test_any_address_shows_the_page_and_a_join_starts_after_the_answer_went_out(self):
        joined = threading.Event()
        chosen = []
        server = portal.Portal(
            "Zirbel-3456",
            lambda: [Network(b"Home", -40, "WPA2")],
            lambda: portal.Pairing("ABCD-EFGH", "http://zirbel.local/pair?code=ABCD-EFGH"),
            lambda choice: (chosen.append(choice), joined.set()),
        )
        server.start("127.0.0.1", 0)
        port = server._server.server_address[1]
        try:
            with NO_PROXY.open(f"http://127.0.0.1:{port}/hotspot-detect.html") as answer:
                page = answer.read().decode()
            self.assertIn("Home", page)
            started = time.monotonic()
            request = urllib.request.Request(f"http://127.0.0.1:{port}/join",
                                             data=f"network={b'Home'.hex()}&password=password1".encode())
            with NO_PROXY.open(request) as answer:
                self.assertIn("ABCD-EFGH", answer.read().decode())
            self.assertFalse(chosen, "the join waits until the page is out")
            self.assertTrue(joined.wait(5))
            self.assertGreater(time.monotonic() - started, 1)
            self.assertEqual((chosen[0].ssid, chosen[0].password), (b"Home", b"password1"))
            with self.assertRaises(urllib.error.HTTPError) as refused:
                NO_PROXY.open(urllib.request.Request(f"http://127.0.0.1:{port}/join", data=b"network=zz"))
            with refused.exception as error:
                self.assertEqual(error.code, 400)
                self.assertIn("Choose a network from the list.", error.read().decode())
        finally:
            server.stop()


class Editor(unittest.TestCase):
    def setUp(self):
        self.calls = []
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, value, status=200):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            # As the box's editor answers on loopback.
            def do_GET(self):
                test.calls.append(("GET", self.path, None))
                self._reply({"box": True, "paired": False, "claimable": test.claimable,
                             "settings": {"harnesses": True, "externalMcp": False, "onboarded": False,
                                          "setupRequested": test.requested}})

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                test.calls.append(("POST", self.path, payload))
                if self.path == "/api/box/setup":
                    self._reply({"setupRequested": payload["requested"]})
                    return
                self._reply({"code": "ABCD-EFGH", "url": "http://zirbel.local/pair?code=ABCD-EFGH",
                             "expiresAt": "2026-01-01T00:00:00Z", "qr": "data:image/png;base64,"}, 201)

        self.requested = False
        self.claimable = True
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.saved = editor.EDITOR, editor.REQUEST
        self.folder = tempfile.TemporaryDirectory()
        editor.EDITOR = f"http://127.0.0.1:{self.server.server_address[1]}"
        editor.REQUEST = Path(self.folder.name) / "request"

    def tearDown(self):
        editor.EDITOR, editor.REQUEST = self.saved
        self.server.shutdown()
        self.server.server_close()
        self.folder.cleanup()

    def test_a_pairing_link_comes_from_the_editor(self):
        # While no device has paired, the link is the claim page, with no code.
        self.assertEqual(editor.pairing(), portal.Pairing("ABCD-EFGH", "http://zirbel.local/pair", claim=True))
        self.assertEqual(self.calls[0][:2], ("POST", "/api/pairing"))
        self.claimable = False
        self.assertEqual(editor.pairing(), portal.Pairing("ABCD-EFGH", "http://zirbel.local/pair?code=ABCD-EFGH"))

    def test_a_request_is_the_file_or_the_editors_setting_and_goes_with_setup(self):
        self.assertFalse(editor.requested())
        self.requested = True
        self.assertTrue(editor.requested())
        self.requested = False
        editor.REQUEST.write_text("")
        self.assertTrue(editor.requested())
        editor.clear_request()
        self.assertFalse(editor.REQUEST.exists())
        self.assertEqual(self.calls[-1], ("POST", "/api/box/setup", {"requested": False}))

    def test_no_editor_means_no_link_and_no_request(self):
        editor.EDITOR = "http://127.0.0.1:9"
        self.assertIsNone(editor.pairing(attempts=1))
        self.assertFalse(editor.requested())
        editor.clear_request()


if __name__ == "__main__":
    unittest.main()
