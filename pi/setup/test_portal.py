"""The setup hotspot's page (portal.py) and the editor calls the setup makes (editor.py): forms read as a network takes
them, names escaped, the pairing code shown before the box leaves the hotspot, the box's own Wi-Fi with its password
shown before the box makes it, the hotspot up at once and back after a failed join, and a request that goes when setup
does."""

import io
import json
import re
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import editor
import own_network
import portal
from own_network import Credentials
from portal import Network
from test_own_network import FakeNetworkManager

NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))
OWN = Credentials("Zirbel <3F2A>", "abcd-efgh-jkmn")


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

    def test_the_boxs_own_wifi_is_offered_beside_the_networks_with_its_password_before_it_is_made(self):
        self.assertNotIn("action=/own", portal.choose_page("Zirbel-3456", []).decode())
        offer = portal.choose_page("Zirbel-3456", [], own=True).decode()
        self.assertIn("or keep the box on its own Wi-Fi", offer)
        self.assertIn("Make the box's own Wi-Fi", offer)
        pairing = portal.Pairing("ABCD-EFGH", "http://zirbel.local/pair?code=ABCD-EFGH")
        ready = portal.own_page("Zirbel-3456", OWN, pairing, token="tok").decode()
        self.assertIn("Zirbel &lt;3F2A&gt;", ready)
        self.assertNotIn("<3F2A>", ready)
        self.assertIn("<p class=code>abcd-efgh-jkmn</p>", ready)
        # On its own Wi-Fi the box is at its own address, which every device opens, and at its .local name.
        self.assertIn("href='http://10.42.0.1/pair?code=ABCD-EFGH'", ready)
        self.assertIn("<b>http://zirbel.local/pair</b>", ready)
        self.assertIn("ABCD-EFGH", ready)
        self.assertIn("name=token value=tok", ready)
        self.assertIn("Make Zirbel &lt;3F2A&gt; now", ready)
        claim = portal.own_page("Zirbel-3456", OWN, portal.Pairing("ABCD-EFGH", "http://zirbel.local/pair", claim=True))
        self.assertIn("href='http://10.42.0.1/pair'", claim.decode())
        self.assertIn("Claim this box", claim.decode())
        self.assertNotIn("action=/go", claim.decode())
        self.assertIn("http://10.42.0.1", portal.own_page("Zirbel-3456", OWN, None).decode())

    def test_a_link_moves_to_the_boxs_own_address(self):
        self.assertEqual(portal.at("http://zirbel.local/pair?code=ABCD-EFGH", "10.42.0.1"),
                         "http://10.42.0.1/pair?code=ABCD-EFGH")
        self.assertEqual(portal.at("http://zirbel.local:8080/pair", "fd00::5"), "http://[fd00::5]:8080/pair")


