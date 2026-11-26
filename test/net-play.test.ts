// play() in its snapshot and predict modes (packages/net/play.ts, snapshot.ts), end to end over the relay a net-v2
// room runs (packages/core/relay.ts) with zirbel-net's own client: playing alone, solo fallbacks, the host's state
// on every seat, what changed sent entity by entity, late join, host handover, away and back, prediction.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { connect, HOST, play, Reader, type PlayOptions, type Session, type WebSocketLike } from '../packages/net/index.ts';
import { dots, memoryRelay, positions, until, wait } from './net-fixture.ts';

function start(t: TestContext, hooks: Parameters<typeof play>[0], options: PlayOptions) {
  const session = play(hooks, options);
  t.after(() => session.stop());
  return session;
}

test('play() without a room plays alone at once and steps the game itself', async (t) => {
  const g = dots();
  const s = start(t, g.hooks, {});
  assert.equal(await s.ready, false);
  assert.deepEqual([s.id, s.isHost(), s.net, s.mode, g.me, g.simulating], [1, true, null, 'snapshot', 1, true]);
  g.local = { dx: 30, dy: 0 };
  await until(() => g.world.get(1)!.x > 1, 2000, 'the game stepping alone');
  assert.throws(() => s.act('x'), /act\(\) is for the actions and events modes/);
  assert.throws(() => play(g.hooks, { mode: 'turbo' as PlayOptions['mode'] }), /modes are snapshot, predict, actions, events, lockstep/);
});

test('play() falls back to playing alone when refused, when no seat comes in time, and when the room closes', async (t) => {
  const room = memoryRelay();
  const g = dots();
  const offline: unknown[] = [];
  const refused = start(t, g.hooks, { connect: room.options({ key: 'wrong' }) });
  refused.on('offline', (code, message) => offline.push([code, message]));
  assert.equal(await refused.ready, false);
  assert.deepEqual(offline, [[6, 'no game with that code is running']]);
  assert.deepEqual([refused.net, refused.isHost(), g.simulating], [null, true, true]);

  // A host that never answers: the client would retry for ever, play() gives up.
  class Silent implements WebSocketLike {
    binaryType = ''; readyState = 0; bufferedAmount = 0;
    onopen = null; onmessage = null; onclose = null; onerror = null;
    send() {}
    close() {}
  }
  const h = dots(), began = performance.now();
  const silent = start(t, h.hooks, { connect: room.options({ WebSocket: Silent }), timeout: 150 });
  assert.equal(await silent.ready, false);
  assert.ok(performance.now() - began >= 140);
  assert.equal(h.simulating, true);

  const a = dots(), b = dots();
  const A = start(t, a.hooks, { connect: room.options() });
  assert.equal(await A.ready, true);
  const B = start(t, b.hooks, { connect: room.options() });
  assert.equal(await B.ready, true);
  await until(() => b.world.has(1) && b.world.has(2), 2000, 'the follower drawing both players');
  assert.equal(b.simulating, false);
  const ended: unknown[] = [];
  B.on('offline', (code) => ended.push(code));
  room.relay.close();
  await until(() => ended.length === 1, 2000, 'the room closing');
  // B plays on alone from the last state it had: its own player, nobody else's, and it runs the game now.
  assert.deepEqual([ended[0], B.net, B.isHost(), b.simulating, [...b.world.keys()]], [5, null, true, true, [2]]);
});

test('snapshot: the host runs the game, every seat draws its state, and a late joiner gets all of it', async (t) => {
  const room = memoryRelay();
  const a = dots(), b = dots(), c = dots();
  const A = start(t, a.hooks, { connect: room.options(), rate: 40 });
  const online: unknown[] = [];
  A.on('online', (id, hostId) => online.push([id, hostId]));
  assert.equal(await A.ready, true);
  assert.deepEqual([A.id, A.isHost(), online], [1, true, [[1, 1]]]);
  const B = start(t, b.hooks, { connect: room.options(), rate: 40 });
  assert.equal(await B.ready, true);
  assert.deepEqual([B.id, B.isHost(), b.me, b.simulating], [2, false, 2, false]);

  a.local = { dx: 40, dy: 0 };
  b.local = { dx: 0, dy: 40 };
  // B's input steers its player on the host; the host's state comes back to B.
  await until(() => (a.world.get(2)?.y ?? 0) > 2 && (b.world.get(1)?.x ?? 0) > 2, 3000, 'inputs and state going round');
  assert.equal(b.calls.step, undefined, 'a follower never steps the game');
  a.local = b.local = null;
  await wait(150);
  assert.deepEqual(positions(b.world), positions(a.world));

  // A newcomer gets the whole state, and joins it.
  const C = start(t, c.hooks, { connect: room.options(), rate: 40 });
  assert.equal(await C.ready, true);
  await until(() => c.world.size === 3, 2000, 'the newcomer drawing every player');
  assert.deepEqual(positions(c.world), positions(a.world));
  assert.deepEqual([...a.world.keys()].sort((x, y) => x - y), [1, 2, 3]);

  // Leaving takes the player out everywhere.
  C.leave();
  await until(() => !a.world.has(3) && !b.world.has(3), 2000, 'the player leaving');
  assert.equal(C.net, null);
});

