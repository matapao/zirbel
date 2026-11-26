"""A controller's state in pad frames (layout.py): the standard layout from the kernel's standard codes, triggers and
the d-pad however a device reports them, every axis normalized by its range, and the device's own buttons and axes in
the kernel's order otherwise; and the pad state's bytes."""

import struct
import unittest

import evdev as ev
import layout
from test_evdev import BT_PAD, FLIGHT_STICK, HID_PAD, STICK, USB_PAD, Recorded, info_of


def play(device: Recorded, *items) -> tuple[bool, list, int, list]:
    state = layout.Layout(info_of(device))
    for item in items:
        state.update(*item)
    return layout.decode(state.frame())


class Standard(unittest.TestCase):
    def test_a_pad_at_rest_is_centred_with_nothing_pressed(self):
        for device in (USB_PAD, BT_PAD):
            standard, values, pressed, axes = play(device)
            self.assertTrue(standard)
            self.assertEqual((len(values), len(axes)), (17, 4))
            self.assertEqual((pressed, values), (0, [0] * 17))
            # A 0 to 255 stick rests at 128, a hair off its middle.
            self.assertTrue(all(abs(value) <= 129 for value in axes), axes)

    def test_buttons_go_to_their_places_in_the_standard_layout(self):
        places = {ev.BTN_SOUTH: 0, ev.BTN_EAST: 1, ev.BTN_WEST: 2, ev.BTN_NORTH: 3, ev.BTN_TL: 4, ev.BTN_TR: 5,
                  ev.BTN_SELECT: 8, ev.BTN_START: 9, ev.BTN_THUMBL: 10, ev.BTN_THUMBR: 11, ev.BTN_MODE: 16}
        for code, place in places.items():
            _, values, pressed, _ = play(USB_PAD, (ev.EV_KEY, code, 1))
            self.assertEqual(pressed, 1 << place, hex(code))
            self.assertEqual(values[place], 255)
        _, _, pressed, _ = play(USB_PAD, (ev.EV_KEY, ev.BTN_SOUTH, 1), (ev.EV_KEY, ev.BTN_SOUTH, 0))
        self.assertEqual(pressed, 0)

    def test_sticks_are_normalized_by_their_range(self):
        _, _, _, axes = play(USB_PAD, (ev.EV_ABS, ev.ABS_X, -32768), (ev.EV_ABS, ev.ABS_Y, 32767),
                             (ev.EV_ABS, ev.ABS_RX, 16384), (ev.EV_ABS, ev.ABS_RY, 0))
        self.assertEqual(axes[:2], [-32767, 32767])
        self.assertAlmostEqual(axes[2] / 32767, 0.5, places=3)
        self.assertEqual(axes[3], 0)
        _, _, _, axes = play(BT_PAD, (ev.EV_ABS, ev.ABS_X, 0), (ev.EV_ABS, ev.ABS_Y, 255))
        self.assertEqual(axes[:2], [-32767, 32767])

    def test_analog_triggers_count_as_pressed_past_a_little(self):
        _, values, pressed, _ = play(USB_PAD, (ev.EV_ABS, ev.ABS_Z, 20), (ev.EV_ABS, ev.ABS_RZ, 255))
        self.assertEqual((values[6], values[7]), (20, 255))
        self.assertEqual(pressed, 1 << 7)
        _, values, pressed, _ = play(USB_PAD, (ev.EV_ABS, ev.ABS_Z, 128))
        self.assertEqual((values[6], pressed), (128, 1 << 6))
        # A pad with both: its digital trigger presses fully, its axis says how far.
        _, values, pressed, _ = play(BT_PAD, (ev.EV_ABS, ev.ABS_RZ, 90), (ev.EV_KEY, ev.BTN_TR2, 1))
        self.assertEqual((values[7], pressed), (255, 1 << 7))

    def test_digital_triggers_and_hat_triggers(self):
        digital = Recorded("Digital", keys=[ev.BTN_SOUTH, ev.BTN_EAST, ev.BTN_TL2, ev.BTN_TR2],
                           axes={ev.ABS_X: STICK, ev.ABS_Y: STICK})
        _, values, pressed, _ = play(digital, (ev.EV_KEY, ev.BTN_TL2, 1))
        self.assertEqual((values[6], pressed), (255, 1 << 6))
        hats = Recorded("Hat triggers", keys=[ev.BTN_SOUTH, ev.BTN_EAST],
                        axes={ev.ABS_X: STICK, ev.ABS_Y: STICK, ev.ABS_HAT2X: (0, 0, 100), ev.ABS_HAT2Y: (0, 0, 100)})
        _, values, pressed, _ = play(hats, (ev.EV_ABS, ev.ABS_HAT2Y, 50), (ev.EV_ABS, ev.ABS_HAT2X, 100))
        self.assertEqual((values[6], values[7], pressed), (128, 255, 1 << 6 | 1 << 7))

    def test_the_dpad_from_a_hat_or_its_own_buttons(self):
        _, _, pressed, _ = play(USB_PAD, (ev.EV_ABS, ev.ABS_HAT0Y, -1), (ev.EV_ABS, ev.ABS_HAT0X, 1))
        self.assertEqual(pressed, 1 << 12 | 1 << 15)
        _, _, pressed, _ = play(USB_PAD, (ev.EV_ABS, ev.ABS_HAT0Y, 1), (ev.EV_ABS, ev.ABS_HAT0X, -1))
        self.assertEqual(pressed, 1 << 13 | 1 << 14)
        buttons = Recorded("D-pad buttons", keys=[ev.BTN_SOUTH, ev.BTN_EAST, ev.BTN_DPAD_UP, ev.BTN_DPAD_DOWN,
                                                  ev.BTN_DPAD_LEFT, ev.BTN_DPAD_RIGHT], axes={ev.ABS_X: STICK, ev.ABS_Y: STICK})
        _, values, pressed, _ = play(buttons, (ev.EV_KEY, ev.BTN_DPAD_LEFT, 1))
        self.assertEqual((pressed, values[14]), (1 << 14, 255))

    def test_a_state_read_again_replaces_the_one_kept(self):
        state = layout.Layout(info_of(USB_PAD))
        state.update(ev.EV_KEY, ev.BTN_SOUTH, 1)
        state.reset({ev.BTN_EAST}, {ev.ABS_X: 32767})
        _, values, pressed, axes = layout.decode(state.frame())
        self.assertEqual((pressed, axes[0]), (1 << 1, 32767))
        self.assertIn(ev.ABS_Z, state.codes())


