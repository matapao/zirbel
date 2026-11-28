// The pads socket's routing (packages/core/pads.ts) and its pad frames (packages/sdk/pads.ts): screens and their codes,
// phones joining by a code, frame and code limits, Show on TV, and a screen kept for its resume. The box's own gamepads,
// the places controllers hold and claims are pads-places.test.ts; the sockets themselves pads.contract.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODE_LETTERS, WRONG_CODES } from '../packages/core/lobby.ts';
import { Pads, RESUME } from '../packages/core/pads.ts';
import { decodePad, encodePad, MAX_PAD_FRAME } from '../packages/sdk/pads.ts';
import { link, listed, state } from './pads-fixtures.ts';

test('a pad frame holds a slot, the layout, up to 32 buttons and 8 axes, and nothing else', () => {
  const frame = encodePad({
    slot: 3,
    standard: true,
    buttons: [
      { pressed: true, value: 1 },
      { pressed: false, value: 0.5 },
      { pressed: true, value: 0.2 },
    ],
    axes: [-1, 0.5, 2, Number.NaN],
  });
  assert.deepEqual([...frame], [3, 1, 3, 4, 0b101, 0, 0, 0, 255, 128, 51, 0x01, 0x80, 0x00, 0x40, 0xff, 0x7f, 0, 0]);
  const decoded = decodePad(frame);
  assert.deepEqual(
    decoded && {
      ...decoded,
      buttons: decoded.buttons.map((button) => [button.pressed, Math.round(button.value * 255)]),
      axes: decoded.axes.map((axis) => Math.round(axis * 32_767)),
    },
    {
      slot: 3,
      standard: true,
      buttons: [
        [true, 255],
        [false, 128],
        [true, 51],
      ],
      axes: [-32_767, 16_384, 32_767, 0],
    },
  );
  // At most 32 buttons and 8 axes are encoded; the largest frame is 56 bytes.
  const largest = encodePad({
    standard: false,
    buttons: Array.from({ length: 40 }, () => ({ pressed: true, value: 1 })),
    axes: Array(9).fill(1),
  });
  assert.equal(largest.length, MAX_PAD_FRAME);
  assert.equal(
    decodePad(largest)?.buttons.every((button) => button.pressed),
    true,
  );
  assert.deepEqual(decodePad(new Uint8Array([7, 0, 0, 0, 0, 0, 0, 0])), {
    slot: 7,
    standard: false,
    buttons: [],
    axes: [],
  });
  const refused = {
    short: [0, 1, 0, 0, 0, 0, 0],
    slot: [8, 0, 0, 0, 0, 0, 0, 0],
    flags: [0, 2, 0, 0, 0, 0, 0, 0],
    buttons: [0, 0, 33, 0, 0, 0, 0, 0],
    axes: [0, 0, 0, 9, 0, 0, 0, 0],
    long: [0, 0, 1, 0, 0, 0, 0, 0, 255, 0],
    cut: [0, 0, 0, 1, 0, 0, 0, 0, 0],
    pressedPastLast: [0, 0, 1, 0, 2, 0, 0, 0, 0],
    axisPastRange: [0, 0, 0, 1, 0, 0, 0, 0, 0x00, 0x80],
  };
  for (const [name, bytes] of Object.entries(refused)) assert.equal(decodePad(Uint8Array.from(bytes)), undefined, name);
});

