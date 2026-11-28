"""Linux input devices (evdev), as the box's controllers service reads them, all through fcntl.ioctl: a device's name,
ids, where it is plugged in and capabilities (EVIOCGNAME, EVIOCGID, EVIOCGPHYS, EVIOCGUNIQ, EVIOCGBIT, EVIOCGPROP), its
axes' ranges (EVIOCGABS), the state of its buttons (EVIOCGKEY), its events as the kernel writes them, and rumble (EV_FF
with FF_RUMBLE, EVIOCSFF).

The ioctl numbers are the kernel's asm-generic ones, which arm, arm64 and x86 share. Two of the kernel's structures are
as long as the system's C long or pointer: an event is 24 bytes on a 64-bit box and 16 on a 32-bit one, and a force
feedback effect 48 or 44.
"""

from __future__ import annotations

import fcntl
import struct
from collections.abc import Callable
from dataclasses import dataclass, field

_READ, _WRITE = 2, 1


def _ioc(direction: int, number: int, size: int) -> int:
    return direction << 30 | size << 16 | ord("E") << 8 | number


EV_SYN, EV_KEY, EV_ABS, EV_FF = 0x00, 0x01, 0x03, 0x15
SYN_REPORT, SYN_DROPPED = 0, 3
KEY_MAX, ABS_MAX, FF_MAX, PROP_MAX = 0x2FF, 0x3F, 0x7F, 0x1F
FF_RUMBLE = 0x50
INPUT_PROP_ACCELEROMETER = 0x06
BUS_USB, BUS_BLUETOOTH = 0x03, 0x05

BTN_MISC, BTN_MOUSE, BTN_JOYSTICK = 0x100, 0x110, 0x120
BTN_SOUTH, BTN_EAST, BTN_NORTH, BTN_WEST = 0x130, 0x131, 0x133, 0x134
BTN_TL, BTN_TR, BTN_TL2, BTN_TR2 = 0x136, 0x137, 0x138, 0x139
BTN_SELECT, BTN_START, BTN_MODE, BTN_THUMBL, BTN_THUMBR = 0x13A, 0x13B, 0x13C, 0x13D, 0x13E
BTN_TOOL_PEN, BTN_TOUCH = 0x140, 0x14A
BTN_DPAD_UP, BTN_DPAD_DOWN, BTN_DPAD_LEFT, BTN_DPAD_RIGHT = 0x220, 0x221, 0x222, 0x223
BTN_TRIGGER_HAPPY, BTN_TRIGGER_HAPPY40 = 0x2C0, 0x2E7
ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ = 0x00, 0x01, 0x02, 0x03, 0x04, 0x05
ABS_HAT0X, ABS_HAT0Y, ABS_HAT2X, ABS_HAT2Y = 0x10, 0x11, 0x14, 0x15
# Axes from ABS_MISC on are multi-touch and the like, which no controller's own axes are.
ABS_MISC = 0x28

EVIOCGID = _ioc(_READ, 0x02, 8)
EVIOCGABS = lambda axis: _ioc(_READ, 0x40 + axis, 24)  # noqa: E731  # the kernel's macro, as in its header
EVIOCGNAME = lambda length: _ioc(_READ, 0x06, length)  # noqa: E731  # the kernel's macro, as in its header
EVIOCGPHYS = lambda length: _ioc(_READ, 0x07, length)  # noqa: E731  # the kernel's macro, as in its header
EVIOCGUNIQ = lambda length: _ioc(_READ, 0x08, length)  # noqa: E731  # the kernel's macro, as in its header
EVIOCGPROP = lambda length: _ioc(_READ, 0x09, length)  # noqa: E731  # the kernel's macro, as in its header
EVIOCGKEY = lambda length: _ioc(_READ, 0x18, length)  # noqa: E731  # the kernel's macro, as in its header
EVIOCGBIT = lambda kind, length: _ioc(_READ, 0x20 + kind, length)  # noqa: E731  # the kernel's macro, as in its header
FF_EFFECT_SIZE = 48 if struct.calcsize("P") == 8 else 44
EVIOCSFF = _ioc(_WRITE, 0x80, FF_EFFECT_SIZE)
EVIOCRMFF = _ioc(_WRITE, 0x81, 4)
EVIOCGRAB = _ioc(_WRITE, 0x90, 4)

# struct input_event: the time as two C longs (native sizes), then type, code and value.
EVENT = struct.Struct("@llHHi")
NAME_BYTES = 256

Ioctl = Callable[..., object]


@dataclass(frozen=True)
class Axis:
    value: int
    minimum: int
    maximum: int


@dataclass
class Info:
    """What a device says it is: its name, bus, vendor and product, where it is plugged in (phys: a USB port's path) and
    its address (a Bluetooth device's own, in uniq), its buttons and axes in the kernel's order, and whether it can
    rumble or is a motion sensor."""

    name: str
    bus: int = 0
    uniq: str = ""
    phys: str = ""
    vendor: int = 0
    product: int = 0
    keys: list[int] = field(default_factory=list)
    axes: dict[int, Axis] = field(default_factory=dict)
    rumble: bool = False
    accelerometer: bool = False


def bits(data: bytes) -> list[int]:
    """The codes a kernel bitmap sets, lowest first."""
    return [index * 8 + bit for index, byte in enumerate(data) for bit in range(8) if byte >> bit & 1]


def _buffer(ioctl: Ioctl, fd: int, request: int, length: int) -> bytes:
    buffer = bytearray(length)
    ioctl(fd, request, buffer, True)
    return bytes(buffer)


def _text(data: bytes) -> str:
    return data.split(b"\0", 1)[0].decode("utf-8", "replace").strip()


