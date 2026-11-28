// The pads socket's routing (packages/core/pads.ts) of the box's own gamepads from its controller service, and the
// places controllers hold: the one asked for, an old one back, moves, swaps, labels and a screen's claims.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAIM, PAD_RESUME, Pads } from '../packages/core/pads.ts';
import { encodePad } from '../packages/sdk/pads.ts';
import { link, listed, placed, state, type Listed } from './pads-fixtures.ts';

test('the box’s gamepads go to its own screen, to a screen that claims one, and back', () => {
  let now = 1_000_000;
  const pads = new Pads(() => now);
  assert.equal(pads.toService({ type: 'scan', on: true }), false);
  const service = link();
  pads.attachService(service);
  assert.equal(pads.toService({ type: 'scan', on: true }), true);
  assert.deepEqual(service.texts.at(-1), { type: 'scan', on: true });
  pads.serviceMessage(service, { type: 'device', device: 3, name: 'Pad A', standard: true });
  pads.serviceMessage(service, { type: 'device', device: 5, name: 'Pad B', standard: false });
  // On no screen, input goes nowhere; the box's own screen takes them all.
  assert.equal(pads.serviceInput(service, 3, encodePad(state([0]))), true);
  const tvLink = link();
  const tv = pads.openScreen(tvLink, 'lan', true)!;
  assert.deepEqual(listed(tvLink), ['0 box Pad A', '1 box Pad B']);
  pads.serviceMessage(service, { type: 'device', device: 7, name: 'Pad C', standard: true });
  assert.deepEqual(listed(tvLink), ['0 box Pad A', '1 box Pad B', '2 box Pad C']);
  pads.serviceInput(service, 5, encodePad({ ...state([], [1, 0, 0, 0]), slot: 6 }));
  assert.deepEqual([...tvLink.frames.at(-1)!], [...encodePad({ ...state([], [1, 0, 0, 0]), slot: 1 })]);
  assert.equal(pads.serviceInput(service, 5, new Uint8Array([0, 4, 0, 0, 0, 0, 0, 0])), false, 'not a pad state');
  pads.screenMessage(tv, tvLink, { type: 'rumble', slot: 1, duration: 300, strong: 0.5, weak: 1 });
  assert.deepEqual(service.texts.at(-1), { type: 'rumble', device: 5, duration: 300, strong: 0.5, weak: 1 });
  // Let go, a gamepad joins the newest claiming screen on its next button down, not on a held one.
  const laptopLink = link();
  const laptop = pads.openScreen(laptopLink, 'lan', false)!;
  const older = link();
  const other = pads.openScreen(older, 'local', false)!;
  pads.screenMessage(other, older, { type: 'claim' });
  pads.screenMessage(laptop, laptopLink, { type: 'claim' });
  pads.screenMessage(tv, tvLink, { type: 'release', slot: 0 });
  assert.deepEqual(listed(tvLink), ['1 box Pad B', '2 box Pad C']);
  pads.serviceInput(service, 3, encodePad(state([0])));
  assert.deepEqual(listed(laptopLink), []);
  pads.serviceInput(service, 3, encodePad(state([0, 2])));
  assert.deepEqual(listed(laptopLink), ['0 box Pad A']);
  assert.deepEqual([...laptopLink.frames.at(-1)!], [...encodePad(state([0, 2]))]);
  // The other claim still waits, for 30 s.
  pads.screenMessage(laptop, laptopLink, { type: 'release', slot: 0 });
  now += CLAIM - 1;
  pads.serviceInput(service, 3, encodePad(state([1])));
  assert.deepEqual(listed(older), ['0 box Pad A']);
  pads.screenMessage(other, older, { type: 'release', slot: 0 });
  now += 1;
  pads.screenMessage(laptop, laptopLink, { type: 'claim' });
  now += CLAIM;
  pads.sweep();
  pads.serviceInput(service, 3, encodePad(state([3])));
  assert.deepEqual(listed(tvLink), ['0 box Pad A', '1 box Pad B', '2 box Pad C'], 'with no claim, the box’s own screen');
  // A screen that ends gives its gamepads back to the box's own screen.
  pads.screenMessage(tv, tvLink, { type: 'release', slot: 2 });
  pads.screenMessage(laptop, laptopLink, { type: 'claim' });
  pads.serviceInput(service, 7, encodePad(state([4])));
  assert.deepEqual(listed(laptopLink), ['0 box Pad C']);
  pads.screenGone(laptop, laptopLink, 1000);
  assert.deepEqual(listed(tvLink), ['0 box Pad A', '1 box Pad B', '2 box Pad C']);
  pads.serviceMessage(service, { type: 'device', device: 7, name: 'Pad C2', standard: true });
  assert.deepEqual(listed(tvLink).at(-1), '2 box Pad C2');
  pads.serviceMessage(service, { type: 'gone', device: 3 });
  assert.deepEqual(listed(tvLink), ['1 box Pad B', '2 box Pad C2']);
  pads.serviceMessage(service, { type: 'controllers', devices: [], found: [], scanning: false });
  assert.deepEqual(pads.controllers, { type: 'controllers', devices: [], found: [], scanning: false });
  // A new service connection replaces the old one, whose gamepads are gone.
  const next = link();
  pads.attachService(next);
  assert.equal(service.closed, 1000);
  assert.deepEqual([listed(tvLink), pads.controllers], [[], undefined]);
  pads.serviceMessage(service, { type: 'device', device: 1, name: 'Old', standard: true });
  assert.deepEqual(listed(tvLink), []);
  pads.serviceMessage(next, { type: 'device', device: 1, name: 'New', standard: true });
  assert.deepEqual(listed(tvLink), ['0 box New']);
  pads.serviceGone(next);
  assert.deepEqual(listed(tvLink), []);
});

