"""The box's gamepads, joysticks and wheels under /dev/input: each one opened as it appears (and let go as it goes),
numbered 0 to 15, lowest free first, announced to the host with who it is across a reconnect (its uid: a Bluetooth
device's address, else the USB port it is in), read as its events come, and sent to the host as pad frames; and rumble,
where a device has it.

A device is held for this service alone (EVIOCGRAB): its input reaches a screen only through the host. Its frames go
out when its state changes at a report, at most 120 a second; a quicker change waits for the next one. Where the
kernel dropped events, the whole state is read again. Nothing of the input is kept or logged.
"""

from __future__ import annotations

import errno
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import evdev as ev
import wire
from layout import Layout

MAX_DEVICES = 16
INTERVAL = 1 / 120
NAME_CHARS = 64
READ_EVENTS = 64
EVENT_NAME = re.compile(r"event\d{1,4}")
ADDRESS = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")


class System:
    """What the service does with the system's devices; the tests give their own."""

    open = staticmethod(os.open)
    close = staticmethod(os.close)
    read = staticmethod(os.read)
    write = staticmethod(os.write)
    listdir = staticmethod(os.listdir)

    @staticmethod
    def ident(path: str) -> tuple[int, int]:
        """A device node as it is now: one made again for another device (unplugged and plugged in) is another."""
        status = os.stat(path)
        return status.st_ino, status.st_rdev

    @staticmethod
    def ioctl(fd: int, request: int, argument: object = 0, mutate: bool = True) -> object:
        import fcntl

        return fcntl.ioctl(fd, request, argument, mutate)


@dataclass
class Device:
    number: int
    path: str
    fd: int
    ident: tuple[int, int]
    info: ev.Info
    layout: Layout
    writable: bool
    watch: object = None
    effect: int = -1
    sent: bytes = b""
    last_sent: float = field(default=-1.0)
    pending: bool = False
    dropping: bool = False

    @property
    def kind(self) -> str:
        return {ev.BUS_USB: "usb", ev.BUS_BLUETOOTH: "bluetooth"}.get(self.info.bus, "other")

    @property
    def address(self) -> str | None:
        """A Bluetooth device's own address, which the kernel gives as its unique id."""
        address = self.info.uniq.upper()
        return address if self.kind == "bluetooth" and ADDRESS.match(address) else None

    @property
    def uid(self) -> str:
        """Who the device is across a quick reconnect, so the host keeps its place: a Bluetooth device's address, else
        where it is plugged in (a USB port's path), else its vendor and product."""
        info = self.info
        return (self.address or info.phys or f"id-{info.vendor:04x}:{info.product:04x}")[:NAME_CHARS]

    def view(self) -> dict:
        item = {"device": self.number, "name": self.info.name[:NAME_CHARS], "kind": self.kind}
        if self.address:
            item["address"] = self.address
        return item


