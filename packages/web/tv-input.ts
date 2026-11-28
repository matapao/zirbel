// How the TV page (tv.ts) is moved around: a TV remote's or a keyboard's keys, and any gamepad's d-pad or left stick,
// A and B, whether the gamepad is the device's own (the Gamepad API) or one of its screen's controllers (a phone, a
// gamepad on the box). Each becomes a command; a held direction repeats as a held key does.

export type Command = 'up' | 'down' | 'left' | 'right' | 'choose' | 'back';
/** A gamepad as the navigator reads it: its pressed buttons as a bitmask, its axes from -1 to 1, its layout. */
export type PadInput = { standard: boolean; pressed: number; axes: readonly number[] };

/** The standard layout's buttons: A, B, Select, Start, and the d-pad. */
const A = 0,
  B = 1,
  SELECT = 8,
  START = 9,
  UP = 12,
  DOWN = 13,
  LEFT = 14,
  RIGHT = 15;
const STICK = 0.5;
const held = (input: PadInput, button: number) => (input.pressed & (1 << button)) !== 0;

/** The direction a gamepad holds: its d-pad, or its left stick past halfway (the larger of its two axes). */
export function direction(input: PadInput): Command | undefined {
  if (input.standard) {
    if (held(input, UP)) return 'up';
    if (held(input, DOWN)) return 'down';
    if (held(input, LEFT)) return 'left';
    if (held(input, RIGHT)) return 'right';
  }
  const x = input.axes[0] ?? 0,
    y = input.axes[1] ?? 0;
  if (Math.max(Math.abs(x), Math.abs(y)) < STICK) return undefined;
  if (Math.abs(x) >= Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'down' : 'up';
}

/** Turns gamepads' states into commands: A (or Start) chooses and B (or Select) goes back as they go down, and a
 *  direction moves at once, then again after delay and every repeat milliseconds while it is held. */
export class PadNavigator {
  private readonly pads = new Map<string, { input: PadInput; direction?: Command | undefined; next: number }>();

  private readonly emit: (command: Command, source: string) => void;
  private readonly delay: number;
  private readonly repeat: number;

  constructor(emit: (command: Command, source: string) => void, delay = 420, repeat = 140) {
    this.emit = emit;
    this.delay = delay;
    this.repeat = repeat;
  }

  /** A gamepad's state now, or none once it is gone. */
  update(source: string, input: PadInput | undefined, now: number) {
    const before = this.pads.get(source);
    if (!input) {
      this.pads.delete(source);
      return;
    }
    const pressed = (button: number) => held(input, button) && !(before && held(before.input, button));
    const going = direction(input);
    const next = going && going !== before?.direction ? now + this.delay : (before?.next ?? 0);
    this.pads.set(source, { input, direction: going, next });
    if (going && going !== before?.direction) this.emit(going, source);
    if (pressed(A) || (input.standard && pressed(START))) this.emit('choose', source);
    if (pressed(B) || (input.standard && pressed(SELECT))) this.emit('back', source);
  }

  /** The held directions that repeat by now. */
  tick(now: number) {
    for (const [source, pad] of this.pads) {
      if (!pad.direction || now < pad.next) continue;
      pad.next = Math.max(pad.next + this.repeat, now);
      this.emit(pad.direction, source);
    }
  }

  /** Whether a gamepad has any button down (it takes a place on its first press). */
  static pressing(input: PadInput) {
    return input.pressed !== 0;
  }
}

/** A key's command: arrows move, Enter (a remote's OK) chooses, Escape, Backspace and the Back keys TVs send go back. */
export function keyCommand(event: { key: string; keyCode?: number | undefined }): Command | undefined {
  switch (event.key) {
    case 'ArrowUp':
    case 'Up':
      return 'up';
    case 'ArrowDown':
    case 'Down':
      return 'down';
    case 'ArrowLeft':
    case 'Left':
      return 'left';
    case 'ArrowRight':
    case 'Right':
      return 'right';
    case 'Enter':
    case 'Accept':
    case 'Select':
      return 'choose';
    case 'Escape':
    case 'Esc':
    case 'Backspace':
    case 'GoBack':
    case 'BrowserBack':
    case 'XF86Back':
      return 'back';
  }
  // webOS's Back and Tizen's Return send no key name.
  return event.keyCode === 461 || event.keyCode === 10009 ? 'back' : undefined;
}

/** A gamepad as the navigator reads it: a device's own (the Gamepad API, standard by its mapping) or a screen's
 *  controller's state from its pad frame (sdk/pads.ts). */
export function padInput(pad: {
  standard: boolean;
  buttons: readonly { pressed: boolean }[];
  axes: readonly number[];
}): PadInput {
  let pressed = 0;
  for (let i = 0; i < pad.buttons.length && i < 32; i++) if (pad.buttons[i]?.pressed) pressed |= 1 << i;
  return { standard: pad.standard, pressed: pressed >>> 0, axes: pad.axes };
}
export const gamepadInput = (gamepad: Pick<Gamepad, 'mapping' | 'buttons' | 'axes'>) =>
  padInput({ standard: gamepad.mapping === 'standard', buttons: gamepad.buttons, axes: gamepad.axes });
