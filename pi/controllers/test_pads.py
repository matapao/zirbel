"""The box's controllers under /dev/input (pads.py): opened, held and numbered as they appear, announced to the host,
read as they report (at most 120 frames a second, and none for a report that changes nothing), read again where the
kernel dropped events, let go as they go, and rumbled where they can be."""

import errno
import os
import struct
import unittest

import evdev as ev
import layout
import pads
import wire
from test_evdev import BT_PAD, BT_PAD_MOTION, FLIGHT_STICK, KEYBOARD, USB_PAD, FakeKernel, Recorded, recording


class FakeSystem:
    """Device nodes in a folder, open file descriptors with the events waiting on them, and what was written."""

    def __init__(self):
        self.kernel = FakeKernel()
        self.nodes: dict[str, tuple[Recorded, tuple[int, int]]] = {}
        self.fds: dict[int, str] = {}
        self.waiting: dict[int, bytearray] = {}
        self.gone: set[int] = set()
        self.denied: set[str] = set()
        self.read_only: set[str] = set()
        self.written: list[tuple[int, bytes]] = []
        self.closed: list[int] = []
        self._fd, self._inode = 10, 100

    def plug(self, name: str, device: Recorded) -> str:
        path = "/dev/input/" + name
        self._inode += 1
        self.nodes[path] = (device, (self._inode, 13 << 8 | 64))
        return path

    def unplug(self, path: str) -> None:
        del self.nodes[path]
        self.gone |= {fd for fd, opened in self.fds.items() if opened == path}

    def fd_of(self, path: str) -> int:
        return next(fd for fd, opened in self.fds.items() if opened == path and fd not in self.closed)

    def feed(self, path: str, *items) -> int:
        fd = self.fd_of(path)
        self.waiting[fd] += recording(*items)
        return fd

    def listdir(self, folder):
        return [path.rsplit("/", 1)[1] for path in self.nodes] + ["by-id", "mice", "js0"]

    def ident(self, path):
        if path not in self.nodes:
            raise FileNotFoundError(errno.ENOENT, "No such file", path)
        return self.nodes[path][1]

    def open(self, path, flags):
        if path in self.denied or (flags & os.O_RDWR and path in self.read_only):
            raise PermissionError(errno.EACCES, "Permission denied", path)
        self._fd += 1
        self.fds[self._fd] = path
        self.waiting[self._fd] = bytearray()
        self.kernel.attach(self._fd, self.nodes[path][0])
        return self._fd

    def close(self, fd):
        self.closed.append(fd)

    def read(self, fd, length):
        if fd in self.gone:
            raise OSError(errno.ENODEV, "No such device")
        if not self.waiting[fd]:
            raise BlockingIOError(errno.EAGAIN, "Resource temporarily unavailable")
        data = bytes(self.waiting[fd][:length - length % ev.EVENT.size])
        del self.waiting[fd][:len(data)]
        return data

    def write(self, fd, data):
        self.written.append((fd, bytes(data)))
        return len(data)

    def ioctl(self, fd, request, argument=0, mutate=True):
        return self.kernel(fd, request, argument, mutate)


class Clock:
    def __init__(self):
        self.now = 100.0
        self.timers: list[tuple[float, object]] = []

    def __call__(self):
        return self.now

    def later(self, seconds, callback):
        self.timers.append((self.now + seconds, callback))
        return len(self.timers)

    def advance(self, seconds):
        self.now += seconds
        due = [timer for timer in self.timers if timer[0] <= self.now]
        self.timers = [timer for timer in self.timers if timer[0] > self.now]
        for _, callback in due:
            callback()


def setup_pads(test: unittest.TestCase):
    system, clock, sent = FakeSystem(), Clock(), []
    found = pads.Pads(sent.append, clock.later, "/dev/input", system, clock, log=lambda text: None)
    reports = []
    found.changed = lambda: reports.append(len(found.devices))
    return system, clock, sent, found, reports


def frames(sent: list) -> list:
    reader = wire.Reader()
    return [frame for data in sent for frame in reader.feed(data)]


def inputs(sent: list) -> list:
    return [(frame[0], layout.decode(frame[1])) for frame in frames(sent) if isinstance(frame, tuple)]


SOUTH = [(ev.EV_KEY, ev.BTN_SOUTH, 1), (ev.EV_SYN, ev.SYN_REPORT, 0)]


