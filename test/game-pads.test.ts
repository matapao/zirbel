// The screen's controllers in a game's frame (packages/web/game-pads.ts, game-keys.ts, pad-state.ts): every one a
// gamepad at its place in the standard Gamepad API, their events and rumble, and the keys a keyboard-only game gets.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonCopy } from '../packages/sdk/bounded.ts';
import { checkedControls, checkedKeys, checkedLabel } from '../packages/sdk/controls.ts';
import { heldCodes, keyFor, keyPresser } from '../packages/web/game-keys.ts';
import { screenPads, type PadLike, type Rumble } from '../packages/web/game-pads.ts';
import { checkedFrame, checkedPads, keyboardPad, padOf, restingPad, samePad, type Pad } from '../packages/web/pad-state.ts';

const pressing = (...buttons: number[]): Pad => {
  const pad = restingPad();
  for (const button of buttons) pad.buttons[button] = { pressed: true, value: 1 };
  return pad;
};
const buttonsOf = (levels: [boolean, number][]) => levels.map(([pressed, value]) => ({ pressed, value }));

// A frame's window and navigator, as far as game-pads.ts reaches them.
const events: { type: string; gamepad: PadLike }[] = [];
const frameWindow = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
Object.assign(globalThis, { window: frameWindow });
frameWindow.addEventListener('gamepadconnected', (event) => events.push({ type: event.type, gamepad: (event as Event & { gamepad: PadLike }).gamepad }));
frameWindow.addEventListener('gamepaddisconnected', (event) => events.push({ type: event.type, gamepad: (event as Event & { gamepad: PadLike }).gamepad }));
const own = { id: 'Own pad', index: 0, mapping: 'standard', connected: true, axes: [0, 0, 0, 0], buttons: [] };
const browserGamepads = () =>
  Object.defineProperty(navigator, 'getGamepads', { value: () => [own, null, null, null], configurable: true, writable: true });

