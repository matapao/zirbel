"""The Zirbel box's Wi-Fi setup: over Bluetooth with Improv Wi-Fi, and an open setup hotspot with a page for phones
without Web Bluetooth. It runs as root (zirbel-setup.service), only while needed (policy.py), and exits when it isn't.
It is also what makes the box's own Wi-Fi (own_network.py), and takes it away: as it starts, and when the editor's
setting for it changes, the Wi-Fi follows that setting; the setup page makes it too, and joining a network ends it.

A box without a Wi-Fi radio has nothing to set up here: it is set up over Ethernet, where the editor pairs the first
device itself. Joining and scanning wait on the radio, so they run in a worker thread with a D-Bus connection of their
own; everything else runs on the main loop.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import editor  # noqa: E402 - the modules beside this one
import improv  # noqa: E402
import own_network  # noqa: E402
import policy  # noqa: E402
from portal import Choice, Pairing, Portal  # noqa: E402

LED = Path("/sys/class/leds/ACT/trigger")
TICK_SECONDS = 5
# At boot the box's Bluetooth controller comes up a few seconds after this service may: it is looked for this long.
BLUETOOTH_WAIT_SECONDS = 120
# And its address, for the name of the box's own Wi-Fi, which is made once: this long.
BLUETOOTH_ADDRESS_WAIT_SECONDS = 20


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


def os_release() -> tuple[str, str]:
    values = {}
    try:
        for line in Path("/etc/os-release").read_text().splitlines():
            key, _, value = line.partition("=")
            values[key] = value.strip('"')
    except OSError:
        pass
    return values.get("NAME", ""), values.get("VERSION_ID", "")


def mac_suffix(address: str) -> str:
    return address.replace(":", "")[-4:].upper()


def box_suffix(bus, nm, radios: policy.Radios, wait: float = 0.0) -> str:
    """The end of the box's Bluetooth address, or of its Wi-Fi's where it has no Bluetooth or none answers within wait
    seconds, which names it in setup and names its own Wi-Fi."""
    address = ""
    if radios.bluetooth:
        import bluetooth

        deadline = time.monotonic() + wait
        while True:
            try:
                address = bluetooth.address(bus)
            except Exception:  # noqa: BLE001 - a controller that doesn't answer is no Bluetooth
                address = ""
            if address or time.monotonic() >= deadline:
                break
            time.sleep(1)
    iface = nm.interface()
    try:
        address = address or (Path(f"/sys/class/net/{iface}/address").read_text() if iface else "")
    except OSError:
        pass
    return mac_suffix(address) or "0000"


def own_credentials(bus, nm, radios: policy.Radios) -> own_network.Credentials | None:
    """The box's own Wi-Fi's name and password, made the first time (None where they can't be kept). They are named as
    the setup hotspot is, by the box's Bluetooth address, which at boot may come a little after this service starts:
    made once, they wait for it a while."""
    kept = own_network.read()
    if kept:
        return kept
    try:
        return own_network.credentials(box_suffix(bus, nm, radios, wait=BLUETOOTH_ADDRESS_WAIT_SECONDS))
    except OSError as error:
        log(f"The box's own Wi-Fi has no name and password to keep: {error}")
        return None


def follow_setting(nm, own: own_network.Credentials | None, before_up=lambda: None) -> str:
    """The Wi-Fi as the editor's ownNetwork setting has it. The wake goes first, so that a change made meanwhile wakes
    the service again."""
    editor.clear_network_wake()
    step = own_network.apply(nm, editor.own_network(), own, before_up)
    if step:
        log({own_network.UP: "The box's own Wi-Fi is up.", own_network.DOWN: "The box's own Wi-Fi is gone.",
             own_network.FAILED: "The box's own Wi-Fi did not start."}[step])
    return step


class Setup:
    def __init__(self, bus, nm, radios: policy.Radios, requested: bool, own: own_network.Credentials | None,
                 after_boot: bool = False):
        from gi.repository import GLib

        self.GLib, self.bus, self.nm, self.radios, self.requested = GLib, bus, nm, radios, requested
        self.own = own
        # A box with a network, in the minutes after power-on: Bluetooth setup only, so its network stays up.
        self.after_boot = after_boot
        self.loop = GLib.MainLoop()
        self.started = self.last_use = self.last_retry = self.last_bluetooth = time.monotonic()
        self.busy = False  # joining, scanning or trying the saved networks: the radio is in use
        self.provisioned = False
        self.hotspot: str | None = None
        self.networks: list[improv.Network] = []
        self.portal_pairing: Pairing | None = None
        self.bluetooth = None
        self.bluetooth_pending = None  # made once its controller is there, started once BlueZ takes it
        self.bluetooth_starting = False  # its registration asked of BlueZ, the answer not yet in
        self.bluetooth_radios: policy.Radios | None = None
        self.bluetooth_error = ""
        suffix = box_suffix(bus, nm, radios)
        self.box, self.hotspot_ssid = f"Zirbel-{suffix}", f"Zirbel setup {suffix}"
        info = improv.DeviceInfo("Zirbel setup", "1", policy.model_name(), self.box, *os_release())
        capabilities = improv.CAN_DEVICE_INFO | improv.CAN_SCAN | (improv.CAN_IDENTIFY if LED.exists() else 0)
        self.service = improv.Service(info=info, capabilities=capabilities, join=self._join_from_bluetooth,
                                      identify=self._identify, scan=self._scan_for_bluetooth)
        self.portal = Portal(self.box, lambda: self.networks, self._pair_for_portal, self._join_from_portal, self._used,
                             own=own, make=self._own_from_portal)

    def _used(self, bluetooth: bool = False) -> None:
        self.last_use = time.monotonic()
        if bluetooth:
            self.last_bluetooth = self.last_use

    def run(self) -> None:
        log(f"Setting up as {self.box}" + (", as asked." if self.requested else
                                           ", over Bluetooth, for the minutes after power-on." if self.after_boot else
                                           ": the box has no network."))
        self.networks = self.nm.scan()
        self._start_bluetooth()
        self._hotspot_if_due()
        self.GLib.timeout_add_seconds(TICK_SECONDS, self._tick)
        self.loop.run()

    def _start_bluetooth(self) -> None:
        """Bluetooth setup, once the box's controller and BlueZ's handle for it are there; the hotspot serves meanwhile.
        Its objects are made once, when the controller is first there, and only its start is tried again. BlueZ's
        answer comes later, on the main loop (_bluetooth_ready, _bluetooth_failed)."""
        if self.bluetooth is not None or self.bluetooth_starting:
            return
        try:
            if self.bluetooth_pending is None:
                radios = policy.detect()
                if not radios.bluetooth:
                    return
                import bluetooth

                self.bluetooth_pending = bluetooth.Bluetooth(self.bus, self.service, self.box, lambda: self._used(True))
                self.bluetooth_radios = radios
            self.service.changed = self.bluetooth_pending.changed
            self.bluetooth_starting = True
            self.bluetooth_pending.start(self._bluetooth_ready, self._bluetooth_failed)
        except Exception as error:  # noqa: BLE001 - the hotspot still serves
            self._bluetooth_failed(error)

    def _bluetooth_ready(self) -> None:
        self.bluetooth_starting = False
        self.bluetooth, self.radios = self.bluetooth_pending, self.bluetooth_radios or self.radios
        log("Bluetooth setup is advertising.")

    def _bluetooth_failed(self, error: Exception) -> None:
        self.bluetooth_starting = False
        if str(error) != self.bluetooth_error:
            log(f"Bluetooth setup did not start yet: {error}")
        self.bluetooth_error = str(error)

    def _hotspot_if_due(self) -> None:
        # The hotspot takes the box's one Wi-Fi radio: never while the box has a network the person didn't ask to leave.
        if self.after_boot and not self.requested and self.nm.online():
            return
        # Bluetooth starting counts as Bluetooth: on a board whose radio does one at a time, the hotspot waits for it.
        radios = policy.Radios(self.radios.wifi, self.bluetooth is not None or self.bluetooth_starting, self.radios.sharing)
        if self.busy or self.hotspot or not policy.hotspot_due(radios, quiet_for=time.monotonic() - self.last_bluetooth):
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
        if self.bluetooth is None and time.monotonic() - self.started < BLUETOOTH_WAIT_SECONDS:
            self._start_bluetooth()
        if self.busy:
            return True
        if editor.network_wake().exists():
            # The box's own Wi-Fi was switched in the editor while setup runs.
            self._in_worker(self._switch_own)
            return True
        online = self.nm.online()
        self.requested = self.requested or editor.REQUEST.exists()
        since_use = time.monotonic() - self.last_use
        after_boot = self.after_boot and policy.after_boot(time.monotonic()) and not self.provisioned
        if policy.finished(online=online, requested=self.requested, provisioned=self.provisioned,
                           after_boot=after_boot) or policy.abandoned(
            requested=self.requested, since_use=since_use
        ):
            return self._finish()
        if policy.retry_saved(saved=self.nm.saved_wifi(), requested=self.requested,
                              since_retry=time.monotonic() - self.last_retry, since_use=since_use):
            self._in_worker(self._retry_saved)
        else:
            self._hotspot_if_due()
        return True

    def _in_worker(self, work, *args) -> bool:
        """Work that waits on the radio, in a thread with a NetworkManager connection of its own. On the main loop."""
        import network

        self.busy = True

        def run() -> None:
            try:
                work(network.NetworkManager.own(), *args)
            except Exception as error:  # noqa: BLE001 - a failure is reported, and setup goes on
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

    def _join(self, nm, ssid: bytes, password: bytes, pairing: Pairing | None) -> None:
        import network

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
        pairing = pairing or editor.pairing()
        # The Bluetooth client opens the link once the box is on the network: at the box's own address, which every
        # device resolves, where .local names fail on some.
        url = editor.at(pairing.url, network.local_address()) if pairing else "http://zirbel.local/"
        self.GLib.idle_add(self._joined, url)

    def _join_from_bluetooth(self, ssid: bytes, password: bytes) -> None:
        self._used(True)
        self._in_worker(self._join, ssid, password, None)

    def _join_from_portal(self, choice: Choice) -> None:
        # From the portal's own thread: the join starts on the main loop.
        self.GLib.idle_add(self._in_worker, self._join, choice.ssid, choice.password, self.portal_pairing)

    def _pair_for_portal(self) -> Pairing | None:
        self.portal_pairing = editor.pairing(attempts=2)
        return self.portal_pairing

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
        """The editor's setting changed while setup runs: the Wi-Fi follows it, the hotspot giving way to the network."""
        step = follow_setting(nm, self.own, before_up=lambda: self._hotspot_down(nm))
        self.GLib.idle_add(self._made_own if step == own_network.UP else self._done)

    def _made_own(self) -> bool:
        log("The box makes its own Wi-Fi.")
        self.busy = False
        self.provisioned = True
        self.GLib.timeout_add_seconds(1, self._finish)
        return False

    def _joined(self, url: str) -> bool:
        log("Joined the network.")
        self.busy = False
        self.provisioned = True
        self.service.joined(url)
        # The Bluetooth client reads the link from its result before the service goes.
        self.GLib.timeout_add_seconds(5, self._finish)
        return False

    def _failed(self, ssid: bytes, message: str) -> bool:
        log("Could not join the network." if ssid else "Setup work failed.")
        self.busy = False
        name = ssid.decode("utf-8", errors="replace")
        self.portal.error = message or f"The box couldn't join {name}. Check the password and try again."
        if self.service.state == improv.PROVISIONING:
            self.service.join_failed()
        self._hotspot_if_due()
        return False

    def _identify(self) -> None:
        def blink() -> None:
            try:
                current = LED.read_text()
                before = current[current.index("[") + 1 : current.index("]")]
                LED.write_text("heartbeat")
                time.sleep(5)
                LED.write_text(before)
            except (OSError, ValueError):
                pass

        threading.Thread(target=blink, name="identify", daemon=True).start()

    def _scan_for_bluetooth(self) -> None:
        self._used(True)
        if self.hotspot or self.busy:
            self.service.scanned(self.networks)  # the radio serves the hotspot: what it saw before
            return
        self._in_worker(lambda nm: self.GLib.idle_add(self._scanned, nm.scan()))

    def _scanned(self, networks: list[improv.Network]) -> bool:
        self.busy = False
        self.networks = networks or self.networks
        self.service.scanned(self.networks)
        return False

    def _finish(self) -> bool:
        log("Setup is over.")
        # A start that never finished may have left part of it with BlueZ: that goes too.
        if self.bluetooth or self.bluetooth_pending:
            try:
                (self.bluetooth or self.bluetooth_pending).stop()
            except Exception:  # noqa: BLE001 - a controller that went away took it with it
                pass
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
    radios = policy.detect()
    if not radios.wifi:
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
    own = own_credentials(bus, nm, radios)
    # Woken for the box's own Wi-Fi, or at boot: the Wi-Fi as the editor's setting has it, before anything else.
    follow_setting(nm, own)
    online, requested = wait_for_network(nm, editor.requested())
    after_boot = online and not requested and radios.bluetooth and policy.after_boot(time.monotonic())
    if online and not requested and not after_boot:
        return 0
    Setup(bus, nm, radios, requested, own, after_boot=after_boot).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
