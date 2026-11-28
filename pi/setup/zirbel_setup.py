"""The Zirbel box's Wi-Fi setup: an open setup hotspot, "Zirbel setup XXXX", with a page (portal.py) that joins the box
to a network or keeps it on its own Wi-Fi. It runs as root (zirbel-setup.service), only while needed (policy.py), and
exits when it isn't. It is also what makes the box's own Wi-Fi (own_network.py), and takes it away: as it starts, and
when the editor's setting for it changes, the Wi-Fi follows that setting; the setup page makes it too, and joining a
network ends it.

A box without a Wi-Fi radio has nothing to set up here: it is set up over Ethernet, where the editor pairs the first
device itself. Joining and trying the saved networks wait on the radio, so they run in a worker thread with a D-Bus
connection of their own; everything else runs on the main loop.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import editor
import own_network
import policy
from portal import Choice, Network, Portal

TICK_SECONDS = 5
# At boot NetworkManager may find the Wi-Fi radio a few seconds after this service starts: its address, for the name of
# the box's own Wi-Fi, which is made once, is waited for this long.
ADDRESS_WAIT_SECONDS = 20


def log(message: str) -> None:
    print(message, flush=True)


def wait_for_network(nm, requested: bool) -> tuple[bool, bool]:
    """The grace period: whether the box is online at its end, and whether setup was asked for meanwhile."""
    start = time.monotonic()
    checks = 0
    while not policy.needed(online=nm.online(), offline_for=time.monotonic() - start, requested=requested):
        if nm.online():
            return True, False
        time.sleep(2)
        checks += 1
        requested = editor.REQUEST.exists() or (checks % 5 == 0 and editor.requested())
    return nm.online(), requested


def mac_suffix(address: str) -> str:
    return address.replace(":", "")[-4:].upper()


def box_suffix(nm, wait: float = 0.0) -> str:
    """The end of the box's Wi-Fi address, which names it in setup and names its own Wi-Fi; at boot the radio may take
    up to wait seconds to appear."""
    deadline = time.monotonic() + wait
    while True:
        iface = nm.interface()
        try:
            address = Path(f"/sys/class/net/{iface}/address").read_text() if iface else ""
        except OSError:
            address = ""
        if address or time.monotonic() >= deadline:
            return mac_suffix(address) or "0000"
        time.sleep(1)


def own_credentials(nm) -> own_network.Credentials | None:
    """The box's own Wi-Fi's name and password, made the first time (None where they can't be kept). They are named as
    the setup hotspot is, by the box's Wi-Fi address."""
    kept = own_network.read()
    if kept:
        return kept
    try:
        return own_network.credentials(box_suffix(nm, wait=ADDRESS_WAIT_SECONDS))
    except OSError as error:
        log(f"The box's own Wi-Fi has no name and password to keep: {error}")
        return None


def follow_setting(nm, own: own_network.Credentials | None, before_up=lambda: None) -> str:
    """The Wi-Fi as the editor's ownNetwork setting has it. The wake goes first, so that a change made meanwhile wakes
    the service again."""
    editor.clear_network_wake()
    step = own_network.apply(nm, editor.own_network(), own, before_up)
    if step:
        log(
            {
                own_network.UP: "The box's own Wi-Fi is up.",
                own_network.DOWN: "The box's own Wi-Fi is gone.",
                own_network.FAILED: "The box's own Wi-Fi did not start.",
            }[step]
        )
    return step


class Setup:
    def __init__(self, nm, requested: bool, own: own_network.Credentials | None):
        from gi.repository import GLib

        self.GLib, self.nm, self.requested, self.own = GLib, nm, requested, own
        self.loop = GLib.MainLoop()
        self.last_use = self.last_retry = time.monotonic()
        self.busy = False  # joining or trying the saved networks: the radio is in use
        self.provisioned = False
        self.hotspot: str | None = None
        self.networks: list[Network] = []
        suffix = box_suffix(nm)
        self.box, self.hotspot_ssid = f"Zirbel-{suffix}", f"Zirbel setup {suffix}"
        self.portal = Portal(
            self.box,
            lambda: self.networks,
            lambda: editor.pairing(attempts=2),
            self._join_from_portal,
            self._used,
            own=own,
            make=self._own_from_portal,
        )

    def _used(self) -> None:
        self.last_use = time.monotonic()

    def run(self) -> None:
        log(f"Setting up as {self.box}" + (", as asked." if self.requested else ": the box has no network."))
        self.networks = self.nm.scan()
        self._hotspot_up()
        self.GLib.timeout_add_seconds(TICK_SECONDS, self._tick)
        self.loop.run()

    def _hotspot_up(self) -> None:
        """The setup hotspot with its page, unless it is up or the radio is joining or trying the saved networks."""
        if self.busy or self.hotspot:
            return
        import network

        self.hotspot = self.nm.hotspot_up(self.hotspot_ssid)
        if self.hotspot:
            self.portal.start(network.HOTSPOT_ADDRESS)
            log(f"The setup hotspot {self.hotspot_ssid} is up.")

    def _hotspot_down(self, nm) -> None:
        """From a worker, with its own NetworkManager connection, before the radio joins a network."""
        import network

        self.portal.stop()
        if self.hotspot:
            nm.hotspot_down(self.hotspot)
            self.hotspot = None
        # Whether or not a hotspot is known to be up: the network the box joins must reach it, and the box's own Wi-Fi
        # must not resolve every name to the box.
        network.firewall(None)
        network.wildcard_dns(False)

    def _tick(self) -> bool:
        if self.busy:
            return True
        if editor.network_wake().exists():
            # The box's own Wi-Fi was switched in the editor while setup runs.
            self._in_worker(self._switch_own)
            return True
        online = self.nm.online()
        self.requested = self.requested or editor.REQUEST.exists()
        since_use = time.monotonic() - self.last_use
        if policy.finished(online=online, requested=self.requested, provisioned=self.provisioned) or policy.abandoned(
            requested=self.requested, since_use=since_use
        ):
            return self._finish()
        if policy.retry_saved(
            saved=self.nm.saved_wifi(),
            requested=self.requested,
            since_retry=time.monotonic() - self.last_retry,
            since_use=since_use,
        ):
            self._in_worker(self._retry_saved)
        else:
            self._hotspot_up()
        return True

    def _in_worker(self, work, *args) -> bool:
        """Work that waits on the radio, in a thread with a NetworkManager connection of its own. On the main loop."""
        import network

        self.busy = True

        def run() -> None:
            try:
                work(network.NetworkManager.own(), *args)
            except Exception as error:
                log(f"Setup work failed: {error}")
                self.GLib.idle_add(self._failed, b"", "Something went wrong there. Try again.")

        threading.Thread(target=run, name="setup-work", daemon=True).start()
        return False

    def _retry_saved(self, nm) -> None:
        log("Trying the saved networks again.")
        self._hotspot_down(nm)
        deadline = time.monotonic() + policy.RETRY_FOR_SECONDS
        while time.monotonic() < deadline and not nm.online():
            time.sleep(2)
        self.last_retry = time.monotonic()
        self.GLib.idle_add(self._done)

    def _done(self) -> bool:
        self.busy = False
        return False

    def _join(self, nm, ssid: bytes, password: bytes) -> None:
        self._hotspot_down(nm)
        auth = next((network.auth for network in self.networks if network.ssid == ssid), "")
        try:
            joined = nm.join(ssid, password, auth)
        except (UnicodeDecodeError, ValueError):
            joined = False
        if not joined:
            self.GLib.idle_add(self._failed, ssid, "")
            return
        # Joining a network ends the box's own Wi-Fi, which would otherwise come back first after a reboot.
        if nm.own_network_down() or editor.own_network():
            log("The box's own Wi-Fi is gone: the box joined a network.")
            editor.set_own_network(False)
            editor.clear_network_wake()  # this is that change
        self.GLib.idle_add(self._joined)

    def _join_from_portal(self, choice: Choice) -> None:
        # From the portal's own thread, once the page with the pairing link went out: the join starts on the main loop.
        self.GLib.idle_add(self._in_worker, self._join, choice.ssid, choice.password)

    def _own_from_portal(self) -> None:
        # From the portal's own thread, as a join: the work starts on the main loop.
        self.GLib.idle_add(self._in_worker, self._make_own)

    def _make_own(self, nm) -> None:
        """The box's own Wi-Fi, chosen on the setup page: the editor's setting first, which the Wi-Fi follows from then
        on, then the network in place of the hotspot. The setting goes back if the network doesn't start."""
        if not editor.set_own_network(True):
            self.GLib.idle_add(self._failed, b"", "The box's editor didn't answer. Try again in a minute.")
            return
        editor.clear_network_wake()  # this is that change
        made = own_network.apply(nm, True, self.own, before_up=lambda: self._hotspot_down(nm))
        if made in (own_network.UP, own_network.KEEP):
            self.GLib.idle_add(self._made_own)
            return
        editor.set_own_network(False)
        editor.clear_network_wake()
        self.GLib.idle_add(self._failed, b"", "The box couldn't make its own Wi-Fi. Try again, or choose a network.")

    def _switch_own(self, nm) -> None:
        """The editor's setting changed while setup runs: the Wi-Fi follows it, the hotspot giving way to the
        network."""
        step = follow_setting(nm, self.own, before_up=lambda: self._hotspot_down(nm))
        self.GLib.idle_add(self._made_own if step == own_network.UP else self._done)

    def _made_own(self) -> bool:
        log("The box makes its own Wi-Fi.")
        self.busy = False
        self.provisioned = True
        self.GLib.timeout_add_seconds(1, self._finish)
        return False

    def _joined(self) -> bool:
        log("Joined the network.")
        self.busy = False
        self.provisioned = True
        self.GLib.timeout_add_seconds(1, self._finish)
        return False

    def _failed(self, ssid: bytes, message: str) -> bool:
        log("Could not join the network." if ssid else "Setup work failed.")
        self.busy = False
        name = ssid.decode("utf-8", errors="replace")
        self.portal.error = message or f"The box couldn't join {name}. Check the password and try again."
        self._hotspot_up()
        return False

    def _finish(self) -> bool:
        log("Setup is over.")
        self.portal.stop()
        if self.hotspot:
            self.nm.hotspot_down(self.hotspot)
            self.hotspot = None
        import network

        network.firewall(None)
        network.wildcard_dns(False)
        if self.requested:
            editor.clear_request()
        self.loop.quit()
        return False


def main() -> int:
    if not policy.has_wifi():
        log("No Wi-Fi radio: nothing to set up here.")
        editor.clear_request()
        editor.clear_network_wake()
        return 0
    # Only now the D-Bus modules: a box with nothing to set up never loads them.
    import dbus
    import dbus.mainloop.glib
    import network

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    nm = network.NetworkManager(bus)
    nm.enable_wifi()
    network.wildcard_dns(False)  # a hotspot that went without this service taking it down
    reset = policy.reset_marker()
    if reset:
        # The box's own Wi-Fi goes too, its setting with it where the editor already answers, and setup starts at once.
        log(f"Reset from the card: {nm.forget_wifi()} saved networks forgotten; setting up.")
        reset.unlink(missing_ok=True)
        editor.set_own_network(False, attempts=1)
        editor.request_setup()
    own = own_credentials(nm)
    # Woken for the box's own Wi-Fi, or at boot: the Wi-Fi as the editor's setting has it, before anything else.
    if not reset:
        follow_setting(nm, own)
    online, requested = wait_for_network(nm, editor.requested())
    if online and not requested:
        return 0
    Setup(nm, requested, own).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
