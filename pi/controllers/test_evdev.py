"""Input devices as the service reads them (evdev.py): the kernel's ioctl numbers, a device's capabilities from its
bitmaps, which devices are controllers and which have the standard layout, events in both sizes, and the rumble effect.

The devices here are recorded as their drivers report them: their names, ids, buttons, axes with their ranges, and
force feedback, which FakeKernel answers through the same ioctls the kernel does."""

import errno
import struct
import unittest
from dataclasses import dataclass, field

import evdev as ev


@dataclass
class Recorded:
    """A device as its ioctls answer: name, bus, unique id (a Bluetooth device's address), buttons, axes as (value,
    minimum, maximum), force feedback and properties."""

    name: str
    bus: int = ev.BUS_USB
    uniq: str = ""
    phys: str = "usb-0000:01:00.0-1.2/input0"
    keys: list = field(default_factory=list)
    axes: dict = field(default_factory=dict)
    ff: list = field(default_factory=list)
    props: list = field(default_factory=list)


STICK = (0, -32768, 32767)
HAT = (0, -1, 1)
# A USB pad as the xpad driver reports one: standard codes, triggers 0 to 255 on ABS_Z and ABS_RZ, the d-pad as a hat.
USB_PAD = Recorded(
    "USB gamepad",
    keys=[ev.BTN_SOUTH, ev.BTN_EAST, ev.BTN_NORTH, ev.BTN_WEST, ev.BTN_TL, ev.BTN_TR, ev.BTN_SELECT, ev.BTN_START,
          ev.BTN_MODE, ev.BTN_THUMBL, ev.BTN_THUMBR],
    axes={ev.ABS_X: STICK, ev.ABS_Y: STICK, ev.ABS_Z: (0, 0, 255), ev.ABS_RX: STICK, ev.ABS_RY: STICK,
          ev.ABS_RZ: (0, 0, 255), ev.ABS_HAT0X: HAT, ev.ABS_HAT0Y: HAT},
    ff=[ev.FF_RUMBLE, 0x51, 0x52, 0x53])
# A Bluetooth pad as hid-playstation reports one, sticks 0 to 255 centred at 128; its motion sensors and touchpad are
# devices of their own.
BT_PAD = Recorded(
    "Wireless Controller", bus=ev.BUS_BLUETOOTH, uniq="a0:b1:c2:d3:e4:f5", phys="b8:27:eb:00:00:01",
    keys=[ev.BTN_SOUTH, ev.BTN_EAST, ev.BTN_NORTH, ev.BTN_WEST, ev.BTN_TL, ev.BTN_TR, ev.BTN_TL2, ev.BTN_TR2,
          ev.BTN_SELECT, ev.BTN_START, ev.BTN_MODE, ev.BTN_THUMBL, ev.BTN_THUMBR],
    axes={ev.ABS_X: (128, 0, 255), ev.ABS_Y: (128, 0, 255), ev.ABS_Z: (0, 0, 255), ev.ABS_RX: (128, 0, 255),
          ev.ABS_RY: (128, 0, 255), ev.ABS_RZ: (0, 0, 255), ev.ABS_HAT0X: HAT, ev.ABS_HAT0Y: HAT},
    ff=[ev.FF_RUMBLE])
BT_PAD_MOTION = Recorded("Wireless Controller Motion Sensors", bus=ev.BUS_BLUETOOTH, uniq="a0:b1:c2:d3:e4:f5",
                         axes={code: (0, -32768, 32767) for code in range(6)}, props=[ev.INPUT_PROP_ACCELEROMETER])
BT_PAD_TOUCHPAD = Recorded("Wireless Controller Touchpad", bus=ev.BUS_BLUETOOTH, uniq="a0:b1:c2:d3:e4:f5",
                           keys=[ev.BTN_MOUSE, 0x145, ev.BTN_TOUCH, 0x14D], axes={ev.ABS_X: (0, 0, 1919), ev.ABS_Y: (0, 0, 1079)})
KEYBOARD = Recorded("USB keyboard", keys=list(range(1, 128)))
# A flight stick as hid-generic reports one: joystick buttons from BTN_TRIGGER, a twist on ABS_RZ and a throttle.
FLIGHT_STICK = Recorded("Flight stick", keys=list(range(0x120, 0x12C)),
                        axes={ev.ABS_X: (512, 0, 1023), ev.ABS_Y: (512, 0, 1023), ev.ABS_RZ: (128, 0, 255),
                              0x06: (0, 0, 255), ev.ABS_HAT0X: HAT, ev.ABS_HAT0Y: HAT})
