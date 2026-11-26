// play()'s ticks and frames (packages/net/play.ts, ticks.ts, snapshot.ts), over the relay a net-v2 room runs: ticks
// by each frame's own time, alpha for drawing between ticks, a follower's own player drawn between its last two
// ticks, a follower driving on while an away host keeps its role, the host's queue of each seat's inputs, and
// leaving the room when the page goes away.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { connect, HOST, pack, play, type Hooks, type PlayOptions } from '../packages/net/index.ts';
import { dots, memoryRelay, until, wait, type Dot } from './net-fixture.ts';

function start(t: TestContext, hooks: Hooks, options: PlayOptions) {
  const session = play(hooks, options);
  t.after(() => session.stop());
  return session;
}

/** requestAnimationFrame as the test drives it: every frame waiting runs when frame(time) says, however late. */
function frames(t: TestContext) {
  const g = globalThis as Record<string, unknown>;
  let waiting: ((time: number) => void)[] = [];
  g.requestAnimationFrame = (f: (time: number) => void) => waiting.push(f);
  t.after(() => { delete g.requestAnimationFrame; });
  return (time: number) => {
    const now = waiting;
    waiting = [];
    for (const f of now) f(time);
  };
}

const blend = (a: unknown, b: unknown, t: number): Dot => {
  const p = a as Dot, q = b as Dot;
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, hp: q.hp };
};

test('play() ticks by each frame\'s own time: as many ticks every frame at an even rate, and alpha between them', (t) => {
  const frame = frames(t);
  const g = dots(), alphas: number[] = [];
  g.hooks.draw = (alpha) => alphas.push(alpha);
  start(t, g.hooks, { mode: 'predict', tick: 60 });
  let at = performance.now();
  // Frames whose callbacks all run at once, long after their time, stamped to 0.1 ms as browsers do.
  const run = (n: number, ms: number) => Array.from({ length: n }, () => {
    const before = g.calls.step ?? 0;
    frame(Math.round((at += ms) * 10) / 10);
    return (g.calls.step ?? 0) - before;
  });
  // A screen at the tick rate: one tick a frame, every frame.
  assert.deepEqual(new Set(run(180, 1000 / 60)), new Set([1]));
  assert.equal(alphas.length, 180);
  // After a stall it catches up, then ticks one a frame again.
  assert.ok(run(1, 500)[0]! >= 7);
  assert.deepEqual(new Set(run(120, 1000 / 60)), new Set([1]));
  // At twice the rate, a tick every other frame; alpha moves on in the frame between.
  alphas.length = 0;
  const half = run(120, 1000 / 120);
  assert.ok(half.every((n, i) => n <= 1 && (i === 0 || n + half[i - 1]! === 1)), half.join(''));
  for (let i = 1; i < half.length; i++) if (!half[i]) assert.ok(alphas[i]! > alphas[i - 1]!, alphas.slice(i - 1, i + 1).join());
  assert.ok(alphas.every((alpha) => alpha >= 0 && alpha <= 1));
});

test('predict: on a screen faster than the tick rate, a follower\'s own player moves every frame, between its last two ticks', async (t) => {
  const frame = frames(t);
  const room = memoryRelay();
  const a = dots(), b = dots();
  a.hooks.blend = b.hooks.blend = blend;
  const A = start(t, a.hooks, { mode: 'predict', connect: room.options() });
  await A.ready;
  const B = start(t, b.hooks, { mode: 'predict', connect: room.options() });
  await B.ready;
  let at = performance.now();
  const run = async (n: number, each = () => {}) => {
    for (let i = 0; i < n; i++) {
      frame(at += 1000 / 120);
      each();
      await wait(2);
    }
  };
  await run(30);
  assert.ok(b.world.has(2));
  b.local = { dx: 60, dy: 0 };
  const xs: number[] = [];
  await run(120, () => xs.push(b.world.get(2)!.x));
  const still = xs.slice(30).filter((x, i, all) => i > 0 && x <= all[i - 1]!).length;
  assert.equal(still, 0, 'frames the player did not move in: ' + xs.slice(30).join(' '));
  assert.ok(xs.at(-1)! > 20);
  // The host agrees once it has every input.
  b.local = { dx: 0, dy: 0 };
  await run(60);
  assert.ok(Math.abs(a.world.get(2)!.x - b.world.get(2)!.x) < 0.01, a.world.get(2)!.x + ' ' + b.world.get(2)!.x);
});