test('a phone takes the place it asks for, takes its old one back within 60 s, and moves to a free one', () => {
  let now = 1_000_000;
  const pads = new Pads(() => now);
  const tv = link();
  const screen = pads.openScreen(tv, 'lan', false)!;
  const join = (place?: number, resume?: string) => {
    const phone = link();
    return { phone, held: pads.openPad(phone, 'lan', '192.168.1.20', screen.code, place, resume) };
  };
  const third = join(2);
  assert.equal(placed(third.phone), 2);
  // Taken, or no place at all: the first free one.
  assert.equal(placed(join(2).phone), 0);
  assert.equal(placed(join(9).phone), 1);
  // A dropped phone's resume takes its place back while it is free, and falls back to the place it asks for.
  pads.padGone(third.held!);
  assert.deepEqual(listed(tv), ['0 phone Phone 1', '1 phone Phone 2']);
  const back = join(5, third.held!.resume);
  assert.deepEqual(back.phone.texts, [{ type: 'pad', slot: 2, screen: screen.id, resume: third.held!.resume, label: null }]);
  pads.padGone(back.held!);
  assert.equal(placed(join().phone), 2, 'the place is free, not kept');
  const moved = join(6, third.held!.resume);
  assert.equal(placed(moved.phone), 6);
  // The same phone again before its old socket was seen to drop: it takes its place over.
  const over = join(undefined, third.held!.resume);
  assert.deepEqual([placed(over.phone), moved.phone.closed, listed(tv).filter((line) => line.startsWith('6 ')).length], [6, 4001, 1]);
  pads.padGone(moved.held!);
  assert.equal(listed(tv).filter((line) => line.startsWith('6 ')).length, 1, 'the old socket closing leaves the place');
  // An old resume, past its 60 s.
  const late = join(7);
  pads.padGone(late.held!);
  now += PAD_RESUME;
  pads.sweep();
  assert.equal(placed(join(undefined, late.held!.resume).phone), 3);
  // A phone moves to a free place, not to a taken one or one the screen's own gamepads hold.
  pads.screenMessage(screen, tv, { type: 'local', places: [4] });
  pads.padMessage(over.held!, { type: 'place', place: 0 });
  pads.padMessage(over.held!, { type: 'place', place: 4 });
  assert.equal(placed(over.phone), 6);
  pads.padMessage(over.held!, { type: 'place', place: 5 });
  assert.deepEqual([placed(over.phone), listed(tv)], [5, ['0 phone Phone 1', '1 phone Phone 2', '2 phone Phone 3', '3 phone Phone 4',
    '5 phone Phone 6']]);
  // A new phone skips the screen's own places.
  assert.equal(placed(join().phone), 6);
  assert.equal(placed(join(4).phone), 7);
  const full = join();
  assert.deepEqual([full.held, full.phone.closed], [undefined, 4409]);
});