class Server(unittest.TestCase):
    def test_the_page_stays_until_join_now_and_the_join_starts_after_the_answer_went_out(self):
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
                ready = answer.read().decode()
            # The page with what comes next stays: the box joins only on Join now, with that page's own token.
            self.assertIn("ABCD-EFGH", ready)
            self.assertIn("Join Home now", ready)
            token = re.search(r"name=token value=([A-Za-z0-9_-]+)", ready).group(1)
            time.sleep(2)
            self.assertFalse(chosen, "nothing is joined before Join now")
            with self.assertRaises(urllib.error.HTTPError) as wrong:
                NO_PROXY.open(urllib.request.Request(f"http://127.0.0.1:{port}/go", data=b"token=nope"))
            self.assertEqual(wrong.exception.code, 400)
            wrong.exception.close()
            started = time.monotonic()
            with NO_PROXY.open(urllib.request.Request(f"http://127.0.0.1:{port}/go", data=f"token={token}".encode())) as answer:
                self.assertIn("is joining Home", answer.read().decode())
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

    def test_the_box_makes_its_own_wifi_only_on_make_it_now_and_after_the_answer_went_out(self):
        made = threading.Event()
        joined = []
        offered = portal.Portal("Zirbel-3456", lambda: [Network(b"Home", -40, "WPA2")],
                                lambda: portal.Pairing("ABCD-EFGH", "http://zirbel.local/pair?code=ABCD-EFGH"),
                                joined.append, own=OWN, make=made.set)
        bare = portal.Portal("Zirbel-3456", lambda: [], lambda: None, joined.append)
        offered.start("127.0.0.1", 0)
        bare.start("127.0.0.1", 0)
        base = f"http://127.0.0.1:{offered._server.server_address[1]}"
        try:
            with NO_PROXY.open(base + "/") as answer:
                self.assertIn("action=/own", answer.read().decode())
            with NO_PROXY.open(urllib.request.Request(base + "/own", data=b"own=1")) as answer:
                ready = answer.read().decode()
            self.assertIn("abcd-efgh-jkmn", ready)
            token = re.search(r"name=token value=([A-Za-z0-9_-]+)", ready).group(1)
            self.assertFalse(made.is_set(), "nothing is made before Make it now")
            started = time.monotonic()
            with NO_PROXY.open(urllib.request.Request(base + "/go", data=f"token={token}".encode())) as answer:
                making = answer.read().decode()
            self.assertIn("is making its own Wi-Fi", making)
            self.assertIn("abcd-efgh-jkmn", making)
            self.assertFalse(made.is_set(), "the network waits until the page is out")
            self.assertTrue(made.wait(5))
            self.assertGreater(time.monotonic() - started, 1)
            self.assertEqual(joined, [])
            # A box that can't make its own Wi-Fi doesn't offer it, nor take its form.
            other = f"http://127.0.0.1:{bare._server.server_address[1]}"
            with NO_PROXY.open(other + "/") as answer:
                self.assertNotIn("action=/own", answer.read().decode())
            with self.assertRaises(urllib.error.HTTPError) as refused:
                NO_PROXY.open(urllib.request.Request(other + "/own", data=b"own=1"))
            with refused.exception as error:
                self.assertEqual(error.code, 400)
        finally:
            offered.stop()
            bare.stop()