test('every controller is a gamepad at its place: the screen\'s once each has sent its state, the device\'s where the page puts it', async () => {
  browserGamepads();
  const rumbles: Rumble[] = [];
  const pads = screenPads((effect) => rumbles.push(effect));
  // The device's own gamepad has no place until the page gives it one.
  assert.deepEqual(navigator.getGamepads(), [null, null, null, null]);
  pads.list([{ slot: 1, kind: 'phone', name: 'Phone', connected: true }, { slot: 5, kind: 'box', name: 'Arcade stick', connected: true }]);
  // Listed, but no state yet: not a gamepad until its first frame.
  assert.deepEqual(navigator.getGamepads(), [null, null, null, null]);
  assert.equal(events.length, 0);
  pads.frame(1, { ...pressing(0), axes: [0.5, -1, 0, 0] });
  const phone = navigator.getGamepads()[1] as unknown as PadLike;
  assert.deepEqual([phone.id, phone.index, phone.mapping, phone.connected, phone.axes, phone.buttons.length],
    ['Zirbel phone 2 (STANDARD GAMEPAD)', 1, 'standard', true, [0.5, -1, 0, 0], 17]);
  assert.deepEqual(phone.buttons[0], { pressed: true, touched: true, value: 1 });
  assert.deepEqual(phone.buttons[1], { pressed: false, touched: false, value: 0 });
  assert.deepEqual(navigator.getGamepads().map((pad) => pad?.index ?? null), [null, 1, null, null]);
  assert.deepEqual(events.map(({ type, gamepad }) => [type, gamepad.index, gamepad.id]),
    [['gamepadconnected', 1, 'Zirbel phone 2 (STANDARD GAMEPAD)']]);
  // The same state reads as the same snapshot until the next frame; a new frame is a new snapshot, with its time.
  assert.equal(navigator.getGamepads()[1], phone);
  pads.frame(1, pressing());
  const next = navigator.getGamepads()[1] as unknown as PadLike;
  assert.notEqual(next, phone);
  assert.ok(next.timestamp >= phone.timestamp);
  assert.equal(next.buttons[0]!.pressed, false);

  // A gamepad of its own layout keeps it, and its name; the list is as long as its last place.
  pads.frame(5, { standard: false, buttons: buttonsOf([[false, 0], [true, 1], [false, 0.5]]), axes: [0.25] });
  const stick = navigator.getGamepads()[5] as unknown as PadLike;
  assert.deepEqual([stick.id, stick.mapping, stick.buttons.map(({ pressed, value }) => [pressed, value]), stick.axes],
    ['Zirbel box 6 (Arcade stick)', '', [[false, 0], [true, 1], [false, 0.5]], [0.25]]);
  assert.equal(navigator.getGamepads().length, 6);
  // One whose layout changes comes again as a new gamepad.
  events.length = 0;
  pads.frame(5, pressing(2));
  assert.deepEqual(events.map(({ type, gamepad }) => [type, gamepad.index, gamepad.connected, gamepad.mapping]),
    [['gamepaddisconnected', 5, false, ''], ['gamepadconnected', 5, true, 'standard']]);

  // The device's own gamepad at the place the page gave it: the browser's state under the place's index.
  events.length = 0;
  pads.local([{ place: 0, index: 0, id: 'Own pad' }]);
  const placed = navigator.getGamepads()[0] as unknown as PadLike;
  assert.deepEqual([placed.id, placed.index, placed.axes], ['Own pad', 0, own.axes]);
  assert.deepEqual(events.map(({ type, gamepad }) => [type, gamepad.index, gamepad.id]), [['gamepadconnected', 0, 'Own pad']]);
  // Moved to another place, it leaves the first and comes at the other; one the browser doesn't have is nowhere.
  events.length = 0;
  pads.local([{ place: 2, index: 0, id: 'Own pad' }, { place: 3, index: 1, id: 'Gone pad' }]);
  assert.deepEqual(events.map(({ type, gamepad }) => [type, gamepad.index]), [['gamepaddisconnected', 0], ['gamepadconnected', 2]]);
  assert.deepEqual(navigator.getGamepads().map((pad) => pad?.id ?? null),
    [null, 'Zirbel phone 2 (STANDARD GAMEPAD)', 'Own pad', null, null, 'Zirbel box 6 (STANDARD GAMEPAD)']);

  // Rumble goes back to its host, bounded, and resolves when it's done, or when another takes its place.
  const first = phone.vibrationActuator!.playEffect('dual-rumble', { duration: 9000, strongMagnitude: 2, weakMagnitude: 0.25 });
  await new Promise((done) => setTimeout(done, 5));
  const second = phone.vibrationActuator!.playEffect('dual-rumble', { duration: 10, weakMagnitude: 1 });
  assert.deepEqual(await Promise.all([first, second]), ['preempted', 'complete']);
  assert.deepEqual(rumbles, [{ slot: 1, duration: 5000, strong: 1, weak: 0.25 }, { slot: 1, duration: 10, strong: 0, weak: 1 }]);
  await assert.rejects(phone.vibrationActuator!.playEffect('trigger-rumble'));
  assert.equal(await (phone.vibrationActuator as { reset(): Promise<string> }).reset(), 'complete');
  assert.deepEqual(rumbles.at(-1), { slot: 1, duration: 0, strong: 0, weak: 0 });

  // A controller that leaves the list, or is no longer connected, is gone.
  events.length = 0;
  pads.list([{ slot: 1, kind: 'phone', name: 'Phone', connected: false }]);
  pads.local([]);
  assert.deepEqual(events.map(({ type, gamepad }) => [type, gamepad.index, gamepad.connected]),
    [['gamepaddisconnected', 1, false], ['gamepaddisconnected', 5, false], ['gamepaddisconnected', 2, false]]);
  assert.deepEqual(navigator.getGamepads(), [null, null, null, null]);
  pads.frame(1, pressing(0));
  assert.deepEqual(navigator.getGamepads(), [null, null, null, null]);
});

test('a frame on its own keeps the device\'s gamepads at their own index', () => {
  browserGamepads();
  screenPads(() => {}, true);
  assert.deepEqual(navigator.getGamepads().map((pad) => pad?.id ?? null), ['Own pad', null, null, null]);
});

