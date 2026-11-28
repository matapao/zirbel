"""A controller's state as the host's pad frames carry it (the W3C Standard Gamepad layout where the kernel reports the
standard codes, else the device's own buttons and axes in the kernel's order), kept from its evdev events.

The standard layout: buttons A (south), B (east), X (west), Y (north), LB, RB, LT, RT, Select, Start, the two stick
presses, the d-pad's up, down, left and right, and Home; axes the left stick's x and y, then the right stick's. The
triggers are ABS_Z and ABS_RZ (or ABS_HAT2Y and ABS_HAT2X) where the device has them, else BTN_TL2 and BTN_TR2; the
d-pad is ABS_HAT0X and ABS_HAT0Y, or its own buttons. Each axis is normalized by its range: -1 to 1 for a stick, 0 to 1
for a trigger.

A pad state, the same in every pad frame (phones, this service, the screen), little-endian:
  u8 slot, u8 flags (bit 0: standard), u8 buttons n, u8 axes m, u32 pressed, u8 value[n], i16 axis[m]
"""

from __future__ import annotations

import struct

import evdev as ev

STANDARD_BUTTONS = [
    ev.BTN_SOUTH,
    ev.BTN_EAST,
    ev.BTN_WEST,
    ev.BTN_NORTH,
    ev.BTN_TL,
    ev.BTN_TR,
    ev.BTN_TL2,
    ev.BTN_TR2,
    ev.BTN_SELECT,
    ev.BTN_START,
    ev.BTN_THUMBL,
    ev.BTN_THUMBR,
    ev.BTN_DPAD_UP,
    ev.BTN_DPAD_DOWN,
    ev.BTN_DPAD_LEFT,
    ev.BTN_DPAD_RIGHT,
    ev.BTN_MODE,
]
STANDARD_AXES = [ev.ABS_X, ev.ABS_Y, ev.ABS_RX, ev.ABS_RY]
LT, RT, UP, DOWN, LEFT, RIGHT = 6, 7, 12, 13, 14, 15
MAX_BUTTONS, MAX_AXES = 32, 8
# A trigger pressed this far counts as pressed, as browsers count it.
TRIGGER_PRESSED = 30
FLAG_STANDARD = 1
HEAD = struct.Struct("<BBBBI")


def stick(value: int, axis: ev.Axis) -> int:
    """-32767 to 32767 for the axis's range."""
    if axis.maximum <= axis.minimum:
        return 0
    scaled = (2 * (value - axis.minimum) / (axis.maximum - axis.minimum) - 1) * 32767
    return max(-32767, min(32767, round(scaled)))


def trigger(value: int, axis: ev.Axis) -> int:
    """0 to 255 for the axis's range."""
    if axis.maximum <= axis.minimum:
        return 0
    return max(0, min(255, round(255 * (value - axis.minimum) / (axis.maximum - axis.minimum))))


def encode(standard: bool, values: list[int], pressed: int, axes: list[int], slot: int = 0) -> bytes:
    return (
        HEAD.pack(slot, FLAG_STANDARD if standard else 0, len(values), len(axes), pressed)
        + bytes(values)
        + struct.pack(f"<{len(axes)}h", *axes)
    )


def decode(data: bytes) -> tuple[bool, list[int], int, list[int]]:
    """A pad state's standard flag, button values, pressed bits and axes; ValueError for anything else."""
    if len(data) < HEAD.size:
        raise ValueError("short")
    _, flags, buttons, axes, pressed = HEAD.unpack_from(data)
    if (
        flags & ~FLAG_STANDARD
        or buttons > MAX_BUTTONS
        or axes > MAX_AXES
        or len(data) != HEAD.size + buttons + 2 * axes
    ):
        raise ValueError("not a pad state")
    values = list(data[HEAD.size : HEAD.size + buttons])
    return bool(flags), values, pressed, list(struct.unpack_from(f"<{axes}h", data, HEAD.size + buttons))


class Layout:
    """One device's mapping and its state now."""

    def __init__(self, info: ev.Info):
        self.info = info
        self.standard = ev.is_standard(info)
        axes = info.axes
        if self.standard:
            self.buttons = list(STANDARD_BUTTONS)
            self.axis_codes = list(STANDARD_AXES)
            self.triggers = {code: index for code, index in ((ev.ABS_Z, LT), (ev.ABS_RZ, RT)) if code in axes} or {
                code: index for code, index in ((ev.ABS_HAT2Y, LT), (ev.ABS_HAT2X, RT)) if code in axes
            }
            self.hats = {code for code in (ev.ABS_HAT0X, ev.ABS_HAT0Y) if code in axes}
        else:
            self.buttons = [key for key in info.keys if key >= ev.BTN_MISC][:MAX_BUTTONS]
            self.axis_codes = [code for code in sorted(axes) if code < ev.ABS_MISC][:MAX_AXES]
            self.triggers, self.hats = {}, set()
        self.button_index = {code: index for index, code in enumerate(self.buttons)}
        self.axis_index = {code: index for index, code in enumerate(self.axis_codes)}
        self.held = [False] * len(self.buttons)
        self.analog = [0] * len(self.buttons)
        self.hat = {ev.ABS_HAT0X: 0, ev.ABS_HAT0Y: 0}
        self.axes = [0] * len(self.axis_codes)
        self.reset(set(), {code: axis.value for code, axis in axes.items()})

    def codes(self) -> list[int]:
        """The axes whose values the state follows."""
        return [*self.axis_codes, *self.triggers, *self.hats]

    def reset(self, keys: set[int], values: dict[int, int]) -> None:
        """The whole state again, from the buttons held and the axes' values (as a device opens, or after the kernel
        dropped events)."""
        self.held = [code in keys for code in self.buttons]
        for code, value in values.items():
            self.update(ev.EV_ABS, code, value)

    def update(self, kind: int, code: int, value: int) -> None:
        if kind == ev.EV_KEY and code in self.button_index:
            self.held[self.button_index[code]] = value != 0
        elif kind != ev.EV_ABS or code not in self.info.axes:
            return
        elif code in self.axis_index:
            self.axes[self.axis_index[code]] = stick(value, self.info.axes[code])
        elif code in self.triggers:
            self.analog[self.triggers[code]] = trigger(value, self.info.axes[code])
        elif code in self.hats:
            self.hat[code] = (value > 0) - (value < 0)

    def state(self) -> tuple[list[int], int]:
        """Each button's value and the pressed bits: a held button is fully pressed, a trigger as far as it goes, and
        the d-pad its hat's direction or its own button."""
        values = [255 if held else analog for held, analog in zip(self.held, self.analog, strict=True)]
        if self.standard:
            for index, on in (
                (UP, self.hat[ev.ABS_HAT0Y] < 0),
                (DOWN, self.hat[ev.ABS_HAT0Y] > 0),
                (LEFT, self.hat[ev.ABS_HAT0X] < 0),
                (RIGHT, self.hat[ev.ABS_HAT0X] > 0),
            ):
                if on:
                    values[index] = 255
        pressed = 0
        for index, (held, value) in enumerate(zip(self.held, values, strict=True)):
            if held or value >= (TRIGGER_PRESSED if index in (LT, RT) and self.standard else 128):
                pressed |= 1 << index
        return values, pressed

    def frame(self) -> bytes:
        values, pressed = self.state()
        return encode(self.standard, values, pressed, self.axes)
