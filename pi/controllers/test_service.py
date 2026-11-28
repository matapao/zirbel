"""The service and the host (wire.py, host_link.py, view.py, zirbel_pads.py's Service), over a real local socket with a
fake host on it: the frames both ways, every device announced to a new connection and then the box's controllers, the
host's rumble and the owner's requests, connecting again after the host restarts, and the controllers' view fitted to a
control frame."""

import json
import os
import shutil
import socket
import struct
import tempfile
import unittest

import layout
import view
import wire
import zirbel_pads
from test_evdev import BT_PAD, USB_PAD
from test_pads import Clock, FakeSystem


class Frames(unittest.TestCase):
    def test_control_and_input_frames_are_a_length_then_their_kind(self):
        frame = wire.control({"type": "gone", "device": 3})
        self.assertEqual(struct.unpack_from("<H", frame)[0], len(frame) - 2)
        self.assertEqual(frame[2], wire.CONTROL)
        self.assertEqual(json.loads(frame[3:]), {"type": "gone", "device": 3})
        state = layout.encode(True, [255] * 17, 1, [0] * 4)
        frame = wire.pad_input(15, state)
        self.assertEqual(frame[:4], struct.pack("<H", 2 + len(state)) + bytes([wire.INPUT, 15]))
        with self.assertRaises(ValueError):
            wire.pad_input(16, state)
        with self.assertRaises(ValueError):
            wire.control({"type": "x", "text": "x" * 4096})

    def test_frames_are_read_as_they_arrive_in_pieces(self):
        stream = wire.control({"type": "rumble", "device": 1}) + wire.pad_input(2, b"\0\0\0\0\0\0\0\0")
        reader = wire.Reader()
        got = []
        for index in range(len(stream)):
            got += reader.feed(stream[index : index + 1])
        self.assertEqual(got, [{"type": "rumble", "device": 1}, (2, b"\0" * 8)])

    def test_a_frame_that_cant_be_one_is_refused(self):
        for bad in (
            b"\0\0",
            struct.pack("<H", 5000) + b"\0",
            b"\x02\0\x07x",
            b"\x03\0\0[]",
            b"\x03\0\0{x",
            struct.pack("<H", 70) + bytes([wire.INPUT]) + bytes(69),
        ):
            with self.assertRaises(wire.FrameError, msg=bad):
                wire.Reader().feed(bad)


PADS = [
    {"device": 0, "name": "USB gamepad", "kind": "usb"},
    {"device": 1, "name": "Wireless Controller", "kind": "bluetooth", "address": "A0:B1:C2:D3:E4:F5"},
]
BLUETOOTH = {
    "bluetooth": True,
    "scanning": True,
    "pairing": None,
    "error": None,
    "paired": [
        {"address": "A0:B1:C2:D3:E4:F5", "name": "DualPad", "connected": True},
        {"address": "11:22:33:44:55:66", "name": "Arcade stick", "connected": False},
    ],
    "found": [{"address": "77:88:99:AA:BB:CC", "name": "Pro pad"}, {"address": "A0:B1:C2:D3:E4:F5", "name": "DualPad"}],
}


class Listing(unittest.TestCase):
    def test_devices_and_paired_controllers_are_one_list(self):
        message = view.controllers(PADS, BLUETOOTH)
        self.assertEqual(
            message,
            {
                "type": "controllers",
                "devices": [
                    {"name": "USB gamepad", "kind": "usb", "connected": True, "device": 0},
                    {
                        "name": "Wireless Controller",
                        "kind": "bluetooth",
                        "connected": True,
                        "device": 1,
                        "address": "A0:B1:C2:D3:E4:F5",
                    },
                    {"name": "Arcade stick", "kind": "bluetooth", "connected": False, "address": "11:22:33:44:55:66"},
                ],
                "found": [{"address": "77:88:99:AA:BB:CC", "name": "Pro pad"}],
                "scanning": True,
                "bluetooth": True,
                "pairing": None,
                "error": None,
            },
        )
        self.assertEqual(
            view.controllers([], None),
            {
                "type": "controllers",
                "devices": [],
                "found": [],
                "scanning": False,
                "bluetooth": False,
                "pairing": None,
                "error": None,
            },
        )
        self.assertEqual(
            view.controllers([], dict(BLUETOOTH, error="BlueZ's"), "The service's")["error"], "The service's"
        )

    def test_the_view_fits_a_control_frame(self):
        long = "Ж" * 64
        many = dict(
            BLUETOOTH,
            found=[{"address": f"77:88:99:AA:BB:{index:02X}", "name": long} for index in range(12)],
            paired=[
                {"address": f"11:22:33:44:55:{index:02X}", "name": long, "connected": False} for index in range(12)
            ],
        )
        pads = [{"device": index, "name": long, "kind": "usb"} for index in range(16)]
        message = view.controllers(pads, many, "x" * 500)
        self.assertTrue(wire.fits(message))
        self.assertEqual(message["found"], [], "the found ones go first")
        self.assertEqual(len(message["error"]), view.ERROR_CHARS)
        self.assertGreater(len(message["devices"]), 10)


class FakeBluetooth:
    def __init__(self):
        self.asked = []

    def view(self):
        return dict(BLUETOOTH, paired=[], found=[])

    def scan(self, on):
        self.asked.append(("scan", on))

    def pair(self, address):
        self.asked.append(("pair", address))

    def forget(self, address):
        self.asked.append(("forget", address))


