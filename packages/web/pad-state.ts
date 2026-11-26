// A pad's state as Zirbel's pages pass it about: a pad frame's fields without its slot (packages/sdk/pads.ts), read from
// a device's own gamepad or from its keyboard, and checked again where it arrives (a game's frame, which never trusts its
// parent's messages). No Zod: the game frame's game-sdk.js imports this.
import { PAD_SLOTS, type PadButton, type PadState } from '../sdk/pads.ts';

/** The W3C Standard Gamepad layout: 17 buttons (A B X Y, LB RB LT RT, Select Start, the sticks' presses, the d-pad, Home)
 *  and 4 axes (the left stick's x and y, the right stick's). */
export const STANDARD_BUTTONS = 17;
export const STANDARD_AXES = 4;
/** The most buttons and axes a pad frame holds. */
const MAX_BUTTONS = 32;
const MAX_AXES = 8;
export type Pad = Omit<PadState, 'slot'>;
/** A screen's controller as its host lists it, and what the game's frame hears of it. */
export type PadEntry = { slot: number; kind: 'phone' | 'box'; name: string; connected: boolean };

/** Each slot's colour, which the pad page, the screen's panel and its list show alike. */
const SLOT_COLOURS = ['#f2c14e', '#5ab4f0', '#f0706a', '#79d48a', '#c595ee', '#f39c4a', '#4ccfc4', '#e9e4d0'] as const;
export const slotColour = (slot: number) => SLOT_COLOURS[slot % SLOT_COLOURS.length]!;
/** Text that reads on a place's colour (#rrggbb, which the game may choose): dark on a light colour, white on a dark one. */
export function inkOn(colour: string) {
  const [red, green, blue] = [1, 3, 5].map((at) => {
    const channel = parseInt(colour.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.18 ? '#111812' : '#ffffff';
}

const up = (): PadButton => ({ pressed: false, value: 0 });
export const down = (): PadButton => ({ pressed: true, value: 1 });
export const restingPad = (): Pad =>
  ({ standard: true, buttons: Array.from({ length: STANDARD_BUTTONS }, up), axes: Array<number>(STANDARD_AXES).fill(0) });

/** A device's own gamepad as a pad: its mapping, its buttons and its axes, as many as a frame holds. */
export function padOf(gamepad: Pick<Gamepad, 'mapping' | 'buttons' | 'axes'>): Pad {
  return { standard: gamepad.mapping === 'standard',
    buttons: [...gamepad.buttons].slice(0, MAX_BUTTONS).map(({ pressed, value }) => ({ pressed, value: value || (pressed ? 1 : 0) })),
    axes: [...gamepad.axes].slice(0, MAX_AXES) };
}

/** Whether two pads read the same, to the frame's own precision. */
export function samePad(a: Pad, b: Pad) {
  const close = (x: readonly number[], y: readonly number[], scale: number) =>
    x.length === y.length && x.every((value, index) => Math.round(value * scale) === Math.round(y[index]! * scale));
  return a.standard === b.standard && a.buttons.length === b.buttons.length &&
    a.buttons.every((button, index) => button.pressed === b.buttons[index]!.pressed) &&
    close(a.buttons.map(({ value }) => value), b.buttons.map(({ value }) => value), 255) && close(a.axes, b.axes, 32767);
}

// The keyboard as a pad, for a page that controls a game on another screen: arrows or WASD the left stick, Space A,
// ShiftLeft B, KeyE X, KeyQ Y, Enter Start, Escape Select.
const KEYBOARD_BUTTONS: Readonly<Record<string, number>> = { Space: 0, ShiftLeft: 1, KeyE: 2, KeyQ: 3, Escape: 8, Enter: 9 };
const KEYBOARD_STICK: Readonly<Record<string, readonly [axis: number, toward: number]>> = {
  ArrowLeft: [0, -1], KeyA: [0, -1], ArrowRight: [0, 1], KeyD: [0, 1], ArrowUp: [1, -1], KeyW: [1, -1], ArrowDown: [1, 1], KeyS: [1, 1],
};
const own = <T>(table: Readonly<Record<string, T>>, code: string) =>
  Object.prototype.hasOwnProperty.call(table, code) ? table[code] : undefined;
export const isPadKey = (code: string) => own(KEYBOARD_BUTTONS, code) !== undefined || own(KEYBOARD_STICK, code) !== undefined;

/** The pad a keyboard plays while these codes are held. */
export function keyboardPad(held: ReadonlySet<string>): Pad {
  const pad = restingPad();
  for (const code of held) {
    const button = own(KEYBOARD_BUTTONS, code);
    if (button !== undefined) pad.buttons[button] = down();
    const stick = own(KEYBOARD_STICK, code);
    if (stick) pad.axes[stick[0]] = Math.max(-1, Math.min(1, pad.axes[stick[0]]! + stick[1]));
  }
  // A diagonal reaches the stick's edge, not past it.
  const length = Math.hypot(pad.axes[0]!, pad.axes[1]!);
  if (length > 1) { pad.axes[0]! /= length; pad.axes[1]! /= length; }
  return pad;
}

const within = (value: unknown, low: number) => typeof value === 'number' && value >= low && value <= 1;
const isSlot = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < PAD_SLOTS;

/** A pad frame's state as a game's frame takes it from the page around it, or nothing. */
export function checkedFrame(value: unknown): PadState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { slot, standard, buttons, axes } = value as Record<string, unknown>;
  if (!isSlot(slot) || typeof standard !== 'boolean' || !Array.isArray(buttons) || buttons.length > MAX_BUTTONS ||
      !Array.isArray(axes) || axes.length > MAX_AXES || !axes.every((axis) => within(axis, -1))) return undefined;
  const checked: PadButton[] = [];
  for (const button of buttons as unknown[]) {
    const { pressed, value: level } = (typeof button === 'object' && button !== null ? button : {}) as Record<string, unknown>;
    if (typeof pressed !== 'boolean' || !within(level, 0)) return undefined;
    checked.push({ pressed, value: level as number });
  }
  return { slot, standard, buttons: checked, axes: [...axes as number[]] };
}

/** The places the page gave the device's own gamepads, as a game's frame takes them: each place once, or nothing. */
export function checkedLocal(value: unknown): { place: number; index: number; id: string }[] | undefined {
  if (!Array.isArray(value) || value.length > PAD_SLOTS) return undefined;
  const placed: { place: number; index: number; id: string }[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return undefined;
    const { place, index, id } = item as Record<string, unknown>;
    if (!isSlot(place) || !Number.isInteger(index) || (index as number) < 0 || (index as number) > 63 || typeof id !== 'string' ||
        id.length > 256 || placed.some((pad) => pad.place === place)) return undefined;
    placed.push({ place, index: index as number, id });
  }
  return placed;
}

/** A screen's list of controllers as a game's frame takes it: at most eight, each slot once, or nothing. */
export function checkedPads(value: unknown): PadEntry[] | undefined {
  if (!Array.isArray(value) || value.length > PAD_SLOTS) return undefined;
  const pads: PadEntry[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return undefined;
    const { slot, kind, name, connected } = item as Record<string, unknown>;
    if (!isSlot(slot) || (kind !== 'phone' && kind !== 'box') || typeof name !== 'string' || typeof connected !== 'boolean' ||
        pads.some((pad) => pad.slot === slot)) return undefined;
    pads.push({ slot, kind, name: name.slice(0, 64), connected });
  }
  return pads;
}