test('predict: while an away host keeps its role, a follower drives on, and carries on from there when it takes over', async (t) => {
  const room = memoryRelay();
  const a = dots(), b = dots();
  const before = new Set(room.sockets);
  const A = start(t, a.hooks, { mode: 'predict', connect: room.options({ reconnect: false }) });
  await A.ready;
  const link = [...room.sockets].find((s) => !before.has(s))!;
  const B = start(t, b.hooks, { mode: 'predict', connect: room.options() });
  await B.ready;
  await until(() => a.world.has(2) && b.world.has(2), 2000, 'B in both');
  b.local = { dx: 60, dy: 0 };
  await wait(100);
  // The host's link drops: the relay keeps its seat, and its role for 2.5 s, and no state comes.
  link.kill();
  const began = performance.now(), xs: [number, number][] = [];
  while (!B.isHost()) {
    xs.push([performance.now() - began, b.world.get(2)!.x]);
    await wait(25);
  }
  const x = (ms: number) => xs.findLast(([when]) => when <= ms)![1];
  assert.ok(performance.now() - began > 2300);
  // 60 units a second, all along: past two seconds too.
  assert.ok(x(2250) - x(1750) > 20, 'moved ' + (x(2250) - x(1750)) + ' from 1.75 s to 2.25 s');
  const last = xs.at(-1)![1];
  await wait(100);
  assert.ok(b.world.get(2)!.x >= last, 'carried on from ' + last + ', not ' + b.world.get(2)!.x);
});

test('predict: the host takes each seat\'s inputs two a tick while more than two wait, and with none a player keeps its last', async (t) => {
  const room = memoryRelay();
  const a = dots();
  const A = start(t, a.hooks, { mode: 'predict', connect: room.options(), rate: 60 });
  await A.ready;
  // A seat on the wire: the inputs it sends, and the newest the host's states say it applied.
  const net = connect(room.options());
  t.after(() => net.close());
  let applied = -1, sent = 0;
  net.on('message', (_from, type, r) => {
    if (type !== 0) return;
    const flags = r.u8();
    r.u16();
    if (flags & 1) r.u16();
    r.f64();
    if (flags & 2) applied = r.u16();
  });
  await new Promise<void>((done) => net.on('open', () => done()));
  const send = (n: number) => {
    const m = net.begin().u8(0).u16(sent + 1).u8(n);
    for (let i = 0; i < n; i++) pack.write(m, { dx: 60, dy: 0 });
    sent += n;
    net.stream(HOST, 1, m);
  };
  // Six at once, as after a slow start, then one a tick at the host's own rate.
  send(6);
  const began = performance.now();
  while (performance.now() - began < 600) {
    await wait(5);
    const due = 6 + Math.floor((performance.now() - began) / (1000 / 60));
    if (due > sent) send(due - sent);
  }
  assert.ok(applied > 0 && sent - applied <= 3, 'the host is ' + (sent - applied) + ' inputs behind');
  // No more inputs: the player keeps the last one.
  const x = a.world.get(2)!.x;
  await wait(200);
  assert.ok(a.world.get(2)!.x > x + 5, x + ' then ' + a.world.get(2)!.x);
});

test('play() leaves the room when its page goes away, and keeps its seat only when asked to', async (t) => {
  const g = globalThis as Record<string, unknown>, listeners = new Map<string, Set<() => void>>();
  g.addEventListener = (type: string, fn: () => void) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)); };
  g.removeEventListener = (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); };
  t.after(() => { delete g.addEventListener; delete g.removeEventListener; });
  const hidden = () => listeners.get('pagehide')?.size ?? 0;
  const room = memoryRelay();
  const a = dots(), b = dots();
  const A = start(t, a.hooks, { connect: room.options(), keepSeat: true });
  await A.ready;
  assert.equal(hidden(), 0);
  const B = start(t, b.hooks, { connect: room.options() });
  await B.ready;
  assert.equal(hidden(), 1);
  const heard: string[] = [];
  A.on('away', (id) => heard.push('away ' + id));
  A.net!.on('leave', (id) => heard.push('leave ' + id));
  for (const fn of listeners.get('pagehide')!) fn();
  await until(() => heard.length > 0, 2000, 'B going');
  await wait(20);
  assert.deepEqual(heard, ['leave 2']);
  assert.deepEqual([B.net, hidden(), A.net !== null], [null, 0, true]);
});
