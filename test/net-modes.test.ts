// play() in its actions, events and lockstep modes (packages/net/log.ts, lockstep.ts), end to end over the relay a
// net-v2 room runs (packages/core/relay.ts): the host's order on every seat, checks, late join with the state in
// chunks, host handover, and lockstep's same simulation on every seat, its joins and leaves, and drift.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { APP } from '../packages/net/internal.ts';
import { play, type Hooks, type PlayOptions } from '../packages/net/index.ts';
import { Cursor } from '../packages/net/protocol.ts';
import { memoryRelay, until, wait } from './net-fixture.ts';

function start(t: TestContext, hooks: Hooks, options: PlayOptions) {
  const session = play(hooks, options);
  t.after(() => session.stop());
  return session;
}

/** A game of moves for the actions mode: every seat keeps the same list of what happened, in the host's order. */
function tally() {
  const g = { list: [] as string[], hooks: {} as Hooks };
  g.hooks = {
    join(id) { g.list.push('+' + id); },
    leave(id) { g.list.push('-' + id); },
    validate: (_id, action) => action !== 'bad',
    apply(id, action) { g.list.push(id + ':' + String(action)); },
    snapshot: () => ({ list: g.list }),
    restore(state) { g.list = [...(state as { list: string[] }).list]; },
  };
  return g;
}

test('actions: every seat applies every action in the host\'s order, and checks keep bad ones out', async (t) => {
  const room = memoryRelay();
  const a = tally(), b = tally(), c = tally(), d = tally();
  const A = start(t, a.hooks, { mode: 'actions', connect: room.options() });
  // Alone, an action is checked and done at once.
  A.act('early');
  A.act('bad');
  assert.deepEqual(a.list, ['1:early']);
  await A.ready;
  const B = start(t, b.hooks, { mode: 'actions', connect: room.options() });
  await B.ready;
  const C = start(t, c.hooks, { mode: 'actions', connect: room.options() });
  await C.ready;
  await until(() => c.list.includes('+3') && b.list.includes('+3'), 2000, 'both joined everywhere');
  for (let i = 0; i < 5; i++) {
    A.act('a' + i);
    B.act('b' + i);
    C.act('c' + i);
    if (i === 2) B.act('bad');
  }
  await until(() => [a, b, c].every((g) => g.list.length === a.list.length && g.list.filter((x) => /^\d:[abc]\d$/.test(x)).length === 15),
    3000, 'every action everywhere');
  assert.deepEqual(b.list, a.list);
  assert.deepEqual(c.list, a.list);
  assert.equal(a.list.some((x) => x.endsWith(':bad')), false);
  // The host's own actions and each seat's keep their order.
  for (const seat of ['1:a', '2:b', '3:c']) assert.deepEqual(a.list.filter((x) => x.startsWith(seat)), [0, 1, 2, 3, 4].map((i) => seat + i));

  // A newcomer gets the state, and every action after it.
  const D = start(t, d.hooks, { mode: 'actions', connect: room.options() });
  await D.ready;
  await until(() => d.list.includes('+4'), 2000, 'the newcomer\'s state');
  C.act('after');
  await until(() => d.list.at(-1) === '3:after' && a.list.at(-1) === '3:after', 2000, 'an action after the newcomer');
  assert.deepEqual(d.list, a.list);
});

test('actions: a new host carries on with the log, and actions sent to the old one are not lost', async (t) => {
  const room = memoryRelay();
  const a = tally(), b = tally(), c = tally();
  const A = play(a.hooks, { mode: 'actions', connect: room.options() });
  await A.ready;
  const B = start(t, b.hooks, { mode: 'actions', connect: room.options() });
  await B.ready;
  const C = start(t, c.hooks, { mode: 'actions', connect: room.options() });
  await C.ready;
  await until(() => b.list.includes('+3'), 2000, 'C in');
  A.stop();
  // Sent while the host is leaving: C asks whoever is host, and asks again when the host changes.
  C.act('during');
  await until(() => B.isHost() && c.list.includes('3:during') && b.list.includes('3:during'), 3000, 'the action on the new host');
  B.act('next');
  await until(() => c.list.at(-1) === '2:next', 2000, 'the new host\'s own action');
  assert.deepEqual(c.list, b.list);
  assert.equal(b.list.filter((x) => x === '-1').length, 1);
  assert.equal(b.list.filter((x) => x === '3:during').length, 1);
});

/** Messages of one of play()'s types in frames a seat received. */
function count(frames: Uint8Array[], type: number) {
  let n = 0;
  for (const f of frames) for (const c = new Cursor().reset(f, 1, f.length); c.next();) if (c.type === APP + type) n++;
  return n;
}