class Pads:
    def __init__(
        self,
        send: Callable[[bytes], object],
        later: Callable[[float, Callable[[], None]], object],
        folder: str = "/dev/input",
        system: System | None = None,
        clock: Callable[[], float] = time.monotonic,
        log: Callable[[str], None] = lambda message: print(message, flush=True),
    ):
        self.send, self.later, self.folder = send, later, folder
        self.system, self.clock, self.log = system or System(), clock, log
        self.devices: dict[str, Device] = {}
        # Devices that aren't controllers (keyboards, a gamepad's motion sensors), as they were when looked at.
        self.ignored: dict[str, tuple[int, int]] = {}
        self.watch: Callable[[Device], object] = lambda device: None
        self.unwatch: Callable[[object], None] = lambda handle: None
        self.changed: Callable[[], None] = lambda: None

    def numbers(self) -> list[Device]:
        return sorted(self.devices.values(), key=lambda device: device.number)

    def by_number(self, number: int) -> Device | None:
        return next((device for device in self.devices.values() if device.number == number), None)

    def scan(self) -> None:
        """Opens the controllers that appeared under the folder, and lets go of those that went."""
        try:
            names = sorted(name for name in self.system.listdir(self.folder) if EVENT_NAME.fullmatch(name))
        except OSError:
            names = []
        present = {}
        for name in names:
            path = os.path.join(self.folder, name)
            try:
                present[path] = self.system.ident(path)
            except OSError:
                continue
        for path, device in list(self.devices.items()):
            if present.get(path) != device.ident:
                self.remove(device)
        self.ignored = {path: ident for path, ident in self.ignored.items() if present.get(path) == ident}
        for path, ident in present.items():
            if path not in self.devices and self.ignored.get(path) != ident and len(self.devices) < MAX_DEVICES:
                self.add(path, ident)

    def _open(self, path: str) -> tuple[int, bool]:
        flags = os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
        try:
            return self.system.open(path, os.O_RDWR | flags), True
        except PermissionError:
            # Readable but not writable: no rumble.
            return self.system.open(path, os.O_RDONLY | flags), False

    def add(self, path: str, ident: tuple[int, int]) -> Device | None:
        try:
            fd, writable = self._open(path)
        except OSError:
            # Not readable yet (udev may still be giving it its group): the next scan tries again.
            return None
        try:
            info = ev.read_info(fd, self.system.ioctl)
            if not ev.is_controller(info):
                self.system.close(fd)
                self.ignored[path] = ident
                return None
            layout = Layout(info)
            layout.reset(ev.pressed_keys(fd, self.system.ioctl), ev.axis_values(fd, layout.codes(), self.system.ioctl))
        except OSError:
            self.system.close(fd)
            return None
        try:
            self.system.ioctl(fd, ev.EVIOCGRAB, 1, False)
        except OSError:
            pass  # held by another program: read as well
        used = {device.number for device in self.devices.values()}
        number = next(index for index in range(MAX_DEVICES) if index not in used)
        device = Device(number, path, fd, ident, info, layout, writable)
        self.devices[path] = device
        device.watch = self.watch(device)
        self.log(f"Controller {number}: {info.name} ({device.kind}{', standard' if layout.standard else ''})")
        self.announce(device)
        self.changed()
        return device

    def announce(self, device: Device) -> None:
        """Tells the host of a device, and sends its state as it is now."""
        self.send(
            wire.control(
                {
                    "type": "device",
                    "device": device.number,
                    "name": device.info.name[:NAME_CHARS],
                    "standard": device.layout.standard,
                    "uid": device.uid,
                }
            )
        )
        device.sent = device.layout.frame()
        device.last_sent = self.clock()
        self.send(wire.pad_input(device.number, device.sent))

    def announce_all(self) -> None:
        for device in self.numbers():
            self.announce(device)

    def remove(self, device: Device) -> None:
        if self.devices.get(device.path) is not device:
            return
        del self.devices[device.path]
        self.unwatch(device.watch)
        try:
            self.system.close(device.fd)
        except OSError:
            pass
        self.log(f"Controller {device.number} went.")
        self.send(wire.control({"type": "gone", "device": device.number}))
        self.changed()

    def readable(self, device: Device) -> bool:
        """Reads what the device wrote; False once it is gone."""
        try:
            data = self.system.read(device.fd, ev.EVENT.size * READ_EVENTS)
        except BlockingIOError:
            return True
        except OSError as error:
            if error.errno == errno.EINTR:
                return True
            self.remove(device)
            return False
        if not data:
            self.remove(device)
            return False
        self.take(device, ev.events(data))
        return device.path in self.devices

    def take(self, device: Device, items: list[tuple[int, int, int]]) -> None:
        for kind, code, value in items:
            if kind == ev.EV_SYN and code == ev.SYN_DROPPED:
                device.dropping = True
            elif kind == ev.EV_SYN and code == ev.SYN_REPORT:
                if device.dropping:
                    device.dropping = False
                    self._resync(device)
                self._report(device)
            elif not device.dropping:
                device.layout.update(kind, code, value)

    def _resync(self, device: Device) -> None:
        try:
            device.layout.reset(
                ev.pressed_keys(device.fd, self.system.ioctl),
                ev.axis_values(device.fd, device.layout.codes(), self.system.ioctl),
            )
        except OSError:
            pass

    def _report(self, device: Device) -> None:
        if device.pending:
            return
        wait = device.last_sent + INTERVAL - self.clock()
        if wait > 0:
            device.pending = True
            self.later(wait, lambda: self._flush(device))
        else:
            self._flush(device)

    def _flush(self, device: Device) -> None:
        device.pending = False
        if self.devices.get(device.path) is not device:
            return
        frame = device.layout.frame()
        if frame != device.sent:
            device.sent, device.last_sent = frame, self.clock()
            self.send(wire.pad_input(device.number, frame))

    def rumble(self, number: int, duration: float, strong: float, weak: float) -> None:
        """Plays the host's rumble on a device that has it: duration in milliseconds, up to 5 s, each motor 0 to 1. A
        rumble of nothing stops the one playing."""
        device = self.by_number(number)
        if not device or not device.info.rumble or not device.writable:
            return
        try:
            if duration <= 0 or (strong <= 0 and weak <= 0):
                if device.effect >= 0:
                    self.system.write(device.fd, ev.event(ev.EV_FF, device.effect, 0))
                return
            device.effect = ev.upload_rumble(device.fd, device.effect, int(duration), strong, weak, self.system.ioctl)
            self.system.write(device.fd, ev.event(ev.EV_FF, device.effect, 1))
        except OSError as error:
            self.log(f"Controller {number} did not rumble: {error.strerror or error}")

    def close(self) -> None:
        for device in list(self.devices.values()):
            self.remove(device)