test('a screen has a code phones join it by, its controllers in the lowest free slots, and their frames with their slot', () => {
  const pads = new Pads();
  const tv = link();
  const screen = pads.openScreen(tv, 'lan', false)!;
  assert.deepEqual(tv.texts[0], {
    type: 'screen',
    id: screen.id,
    code: screen.code,
    resume: screen.resume,
    box: false,
    tv: false,
  });
  assert.match(screen.code, new RegExp('^[' + CODE_LETTERS + ']{4}$'));
  assert.match(screen.id, /^[a-f0-9]{12}$/);
  assert.match(screen.resume, /^[\w-]{32}$/);
  assert.deepEqual(tv.texts[1], { type: 'pads', pads: [] });
  // Typed as people type it; the other listener's phones don't reach it.
  const phones = Array.from({ length: 8 }, () => link());
  const typed = screen.code.toLowerCase().split('').join(' ');
  assert.equal(pads.openPad(link(), 'local', '127.0.0.1', screen.code), undefined);
  const held = phones.map((phone) => pads.openPad(phone, 'lan', '192.168.1.20', typed)!);
  assert.deepEqual(phones[2]!.texts, [
    { type: 'pad', slot: 2, screen: screen.id, resume: held[2]!.resume, label: null },
  ]);
  assert.match(held[2]!.resume, /^[\w-]{32}$/);
  assert.deepEqual(listed(tv), [
    '0 phone Phone 1',
    '1 phone Phone 2',
    '2 phone Phone 3',
    '3 phone Phone 4',
    '4 phone Phone 5',
    '5 phone Phone 6',
    '6 phone Phone 7',
    '7 phone Phone 8',
  ]);
  assert.deepEqual(
    tv.last('pads')?.pads,
    listed(tv).map((_, slot) => ({
      slot,
      place: slot,
      kind: 'phone',
      name: 'Phone ' + (slot + 1),
      connected: true,
      label: null,
    })),
  );
  const ninth = link();
  assert.equal(pads.openPad(ninth, 'lan', '192.168.1.20', screen.code), undefined);
  assert.equal(ninth.closed, 4409);
  // A phone's own slot is ignored: the host writes it.
  pads.padFrame(held[5]!, encodePad({ ...state([0]), slot: 7 }));
  assert.deepEqual([...tv.frames.at(-1)!], [...encodePad({ ...state([0]), slot: 5 })]);
  // A phone that leaves frees its slot, the lowest free is taken next.
  pads.padGone(held[1]!);
  pads.padGone(held[1]!);
  assert.deepEqual(
    listed(tv).map((line) => line.split(' ')[0]),
    ['0', '2', '3', '4', '5', '6', '7'],
  );
  const again = link();
  pads.openPad(again, 'lan', '192.168.1.20', screen.code);
  assert.deepEqual(
    again.texts.map((message) => message.slot),
    [1],
  );
  // Anything else than a pad frame closes the phone.
  pads.padFrame(held[3]!, new Uint8Array([0, 0, 1, 0, 0, 0, 0, 0]));
  assert.equal(phones[3]!.closed, 1003);
  assert.equal(listed(tv).length, 7);
  const before = tv.frames.length;
  pads.padFrame(held[3]!, encodePad(state()));
  assert.equal(tv.frames.length, before, 'nothing more from a closed phone');
});

test('frames past 120 a second are dropped, and so are control messages', () => {
  let now = 1_000_000;
  const pads = new Pads(() => now);
  const tv = link();
  const screen = pads.openScreen(tv, 'lan', false)!;
  const phone = link();
  const held = pads.openPad(phone, 'lan', '192.168.1.20', screen.code)!;
  for (let i = 0; i < 130; i++) pads.padFrame(held, encodePad(state()));
  assert.equal(tv.frames.length, 120);
  now += 1000;
  pads.padFrame(held, encodePad(state()));
  assert.equal(tv.frames.length, 121);
  for (let i = 0; i < 130; i++)
    pads.screenMessage(screen, tv, { type: 'rumble', slot: 0, duration: 10, strong: 1, weak: 0 });
  assert.equal(phone.texts.filter((message) => message.type === 'rumble').length, 120);
  assert.equal(phone.closed, undefined);
});

test('wrong codes count against the address as the lobby counts them', () => {
  let now = 1_000_000;
  const pads = new Pads(() => now);
  const screen = pads.openScreen(link(), 'lan', false)!;
  const wrong = screen.code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
  for (let i = 0; i < WRONG_CODES; i++) {
    const phone = link();
    assert.equal(pads.openPad(phone, 'lan', '192.168.1.30', i % 2 ? wrong : 'not a code'), undefined);
    assert.equal(phone.closed, 4404);
  }
  const blocked = link();
  assert.equal(pads.openPad(blocked, 'lan', '::ffff:192.168.1.30', screen.code), undefined);
  assert.equal(blocked.closed, 4429);
  assert.ok(pads.openPad(link(), 'lan', '192.168.1.31', screen.code), 'another address');
  now += 60_000;
  assert.ok(pads.openPad(link(), 'lan', '192.168.1.30', screen.code), 'after the minute');
});

test('a screen lets its controllers go and rumbles them', () => {
  const pads = new Pads();
  const tv = link();
  const screen = pads.openScreen(tv, 'lan', false)!;
  const phone = link();
  pads.openPad(phone, 'lan', '192.168.1.20', screen.code);
  pads.screenMessage(screen, tv, { type: 'rumble', slot: 0, duration: 200, strong: 1, weak: 0.25 });
  pads.screenMessage(screen, tv, { type: 'rumble', slot: 4, duration: 200, strong: 1, weak: 0.25 });
  assert.deepEqual(phone.last('rumble'), { type: 'rumble', slot: 0, duration: 200, strong: 1, weak: 0.25 });
  pads.screenMessage(screen, tv, { type: 'release', slot: 0 });
  assert.equal(phone.closed, 4000);
  assert.deepEqual(tv.last('pads'), { type: 'pads', pads: [] });
  // Messages from a socket the screen no longer has are not its.
  pads.screenMessage(screen, link(), { type: 'claim' });
});