test('events: the host runs a big world, a newcomer gets it in chunks, then the changes since', async (t) => {
  const room = memoryRelay();
  const world = () => {
    const g = { bytes: new Uint8Array(300_000), simulating: true, hooks: {} as Hooks };
    g.hooks = {
      simulate(on) { g.simulating = on; },
      apply(_id, e) { const { i, v } = e as { i: number; v: number }; g.bytes[i] = v; },
      snapshot: () => g.bytes,
      restore(state) { g.bytes = new Uint8Array(state as Uint8Array); },
    };
    return g;
  };
  const a = world(), b = world();
  for (let i = 0; i < a.bytes.length; i += 7) a.bytes[i] = i % 251;
  const A = start(t, a.hooks, { mode: 'events', connect: room.options() });
  await A.ready;
  assert.equal(a.simulating, true);
  // The host's game keeps changing the world while the newcomer comes in.
  let i = 0;
  const changes = setInterval(() => { A.act({ i: (i += 997) % 300_000, v: i % 256 }); }, 2);
  t.after(() => clearInterval(changes));
  await wait(20);
  const before = new Set(room.sockets);
  const B = start(t, b.hooks, { mode: 'events', connect: room.options() });
  await B.ready;
  const socket = [...room.sockets].find((s) => !before.has(s))!;
  assert.equal(b.simulating, false);
  await until(() => count(socket.received, 6) >= 5, 3000, 'the world in chunks');
  await wait(50);
  clearInterval(changes);
  B.act({ i: 5, v: 99 });
  await until(() => a.bytes[5] === 99 && b.bytes[5] === 99, 2000, 'a change from the newcomer');
  assert.ok(count(socket.received, 6) >= 5, 'chunks within the message limit');
  assert.ok(count(socket.received, 3) > 0, 'changes after the world');
  assert.deepEqual(b.bytes, a.bytes);
});

/** A deterministic game for lockstep: every player walks by its input each tick; history keeps each tick's state. */
function walkers() {
  const g = {
    players: new Map<number, number>([[1, 0]]), inputs: new Map<number, number>(), tick: 0, local: 1, skew: 0,
    history: new Map<number, string>(), hooks: {} as Hooks,
  };
  const state = () => JSON.stringify([...g.players].sort((x, y) => x[0] - y[0]));
  g.hooks = {
    join(id) { if (!g.players.has(id)) g.players.set(id, 0); },
    leave(id) { g.players.delete(id); },
    input: () => g.local,
    control(id, input) { g.inputs.set(id, typeof input === 'number' ? input : 0); },
    step() {
      for (const [id, x] of g.players) g.players.set(id, x + (g.inputs.get(id) ?? 0) * id);
      g.inputs.clear();
      g.history.set(++g.tick, state());
    },
    snapshot: () => ({ tick: g.tick, players: [...g.players] }),
    restore(s) { const v = s as { tick: number; players: [number, number][] }; g.tick = v.tick; g.players = new Map(v.players); },
    checksum: () => [...g.players].reduce((sum, [id, x]) => sum + id * 31 + x, 0) + (g.tick > 30 ? g.skew : 0),
  };
  return g;
}

/** The ticks both reached, and whether their states match at every one of them. */
function agree(x: ReturnType<typeof walkers>, y: ReturnType<typeof walkers>) {
  const ticks = [...y.history.keys()].filter((tick) => x.history.has(tick));
  return { ticks: ticks.length, same: ticks.every((tick) => x.history.get(tick) === y.history.get(tick)) };
}

test('lockstep: every seat steps the same game with everyone\'s inputs; newcomers, leavers and a new host keep it so', async (t) => {
  const room = memoryRelay();
  const a = walkers(), b = walkers(), c = walkers();
  const options = { mode: 'lockstep', tick: 50, delay: 2, check: 10 } as const;
  const A = play(a.hooks, { ...options, connect: room.options() });
  await A.ready;
  const B = start(t, b.hooks, { ...options, connect: room.options() });
  await B.ready;
  await until(() => agree(a, b).ticks > 10, 3000, 'B stepping with A');
  a.local = 2;
  b.local = -1;
  await wait(100);
  const C = start(t, c.hooks, { ...options, connect: room.options() });
  await C.ready;
  await until(() => agree(a, c).ticks > 10, 3000, 'C stepping with both');
  c.local = 3;
  await wait(150);
  assert.deepEqual(agree(a, b).same, true);
  assert.deepEqual(agree(a, c).same, true);
  assert.deepEqual([...a.players.keys()].sort((x, y) => x - y), [1, 2, 3]);

  // C leaves: the others go on without waiting for it.
  C.leave();
  const at = a.tick;
  await until(() => a.tick > at + 10 && !a.players.has(3) && !b.players.has(3), 3000, 'A and B going on');
  // The host leaves: B carries on alone, as the room's host.
  A.stop();
  await until(() => B.isHost(), 3000, 'B taking over');
  const then = b.tick;
  await until(() => b.tick > then + 10 && !b.players.has(1), 3000, 'B going on as host');
  assert.equal(agree(a, b).same, true);
});

test('lockstep: a checksum that differs is drift, and both the host and that seat hear of it', async (t) => {
  const room = memoryRelay();
  const a = walkers(), b = walkers();
  const options = { mode: 'lockstep', tick: 50, check: 5 } as const;
  const A = start(t, a.hooks, { ...options, connect: room.options() });
  await A.ready;
  const B = start(t, b.hooks, { ...options, connect: room.options() });
  await B.ready;
  const drifts: [string, number, number][] = [];
  A.on('drift', (seat, tick) => drifts.push(['host', seat, tick]));
  B.on('drift', (seat, tick) => drifts.push(['seat', seat, tick]));
  await until(() => b.tick > 20, 3000, 'B stepping');
  assert.deepEqual(drifts, []);
  b.skew = 1;
  await until(() => drifts.length >= 2, 3000, 'drift');
  const heard = (who: string) => drifts.find((d) => d[0] === who)!;
  const host = heard('host'), seat = heard('seat');
  // Seat 2 drifted at a tick it checked, once its checksum changed (the game's 31st step is tick 30).
  assert.deepEqual([host[1], seat[1], seat[2], host[2] % 5], [2, 2, host[2], 0]);
  assert.ok(host[2] >= 30);
});
