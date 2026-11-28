// Properties of the parsers and validators that read what comes from outside: a pad's binary frame, a game's file
// paths, a git ref to import, and the bounded JSON a game frame registers. fast-check tries many inputs from one fixed
// seed, so every run tries the same ones; a failure prints its seed and path, which `fc.assert(..., { seed, path })`
// replays.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { gitRef } from '../packages/sdk/contracts.ts';
import { boundedJson, GAME_FILE_TYPES, gameFilePath } from '../packages/sdk/game.ts';
import { decodePad, encodePad, MAX_PAD_FRAME } from '../packages/sdk/pads.ts';

fc.configureGlobal({ seed: 20261126, numRuns: 300 });

// A pad's state as a controller has it: fast-check's records have no prototype, so the tests compare plain copies.
const button = fc.record({ pressed: fc.boolean(), value: fc.double({ min: 0, max: 1, noNaN: true }) });
const pad = fc.record({
  slot: fc.integer({ min: 0, max: 7 }),
  standard: fc.boolean(),
  buttons: fc.array(button, { maxLength: 32 }),
  axes: fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { maxLength: 8 }),
});

test('a pad’s frame reads back as it was written, each value to its step, and writes again to the same bytes', () => {
  fc.assert(
    fc.property(pad, (state) => {
      const frame = encodePad(state);
      const read = decodePad(frame);
      assert.ok(read && frame.length <= MAX_PAD_FRAME);
      assert.equal(read.slot, state.slot);
      assert.equal(read.standard, state.standard);
      assert.deepEqual(
        read.buttons.map(({ pressed }) => pressed),
        state.buttons.map(({ pressed }) => pressed),
      );
      read.buttons.forEach(({ value }, index) => assert.ok(Math.abs(value - state.buttons[index]!.value) <= 0.5 / 255));
      read.axes.forEach((axis, index) => assert.ok(Math.abs(axis - state.axes[index]!) <= 0.5 / 32_767 + 1e-12));
      assert.deepEqual(encodePad(read), frame);
    }),
  );
});

test('any bytes read as a pad’s state or as none, and a state read from them writes back to the same bytes', () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: MAX_PAD_FRAME + 8 }), (bytes) => {
      const read = decodePad(bytes);
      if (read) assert.deepEqual(encodePad(read), bytes);
    }),
  );
});

test('a game file path the contract takes stays inside the game’s folder, at most 8 deep, with a known type', () => {
  const extensions = Object.keys(GAME_FILE_TYPES);
  const character = fc.constantFrom(...'abcXYZ019_.-/\\: é'.split(''));
  const extension = fc.constantFrom(...extensions, 'exe', 'sh', '');
  const path = fc
    .tuple(fc.string({ unit: character, maxLength: 40 }), extension)
    .map(([stem, type]) => (type ? stem + '.' + type : stem));
  fc.assert(
    fc.property(fc.oneof(path, fc.string({ maxLength: 60 })), (candidate) => {
      if (!gameFilePath.safeParse(candidate).success) return;
      const segments = candidate.split('/');
      assert.ok(segments.length <= 8, candidate);
      assert.ok(
        segments.every((segment) => segment !== '' && !segment.startsWith('.')),
        candidate,
      );
      assert.ok(!/[\\:\s]/.test(candidate) && candidate.length <= 240, candidate);
      assert.ok(extensions.includes(candidate.slice(candidate.lastIndexOf('.') + 1)), candidate);
    }),
  );
  // And every path made of plain segments and a known extension is taken.
  const segment = fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,11}$/);
  const plain = fc
    .tuple(fc.array(segment, { maxLength: 7 }), segment, fc.constantFrom(...extensions))
    .map(([folders, name, type]) => [...folders, name + '.' + type].join('/'));
  fc.assert(fc.property(plain, (candidate) => assert.ok(gameFilePath.safeParse(candidate).success, candidate)));
});

test('a git ref the import takes can be neither an option nor a second refspec, and is a name git keeps', () => {
  const character = fc.constantFrom(...'aZ09._/-@{}:^~ *?\\'.split(''));
  fc.assert(
    fc.property(fc.oneof(fc.string({ unit: character, maxLength: 24 }), fc.string({ maxLength: 24 })), (ref) => {
      if (!gitRef.safeParse(ref).success) return;
      assert.match(ref, /^[A-Za-z0-9]/, 'never an option');
      assert.doesNotMatch(ref, /[\s:^~*?\\@{}]|\.\.|\/\/|\/\.|\/$|\.$|\.lock$/, ref);
    }),
  );
});

test('bounded JSON is JSON a frame can send as it is, and anything nested too deep is refused', () => {
  fc.assert(
    fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
      if (!boundedJson(value)) return;
      const copy: unknown = JSON.parse(JSON.stringify(value));
      assert.ok(boundedJson(copy), 'its JSON copy is bounded too');
    }),
  );
  fc.assert(
    fc.property(fc.integer({ min: 9, max: 40 }), fc.jsonValue({ maxDepth: 1 }), (depth, leaf) => {
      let value: unknown = [leaf];
      for (let level = 0; level < depth; level++) value = { level: value };
      assert.equal(boundedJson(value), false);
    }),
  );
});