def _optional(ioctl: Ioctl, fd: int, request: int) -> str:
    """A text a device may have none of (the kernel answers ENOENT)."""
    try:
        return _text(_buffer(ioctl, fd, request, 64))
    except OSError:
        return ""


def read_info(fd: int, ioctl: Ioctl = fcntl.ioctl) -> Info:
    """A device's name, ids and capabilities, as its ioctls answer them."""
    name = _text(_buffer(ioctl, fd, EVIOCGNAME(NAME_BYTES), NAME_BYTES))
    bus, vendor, product, _ = struct.unpack("=4H", _buffer(ioctl, fd, EVIOCGID, 8))
    uniq, phys = (_optional(ioctl, fd, request) for request in (EVIOCGUNIQ(64), EVIOCGPHYS(64)))
    kinds = set(bits(_buffer(ioctl, fd, EVIOCGBIT(0, 4), 4)))
    keys = bits(_buffer(ioctl, fd, EVIOCGBIT(EV_KEY, KEY_MAX // 8 + 1), KEY_MAX // 8 + 1)) if EV_KEY in kinds else []
    axes = {}
    if EV_ABS in kinds:
        for code in bits(_buffer(ioctl, fd, EVIOCGBIT(EV_ABS, ABS_MAX // 8 + 1), ABS_MAX // 8 + 1)):
            value, minimum, maximum = struct.unpack("=6i", _buffer(ioctl, fd, EVIOCGABS(code), 24))[:3]
            axes[code] = Axis(value, minimum, maximum)
    rumble = EV_FF in kinds and FF_RUMBLE in bits(
        _buffer(ioctl, fd, EVIOCGBIT(EV_FF, FF_MAX // 8 + 1), FF_MAX // 8 + 1)
    )
    try:
        props = bits(_buffer(ioctl, fd, EVIOCGPROP(PROP_MAX // 8 + 1), PROP_MAX // 8 + 1))
    except OSError:
        props = []
    return Info(
        name or "Controller", bus, uniq, phys, vendor, product, keys, axes, rumble, INPUT_PROP_ACCELEROMETER in props
    )


def pressed_keys(fd: int, ioctl: Ioctl = fcntl.ioctl) -> set[int]:
    """The buttons held down now (after events were dropped, or as a device opens)."""
    return set(bits(_buffer(ioctl, fd, EVIOCGKEY(KEY_MAX // 8 + 1), KEY_MAX // 8 + 1)))


def axis_values(fd: int, codes: list[int], ioctl: Ioctl = fcntl.ioctl) -> dict[int, int]:
    return {code: struct.unpack("=6i", _buffer(ioctl, fd, EVIOCGABS(code), 24))[0] for code in codes}


def is_controller(info: Info) -> bool:
    """A gamepad, joystick or wheel: buttons of a joystick or gamepad (or a d-pad's, or the numbered extra ones), and no
    motion sensor, touch surface, pen or mouse. The motion sensors and touchpads of some gamepads are their own devices,
    and stay out."""
    keys = set(info.keys)
    if info.accelerometer or keys & {BTN_TOUCH, BTN_TOOL_PEN, BTN_MOUSE}:
        return False
    return any(
        BTN_JOYSTICK <= key <= 0x13F
        or BTN_DPAD_UP <= key <= BTN_DPAD_RIGHT
        or BTN_TRIGGER_HAPPY <= key <= BTN_TRIGGER_HAPPY40
        for key in keys
    )


def is_standard(info: Info) -> bool:
    """Whether the kernel reports the device with the standard gamepad codes (Documentation/input/gamepad.rst): face
    buttons BTN_SOUTH and BTN_EAST, a left stick on ABS_X and ABS_Y, and a right stick, if any, on ABS_RX and ABS_RY. A
    pad with no ABS_RX and ABS_RY but both ABS_Z and ABS_RZ has its right stick there, as generic HID pads do: not the
    standard layout."""
    keys, axes = set(info.keys), info.axes
    if not {BTN_SOUTH, BTN_EAST} <= keys or ABS_X not in axes or ABS_Y not in axes:
        return False
    return (ABS_RX in axes and ABS_RY in axes) or not (ABS_Z in axes and ABS_RZ in axes)


def events(data: bytes, size: int = EVENT.size) -> list[tuple[int, int, int]]:
    """Each whole event in data as (type, code, value)."""
    layout = EVENT if size == EVENT.size else struct.Struct("=iiHHi" if size == 16 else "=qqHHi")
    return [layout.unpack_from(data, offset)[2:] for offset in range(0, len(data) - size + 1, size)]


def event(kind: int, code: int, value: int) -> bytes:
    return EVENT.pack(0, 0, kind, code, value)


def rumble_effect(effect: int, duration_ms: int, strong: float, weak: float) -> bytearray:
    """struct ff_effect for FF_RUMBLE: its id (-1 for a new one), the length it plays, and its two motors, 0 to 1."""

    def magnitude(value: float) -> int:
        return max(0, min(0xFFFF, round(value * 0xFFFF)))

    head = struct.pack(
        "=HhHHHHH2xHH",
        FF_RUMBLE,
        effect,
        0,
        0,
        0,
        max(0, min(5000, int(duration_ms))),
        0,
        magnitude(strong),
        magnitude(weak),
    )
    return bytearray(head.ljust(FF_EFFECT_SIZE, b"\0"))


def upload_rumble(
    fd: int, effect: int, duration_ms: int, strong: float, weak: float, ioctl: Ioctl = fcntl.ioctl
) -> int:
    """Uploads (or, with its id, changes) a rumble effect; the kernel writes back the id it plays by."""
    buffer = rumble_effect(effect, duration_ms, strong, weak)
    ioctl(fd, EVIOCSFF, buffer, True)
    return struct.unpack_from("=h", buffer, 2)[0]