class Devices(unittest.TestCase):
    def test_controllers_are_opened_held_numbered_and_announced(self):
        system, _, sent, found, reports = setup_pads(self)
        system.plug("event3", USB_PAD)
        system.plug("event4", KEYBOARD)
        system.plug("event5", BT_PAD)
        system.plug("event6", BT_PAD_MOTION)
        found.scan()
        self.assertEqual([(device.number, device.info.name) for device in found.numbers()],
                         [(0, "USB gamepad"), (1, "Wireless Controller")])
        messages = frames(sent)
        self.assertEqual(messages[0], {"type": "device", "device": 0, "name": "USB gamepad", "standard": True,
                                       "uid": "usb-0000:01:00.0-1.2/input0"})
        # A Bluetooth gamepad is who its address says, wherever it connects.
        self.assertEqual(messages[2], {"type": "device", "device": 1, "name": "Wireless Controller", "standard": True,
                                       "uid": "A0:B1:C2:D3:E4:F5"})
        # Each one's state as it is, right after it.
        self.assertEqual(messages[1][0], 0)
        self.assertEqual(layout.decode(messages[1][1])[2], 0)
        self.assertEqual(sorted(system.kernel.grabbed), sorted(device.fd for device in found.numbers()))
        self.assertEqual(reports, [1, 2])
        # The keyboard and the motion sensors were closed, and aren't looked at again until they change.
        self.assertEqual(len(system.closed), 2)
        found.scan()
        self.assertEqual(len(system.fds), 4)
        self.assertEqual(
            [device.view() for device in found.numbers()],
            [
                {"device": 0, "name": "USB gamepad", "kind": "usb"},
                {"device": 1, "name": "Wireless Controller", "kind": "bluetooth", "address": "A0:B1:C2:D3:E4:F5"},
            ],
        )

    def test_a_device_that_goes_is_let_go_and_its_number_is_used_again(self):
        system, _, sent, found, _ = setup_pads(self)
        first = system.plug("event3", USB_PAD)
        system.plug("event5", FLIGHT_STICK)
        found.scan()
        fd = system.fd_of(first)
        system.unplug(first)
        found.scan()
        self.assertIn(fd, system.closed)
        self.assertIn({"type": "gone", "device": 0}, frames(sent))
        again = system.plug("event3", BT_PAD)
        found.scan()
        self.assertEqual(found.devices[again].number, 0)
        # One unplugged while it is read goes as it is read.
        system.unplug(again)
        self.assertFalse(found.readable(found.devices[again]))
        self.assertNotIn(again, found.devices)

    def test_a_node_made_again_for_another_device_is_another_device(self):
        system, _, sent, found, _ = setup_pads(self)
        path = system.plug("event3", USB_PAD)
        found.scan()
        system.unplug(path)
        system.plug("event3", BT_PAD)
        found.scan()
        self.assertEqual(found.devices[path].info.name, "Wireless Controller")
        self.assertEqual(
            [frame["type"] for frame in frames(sent) if isinstance(frame, dict)], ["device", "gone", "device"]
        )

    def test_one_not_readable_yet_is_tried_again_and_one_not_writable_reads_without_rumble(self):
        system, _, _, found, _ = setup_pads(self)
        path = system.plug("event3", USB_PAD)
        system.denied.add(path)
        found.scan()
        self.assertEqual(found.devices, {})
        system.denied.clear()
        system.read_only.add(path)
        found.scan()
        device = found.devices[path]
        self.assertFalse(device.writable)
        found.rumble(0, 100, 1, 1)
        self.assertEqual((system.kernel.effects, system.written), ([], []))

    def test_at_most_sixteen(self):
        system, _, _, found, _ = setup_pads(self)
        for index in range(18):
            system.plug(f"event{index}", USB_PAD)
        found.scan()
        self.assertEqual(sorted(device.number for device in found.numbers()), list(range(16)))