# A generic HID pad: gamepad buttons, and its right stick on ABS_Z and ABS_RZ.
HID_PAD = Recorded("Generic gamepad",
                   keys=[ev.BTN_SOUTH, ev.BTN_EAST, 0x132, ev.BTN_NORTH, ev.BTN_WEST, 0x135, ev.BTN_TL, ev.BTN_TR,
                         ev.BTN_TL2, ev.BTN_TR2, ev.BTN_SELECT, ev.BTN_START],
                   axes={ev.ABS_X: (128, 0, 255), ev.ABS_Y: (128, 0, 255), ev.ABS_Z: (128, 0, 255),
                         ev.ABS_RZ: (128, 0, 255), ev.ABS_HAT0X: HAT, ev.ABS_HAT0Y: HAT})
# A wheel: its own buttons, the wheel on ABS_X and pedals.
WHEEL = Recorded("Racing wheel", keys=list(range(0x120, 0x130)) + [0x2C0, 0x2C1],
                 axes={ev.ABS_X: (32768, 0, 65535), ev.ABS_Y: (255, 0, 255), ev.ABS_Z: (255, 0, 255),
                       ev.ABS_RZ: (255, 0, 255)}, ff=[0x52])


def bitmap(codes, length: int) -> bytes:
    data = bytearray(length)
    for code in codes:
        data[code // 8] |= 1 << code % 8
    return bytes(data)


class FakeKernel:
    """The ioctls of open devices, by file descriptor, answered from their recordings as the kernel answers them, and
    what was asked: grabs, uploaded effects."""

    def __init__(self):
        self.devices: dict[int, Recorded] = {}
        self.held: dict[int, set] = {}
        self.values: dict[int, dict] = {}
        self.grabbed: list[int] = []
        self.effects: list[tuple[int, bytes]] = []
        self.next_effect = 0

    def attach(self, fd: int, device: Recorded) -> None:
        self.devices[fd] = device
        self.held[fd] = set()
        self.values[fd] = {code: axis[0] for code, axis in device.axes.items()}

    def __call__(self, fd, request, argument=0, mutate=True):
        device = self.devices[fd]
        number, size = request & 0xFF, request >> 16 & 0x3FFF
        if number == 0x90:
            self.grabbed.append(fd)
            return 0
        if number == 0x80:
            effect = struct.unpack_from("=h", argument, 2)[0]
            if effect < 0:
                effect, self.next_effect = self.next_effect, self.next_effect + 1
                struct.pack_into("=h", argument, 2, effect)
            self.effects.append((fd, bytes(argument)))
            return 0
        if number == 0x06:
            answer = device.name.encode() + b"\0"
        elif number == 0x02:
            answer = struct.pack("=4H", device.bus, 0x1234, 0x5678, 0x0100)
        elif number in (0x07, 0x08):
            text = device.phys if number == 0x07 else device.uniq
            if not text:
                raise OSError(errno.ENOENT, "No such file or directory")
            answer = text.encode() + b"\0"
        elif number == 0x09:
            answer = bitmap(device.props, size)
        elif number == 0x18:
            answer = bitmap(self.held[fd], size)
        elif number == 0x20:
            kinds = [ev.EV_SYN] + [kind for kind, has in ((ev.EV_KEY, device.keys), (ev.EV_ABS, device.axes),
                                                          (ev.EV_FF, device.ff)) if has]
            answer = bitmap(kinds, size)
        elif number == 0x20 + ev.EV_KEY:
            answer = bitmap(device.keys, size)
        elif number == 0x20 + ev.EV_ABS:
            answer = bitmap(device.axes, size)
        elif number == 0x20 + ev.EV_FF:
            answer = bitmap(device.ff, size)
        elif 0x40 <= number < 0x80:
            _, minimum, maximum = device.axes[number - 0x40]
            answer = struct.pack("=6i", self.values[fd][number - 0x40], minimum, maximum, 0, 0, 0)
        else:
            raise OSError(errno.EINVAL, "Invalid argument")
        argument[:size] = answer[:size].ljust(size, b"\0")
        return 0


def info_of(device: Recorded) -> ev.Info:
    kernel = FakeKernel()
    kernel.attach(3, device)
    return ev.read_info(3, kernel)


def recording(*items, size: int = ev.EVENT.size) -> bytes:
    """Events as the kernel writes them, a millisecond apart."""
    layout = struct.Struct("=qqHHi" if size == 24 else "=iiHHi")
    return b"".join(layout.pack(1700000000, index * 1000, *item) for index, item in enumerate(items))


class Ioctls(unittest.TestCase):
    def test_the_numbers_are_the_kernels(self):
        self.assertEqual(ev.EVIOCGID, 0x80084502)
        self.assertEqual(ev.EVIOCGNAME(256), 0x81004506)
        self.assertEqual(ev.EVIOCGPHYS(64), 0x80404507)
        self.assertEqual(ev.EVIOCGBIT(ev.EV_KEY, 96), 0x80604521)
        self.assertEqual(ev.EVIOCGABS(ev.ABS_RZ), 0x80184545)
        self.assertEqual(ev.EVIOCGKEY(96), 0x80604518)
        self.assertEqual(ev.EVIOCGRAB, 0x40044590)
        # struct ff_effect holds a pointer: 48 bytes on a 64-bit box, 44 on a 32-bit one, and the number says so.
        self.assertEqual(ev.EVIOCSFF, 0x40304580 if struct.calcsize("P") == 8 else 0x402C4580)

    def test_a_device_reads_as_its_driver_reports_it(self):
        info = info_of(BT_PAD)
        self.assertEqual((info.name, info.bus, info.uniq), ("Wireless Controller", ev.BUS_BLUETOOTH, "a0:b1:c2:d3:e4:f5"))
        self.assertEqual((info.vendor, info.product), (0x1234, 0x5678))
        self.assertEqual(info_of(USB_PAD).phys, "usb-0000:01:00.0-1.2/input0")
        self.assertEqual(info.keys, sorted(BT_PAD.keys))
        self.assertEqual(info.axes[ev.ABS_X], ev.Axis(128, 0, 255))
        self.assertTrue(info.rumble)
        self.assertFalse(info.accelerometer)
        plain = info_of(KEYBOARD)
        self.assertEqual((plain.uniq, plain.axes, plain.rumble), ("", {}, False))
        self.assertFalse(info_of(WHEEL).rumble, "force feedback without FF_RUMBLE is no rumble")

    def test_bitmaps_read_lowest_first(self):
        self.assertEqual(ev.bits(bytes([0b101, 0, 0x80])), [0, 2, 23])


class Kinds(unittest.TestCase):
    def test_gamepads_joysticks_and_wheels_are_controllers_and_nothing_else_is(self):
        for device in (USB_PAD, BT_PAD, FLIGHT_STICK, HID_PAD, WHEEL):
            self.assertTrue(ev.is_controller(info_of(device)), device.name)
        for device in (BT_PAD_MOTION, BT_PAD_TOUCHPAD, KEYBOARD):
            self.assertFalse(ev.is_controller(info_of(device)), device.name)

    def test_the_standard_layout_is_the_kernels_standard_codes(self):
        self.assertTrue(ev.is_standard(info_of(USB_PAD)))
        self.assertTrue(ev.is_standard(info_of(BT_PAD)))
        # Its right stick on ABS_Z and ABS_RZ: its own layout.
        self.assertFalse(ev.is_standard(info_of(HID_PAD)))
        self.assertFalse(ev.is_standard(info_of(FLIGHT_STICK)))
        self.assertFalse(ev.is_standard(info_of(WHEEL)))
        # One stick and no right stick at all is still the standard layout.
        one_stick = Recorded("Mini pad", keys=[ev.BTN_SOUTH, ev.BTN_EAST, ev.BTN_START], axes={ev.ABS_X: STICK, ev.ABS_Y: STICK})
        self.assertTrue(ev.is_standard(info_of(one_stick)))


class Events(unittest.TestCase):
    def test_events_read_in_the_systems_size_and_the_other(self):
        items = [(ev.EV_KEY, ev.BTN_SOUTH, 1), (ev.EV_ABS, ev.ABS_X, -32768), (ev.EV_SYN, ev.SYN_REPORT, 0)]
        self.assertEqual(ev.events(recording(*items)), items)
        for size in (16, 24):
            self.assertEqual(ev.events(recording(*items, size=size), size), items)
        # A piece of an event is not one.
        self.assertEqual(ev.events(recording(*items)[:-3]), items[:2])

    def test_a_rumble_effect_is_struct_ff_effect(self):
        effect = ev.rumble_effect(-1, 250, 1.0, 0.5)
        self.assertEqual(len(effect), ev.FF_EFFECT_SIZE)
        self.assertEqual(struct.unpack_from("=HhHHHHH", effect), (ev.FF_RUMBLE, -1, 0, 0, 0, 250, 0))
        # The union starts at 16: strong, then weak.
        self.assertEqual(struct.unpack_from("=HH", effect, 16), (0xFFFF, 0x8000))
        self.assertEqual(struct.unpack_from("=HhHHHHH", ev.rumble_effect(3, 9000, 2, -1))[5], 5000)
        self.assertEqual(struct.unpack_from("=HH", ev.rumble_effect(3, 100, 2, -1), 16), (0xFFFF, 0))

    def test_uploading_reads_back_the_id_the_kernel_gave(self):
        kernel = FakeKernel()
        kernel.attach(5, USB_PAD)
        self.assertEqual(ev.upload_rumble(5, -1, 100, 1, 1, kernel), 0)
        self.assertEqual(ev.upload_rumble(5, 0, 100, 0.2, 0.2, kernel), 0)
        self.assertEqual(ev.upload_rumble(5, -1, 100, 1, 1, kernel), 1)


if __name__ == "__main__":
    unittest.main()
