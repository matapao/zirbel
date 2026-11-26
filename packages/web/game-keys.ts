// In every game frame whose zirbel.json gives gamepad inputs keys (controls.keys, which the game page carries in
// #zirbel-keys): every gamepad's presses, the device's own and the screen's, become the keyboard's, so a game that reads
// only the keyboard plays with gamepads and phones. Each change of a key is one keydown or keyup, with the code and the
// key a keyboard gives, at the focused element (or the body), bubbling; checked each animation frame while a gamepad is
// connected. Inputs that share a code hold it while any of them is held.
import { checkedKeys, type ControlInput, type ControlKeys as Keys } from '../sdk/controls.ts';

type Readable = { readonly connected: boolean; readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[] };

/** Each input's button in the standard layout; up, down, left and right are also the left stick beyond half way. */
const BUTTON: Readonly<Record<ControlInput, number>> = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, select: 8, start: 9,
  ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15, home: 16 };
const STICK: Partial<Record<ControlInput, (axes: readonly number[]) => boolean>> = {
  up: (axes) => (axes[1] ?? 0) < -0.5, down: (axes) => (axes[1] ?? 0) > 0.5,
  left: (axes) => (axes[0] ?? 0) < -0.5, right: (axes) => (axes[0] ?? 0) > 0.5,
};

/** The codes these gamepads hold now. */
export function heldCodes(keys: Keys, gamepads: readonly (Readable | null)[]) {
  const held = new Set<string>();
  for (const pad of gamepads) {
    if (!pad?.connected) continue;
    for (const [input, code] of Object.entries(keys) as [ControlInput, string][]) {
      const button = pad.buttons[BUTTON[input]];
      if (button?.pressed || (button?.value ?? 0) > 0.5 || STICK[input]?.(pad.axes)) held.add(code);
    }
  }
  return held;
}

const NAMED: Readonly<Record<string, string>> = { Space: ' ', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/', NumpadEnter: 'Enter',
  NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/', NumpadDecimal: '.' };
const LEGACY: Readonly<Record<string, number>> = { Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, Escape: 27, Space: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18, MetaLeft: 91, MetaRight: 93,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219,
  Backslash: 220, BracketRight: 221, Quote: 222 };
// A table's own entry alone ("constructor" is a code too), without Object.hasOwn, which the frame's oldest browsers
// (Chromium 89 on) lack.
const own = <T>(table: Readonly<Record<string, T>>, code: string) =>
  Object.prototype.hasOwnProperty.call(table, code) ? table[code] : undefined;

/** What a keyboard with the US layout gives for a code: its key, its place (left, right, the number pad), and the
 *  keyCode older games read. */
export function keyFor(code: string) {
  let key = code, location = 0, keyCode = own(LEGACY, code) ?? 0;
  const letter = /^Key([A-Z])$/.exec(code)?.[1], digit = /^(?:Digit|Numpad)([0-9])$/.exec(code)?.[1];
  const side = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code);
  if (letter) { key = letter.toLowerCase(); keyCode = letter.charCodeAt(0); }
  else if (digit) { key = digit; keyCode = code.startsWith('Numpad') ? 96 + Number(digit) : digit.charCodeAt(0); }
  else if (side) { key = side[1]!; location = side[2] === 'Left' ? 1 : 2; }
  else if (own(NAMED, code) !== undefined) key = own(NAMED, code)!;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) keyCode = 111 + Number(code.slice(1));
  if (code.startsWith('Numpad')) location = 3;
  return { key, code, location, keyCode };
}

/** Presses and lets go of the keys as the gamepads change: send gets each keydown or keyup, once per change. */
export function keyPresser(keys: Keys, send: (type: 'keydown' | 'keyup', code: string) => void) {
  let held = new Set<string>();
  return (gamepads: readonly (Readable | null)[]) => {
    const now = heldCodes(keys, gamepads);
    for (const code of held) if (!now.has(code)) send('keyup', code);
    for (const code of now) if (!held.has(code)) send('keydown', code);
    held = now;
  };
}

/** Runs the keys in this frame: from the page's #zirbel-keys, over navigator.getGamepads (the device's and the screen's). */
export function pressKeys() {
  const element = document.getElementById('zirbel-keys');
  let keys: Keys | undefined;
  try { keys = checkedKeys(element ? JSON.parse(element.textContent) : undefined); } catch { keys = undefined; }
  if (!keys) return;
  const press = keyPresser(keys, (type, code) => {
    const { key, location, keyCode } = keyFor(code);
    const event = new KeyboardEvent(type, { key, code, location, bubbles: true, cancelable: true, composed: true });
    for (const name of ['keyCode', 'which']) Object.defineProperty(event, name, { value: keyCode });
    (document.activeElement ?? document.body ?? document.documentElement).dispatchEvent(event);
  });
  const gamepads = () => { try { return navigator.getGamepads(); } catch { return []; } };
  let frame: number | undefined;
  const poll = () => {
    const pads = gamepads();
    press(pads);
    frame = pads.some((pad) => pad?.connected) ? requestAnimationFrame(poll) : undefined;
  };
  const start = () => { frame ??= requestAnimationFrame(poll); };
  window.addEventListener('gamepadconnected', start);
  window.addEventListener('gamepaddisconnected', start);
  start();
}
