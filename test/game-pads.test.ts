// The screen's controllers in a game's frame (packages/web/game-pads.ts, game-keys.ts, pad-state.ts): gamepads after
// the device's own in the standard Gamepad API, their events and rumble, and the keys a keyboard-only game gets.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonCopy } from '../packages/sdk/bounded.ts';
import { checkedKeys } from '../packages/sdk/controls.ts';
import { heldCodes, keyFor, keyPresser } from '../packages/web/game-keys.ts';
import { screenPads, type PadLike, type Rumble } from '../packages/web/game-pads.ts';
import { checkedFrame, checkedPads, keyboardPad, padOf, restingPad, samePad, type Pad } from '../packages/web/pad-state.ts';

const pressing = (...buttons: number[]): Pad => {
  const pad = restingPad();
  for (const button of buttons) pad.values[button] = 1;
  return { ...pad, pressed: buttons.reduce((mask, button) => mask | (1 << button), 0) >>> 0 };
};

// A frame's window and navigator, as far as game-pads.ts reaches them.
const events: { type: string; gamepad: PadLike }[] = [];
const frameWindow = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
Object.assign(globalThis, { window: frameWindow });
frameWindow.addEventListener('gamepadconnected', (event) => events.push({ type: event.type, gamepad: (event as Event & { gamepad: PadLike }).gamepad }));
frameWindow.addEventListener('gamepaddisconnected', (event) => events.push({ type: event.type, gamepad: (event as Event & { gamepad: PadLike }).gamepad }));
const own = { id: 'Own pad', index: 0, mapping: 'standard', connected: true, axes: [0, 0, 0, 0], buttons: [] };
Object.defineProperty(navigator, 'getGamepads', { value: () => [own, null, null, null], configurable: true, writable: true });

test('the screen\'s controllers come after the device\'s own gamepads, as gamepads, once each has sent its state', async () => {
  const rumbles: Rumble[] = [];
  const pads = screenPads((effect) => rumbles.push(effect));
  pads.list([{ slot: 1, kind: 'phone', name: 'Phone', connected: true }, { slot: 0, kind: 'box', name: 'Arcade stick', connected: true }]);
  // Listed, but no state yet: not a gamepad until its first frame.
  assert.deepEqual(navigator.getGamepads(), [own, null, null, null]);
  assert.deepEqual(events, []);
  pads.frame(1, { ...pressing(0), axes: [0.5, -1, 0, 0] });
  const phone = navigator.getGamepads()[5] as unknown as PadLike;
  assert.deepEqual([phone.id, phone.index, phone.mapping, phone.connected, phone.axes, phone.buttons.length],
    ['Zirbel phone 2 (STANDARD GAMEPAD)', 5, 'standard', true, [0.5, -1, 0, 0], 17]);
  assert.deepEqual(phone.buttons[0], { pressed: true, touched: true, value: 1 });
  assert.deepEqual(phone.buttons[1], { pressed: false, touched: false, value: 0 });
  assert.equal(navigator.getGamepads()[0], own);
  assert.equal(navigator.getGamepads().length, 6);
  assert.deepEqual(events.map(({ type, gamepad }) => [type, gamepad.index, gamepad.id]),
    [['gamepadconnected', 5, 'Zirbel phone 2 (STANDARD GAMEPAD)']]);
  // The same state reads as the same snapshot until the next frame; a new frame is a new snapshot, with its time.
  assert.equal(navigator.getGamepads()[5], phone);
  pads.frame(1, pressing());
  const next = navigator.getGamepads()[5] as unknown as PadLike;
  assert.notEqual(next, phone);
  assert.ok(next.timestamp >= phone.timestamp);
  assert.equal(next.buttons[0]!.pressed, false);

  // A gamepad of its own layout keeps it, and its name.
  pads.frame(0, { standard: false, pressed: 2, values: [0, 1, 0.5], axes: [0.25] });
  const stick = navigator.getGamepads()[4] as unknown as PadLike;
  assert.deepEqual([stick.id, stick.mapping, stick.buttons.map(({ pressed, value }) => [pressed, value]), stick.axes],
    ['Zirbel box 1 (Arcade stick)', '', [[false, 0], [true, 1], [false, 0.5]], [0.25]]);
  // One whose layout changes comes again as a new gamepad.
  events.length = 0;
  pads.frame(0, pressing(2));
  assert.deepEqual(events.map(({ type, gamepad }) => [type, gamepad.index, gamepad.connected, gamepad.mapping]),
    [['gamepaddisconnected', 4, false, ''], ['gamepadconnected', 4, true, 'standard']]);

  // Rumble goes back to its host, bounded, and resolves when it's done, or when another takes its place.
  const first = phone.vibrationActuator.playEffect('dual-rumble', { duration: 9000, strongMagnitude: 2, weakMagnitude: 0.25 });
  await new Promise((done) => setTimeout(done, 5));
  const second = phone.vibrationActuator.playEffect('dual-rumble', { duration: 10, weakMagnitude: 1 });
  assert.deepEqual(await Promise.all([first, second]), ['preempted', 'complete']);
  assert.deepEqual(rumbles, [{ slot: 1, duration: 5000, strong: 1, weak: 0.25 }, { slot: 1, duration: 10, strong: 0, weak: 1 }]);
  await assert.rejects(phone.vibrationActuator.playEffect('trigger-rumble'));
  assert.equal(await phone.vibrationActuator.reset(), 'complete');
  assert.deepEqual(rumbles.at(-1), { slot: 1, duration: 0, strong: 0, weak: 0 });

  // A controller that leaves the list, or is no longer connected, is gone.
  events.length = 0;
  pads.list([{ slot: 1, kind: 'phone', name: 'Phone', connected: false }]);
  assert.deepEqual(events.map(({ type, gamepad }) => [type, gamepad.index, gamepad.connected]),
    [['gamepaddisconnected', 5, false], ['gamepaddisconnected', 4, false]]);
  assert.deepEqual(navigator.getGamepads(), [own, null, null, null]);
  pads.frame(1, pressing(0));
  assert.deepEqual(navigator.getGamepads(), [own, null, null, null]);
});