class Host:
    """The host's side of the local socket."""

    def __init__(self, test: unittest.TestCase):
        folder = tempfile.mkdtemp(prefix="zp")
        test.addCleanup(shutil.rmtree, folder)
        self.path = os.path.join(folder, "host.sock")
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        test.addCleanup(self.server.close)
        self.server.bind(self.path)
        self.server.listen(1)
        self.conn: socket.socket | None = None
        self.reader = wire.Reader()
        test.addCleanup(lambda: self.conn and self.conn.close())

    def accept(self):
        self.conn, _ = self.server.accept()
        self.conn.settimeout(2)
        self.reader = wire.Reader()

    def frames(self, count: int) -> list:
        got: list = []
        while len(got) < count:
            got += self.reader.feed(self.conn.recv(65536))
        return got

    def send(self, message: dict) -> None:
        self.conn.sendall(wire.control(message))


def service_for(test: unittest.TestCase, host: Host):
    system, clock = FakeSystem(), Clock()
    service = zirbel_pads.Service(host.path, clock.later, lambda timer: None, "/dev/input", system)
    service.pads.log = service.link.log = lambda text: None
    test.addCleanup(service.link.close)
    return service, system, clock


class Service(unittest.TestCase):
    def test_a_new_connection_hears_of_every_device_then_of_the_controllers(self):
        host = Host(self)
        service, system, _ = service_for(self, host)
        system.plug("event3", USB_PAD)
        system.plug("event5", BT_PAD)
        service.pads.scan()
        self.assertTrue(service.link.open())
        host.accept()
        device, state, other, _, listing = host.frames(5)
        self.assertEqual(
            device,
            {
                "type": "device",
                "device": 0,
                "name": "USB gamepad",
                "standard": True,
                "uid": "usb-0000:01:00.0-1.2/input0",
            },
        )
        self.assertEqual(state[0], 0)
        self.assertEqual(other["device"], 1)
        self.assertEqual(listing["type"], "controllers")
        self.assertEqual([item["device"] for item in listing["devices"]], [0, 1])
        self.assertFalse(listing["bluetooth"])

    def test_the_hosts_rumble_and_the_owners_requests(self):
        host = Host(self)
        service, system, _ = service_for(self, host)
        path = system.plug("event3", USB_PAD)
        service.pads.scan()
        service.link.open()
        host.accept()
        host.frames(3)
        host.send({"type": "rumble", "device": 0, "duration": 300, "strong": 1, "weak": 0.5})
        for bad in (
            {"type": "rumble", "device": 0, "duration": 9000, "strong": 1, "weak": 1},
            {"type": "rumble", "device": 0, "duration": 100, "strong": 2, "weak": 0},
            {"type": "rumble", "device": "0", "duration": 100, "strong": 1, "weak": 0},
            {"type": "rumble", "device": 0, "duration": 100, "strong": True, "weak": 0},
        ):
            host.send(bad)
        host.send({"type": "pair", "address": "11:22:33:44:55:66"})
        service.link.readable()
        self.assertEqual(len(system.written), 1, "one rumble played, the others refused")
        self.assertEqual(system.written[0][0], system.fd_of(path))
        [answer] = host.frames(1)
        self.assertEqual(answer["error"], view.NO_BLUETOOTH)
        service.bluetooth = FakeBluetooth()
        for message in (
            {"type": "scan", "on": True},
            {"type": "pair", "address": "11:22:33:44:55:66"},
            {"type": "forget", "address": "11:22:33:44:55:66"},
            {"type": "scan", "on": "yes"},
            {"type": "pair", "address": "11:22:33:44:55:6g"},
            {"type": "something"},
        ):
            host.send(message)
        service.link.readable()
        self.assertEqual(
            service.bluetooth.asked, [("scan", True), ("pair", "11:22:33:44:55:66"), ("forget", "11:22:33:44:55:66")]
        )
        answers = host.frames(5)
        self.assertEqual(
            [answer["error"] for answer in answers], [None, None, None, zirbel_pads.UNKNOWN, zirbel_pads.UNKNOWN]
        )
        self.assertTrue(answers[0]["scanning"])

    def test_the_service_connects_again_after_the_host_restarts(self):
        host = Host(self)
        service, system, _ = service_for(self, host)
        system.plug("event3", USB_PAD)
        service.pads.scan()
        self.assertTrue(service.link.open())
        host.accept()
        host.frames(3)
        host.conn.close()
        host.conn = None
        self.assertFalse(service.link.readable())
        self.assertFalse(service.link.connected)
        self.assertFalse(service.link.send(b"\0"))
        self.assertTrue(service.link.open())
        host.accept()
        self.assertEqual(host.frames(3)[0]["type"], "device")

    def test_a_host_that_sends_what_isnt_a_frame_is_left(self):
        host = Host(self)
        service, _, _ = service_for(self, host)
        service.link.open()
        host.accept()
        host.frames(1)
        host.conn.sendall(b"\xff\xff")
        self.assertFalse(service.link.readable())
        self.assertFalse(service.link.connected)

    def test_no_host_yet_is_tried_again_later(self):
        folder = tempfile.mkdtemp(prefix="zp")
        self.addCleanup(shutil.rmtree, folder)
        service = zirbel_pads.Service(
            os.path.join(folder, "host.sock"), Clock().later, lambda timer: None, "/dev/input", FakeSystem()
        )
        self.assertFalse(service.link.open())
        self.assertFalse(service.link.readable())
        service.report()


if __name__ == "__main__":
    unittest.main()
