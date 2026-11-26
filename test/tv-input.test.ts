// How the TV page is moved around (packages/web/tv-input.ts, tv-focus.ts): keys, gamepads' d-pads and sticks with a
// held direction repeating, A and B as they go down, and the nearest tile in a direction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextFocus, type Rect } from '../packages/web/tv-focus.ts';
import { direction, gamepadInput, keyCommand, PadNavigator, type Command, type PadInput } from '../packages/web/tv-input.ts';

const pad = (buttons: number[] = [], axes: number[] = [0, 0, 0, 0], standard = true): PadInput =>
  ({ standard, pressed: buttons.reduce((bits, button) => bits | (1 << button), 0) >>> 0, axes });

test('a key is a command: a remote’s arrows, OK and the Back keys TVs send', () => {
  const keys: [string, number | undefined, Command | undefined][] = [['ArrowUp', 38, 'up'], ['ArrowLeft', 37, 'left'], ['Right', 39, 'right'],
    ['Enter', 13, 'choose'], ['Escape', 27, 'back'], ['Backspace', 8, 'back'], ['GoBack', 0, 'back'], ['BrowserBack', 166, 'back'],
    ['Unidentified', 461, 'back'], ['Unidentified', 10009, 'back'], ['a', 65, undefined], ['Tab', 9, undefined]];
  for (const [key, keyCode, want] of keys) assert.equal(keyCommand({ key, keyCode }), want, key);
});

test('a gamepad’s direction is its d-pad, or its stick past halfway along its larger axis', () => {
  assert.equal(direction(pad([12])), 'up');
  assert.equal(direction(pad([15])), 'right');
  assert.equal(direction(pad([], [0.7, -0.2])), 'right');
  assert.equal(direction(pad([], [-0.3, -0.9])), 'up');
  assert.equal(direction(pad([], [0.4, 0.4])), undefined);
  // A gamepad of no known layout has no d-pad buttons to read: its stick alone.
  assert.equal(direction(pad([12], [0, 0], false)), undefined);
  assert.equal(direction(pad([], [0, 0.8], false)), 'down');
  const read = gamepadInput({ mapping: 'standard', axes: [0.1, 0.9],
    buttons: [{ pressed: true }, { pressed: false }, { pressed: true }].map((button) => ({ ...button, touched: false, value: 1 })) });
  assert.deepEqual(read, { standard: true, pressed: 0b101, axes: [0.1, 0.9] });
});

test('a held direction moves at once and repeats, A and B act as they go down, and a gamepad that goes is forgotten', () => {
  const said: string[] = [];
  const navigator = new PadNavigator((command, source) => said.push(source + ' ' + command), 400, 100);
  navigator.update('pad:0', pad([15]), 0);
  navigator.tick(100);
  navigator.tick(399);
  assert.deepEqual(said, ['pad:0 right']);
  navigator.tick(400);
  navigator.tick(500);
  navigator.tick(560);
  assert.deepEqual(said.splice(0), ['pad:0 right', 'pad:0 right', 'pad:0 right']);
  // The same state again (a frame while still) neither moves nor repeats sooner; a new direction moves at once.
  navigator.update('pad:0', pad([15]), 600);
  navigator.update('pad:0', pad([13]), 610);
  navigator.tick(700);
  assert.deepEqual(said.splice(0), ['pad:0 down']);
  navigator.update('pad:0', pad([]), 720);
  navigator.tick(2000);
  assert.deepEqual(said.splice(0), []);
  // A, then Start, choose; B and Select go back; held, they don't again.
  navigator.update('pad:1', pad([0]), 0);
  navigator.update('pad:1', pad([0]), 10);
  navigator.update('pad:1', pad([]), 20);
  navigator.update('pad:1', pad([9]), 30);
  navigator.update('pad:1', pad([1, 9]), 40);
  navigator.update('pad:1', pad([8]), 50);
  assert.deepEqual(said.splice(0), ['pad:1 choose', 'pad:1 choose', 'pad:1 back', 'pad:1 back']);
  navigator.update('device:0', pad([14]), 0);
  navigator.update('device:0', undefined, 10);
  navigator.tick(5000);
  assert.deepEqual(said.splice(0), ['device:0 left']);
  assert.equal(PadNavigator.pressing(pad([])), false);
  assert.equal(PadNavigator.pressing(pad([31])), true);
});

test('focus goes to the nearest tile in a direction, in line before beside it, and nowhere past the edge', () => {
  // A row of three games, a row of two sessions under it, and the places in a corner to the right.
  const rect = (left: number, top: number, width = 100, height = 60): Rect => ({ left, top, width, height });
  const rects = [rect(0, 0), rect(120, 0), rect(240, 0), rect(0, 100), rect(120, 100),
    rect(500, 0, 200, 50), rect(500, 60, 200, 50), rect(500, 120, 200, 50)];
  assert.equal(nextFocus(rects, 0, 'right'), 1);
  assert.equal(nextFocus(rects, 1, 'down'), 4);
  assert.equal(nextFocus(rects, 2, 'down'), 4);
  assert.equal(nextFocus(rects, 4, 'up'), 1);
  assert.equal(nextFocus(rects, 2, 'right'), 5);
  // In line beats nearer beside it: from the sessions' row, the place beside it rather than a game above.
  assert.equal(nextFocus(rects, 4, 'right'), 7);
  assert.equal(nextFocus(rects, 5, 'down'), 6);
  assert.equal(nextFocus(rects, 6, 'left'), 4);
  assert.equal(nextFocus(rects, 5, 'left'), 2);
  assert.equal(nextFocus(rects, 0, 'left'), undefined);
  assert.equal(nextFocus(rects, 0, 'up'), undefined);
  // From nothing in focus, the first tile; with no tiles, none.
  assert.equal(nextFocus(rects, -1, 'down'), 0);
  assert.equal(nextFocus([], -1, 'down'), undefined);
});