test('a keyboard-only game gets its keys from every gamepad, each change once', () => {
  const keys = checkedKeys({ a: 'Space', start: 'Enter', up: 'ArrowUp', left: 'KeyA', b: 'Space' })!;
  const pad = (buttons: number[], axes = [0, 0, 0, 0]) => ({ connected: true, axes,
    buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: buttons.includes(index), value: buttons.includes(index) ? 1 : 0 })) });
  assert.deepEqual([...heldCodes(keys, [pad([0, 9])])].sort(), ['Enter', 'Space']);
  // The d-pad and the left stick beyond half way, and a trigger's value without its press.
  assert.deepEqual([...heldCodes(keys, [pad([12])])], ['ArrowUp']);
  assert.deepEqual([...heldCodes(keys, [pad([], [-0.6, -0.7, 0, 0])])].sort(), ['ArrowUp', 'KeyA']);
  assert.deepEqual([...heldCodes(keys, [pad([], [-0.4, 0.2, 0, 0])])], []);
  assert.deepEqual([...heldCodes(keys, [null, { ...pad([0]), connected: false }])], []);

  const sent: string[] = [];
  const press = keyPresser(keys, (type, code) => sent.push(type + ' ' + code));
  press([pad([0])]);
  press([pad([0]), pad([1])]); // A and B share Space, on two gamepads: held, not pressed again
  press([pad([]), pad([1])]);
  press([pad([]), pad([9])]);
  press([]);
  assert.deepEqual(sent, ['keydown Space', 'keyup Space', 'keydown Enter', 'keyup Enter']);

  for (const keys of [{}, { a: 'Space bar' }, { jump: 'Space' }, ['Space'], { a: 3 }, 'Space', null]) assert.equal(checkedKeys(keys), undefined);
});