class Hotspot(unittest.TestCase):
    def test_the_hotspot_comes_up_at_once_and_again_after_a_failed_join_never_while_the_radio_is_busy(self):
        import zirbel_setup

        setup = object.__new__(zirbel_setup.Setup)
        started, asked = [], []
        setup.nm = types.SimpleNamespace(hotspot_up=lambda ssid: asked.append(ssid) or "active")
        setup.portal = types.SimpleNamespace(start=started.append, error="")
        setup.busy, setup.hotspot, setup.hotspot_ssid = True, None, "Zirbel setup 3456"
        with mock.patch.dict("sys.modules", {"network": types.SimpleNamespace(HOTSPOT_ADDRESS="10.42.0.1")}), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as said:
            setup._hotspot_up()
            self.assertEqual(asked, [], "the radio is joining a network")
            setup.busy = False
            setup._hotspot_up()
            self.assertEqual((asked, started, setup.hotspot), (["Zirbel setup 3456"], ["10.42.0.1"], "active"))
            setup._hotspot_up()
            self.assertEqual(len(asked), 1, "a hotspot that is up stays as it is")
            setup.busy, setup.hotspot = True, None  # the join took the hotspot down, and failed
            setup._failed(b"Home", "")
            self.assertEqual(len(asked), 2)
            self.assertFalse(setup.busy)
        self.assertIn("couldn't join Home", setup.portal.error)
        self.assertIn("The setup hotspot Zirbel setup 3456 is up.", said.getvalue())


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
                                          "setupRequested": test.requested, "ownNetwork": test.own}})

            def do_PUT(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                test.calls.append(("PUT", self.path, payload))
                if test.refuse:
                    self._reply({"error": "This box can't make its own Wi-Fi: it has no Wi-Fi setup."}, 409)
                    return
                test.own = payload["ownNetwork"]
                editor.network_wake().write_text("")  # as the editor wakes the service for a change
                self._reply({"harnesses": True, "externalMcp": False, "onboarded": False, "setupRequested": False,
                             "ownNetwork": test.own})

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
        self.own = False
        self.refuse = False
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

    def test_the_boxs_own_wifi_is_the_editors_setting_which_setup_changes_and_whose_wake_it_clears(self):
        self.assertEqual(editor.network_wake(), editor.REQUEST.with_name("network"))
        self.assertIs(editor.own_network(), False)
        self.assertTrue(editor.set_own_network(True))
        self.assertEqual(self.calls[-1], ("PUT", "/api/box/settings", {"ownNetwork": True}))
        self.assertIs(editor.own_network(), True)
        self.assertTrue(editor.network_wake().exists())
        editor.clear_network_wake()
        self.assertFalse(editor.network_wake().exists())
        editor.clear_network_wake()  # gone already
        # An editor that refuses is not asked again.
        self.refuse = True
        before = len(self.calls)
        self.assertFalse(editor.set_own_network(True, attempts=3))
        self.assertEqual(len(self.calls), before + 1)

    def test_as_the_service_starts_its_wake_goes_first_and_the_wifi_follows_the_setting(self):
        import zirbel_setup

        nm = FakeNetworkManager()
        editor.network_wake().write_text("")
        self.own = True
        with mock.patch("sys.stdout", new_callable=io.StringIO) as said:
            self.assertEqual(zirbel_setup.follow_setting(nm, OWN), own_network.UP)
        self.assertFalse(editor.network_wake().exists())
        self.assertEqual(nm.calls, [("up", OWN.name, OWN.password)])
        self.assertIn("The box's own Wi-Fi is up.", said.getvalue())
        self.own = False
        with mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(zirbel_setup.follow_setting(nm, OWN), own_network.DOWN)
        editor.EDITOR = "http://127.0.0.1:9"  # an editor that doesn't answer changes nothing
        self.assertEqual(zirbel_setup.follow_setting(FakeNetworkManager(exists=True, active=True), OWN), own_network.KEEP)

    def test_made_from_the_setup_page_the_setting_comes_first_and_goes_back_if_the_network_does_not_start(self):
        import zirbel_setup

        def setup_with(nm):
            # The service as its setup page's worker sees it, its main loop a list of what was handed to it.
            setup = object.__new__(zirbel_setup.Setup)
            setup.own, setup.scheduled = OWN, []
            setup.GLib = types.SimpleNamespace(idle_add=lambda work, *args: setup.scheduled.append((work.__name__, args)))
            setup._hotspot_down = lambda _nm: nm.calls.append(("hotspot down",))
            return setup

        nm = FakeNetworkManager()
        setup = setup_with(nm)
        setup._make_own(nm)
        self.assertEqual(self.calls[-1], ("PUT", "/api/box/settings", {"ownNetwork": True}))
        self.assertFalse(editor.network_wake().exists(), "the service's own change wakes nothing more")
        self.assertEqual(nm.calls, [("hotspot down",), ("up", OWN.name, OWN.password)])
        self.assertEqual(setup.scheduled, [("_made_own", ())])

        failing = FakeNetworkManager(starts=False)
        setup = setup_with(failing)
        setup._make_own(failing)
        self.assertEqual(self.calls[-1], ("PUT", "/api/box/settings", {"ownNetwork": False}))
        self.assertIs(self.own, False)
        self.assertEqual(failing.calls[-1], ("down",))
        self.assertEqual(setup.scheduled[0][0], "_failed")
        self.assertIn("couldn't make its own Wi-Fi", setup.scheduled[0][1][1])

        # An editor that won't take the setting: the radio is left as it is.
        self.refuse = True
        untouched = FakeNetworkManager()
        setup = setup_with(untouched)
        setup._make_own(untouched)
        self.assertEqual(untouched.calls, [])
        self.assertIn("didn't answer", setup.scheduled[0][1][1])

    def test_no_editor_means_no_link_and_no_request(self):
        editor.EDITOR = "http://127.0.0.1:9"
        self.assertIsNone(editor.pairing(attempts=1))
        self.assertFalse(editor.requested())
        self.assertIsNone(editor.own_network())
        self.assertFalse(editor.set_own_network(False, attempts=1))
        editor.clear_request()


if __name__ == "__main__":
    unittest.main()