/** A raw zirbel-net client in the room, reading the host's STATE messages as they are on the wire. */
function wireFollower(room: ReturnType<typeof memoryRelay>) {
  const net = connect(room.options());
  const states: { full: boolean; seq: number; base: number; keys: string[]; gone: string[] }[] = [];
  let acking = true;
  net.on('message', (_from, type, r: Reader) => {
    if (type !== 0) return;
    const flags = r.u8(), seq = r.u16(), base = flags & 1 ? r.u16() : -1;
    r.f64();
    if (flags & 2) r.u16();
    const keys: string[] = [], gone: string[] = [];
    for (let n = r.varint(); n > 0; n--) { keys.push(r.str()); r.bytes(); }
    for (let n = r.varint(); n > 0; n--) gone.push(r.str());
    states.push({ full: !(flags & 1), seq, base, keys: keys.sort(), gone });
    // INPUT: ack the newest state, no input.
    if (acking) net.stream(HOST, 1, net.begin().u8(1).u16(seq).u16(0).u8(0));
  });
  return { net, states, stopAcking: () => { acking = false; } };
}

test('snapshot: each seat gets what changed since the state it confirmed, entity by entity, and everything now and then', async (t) => {
  const room = memoryRelay();
  const a = dots({ stepping: false });
  a.extra = { rock1: { x: 1 }, rock2: { x: 2 } };
  start(t, a.hooks, { connect: room.options(), rate: 50, full: 600 });
  await wait(20);
  const f = wireFollower(room);
  t.after(() => f.net.close());
  await until(() => f.states.length >= 3, 2000, 'states');
  // The first state is everything; after it is confirmed, nothing changed, so nothing is sent.
  assert.deepEqual(f.states[0], { full: true, seq: f.states[0]!.seq, base: -1, keys: ['p1', 'p2', 'rock1', 'rock2'], gone: [] });
  const quiet = f.states.slice(1).filter((s) => !s.full);
  assert.ok(quiet.length >= 1 && quiet.every((s) => s.keys.length === 0 && s.gone.length === 0), JSON.stringify(f.states));

  // One entity changes, one goes: only those.
  const seen = f.states.length;
  a.world.get(1)!.x = 5;
  delete a.extra.rock2;
  await until(() => f.states.slice(seen).some((s) => s.keys.length > 0), 2000, 'the change');
  const change = f.states.slice(seen).find((s) => s.keys.length > 0)!;
  assert.deepEqual([change.full, change.keys, change.gone], [false, ['p1'], ['rock2']]);

  // Without confirmations, each state carries everything since the last confirmed one.
  f.stopAcking();
  await wait(60);
  const unconfirmed = f.states.length;
  a.world.get(2)!.x = 7;
  await until(() => f.states.length > unconfirmed + 3, 2000, 'more states');
  const later = f.states.slice(unconfirmed + 1).filter((s) => !s.full);
  assert.ok(later.length > 0 && later.every((s) => s.keys.includes('p2')), JSON.stringify(later));

  // The safety net: a full state every 600 ms even while every state is confirmed.
  await until(() => f.states.filter((s) => s.full).length >= 2, 2000, 'a second full state');
  assert.deepEqual(f.states.filter((s) => s.full).at(-1)!.keys, ['p1', 'p2', 'rock1']);
});

