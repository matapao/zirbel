"""The setup hotspot's page, for a phone without Bluetooth setup: the networks the box sees, a password, and the pairing
code to open once the phone is back on that network.

A phone that joins the open "Zirbel setup" network finds this page by its captive-portal check: every name resolves to
the box, and every request to port 80 reaches this server, so any address shows the page. It is plain HTML with no
outside resources. Network names come from whoever is near, so every one is escaped; the form names a network by its
SSID's bytes in hex, so any SSID comes back exactly.
"""

from __future__ import annotations

import html
import secrets
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable
from urllib.parse import parse_qs

from improv import PASSWORD_BYTES, SSID_BYTES, Network

FORM_BYTES = 4096
PORT = 8081

STYLE = (
    "body{font:17px/1.4 system-ui,sans-serif;margin:0;padding:24px;background:#141717;color:#f2f2ef}"
    "main{max-width:28em;margin:auto}h1{font-size:1.4em}label{display:block;margin:.6em 0}"
    "input[type=password],input[type=text]{width:100%;box-sizing:border-box;padding:.6em;font:inherit;border-radius:6px;"
    "border:1px solid #556;background:#1f2424;color:inherit}button{font:inherit;padding:.7em 1.2em;border-radius:6px;"
    "border:0;background:#7bc8a4;color:#102018;margin-top:1em}.error{color:#ffb4a8}.code{font-size:1.6em;"
    "letter-spacing:.08em;font-weight:600}small{color:#b8bdb9}a{color:#9fd8bd}"
)


class FormError(ValueError):
    """A form the page can't take, with what to tell the person."""


@dataclass
class Choice:
    """The network the person chose and its password."""

    ssid: bytes
    password: bytes


@dataclass
class Pairing:
    """The link that pairs the person's device with the box's editor, once both are on the same network. While no device
    has paired with the box (claim), its page claims the box with one tap and no code, with no time limit; after that
    it pairs with the one-time code, for 10 minutes."""

    code: str
    url: str
    claim: bool = False


def parse(body: bytes) -> Choice:
    """The network and password from the page's form, checked as a Wi-Fi network takes them."""
    if len(body) > FORM_BYTES:
        raise FormError("That form is too long.")
    fields = parse_qs(body.decode("utf-8", errors="strict"), keep_blank_values=True, max_num_fields=8)
    chosen = fields.get("network", [""])[0]
    other = fields.get("other", [""])[0].strip()
    if chosen and chosen != "other":
        try:
            ssid = bytes.fromhex(chosen)
        except ValueError:
            raise FormError("Choose a network from the list.") from None
    else:
        ssid = other.encode("utf-8")
    if not 1 <= len(ssid) <= SSID_BYTES:
        raise FormError("Choose a network, or type a network name of up to 32 bytes.")
    password = fields.get("password", [""])[0].encode("utf-8")
    if password and not (8 <= len(password) <= PASSWORD_BYTES - 1 or _hex_key(password)):
        raise FormError("A Wi-Fi password has 8 to 63 characters.")
    return Choice(ssid=ssid, password=password)


def _hex_key(password: bytes) -> bool:
    return len(password) == PASSWORD_BYTES and all(chr(byte) in "0123456789abcdefABCDEF" for byte in password)


def _page(title: str, body: str) -> bytes:
    return (
        "<!doctype html><html lang=en><head><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        f"<title>{html.escape(title)}</title><style>{STYLE}</style></head><body><main>{body}</main></body></html>"
    ).encode("utf-8")


def choose_page(box: str, networks: list[Network], error: str = "") -> bytes:
    """The page to choose a network on, with the last attempt's error when there was one."""
    rows = []
    for index, network in enumerate(networks):
        lock = "" if network.auth == "NO" else " 🔒"
        rows.append(
            f"<label><input type=radio name=network value={network.ssid.hex()}{' checked' if index == 0 else ''}> "
            f"{html.escape(network.name)}{lock} <small>{network.rssi} dBm</small></label>"
        )
    rows.append(
        f"<label><input type=radio name=network value=other{' checked' if not networks else ''}> Another network"
        "<input type=text name=other autocomplete=off autocapitalize=off spellcheck=false"
        " aria-label='Network name'></label>"
    )
    failed = f"<p class=error role=alert>{html.escape(error)}</p>" if error else ""
    return _page(
        "Set up " + box,
        f"<h1>Set up {html.escape(box)}</h1>{failed}<p>Choose the Wi-Fi network the box should join.</p>"
        f"<form method=post action=/join>{''.join(rows)}<label>Password"
        "<input type=password name=password autocomplete=off></label>"
        "<button type=submit>Join</button></form>",
    )


# A choice nobody confirms (the page closed, say) is joined after this long: the box doesn't wait on its hotspot for ever.
CONFIRM_SECONDS = 5 * 60


