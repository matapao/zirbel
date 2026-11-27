"""The box's controllers service (zirbel-pads.service), as its own user, zirbel-pads (groups input, bluetooth and
zirbel-pads), never root: every gamepad, joystick and wheel on the box (pads.py), USB or Bluetooth, goes to the host
over its local socket (host_link.py, wire.py), which routes it to a screen; the host's rumble comes back to it; and the
owner pairs and forgets Bluetooth controllers from Box settings (bluetooth.py, agent.py), which the host relays here.

It runs on GLib's main loop: the devices, the host's socket and D-Bus. /dev/input is watched for devices that come and
go, and looked at again every few seconds for one whose permissions came after it did. The host may start after this
service, or restart: it connects again every two seconds while it isn't connected. With no system bus or no BlueZ, the
box's gamepads still work, and Box settings says there is no Bluetooth.
"""

from __future__ import annotations

import os
import signal
import sys
from collections.abc import Callable

# The modules beside this one, however it is started.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import view
import wire
from host_link import SOCKET, HostLink
from pads import ADDRESS, Pads, System
from view import NO_BLUETOOTH

RECONNECT_SECONDS = 2
RESCAN_SECONDS = 5
UNKNOWN = "The controllers service doesn't know that request."


def log(message: str) -> None:
    print(message, flush=True)


def _unit(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1 else None


class Service:
    """The gamepads, Bluetooth and the host, together; the loop's timers come in as later and cancel."""

    def __init__(
        self,
        path: str,
        later: Callable[[float, Callable[[], None]], object],
        cancel: Callable[[object], None],
        folder: str = "/dev/input",
        system: System | None = None,
    ):
        self.later, self.cancel = later, cancel
        self.link = HostLink(path, self.opened, self.message, log=log)
        self.pads = Pads(self.link.send, later, folder, system, log=log)
        self.pads.changed = self.report
        self.bluetooth = None
        self.agent = None
        self.error: str | None = None

    def opened(self) -> None:
        """A new connection hears of every device, then of the box's controllers."""
        self.pads.announce_all()
        self.report()

    def view(self) -> dict:
        devices = [device.view() for device in self.pads.numbers()]
        return view.controllers(devices, self.bluetooth.view() if self.bluetooth else None, self.error)

    def report(self) -> None:
        if self.link.connected:
            self.link.send(wire.control(self.view()))

    def message(self, message: dict) -> None:
        kind = message.get("type")
        if kind == "rumble":
            device, duration = message.get("device"), message.get("duration")
            strong, weak = _unit(message.get("strong", 0)), _unit(message.get("weak", 0))
            if isinstance(device, int) and isinstance(duration, (int, float)) and 0 <= duration <= 5000 and \
                    strong is not None and weak is not None:
                self.pads.rumble(device, duration, strong, weak)
            return
        if kind not in ("scan", "pair", "forget"):
            return
        # The owner's requests, each answered with the box's controllers as they are now.
        self.error = None
        address = message.get("address")
        if not self.bluetooth:
            self.error = NO_BLUETOOTH
        elif kind == "scan" and isinstance(message.get("on"), bool):
            self.bluetooth.scan(message["on"])
        elif kind in ("pair", "forget") and isinstance(address, str) and ADDRESS.match(address):
            getattr(self.bluetooth, kind)(address)
        else:
            self.error = UNKNOWN
        self.report()


def main() -> None:
    import dbus
    import dbus.mainloop.glib
    from gi.repository import Gio, GLib

    def later(seconds: float, callback: Callable[[], None]) -> int:
        return GLib.timeout_add(max(1, round(seconds * 1000)), lambda: (callback(), False)[1])

    service = Service(SOCKET, later, GLib.source_remove)
    pads, link = service.pads, service.link
    pads.watch = lambda device: GLib.io_add_watch(
        device.fd, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, lambda *_: pads.readable(device)
    )
    pads.unwatch = lambda handle: handle and GLib.source_remove(handle)

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    try:
        from agent import Agent
        from bluetooth import Bluetooth

        bus = dbus.SystemBus()
        service.bluetooth = Bluetooth(bus, service.report, later, GLib.source_remove, log=log)
        service.agent = Agent(bus, service.bluetooth)
        service.bluetooth.start()
    except dbus.DBusException as error:
        log(f"No Bluetooth: the system bus didn't answer ({error}).")
        service.bluetooth = None

    # The host's socket is watched while it is open, and no longer once it closes, wherever it closes: a closed socket's
    # watch would wake the loop for nothing, or its number would come back as the next socket's.
    watching: list[int] = []

    def unwatch_link() -> None:
        while watching:
            GLib.source_remove(watching.pop())

    link.closed = unwatch_link

    def connect() -> bool:
        if not link.connected and link.open() and link.sock:
            watching.append(GLib.io_add_watch(link.sock.fileno(), GLib.PRIORITY_DEFAULT,
                                              GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, lambda *_: link.readable()))
        return True

    def rescan() -> bool:
        pads.scan()
        return True

    monitor = Gio.File.new_for_path(pads.folder).monitor_directory(Gio.FileMonitorFlags.NONE, None)
    # A device's node appears before udev gives it its group: looked at again a moment later.
    monitor.connect("changed", lambda *_: (later(0.2, pads.scan), later(1.5, pads.scan)))
    pads.scan()
    connect()
    GLib.timeout_add_seconds(RECONNECT_SECONDS, connect)
    GLib.timeout_add_seconds(RESCAN_SECONDS, rescan)
    loop = GLib.MainLoop()
    for number in (signal.SIGTERM, signal.SIGINT):
        GLib.unix_signal_add(GLib.PRIORITY_HIGH, number, lambda: loop.quit() or False)
    log(f"Watching {pads.folder} for controllers, for the host at {SOCKET}.")
    try:
        loop.run()
    finally:
        pads.close()
        link.close()
        monitor.cancel()


if __name__ == "__main__":
    main()