test('a keyboard-only game gets each place\'s keys from its gamepad, each change once', () => {
  const keys = checkedKeys({ a: 'Space', start: 'Enter', up: 'ArrowUp', left: 'KeyA', b: 'Space' })!;
  const pad = (buttons: number[], axes = [0, 0, 0, 0]) => ({ connected: true, axes,
    buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: buttons.includes(index), value: buttons.includes(index) ? 1 : 0 })) });
  // controls.keys are P1's alone.
  assert.deepEqual([...heldCodes({ keys }, [pad([0, 9])])].sort(), ['Enter', 'Space']);
  assert.deepEqual([...heldCodes({ keys }, [null, pad([0, 9])])], []);
  // The d-pad and the left stick beyond half way.
  assert.deepEqual([...heldCodes({ keys }, [pad([12])])], ['ArrowUp']);
  assert.deepEqual([...heldCodes({ keys }, [pad([], [-0.6, -0.7, 0, 0])])].sort(), ['ArrowUp', 'KeyA']);
  assert.deepEqual([...heldCodes({ keys }, [pad([], [-0.4, 0.2, 0, 0])])], []);
  assert.deepEqual([...heldCodes({ keys }, [{ ...pad([0]), connected: false }])], []);
  // With players, each place its own, and controls.keys not at all.
  const players = checkedControls({ keys, players: [{ keys: { up: 'KeyW', a: 'Space' } }, {}, { keys: { up: 'ArrowUp', a: 'Enter' } }] })!;
  assert.deepEqual([...heldCodes(players, [pad([12, 9]), pad([0]), pad([0, 12])])].sort(), ['ArrowUp', 'Enter', 'KeyW']);

  const sent: string[] = [];
  const press = keyPresser({ players: [{ keys }, { keys }] }, (type, code) => sent.push(type + ' ' + code));
  press([pad([0])]);
  press([pad([0]), pad([1])]); // A and B share Space, at two places: held, not pressed again
  press([pad([]), pad([1])]);
  press([pad([]), pad([9])]);
  press([]);
  assert.deepEqual(sent, ['keydown Space', 'keyup Space', 'keydown Enter', 'keyup Enter']);

  for (const keys of [{}, { a: 'Space bar' }, { jump: 'Space' }, ['Space'], { a: 3 }, 'Space', null]) assert.equal(checkedKeys(keys), undefined);
  assert.deepEqual(checkedLabel({ name: 'Red car', color: '#d03030', more: 1 }), { name: 'Red car', color: '#d03030' });
  for (const label of [{ name: '' }, { name: 'n'.repeat(25) }, { color: 'red' }, { name: 3 }, null, []])
    assert.equal(checkedLabel(label), undefined, JSON.stringify(label));
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
    { standard: true, buttons: buttonsOf([[true, 1], [false, 0.25], [true, 0.5]]), axes: [0.1, -1] });
  const crowded = padOf({ mapping: '', buttons: Array(40).fill({ pressed: true, value: 1 }), axes: Array(12).fill(0) });
  assert.deepEqual([crowded.standard, crowded.buttons.length, crowded.axes.length], [false, 32, 8]);
  assert.ok(samePad(pressing(0), pressing(0)));
  assert.ok(samePad({ ...restingPad(), axes: [0.00001, 0, 0, 0] }, restingPad()));
  assert.ok(!samePad(pressing(0), pressing(1)));

  // Arrows or WASD the left stick, a diagonal to its edge; Space A, ShiftLeft B, KeyE X, KeyQ Y, Enter Start, Escape Select.
  const keyboard = keyboardPad(new Set(['KeyW', 'ArrowRight', 'Space', 'ShiftLeft', 'KeyE', 'KeyQ', 'Enter', 'Escape']));
  assert.deepEqual([keyboard.buttons.flatMap(({ pressed }, button) => (pressed ? [button] : [])), keyboard.axes.map((axis) =>
    Math.round(axis * 1000) / 1000)], [[0, 1, 2, 3, 8, 9], [0.707, -0.707, 0, 0]]);
  assert.deepEqual(keyboardPad(new Set(['KeyA', 'ArrowLeft'])).axes, [-1, 0, 0, 0]);
  assert.deepEqual(keyboardPad(new Set(['KeyA', 'KeyD'])).axes, [0, 0, 0, 0]);

  const frame = { slot: 2, standard: true, buttons: buttonsOf([[true, 1], [false, 0.5]]), axes: [0, -1] };
  assert.deepEqual(checkedFrame(frame), frame);
  for (const wrong of [{ ...frame, slot: 8 }, { ...frame, slot: 1.5 }, { ...frame, standard: 1 }, { ...frame, buttons: [{ pressed: 1, value: 1 }] },
    { ...frame, buttons: buttonsOf([[true, 2]]) }, { ...frame, buttons: [null] }, { ...frame, axes: [-2] },
    { ...frame, buttons: Array(33).fill({ pressed: false, value: 0 }) }, { ...frame, axes: Array(9).fill(0) }, { ...frame, buttons: 'A' },
    null, 'frame'])
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