test('a screen is kept 15 s for its resume, with its code and controllers, and then its phones are told it ended', () => {
  let now = 1_000_000;
  const pads = new Pads(() => now);
  const first = link();
  const screen = pads.openScreen(first, 'lan', false)!;
  const phone = link();
  pads.openPad(phone, 'lan', '192.168.1.20', screen.code);
  pads.screenGone(screen, first, 1001);
  now += RESUME - 1;
  pads.sweep();
  // Another listener's resume opens a screen of its own.
  const elsewhere = link();
  assert.notEqual(pads.openScreen(elsewhere, 'local', false, screen.resume), screen);
  const next = link();
  assert.equal(pads.openScreen(next, 'lan', false, screen.resume), screen);
  assert.deepEqual(next.texts, [
    { type: 'screen', id: screen.id, code: screen.code, resume: screen.resume, box: false, tv: false },
    { type: 'pads', pads: [{ slot: 0, place: 0, kind: 'phone', name: 'Phone 1', connected: true, label: null }] },
  ]);
  // A page that resumes it while its socket is still open takes it over.
  const taken = link();
  pads.openScreen(taken, 'lan', false, screen.resume);
  assert.equal(next.closed, 4001);
  pads.screenGone(screen, next, 4001);
  pads.padFrame(pads.openPad(link(), 'lan', '192.168.1.20', screen.code)!, encodePad(state([1])));
  assert.equal(taken.frames.length, 1);
  // Its socket drops for good.
  pads.screenGone(screen, taken, 1006);
  now += RESUME;
  pads.sweep();
  assert.deepEqual(phone.texts.at(-1), { type: 'closed' });
  assert.equal(phone.closed, 1000);
  assert.notEqual(pads.openScreen(link(), 'lan', false, screen.resume), screen, 'a new screen for a resume that ended');
  assert.equal(pads.openPad(link(), 'lan', '192.168.1.20', screen.code), undefined);
});

test('a screen that closes itself ends at once, and a listener holds 64 screens', () => {
  const pads = new Pads();
  const tv = link();
  const screen = pads.openScreen(tv, 'lan', false)!;
  const phone = link();
  pads.openPad(phone, 'lan', '192.168.1.20', screen.code);
  pads.screenGone(screen, tv, 1000);
  assert.deepEqual([phone.texts.at(-1), phone.closed], [{ type: 'closed' }, 1000]);
  for (let i = 0; i < 64; i++) assert.ok(pads.openScreen(link(), 'lan', false));
  const refused = link();
  assert.equal(pads.openScreen(refused, 'lan', false), undefined);
  assert.equal(refused.closed, 4409);
  assert.ok(pads.openScreen(link(), 'local', false), 'the other listener has its own');
  const codes = new Set([...Array(30)].map(() => pads.openScreen(link(), 'local', false)!.code));
  assert.equal(codes.size, 30, 'never reused while open');
});

test('Show on TV opens the link on the box’s own screen, which tells the others it is open', () => {
  const pads = new Pads();
  const laptop = link();
  const screen = pads.openScreen(laptop, 'lan', false)!;
  pads.screenMessage(screen, laptop, { type: 'show', link: '/join/abc' });
  assert.equal(laptop.last('shown'), undefined, 'no TV to show on');
  const tvLink = link();
  const tv = pads.openScreen(tvLink, 'lan', true)!;
  assert.deepEqual([tvLink.texts[0]?.box, tvLink.texts[0]?.tv], [true, true]);
  assert.deepEqual(laptop.texts.at(-1), {
    type: 'screen',
    id: screen.id,
    code: screen.code,
    resume: screen.resume,
    box: false,
    tv: true,
  });
  const local = link();
  pads.openScreen(local, 'local', false);
  assert.equal(local.texts[0]?.tv, false, 'the TV is another listener’s');
  pads.screenMessage(screen, laptop, { type: 'show', link: '/join/abc#seat=ticket' });
  assert.deepEqual(tvLink.texts.at(-1), { type: 'open', link: '/join/abc#seat=ticket' });
  assert.deepEqual(laptop.texts.at(-1), { type: 'shown', code: tv.code });
  // While the TV's page navigates, the link waits for the page that resumes it.
  pads.screenGone(tv, tvLink, 1001);
  pads.screenMessage(screen, laptop, { type: 'show', link: '/join/def' });
  assert.deepEqual(laptop.texts.at(-1), { type: 'shown', code: tv.code });
  const resumed = link();
  pads.openScreen(resumed, 'lan', true, tv.resume);
  assert.deepEqual(
    resumed.texts.map((message) => message.type),
    ['screen', 'pads', 'open'],
  );
  assert.deepEqual(resumed.texts[2], { type: 'open', link: '/join/def' });
  pads.screenGone(tv, resumed, 1000);
  assert.deepEqual(laptop.texts.at(-1), {
    type: 'screen',
    id: screen.id,
    code: screen.code,
    resume: screen.resume,
    box: false,
    tv: false,
  });
});