test('a screen swaps two places, labels each place, and its phones hear their own', () => {
  const pads = new Pads();
  const tv = link();
  const screen = pads.openScreen(tv, 'lan', true)!;
  const service = link();
  pads.attachService(service);
  pads.serviceMessage(service, { type: 'device', device: 1, name: 'Pad', standard: true });
  const phone = link();
  const held = pads.openPad(phone, 'lan', '192.168.1.20', screen.code)!;
  assert.deepEqual(listed(tv), ['0 box Pad', '1 phone Phone 2']);
  pads.screenMessage(screen, tv, { type: 'move', from: 1, to: 0 });
  assert.deepEqual([listed(tv), placed(phone)], [['0 phone Phone 1', '1 box Pad'], 0]);
  pads.screenMessage(screen, tv, { type: 'move', from: 1, to: 6 });
  assert.deepEqual(listed(tv), ['0 phone Phone 1', '6 box Pad']);
  pads.serviceInput(service, 1, encodePad(state([2])));
  assert.equal(tv.frames.at(-1)![0], 6);
  const told = phone.texts.length;
  pads.screenMessage(screen, tv, { type: 'move', from: 3, to: 4 });
  assert.equal(phone.texts.length, told, 'two empty places');
  pads.screenMessage(screen, tv, { type: 'labels', labels: [{ place: 0, name: 'Red car', color: '#ff0000' }, { place: 6, name: 'Blue', color: '#0000ff' }] });
  assert.deepEqual(phone.texts.at(-1), { type: 'pad', slot: 0, screen: screen.id, resume: held.resume, label: { name: 'Red car', color: '#ff0000' } });
  assert.deepEqual(listed(tv), ['0 phone Phone 1 · Red car', '6 box Pad · Blue']);
  assert.deepEqual((tv.last('pads')!.pads as Listed[])[0]!.label, { name: 'Red car', color: '#ff0000' });
  // Labels that don't change say nothing; the places left out lose theirs.
  const said = [phone.texts.length, tv.texts.length];
  pads.screenMessage(screen, tv, { type: 'labels', labels: [{ place: 6, name: 'Blue', color: '#0000ff' }, { place: 0, name: 'Red car', color: '#ff0000' }] });
  assert.deepEqual([phone.texts.length, tv.texts.length], said);
  pads.screenMessage(screen, tv, { type: 'labels', labels: [{ place: 6, name: 'Blue', color: '#0000ff' }] });
  assert.deepEqual([phone.last('pad')?.label, listed(tv)], [null, ['0 phone Phone 1', '6 box Pad · Blue']]);
  // A page that resumes the screen says its own labels and places.
  pads.screenMessage(screen, tv, { type: 'labels', labels: [{ place: 0, name: 'Red car', color: '#ff0000' }] });
  pads.screenMessage(screen, tv, { type: 'local', places: [2] });
  pads.screenGone(screen, tv, 1001);
  const next = link();
  pads.openScreen(next, 'lan', true, screen.resume);
  assert.deepEqual([phone.last('pad')?.label, listed(next)], [null, ['0 phone Phone 1', '6 box Pad']]);
  pads.padMessage(held, { type: 'place', place: 2 });
  assert.equal(placed(phone), 2);
});

test('a screen’s claim of a place goes to the next controller whose A goes down', () => {
  let now = 1_000_000;
  const pads = new Pads(() => now);
  const tvLink = link();
  const tv = pads.openScreen(tvLink, 'lan', true)!;
  const service = link();
  pads.attachService(service);
  pads.serviceMessage(service, { type: 'device', device: 1, name: 'Pad', standard: true });
  const phone = link();
  const held = pads.openPad(phone, 'lan', '192.168.1.20', tv.code)!;
  assert.deepEqual(listed(tvLink), ['0 box Pad', '1 phone Phone 2']);
  // Press A to take P4: B goes down to nothing, A takes it, once.
  pads.screenMessage(tv, tvLink, { type: 'claim', place: 3 });
  pads.padFrame(held, encodePad(state([1])));
  assert.equal(placed(phone), 1);
  pads.padFrame(held, encodePad(state([1, 0])));
  assert.equal(placed(phone), 3);
  assert.equal(tvLink.frames.at(-1)![0], 3);
  pads.serviceInput(service, 1, encodePad(state([0])));
  assert.deepEqual(listed(tvLink), ['0 box Pad', '3 phone Phone 4']);
  // A box gamepad on the screen takes it the same way.
  pads.screenMessage(tv, tvLink, { type: 'claim', place: 5 });
  pads.serviceInput(service, 1, encodePad(state([])));
  pads.serviceInput(service, 1, encodePad(state([0])));
  assert.deepEqual(listed(tvLink), ['3 phone Phone 4', '5 box Pad']);
  // One on no screen takes it on the screen that claims it: with its A, not another button.
  const laptopLink = link();
  const laptop = pads.openScreen(laptopLink, 'lan', false)!;
  pads.screenMessage(tv, tvLink, { type: 'release', slot: 5 });
  pads.screenMessage(laptop, laptopLink, { type: 'claim', place: 2 });
  pads.serviceInput(service, 1, encodePad(state([])));
  pads.serviceInput(service, 1, encodePad(state([1])));
  assert.deepEqual(listed(tvLink), ['0 box Pad', '3 phone Phone 4'], 'B goes to the box’s own screen');
  pads.screenMessage(tv, tvLink, { type: 'release', slot: 0 });
  pads.serviceInput(service, 1, encodePad(state([1, 0])));
  assert.deepEqual(listed(laptopLink), ['2 box Pad']);
  // A claim of a place the screen's own gamepad took, or older than 30 s, takes nothing.
  pads.screenMessage(laptop, laptopLink, { type: 'claim', place: 4 });
  pads.screenMessage(laptop, laptopLink, { type: 'local', places: [4] });
  pads.serviceInput(service, 1, encodePad(state([])));
  pads.serviceInput(service, 1, encodePad(state([0])));
  assert.deepEqual(listed(laptopLink), ['2 box Pad']);
  pads.screenMessage(tv, tvLink, { type: 'claim', place: 6 });
  now += CLAIM;
  pads.padFrame(held, encodePad(state([])));
  pads.padFrame(held, encodePad(state([0])));
  assert.equal(placed(phone), 3);
});
