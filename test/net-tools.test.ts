// The parts of zirbel-net play() is built from, on their own: the pack, pack32 and json codecs, named channels, the
// network simulator and its ?net= switch, and the stats overlay.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ALL, channels, connect, json, netParams, netsim, overlay, pack, pack32, play, Reader, Writer, type Connection } from '../packages/net/index.ts';
import { dots, KEY, memoryRelay, ROOM, until, wait } from './net-fixture.ts';

const roundTrip = (codec: typeof pack, value: unknown) => {
  const w = new Writer(8);
  codec.write(w, value);
  return { value: codec.read(new Reader(w.view())), size: w.pos };
};

/** A small seeded random source, so a failing case can be found again. */
function random(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function anyValue(next: () => number, depth = 0): unknown {
  const kind = Math.floor(next() * (depth > 3 ? 6 : 8));
  switch (kind) {
    case 0: return null;
    case 1: return next() < 0.5;
    case 2: return Math.floor(next() * 600) - 300;
    case 3: return (next() - 0.5) * 1e6;
    case 4: return Math.fround(next() * 100);
    case 5: return String.fromCodePoint(...Array.from({ length: Math.floor(next() * 6) }, () => Math.floor(next() * 0x2ffff)).filter((c) => c < 0xd800 || c > 0xdfff));
    case 6: return Array.from({ length: Math.floor(next() * 5) }, () => anyValue(next, depth + 1));
    default: return Object.fromEntries(Array.from({ length: Math.floor(next() * 5) }, (_, i) => ['k' + i + Math.floor(next() * 9), anyValue(next, depth + 1)]));
  }
}

test('pack keeps every value exactly, small ones small, and never throws on bytes that are not a value', () => {
  for (const value of [null, true, false, 0, 239, 240, -1, 2 ** 52 - 1, -(2 ** 52 - 1), 2 ** 52, -(2 ** 52), 2 ** 53, 1.5, -2.5, 0.1, Number.NaN, Infinity, -0,
    'zirbel', 'grüß 🎮', [], [1, [2, [3]]], { x: 1, y: [true, null], z: { w: 'w' } }, Uint8Array.of(1, 2, 3)]) {
    assert.deepStrictEqual(roundTrip(pack, value).value, value);
  }
  // Property-style: random plain values come back as they went.
  const next = random(7);
  for (let i = 0; i < 500; i++) {
    const value = anyValue(next);
    assert.deepStrictEqual(roundTrip(pack, value).value, value);
  }
  assert.deepEqual([0, 239, 240, -1, true, 'ab', { x: 1 }].map((v) => roundTrip(pack, v).size), [1, 1, 3, 2, 1, 4, 5]);
  // As JSON: an undefined property is left out, an undefined item is null.
  assert.deepStrictEqual(roundTrip(pack, { a: undefined, b: [undefined] }).value, { b: [null] });
  assert.throws(() => roundTrip(pack, () => 1), /cannot send a function/);
  // A key such as __proto__ stays a key.
  const odd = roundTrip(pack, JSON.parse('{"__proto__":{"polluted":1}}') as unknown).value as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(odd), Object.prototype);
  assert.deepEqual(Object.keys(odd), ['__proto__']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  // Several values in a row read back in order; garbage reads as something, never an exception.
  const w = new Writer();
  for (const v of [1, 'two', [3]]) pack.write(w, v);
  const r = new Reader(w.view());
  assert.deepEqual([pack.read(r), pack.read(r), pack.read(r)], [1, 'two', [3]]);
  const bytes = random(3);
  for (let i = 0; i < 2000; i++) pack.read(new Reader(Uint8Array.from({ length: 1 + Math.floor(bytes() * 40) }, () => Math.floor(bytes() * 256))));
  assert.equal(pack.read(new Reader(Uint8Array.of(7, 0xff, 0xff, 0xff, 0x7f))), null, 'a count past the end');
  // json: what JSON keeps; text that is not JSON reads as null.
  assert.deepEqual(roundTrip(json, { x: [1, 'a'], u: undefined }).value, { x: [1, 'a'] });
  assert.equal(json.read(new Reader(new Writer().str('{nope').view())), null);
});

test('pack32 sends numbers that aren\'t whole as 32-bit floats, and play() with f32 sends states and inputs so', async (t) => {
  const value = { x: 0.1, y: [-2.5, 1e-9, Number.NaN, -Infinity], n: 3, big: 2 ** 40, s: 'a', b: true };
  const exact = roundTrip(pack, value), small = roundTrip(pack32, value);
  assert.deepStrictEqual(exact.value, value);
  assert.deepStrictEqual(small.value, { ...value, x: Math.fround(0.1), y: [-2.5, Math.fround(1e-9), Number.NaN, -Infinity] });
  assert.equal(exact.size - small.size, 12);

  const room = memoryRelay();
  const a = dots({ stepping: false }), b = dots({ stepping: false });
  a.world.get(1)!.x = 0.1;
  const A = play(a.hooks, { connect: room.options(), f32: true });
  const B = play(b.hooks, { connect: room.options(), f32: true });
  t.after(() => { A.stop(); B.stop(); });
  await Promise.all([A.ready, B.ready]);
  b.local = { dx: 0.3, dy: 1 };
  await until(() => (b.world.get(1)?.x ?? 0) !== 0 && (a.world.get(2)?.input?.dx ?? 0) !== 0, 2000, 'a state and an input');
  assert.deepEqual([b.world.get(1)!.x, a.world.get(2)!.input, a.world.get(1)!.x], [Math.fround(0.1), { dx: Math.fround(0.3), dy: 1 }, 0.1]);
});

function pair(t: TestContext) {
  const room = memoryRelay();
  const a = connect(room.options()), b = connect(room.options());
  t.after(() => { a.close(); b.close(); });
  const opened = (net: Connection) => new Promise<void>((done) => net.on('open', () => done()));
  return { room, a, b, ready: Promise.all([opened(a), opened(b)]) };
}

test('channels map names to message types in the order they are declared, the same on every seat', async (t) => {
  const { a, b, ready } = pair(t);
  await ready;
  const ca = channels(a, ['shot', 'chat'], { first: 10 }), cb = channels(b, ['shot', 'chat'], { first: 10 });
  assert.deepEqual({ ...ca.types }, { shot: 10, chat: 11 });
  assert.throws(() => channels(a, ['x', 'x']), /must differ/);
  assert.throws(() => channels(a, ['x', 'y'], { first: 223 }), /past 223/);
  assert.throws(() => ca.send('nope' as 'shot'), /no channel nope/);
  const got: unknown[] = [], types: number[] = [];
  b.on('message', (_from, type) => types.push(type));
  const shot = (value: unknown, from: number, reliable: boolean) => got.push(['shot', value, from, reliable]);
  cb.on('shot', shot).on('chat', (value, from, reliable) => got.push(['chat', value, from, reliable]));
  ca.send('shot', { x: 1, y: 2 });
  ca.stream('chat', 'hi', ALL);
  await until(() => got.length === 2, 2000, 'both messages');
  assert.deepEqual(got, [['shot', { x: 1, y: 2 }, 1, true], ['chat', 'hi', 1, false]]);
  assert.deepEqual(types, [10, 11]);
  cb.off('shot', shot);
  ca.send('shot', 1);
  ca.send('chat', 'after');
  await until(() => got.length === 3, 2000, 'the chat line');
  assert.deepEqual(got[2], ['chat', 'after', 1, true]);
  cb.close();
  ca.send('chat', 'unheard');
  await wait(30);
  assert.equal(got.length, 3);
});

test('play() sessions talk on the game\'s own channels', async (t) => {
  const room = memoryRelay();
  const a = dots(), b = dots();
  const A = play(a.hooks, { connect: room.options(), channels: ['chat', 'boom'] });
  const B = play(b.hooks, { connect: room.options(), channels: ['chat', 'boom'] });
  t.after(() => { A.stop(); B.stop(); });
  await Promise.all([A.ready, B.ready]);
  const heard: unknown[] = [];
  B.on('message', (channel, value, from) => heard.push([channel, value, from]));
  A.send('boom', { at: [3, 4] });
  A.stream('chat', 'gg');
  await until(() => heard.length === 2, 2000, 'both');
  assert.deepEqual(heard, [['boom', { at: [3, 4] }, 1], ['chat', 'gg', 1]]);
});

test('?net= asks for lag, jitter, loss, a bandwidth cap and the stats overlay; anything else is left out', () => {
  assert.deepEqual(netParams('?room=AB&net=lag:120,jitter:30,loss:5,kbps:256,stats&key=k'), { lag: 120, jitter: 30, loss: 5, kbps: 256, stats: true });
  assert.deepEqual(netParams('?net=lag%3A50%2Closs%3A200,lag:-1,jitter:,foo:3,kbps:x'), { lag: 50 });
  assert.equal(netParams('?room=AB'), null);
  assert.equal(netParams('?net=%E0%A4%A'), null);
  assert.equal(netParams(''), null);
});

test('the simulator delays both ways, keeps frames in order, and drops only unreliable messages', async (t) => {
  const room = memoryRelay();
  const sim = netsim({ lag: 160, jitter: 40, loss: 50 }, room.WebSocket);
  const a = connect(room.options()), b = connect(room.options({ WebSocket: sim }));
  t.after(() => { a.close(); b.close(); });
  await Promise.all([a, b].map((net) => new Promise<void>((done) => net.on('open', () => done()))));
  const got: { n: number; reliable: boolean; at: number }[] = [];
  b.on('message', (_from, _type, r, reliable) => got.push({ n: r.u16(), reliable, at: performance.now() }));
  const sent = performance.now();
  for (let n = 0; n < 200; n++) {
    a.send(ALL, 1, a.begin().u16(n));
    a.stream(ALL, 2, a.begin().u16(n));
    if (n % 20 === 0) await wait(1);
  }
  await until(() => got.filter((m) => m.reliable).length === 200, 4000, 'every reliable message');
  await wait(200);
  const reliable = got.filter((m) => m.reliable), unreliable = got.filter((m) => !m.reliable);
  assert.deepEqual(reliable.map((m) => m.n), Array.from({ length: 200 }, (_, n) => n), 'reliable: all, in order');
  assert.ok(unreliable.length > 40 && unreliable.length < 160, 'about half the unreliable ones: ' + unreliable.length);
  assert.equal(sim.lost, 200 - unreliable.length);
  assert.ok(got[0]!.at - sent >= 75, 'half the lag on the way in: ' + (got[0]!.at - sent));
  // The client's own pings and pongs are never dropped, and its round trip shows the lag.
  await until(() => b.rtt >= 150, 3000, 'the round trip with the lag: ' + b.rtt);
  assert.equal(b.connected, true);
});

test('the simulator closes at once, after what it still holds: a clean leave stays one as a page unloads', async (t) => {
  const room = memoryRelay();
  const a = connect(room.options()), b = connect(room.options({ WebSocket: netsim({ lag: 400 }, room.WebSocket) }));
  t.after(() => { a.close(); b.close(); });
  await Promise.all([a, b].map((net) => new Promise<void>((done) => net.on('open', () => done()))));
  const heard: string[] = [];
  a.on('message', (_from, _type, r) => heard.push(r.text())).on('leave', (id) => heard.push('leave ' + id)).on('away', (id) => heard.push('away ' + id));
  const began = performance.now();
  b.send(ALL, 1, 'last words');
  b.close();
  await until(() => heard.length === 2, 2000, 'the leave');
  assert.deepEqual(heard, ['last words', 'leave 2']);
  assert.ok(performance.now() - began < 100, 'took ' + (performance.now() - began) + ' ms, not the 200 ms lag on the way up');
});

test('the simulator\'s bandwidth cap queues frames, and the client drops its unreliable data behind the queue', async (t) => {
  const room = memoryRelay();
  const sim = netsim({ kbps: 400 }, room.WebSocket);
  const a = connect(room.options({ WebSocket: sim })), b = connect(room.options());
  t.after(() => { a.close(); b.close(); });
  await Promise.all([a, b].map((net) => new Promise<void>((done) => net.on('open', () => done()))));
  let bytes = 0, last = 0;
  b.on('message', (_from, _type, r) => { bytes += r.left(); last = performance.now(); });
  const sent = performance.now();
  // 20 KB at 400 kbit/s, 50 kB/s: about 400 ms on the wire.
  for (let i = 0; i < 20; i++) a.send(ALL, 1, new Uint8Array(1000));
  await wait(0);
  for (let i = 0; i < 5; i++) a.stream(ALL, 2, new Uint8Array(100));
  await wait(0);
  await until(() => bytes >= 20_000, 3000, 'everything through the cap');
  assert.ok(last - sent >= 300, 'paced by the cap: ' + (last - sent));
  assert.ok(a.stats.dropped >= 1, 'stale data dropped behind the queue');
});

test('the stats overlay shows the round trip, the traffic and the drops, and goes again; ?net=…,stats turns it on in play()', async (t) => {
  const body: { children: { style: { cssText: string }; textContent: string | null; remove(): void }[] } & { appendChild(node: unknown): void } = {
    children: [],
    appendChild(node) { this.children.push(node as never); },
  };
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, location: g.location };
  g.document = {
    body, visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
    createElement: () => {
      const el = { style: { cssText: '' }, textContent: '' as string | null, remove() { body.children.splice(body.children.indexOf(el), 1); } };
      return el;
    },
  };
  g.location = { protocol: 'http:', host: 'relay.test', pathname: '/game/', search: '?room=' + ROOM.toLowerCase() + '&key=' + KEY + '&net=lag:80,stats' };
  t.after(() => Object.assign(g, saved));
  const room = memoryRelay();
  const a = dots(), b = dots();
  // Room and key come from the address, as on a Zirbel host: the options only say how to reach this test's relay.
  const A = play(a.hooks, { connect: { url: 'ws://relay.test/mp', WebSocket: room.WebSocket, storage: null } });
  const B = play(b.hooks, { connect: { url: 'ws://relay.test/mp', WebSocket: room.WebSocket, storage: null } });
  t.after(() => { A.stop(); B.stop(); });
  assert.deepEqual(await Promise.all([A.ready, B.ready]), [true, true]);
  assert.equal(body.children.length, 2);
  assert.match(body.children[0]!.style.cssText, /position:fixed/);
  await until(() => /seat 2[^]*rtt ([7-9]\d|\d{3,}) ms/.test(body.children[1]!.textContent ?? ''), 4000, 'the lag in the overlay');
  assert.match(body.children[1]!.textContent!, /^snapshot seat 2 {2}lost 0\nrtt \d+ ms {2}jitter \d+ ms\nin [\d.]+ kB\/s {2}out [\d.]+ kB\/s\ndropped 0$/);
  B.stop();
  assert.equal(body.children.length, 1);
  const hide = overlay(A.net!, () => 'mine');
  assert.match(body.children[1]!.textContent!, /^mine\nrtt/);
  hide();
  assert.equal(body.children.length, 1);
});