class Own(unittest.TestCase):
    def test_another_device_keeps_its_buttons_and_axes_in_the_kernels_order(self):
        standard, values, pressed, axes = play(FLIGHT_STICK, (ev.EV_KEY, 0x120, 1), (ev.EV_KEY, 0x12B, 1),
                                               (ev.EV_ABS, ev.ABS_X, 0), (ev.EV_ABS, 0x06, 255), (ev.EV_ABS, ev.ABS_HAT0Y, 1))
        self.assertFalse(standard)
        self.assertEqual((len(values), len(axes)), (12, 6))
        self.assertEqual(pressed, 1 | 1 << 11)
        # X, Y, the twist (ABS_RZ), the throttle, then the hat's two axes.
        self.assertEqual(axes, [-32767, 32, 128, 32767, 0, 32767])

    def test_a_generic_pad_with_its_right_stick_on_z_is_its_own(self):
        standard, values, _, axes = play(HID_PAD, (ev.EV_KEY, ev.BTN_TL2, 1), (ev.EV_ABS, ev.ABS_Z, 255))
        self.assertFalse(standard)
        self.assertEqual(len(values), 12)
        self.assertEqual(values[8], 255, "its ninth button, BTN_TL2 in the kernel's order")
        self.assertEqual(axes[2], 32767, "its third axis, ABS_Z")

    def test_at_most_32_buttons_and_8_axes(self):
        many = Recorded("Big", keys=list(range(0x120, 0x130)) + list(range(0x2C0, 0x2D8)),
                        axes={code: (0, 0, 10) for code in range(0x10)})
        _, values, _, axes = play(many)
        self.assertEqual((len(values), len(axes)), (32, 8))


class Bytes(unittest.TestCase):
    def test_a_pad_state_is_little_endian_as_the_host_reads_it(self):
        frame = layout.encode(True, [255, 0, 128], 0b101, [-32767, 32767])
        self.assertEqual(frame[:4], bytes([0, 1, 3, 2]))
        self.assertEqual(struct.unpack_from("<I", frame, 4)[0], 0b101)
        self.assertEqual(frame[8:11], bytes([255, 0, 128]))
        self.assertEqual(struct.unpack_from("<2h", frame, 11), (-32767, 32767))
        self.assertEqual(len(frame), 15)
        self.assertEqual(layout.decode(frame), (True, [255, 0, 128], 0b101, [-32767, 32767]))
        self.assertEqual(len(layout.Layout(info_of(USB_PAD)).frame()), 8 + 17 + 8)

    def test_anything_else_is_not_a_pad_state(self):
        good = layout.encode(False, [1], 0, [2])
        for bad in (good[:-1], good + b"\0", b"\0\x02" + good[2:], b"\0\0\x21\0" + bytes(4 + 33), b""):
            with self.assertRaises(ValueError):
                layout.decode(bad)


if __name__ == "__main__":
    unittest.main()