test('snapshot: interest gives each seat only the entities it should see', async (t) => {
  const room = memoryRelay();
  const a = dots(), b = dots(), c = dots();
  a.extra = { secret: { x: 1, y: 1, hp: 1 } };
  a.hooks.interest = (seat: number, key: string) => key !== 'secret' || seat === 3;
  const keys: Record<number, Set<string>> = { 2: new Set(), 3: new Set() };
  for (const [seat, g] of [[2, b], [3, c]] as const) {
    const restore = g.hooks.restore!.bind(g.hooks);
    g.hooks.restore = (state: unknown) => { for (const k of Object.keys(state as object)) keys[seat]!.add(k); restore(state); };
  }
  start(t, a.hooks, { connect: room.options() });
  await wait(20);
  start(t, b.hooks, { connect: room.options() });
  await wait(20);
  start(t, c.hooks, { connect: room.options() });
  await until(() => keys[3]!.has('secret') && keys[2]!.has('p3'), 2000, 'states for both');
  assert.equal(keys[2]!.has('secret'), false);
});

test('snapshot: when the host leaves, the next seat carries on from its last state and the others follow it', async (t) => {
  const room = memoryRelay();
  const a = dots(), b = dots(), c = dots();
  const A = play(a.hooks, { connect: room.options(), rate: 40 });
  await A.ready;
  const B = start(t, b.hooks, { connect: room.options(), rate: 40 });
  await B.ready;
  const C = start(t, c.hooks, { connect: room.options(), rate: 40 });
  await C.ready;
  b.local = { dx: 50, dy: 0 };
  await until(() => (c.world.get(2)?.x ?? 0) > 2, 3000, 'B moving under the first host');
  const hosts: boolean[] = [];
  B.on('host', (host) => hosts.push(host));
  A.stop();
  await until(() => B.isHost(), 2000, 'B taking over');
  assert.deepEqual([hosts, b.simulating, c.simulating], [[true], true, false]);
  // B runs the game now, from where it was, and C draws B's state; A is gone from both.
  const from = b.world.get(2)!.x;
  assert.ok(from > 2);
  await until(() => (c.world.get(2)?.x ?? 0) > from + 2, 3000, 'C following the new host');
  assert.equal(b.world.has(1) || c.world.has(1), false);
  assert.ok((b.calls.step ?? 0) > 0);
});

test('snapshot: a dropped link comes back on the same seat, and the others hear it was away', async (t) => {
  const room = memoryRelay();
  const a = dots(), b = dots();
  const A = start(t, a.hooks, { connect: room.options() });
  await A.ready;
  const before = new Set(room.sockets);
  const B = start(t, b.hooks, { connect: room.options() });
  await B.ready;
  const socket = [...room.sockets].find((s) => !before.has(s))!;
  const heard: unknown[] = [];
  A.on('away', (id) => heard.push(['away', id])).on('back', (id) => heard.push(['back', id]));
  socket.kill();
  await until(() => heard.length === 2, 3000, 'away and back');
  assert.deepEqual(heard, [['away', 2], ['back', 2]]);
  assert.equal(B.id, 2);
  a.world.get(1)!.hp = 9;
  await until(() => b.world.get(1)?.hp === 9, 2000, 'state after the resume');
});

test('predict: a follower moves its own player at once and settles on the host\'s state', async (t) => {
  const room = memoryRelay();
  const a = dots(), b = dots();
  const A = start(t, a.hooks, { mode: 'predict', connect: room.options() });
  await A.ready;
  const B: Session = start(t, b.hooks, { mode: 'predict', connect: room.options(), net: 'lag:300' });
  await B.ready;
  await until(() => b.world.has(2), 3000, 'B\'s own player in the state');
  const began = performance.now();
  b.local = { dx: 60, dy: 0 };
  // Long before the 300 ms round trip, B already sees its player move.
  await until(() => (b.world.get(2)?.x ?? 0) > 1, 250, 'the prediction');
  assert.ok(performance.now() - began < 250);
  assert.ok((a.world.get(2)?.x ?? 0) < 1, 'the host has not had the input yet');
  await wait(400);
  b.local = { dx: 0, dy: 0 };
  // Once the host has applied every input, the prediction and the host agree.
  await until(() => Math.abs((a.world.get(2)?.x ?? 0) - (b.world.get(2)?.x ?? -1)) < 0.01, 3000, 'prediction and host agreeing');
  assert.ok((b.calls.predict ?? 0) > 0);
  assert.ok(a.world.get(2)!.x > 20, 'every input reached the host: ' + a.world.get(2)!.x);
  assert.equal(B.isHost(), false);
});
