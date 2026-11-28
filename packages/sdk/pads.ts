// A pad's state on the wire: the binary frame phones, the box's controller service and the hosts all send, the same
// everywhere (the pads socket, packages/core/pads.ts). Zod-free, so the browser and a game's frame can read it.
//
//   u8  slot      the controller's place on its screen, 0..7 (the host writes it; a controller's own is ignored)
//   u8  flags     bit 0: the W3C Standard Gamepad layout; the other bits 0
//   u8  buttons   n, at most 32 (17 for the standard layout)
//   u8  axes      m, at most 8 (4 for the standard layout)
//   u32 pressed   little-endian, bit i = button i pressed
//   u8  value[n]  each button's value, 0..255 (255 = fully pressed)
//   i16 axis[m]   little-endian, -32767..32767 (= -1..1)

/** Controllers one screen holds. */
export const PAD_SLOTS = 8;
const PAD_BUTTONS = 32;
const PAD_AXES = 8;
/** The largest frame: 8 bytes of header, 32 values and 8 axes. */
export const MAX_PAD_FRAME = 8 + PAD_BUTTONS + 2 * PAD_AXES;
const STANDARD = 1;
const AXIS = 32_767;

/** One button as the Gamepad API has it: value 0..1. */
export type PadButton = { pressed: boolean; value: number };
/** A pad's state: its slot on its screen, whether it has the standard layout, its buttons and its axes (-1..1). */
export type PadState = { slot: number; standard: boolean; buttons: PadButton[]; axes: number[] };

const clamp = (value: number, low: number, high: number) =>
  Number.isNaN(value) ? 0 : Math.min(high, Math.max(low, value));

/** The frame of a state: at most 32 buttons and 8 axes (any more are left out), values and axes clamped to their range. */
export function encodePad(state: {
  slot?: number;
  standard: boolean;
  buttons: readonly PadButton[];
  axes: readonly number[];
}) {
  const buttons = state.buttons.slice(0, PAD_BUTTONS),
    axes = state.axes.slice(0, PAD_AXES);
  const frame = new Uint8Array(8 + buttons.length + 2 * axes.length);
  const view = new DataView(frame.buffer);
  frame[0] = clamp(Math.trunc(state.slot ?? 0), 0, PAD_SLOTS - 1);
  frame[1] = state.standard ? STANDARD : 0;
  frame[2] = buttons.length;
  frame[3] = axes.length;
  let pressed = 0;
  buttons.forEach((button, index) => {
    if (button.pressed) pressed |= 1 << index;
    frame[8 + index] = Math.round(clamp(button.value, 0, 1) * 255);
  });
  view.setUint32(4, pressed >>> 0, true);
  axes.forEach((axis, index) =>
    view.setInt16(8 + buttons.length + 2 * index, Math.round(clamp(axis, -1, 1) * AXIS), true),
  );
  return frame;
}

/** The state in a frame, or undefined for anything that isn't one: a slot past 7, other flags, more than 32 buttons or
 *  8 axes, a length that isn't theirs, a pressed bit past the last button, an axis of -32768. */
export function decodePad(frame: Uint8Array): PadState | undefined {
  if (frame.length < 8) return undefined;
  const [slot = 0, flags = 0, count = 0, axisCount = 0] = frame;
  if (
    slot >= PAD_SLOTS ||
    (flags & ~STANDARD) !== 0 ||
    count > PAD_BUTTONS ||
    axisCount > PAD_AXES ||
    frame.length !== 8 + count + 2 * axisCount
  )
    return undefined;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const pressed = view.getUint32(4, true);
  if (count < 32 && pressed >>> count !== 0) return undefined;
  const axes: number[] = [];
  for (let index = 0; index < axisCount; index++) {
    const axis = view.getInt16(8 + count + 2 * index, true);
    if (axis < -AXIS) return undefined;
    axes.push(axis / AXIS);
  }
  const buttons = Array.from(frame.subarray(8, 8 + count), (value, index) => ({
    pressed: ((pressed >>> index) & 1) === 1,
    value: value / 255,
  }));
  return { slot, standard: (flags & STANDARD) !== 0, buttons, axes };
}