test('a code gives the key, place and keyCode a keyboard gives', () => {
  const key = (code: string) => { const { key, location, keyCode } = keyFor(code); return [key, location, keyCode]; };
  assert.deepEqual(key('KeyA'), ['a', 0, 65]);
  assert.deepEqual(key('Space'), [' ', 0, 32]);
  assert.deepEqual(key('ArrowUp'), ['ArrowUp', 0, 38]);
  assert.deepEqual(key('ShiftLeft'), ['Shift', 1, 16]);
  assert.deepEqual(key('ControlRight'), ['Control', 2, 17]);
  assert.deepEqual(key('Digit1'), ['1', 0, 49]);
  assert.deepEqual(key('Numpad7'), ['7', 3, 103]);
  assert.deepEqual(key('NumpadEnter'), ['Enter', 3, 13]);
  assert.deepEqual(key('Enter'), ['Enter', 0, 13]);
  assert.deepEqual(key('Escape'), ['Escape', 0, 27]);
  assert.deepEqual(key('Tab'), ['Tab', 0, 9]);
  assert.deepEqual(key('Comma'), [',', 0, 188]);
  assert.deepEqual(key('F5'), ['F5', 0, 116]);
  // A code it doesn't know is its own key; one that names an object's own property is no entry of a table.
  assert.deepEqual(key('Lang1'), ['Lang1', 0, 0]);
  assert.deepEqual(key('constructor'), ['constructor', 0, 0]);
});

test('a device\'s gamepad and a keyboard read as pads, and a frame\'s pads are checked where they arrive', () => {
  const buttons = [{ pressed: true, value: 0 }, { pressed: false, value: 0.25 }, { pressed: true, value: 0.5 }];
  assert.deepEqual(padOf({ mapping: 'standard', buttons: buttons as GamepadButton[], axes: [0.1, -1] }),
    { standard: true, pressed: 0b101, values: [1, 0.25, 0.5], axes: [0.1, -1] });
  assert.equal(padOf({ mapping: '', buttons: Array(40).fill({ pressed: true, value: 1 }), axes: Array(12).fill(0) }).values.length, 32);
  assert.equal(padOf({ mapping: '', buttons: Array(32).fill({ pressed: true, value: 1 }), axes: [] }).pressed, 0xffffffff);
  assert.ok(samePad(pressing(0), pressing(0)));
  assert.ok(samePad({ ...restingPad(), axes: [0.00001, 0, 0, 0] }, restingPad()));
  assert.ok(!samePad(pressing(0), pressing(1)));

  // Arrows or WASD the left stick, a diagonal to its edge; Space A, ShiftLeft B, KeyE X, KeyQ Y, Enter Start, Escape Select.
  const keyboard = keyboardPad(new Set(['KeyW', 'ArrowRight', 'Space', 'ShiftLeft', 'KeyE', 'KeyQ', 'Enter', 'Escape']));
  assert.deepEqual([keyboard.pressed, keyboard.axes.map((axis) => Math.round(axis * 1000) / 1000)],
    [0b1100001111, [0.707, -0.707, 0, 0]]);
  assert.deepEqual(keyboardPad(new Set(['KeyA', 'ArrowLeft'])).axes, [-1, 0, 0, 0]);
  assert.deepEqual(keyboardPad(new Set(['KeyA', 'KeyD'])).axes, [0, 0, 0, 0]);

  const frame = { slot: 2, standard: true, pressed: 3, values: [1, 1], axes: [0, -1] };
  assert.deepEqual(checkedFrame(frame), frame);
  for (const wrong of [{ ...frame, slot: 8 }, { ...frame, slot: 1.5 }, { ...frame, standard: 1 }, { ...frame, pressed: -1 },
    { ...frame, pressed: 2 ** 32 }, { ...frame, values: [2] }, { ...frame, axes: [-2] }, { ...frame, values: Array(33).fill(0) },
    { ...frame, axes: Array(9).fill(0) }, { ...frame, values: ['1'] }, null, 'frame'])
    assert.equal(checkedFrame(wrong), undefined, JSON.stringify(wrong));
  const entry = { slot: 0, kind: 'phone', name: 'x'.repeat(80), connected: true };
  assert.deepEqual(checkedPads([entry]), [{ ...entry, name: 'x'.repeat(64) }]);
  for (const wrong of [[entry, entry], [{ ...entry, kind: 'mouse' }], [{ ...entry, slot: -1 }], Array(9).fill(entry), {}, [null]])
    assert.equal(checkedPads(wrong), undefined, JSON.stringify(wrong));
});

test('registered objects are copied where structuredClone is missing, as on older TV browsers', () => {
  const value = { id: 'tree', properties: { at: [1, 2], name: 'Oak' } };
  for (const clone of [structuredClone, undefined]) {
    const copy = jsonCopy(value, clone);
    assert.deepEqual(copy, value);
    assert.notEqual(copy.properties, value.properties);
  }
});