class Input(unittest.TestCase):
    def test_each_report_that_changes_the_state_sends_a_frame(self):
        system, clock, sent, found, _ = setup_pads(self)
        path = system.plug("event3", USB_PAD)
        found.scan()
        sent.clear()
        device = found.devices[path]
        clock.advance(1)
        system.feed(path, (ev.EV_ABS, ev.ABS_X, -32768), (ev.EV_KEY, ev.BTN_SOUTH, 1), (ev.EV_SYN, ev.SYN_REPORT, 0))
        self.assertTrue(found.readable(device))
        [(number, (standard, values, pressed, axes))] = inputs(sent)
        self.assertEqual((number, standard, pressed, axes[0], values[0]), (0, True, 1, -32767, 255))
        # Nothing waiting is nothing to do; a report with no change sends nothing.
        self.assertTrue(found.readable(device))
        system.feed(path, (ev.EV_SYN, ev.SYN_REPORT, 0))
        found.readable(device)
        self.assertEqual(len(inputs(sent)), 1)

    def test_at_most_120_frames_a_second_and_the_latest_state_after_a_wait(self):
        system, clock, sent, found, _ = setup_pads(self)
        path = system.plug("event3", USB_PAD)
        found.scan()
        sent.clear()
        device = found.devices[path]
        clock.advance(1)
        for value in (100, 200, 300):
            system.feed(path, (ev.EV_ABS, ev.ABS_X, value), (ev.EV_SYN, ev.SYN_REPORT, 0))
            found.readable(device)
        self.assertEqual(len(inputs(sent)), 1)
        self.assertEqual(len(clock.timers), 1, "one wait, however many reports come in it")
        clock.advance(pads.INTERVAL)
        latest = inputs(sent)[-1][1][3][0]
        self.assertEqual(latest, layout.stick(300, ev.Axis(0, -32768, 32767)))
        self.assertEqual(len(inputs(sent)), 2)

    def test_events_the_kernel_dropped_are_read_again_from_the_device(self):
        system, clock, sent, found, _ = setup_pads(self)
        path = system.plug("event3", USB_PAD)
        found.scan()
        sent.clear()
        clock.advance(1)
        fd = system.feed(
            path,
            (ev.EV_KEY, ev.BTN_SOUTH, 1),
            (ev.EV_SYN, ev.SYN_DROPPED, 0),
            (ev.EV_KEY, ev.BTN_SOUTH, 0),
            (ev.EV_SYN, ev.SYN_REPORT, 0),
        )
        # What the device holds now: B down, the stick right.
        system.kernel.held[fd] = {ev.BTN_EAST}
        system.kernel.values[fd][ev.ABS_X] = 32767
        found.readable(found.devices[path])
        [(_, (_, _, pressed, axes))] = inputs(sent)
        self.assertEqual((pressed, axes[0]), (1 << 1, 32767))

    def test_a_device_opened_with_a_button_down_says_so(self):
        system, _, sent, found, _ = setup_pads(self)
        path = system.plug("event3", USB_PAD)
        original = system.open

        def opened(path_, flags):
            fd = original(path_, flags)
            system.kernel.held[fd] = {ev.BTN_START}
            return fd
        system.open = opened
        found.scan()
        self.assertEqual(inputs(sent)[0][1][2], 1 << 9)
        self.assertIn(path, found.devices)


class Rumble(unittest.TestCase):
    def test_rumble_uploads_an_effect_once_and_plays_it(self):
        system, _, _, found, _ = setup_pads(self)
        path = system.plug("event3", USB_PAD)
        found.scan()
        fd = system.fd_of(path)
        found.rumble(0, 200, 1.0, 0.25)
        found.rumble(0, 100, 0.5, 0.5)
        self.assertEqual(len(system.kernel.effects), 2)
        uploaded = system.kernel.effects[0][1]
        self.assertEqual(struct.unpack_from("=HhHHHHH", uploaded)[5], 200)
        self.assertEqual(struct.unpack_from("=HH", uploaded, 16), (0xFFFF, 0x4000))
        self.assertEqual(struct.unpack_from("=h", system.kernel.effects[1][1], 2)[0], 0, "the same effect, changed")
        play = ev.event(ev.EV_FF, 0, 1)
        self.assertEqual(system.written, [(fd, play), (fd, play)])
        found.rumble(0, 0, 0, 0)
        self.assertEqual(system.written[-1], (fd, ev.event(ev.EV_FF, 0, 0)))

    def test_no_rumble_where_there_is_none(self):
        system, _, _, found, _ = setup_pads(self)
        system.plug("event3", FLIGHT_STICK)
        found.scan()
        found.rumble(0, 200, 1, 1)
        found.rumble(7, 200, 1, 1)
        self.assertEqual((system.kernel.effects, system.written), ([], []))


if __name__ == "__main__":
    unittest.main()