def joining_page(box: str, network: str, pairing: Pairing | None, token: str = "") -> bytes:
    """What to do next, shown while the box still runs its hotspot: the phone loses this page once the box leaves it,
    so the box leaves only when the person taps Join now (token), after reading it, or after CONFIRM_SECONDS."""
    # Some phones can't open .local names: the box's plain name, which many home routers resolve, is the other way.
    plain = "<p><small>If it doesn't open, try <b>http://zirbel/pair</b>, or the box's address in your router's list " \
        "of devices.</small></p>"
    if pairing and pairing.claim:
        finish = (
            "<p>Then open this address and tap Claim this box:</p>"
            f"<p><a href='{html.escape(pairing.url, quote=True)}'>{html.escape(pairing.url)}</a></p>"
            "<p><small>No device has paired with this box yet, so there is no code and no hurry.</small></p>" + plain
        )
    elif pairing:
        finish = (
            "<p>Then open this address and tap Pair this device:</p>"
            f"<p><a href='{html.escape(pairing.url, quote=True)}'>{html.escape(pairing.url)}</a></p>"
            f"<p>Or open <b>http://zirbel.local/pair</b> and enter the code</p>"
            f"<p class=code>{html.escape(pairing.code)}</p><small>The code works once, for 10 minutes. A device "
            "already paired with the box can make a new one in Box settings.</small>" + plain
        )
    else:
        finish = "<p>Then open <b>http://zirbel.local</b>.</p>" + plain
    after = "<p><small>If the box can't join, the Zirbel setup network comes back with what went wrong.</small></p>"
    if token:
        return _page(
            "Ready to join " + network,
            f"<h1>{html.escape(box)} is ready to join {html.escape(network)}</h1>"
            "<p>Note what comes next: when the box joins, this setup network and this page go away. Then join "
            f"<b>{html.escape(network)}</b> on this phone again.</p>{finish}"
            f"<form method=post action=/go><input type=hidden name=token value={html.escape(token, quote=True)}>"
            f"<button type=submit>Join {html.escape(network)} now</button></form>"
            "<p><a href=/>Choose another network</a></p>" + after,
        )
    return _page(
        "Joining " + network,
        f"<h1>{html.escape(box)} is joining {html.escape(network)}</h1>"
        f"<p>This setup network goes away now. Join <b>{html.escape(network)}</b> on this phone again.</p>{finish}" + after,
    )


class Portal:
    """The page's server, on the hotspot's own address only. `pair` gets a pairing link before the box leaves the
    hotspot, and `join` is called once the page has gone out, so the phone has it before the network changes."""

    def __init__(
        self,
        box: str,
        networks: Callable[[], list[Network]],
        pair: Callable[[], Pairing | None],
        join: Callable[[Choice], None],
        used: Callable[[], None] = lambda: None,
    ):
        self.box, self.networks, self.pair, self.join, self.used = box, networks, pair, join, used
        self.error = ""
        self._server: ThreadingHTTPServer | None = None
        # The network chosen and not yet joined: its choice, its page's link, the token Join now carries, its timer.
        self._pending: tuple[Choice, Pairing | None, str, threading.Timer] | None = None
        self._lock = threading.Lock()

    def _hold(self, choice: Choice, pairing: Pairing | None) -> str:
        token = secrets.token_urlsafe(16)
        timer = threading.Timer(CONFIRM_SECONDS, self._go, args=(token,))
        timer.daemon = True
        with self._lock:
            if self._pending:
                self._pending[3].cancel()
            self._pending = (choice, pairing, token, timer)
        timer.start()
        return token

    def _go(self, token: str) -> tuple[Choice, Pairing | None] | None:
        """The chosen network, joined once: for the token of the choice still held, by Join now or its timer."""
        with self._lock:
            if not self._pending or not secrets.compare_digest(self._pending[2], token):
                return None
            choice, pairing, _token, timer = self._pending
            self._pending = None
        timer.cancel()
        self.error = ""
        threading.Timer(1.5, self.join, args=(choice,)).start()
        return choice, pairing

    def start(self, address: str, port: int = PORT) -> None:
        portal = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "Zirbel setup"
            sys_version = ""

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - the base class's name
                return  # requests carry nothing worth keeping, and a password never reaches a log

            def _send(self, status: int, body: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Referrer-Policy", "no-referrer")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802 - the base class's name
                portal.used()
                self._send(200, choose_page(portal.box, portal.networks(), portal.error))

            def do_POST(self) -> None:  # noqa: N802 - the base class's name
                portal.used()
                length = int(self.headers.get("Content-Length") or 0)
                if self.path == "/go" and 0 < length <= FORM_BYTES:
                    fields = parse_qs(self.rfile.read(length).decode("ascii", errors="replace"))
                    held = portal._go((fields.get("token") or [""])[0])
                    if not held:
                        self._send(400, choose_page(portal.box, portal.networks(), "Choose the network again."))
                        return
                    choice, pairing = held
                    self._send(200, joining_page(portal.box, choice.ssid.decode("utf-8", errors="replace"), pairing))
                    return
                if self.path != "/join" or not 0 < length <= FORM_BYTES:
                    self._send(400, choose_page(portal.box, portal.networks(), "That form could not be read."))
                    return
                try:
                    choice = parse(self.rfile.read(length))
                except (FormError, UnicodeDecodeError) as error:
                    message = str(error) if isinstance(error, FormError) else "That form could not be read."
                    self._send(400, choose_page(portal.box, portal.networks(), message))
                    return
                name = choice.ssid.decode("utf-8", errors="replace")
                pairing = portal.pair()
                self._send(200, joining_page(portal.box, name, pairing, portal._hold(choice, pairing)))

        self._server = ThreadingHTTPServer((address, port), Handler)
        self._server.daemon_threads = True
        threading.Thread(target=self._server.serve_forever, name="portal", daemon=True).start()

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
