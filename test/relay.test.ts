// The relay a net-v2 room runs (packages/core/relay.ts), driven through fake connections: seats, routing, the host
// role, away seats and resume. test/relay-socket.test.ts runs it over WebSocket.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { join, type Link } from '../packages/core/relay.ts';
import { Rooms } from '../packages/core/rooms.ts';
import { Reader, Writer } from '../packages/net/codec.ts';
import { errorOf, frameOf, hello, install, netGame, rights, welcomeOf, wire, type Wire } from './helpers.ts';

const turn = () => new Promise((done) => setImmediate(done));
const seatOf = (message: Wire | undefined) => message?.payload[0];

/** A room of a net game for three, and the way to it a HELLO takes. */
function netRoom(t: TestContext) {
  const { projects, releases } = install(t);
  const release = releases.package(netGame(projects, 3).id, 'main', rights, false);
  const rooms = new Rooms();
  t.after(() => rooms.dispose());
  const find = (id: string) => {
    const room = rooms.find(id);
    return room?.relay ? { relay: room.relay, key: room.documentKey } : undefined;
  };
  return { rooms, release, releases, projects, room: rooms.create(release, false), find };
}

function client(find: Parameters<typeof join>[2]) {
  const frames: Uint8Array[] = [];
  const link: Link & { closed?: number; dropped?: boolean } = {
    lastRx: performance.now(),
    send: (frame) => { frames.push(frame); },
    buffered: () => 0,
    close(code) { link.closed = code; },
    drop() { link.dropped = true; },
  };
  return {
    link, frames,
    hello(room: string, key: string, more?: Parameters<typeof hello>[2]) { join(link, hello(room, key, more), find); },
    send(...messages: Parameters<typeof frameOf>) { link.lastRx = performance.now(); link.relay?.receive(link, frameOf(...messages)); },
    gone(code: number) { link.relay?.gone(link, code); },
    /** Every message that arrived since the last take. */
    take(): Wire[] { return frames.splice(0).flatMap(wire); },
  };
}

test('the relay seats players, routes their messages and hands the host role on', async (t) => {
  const { room, find } = netRoom(t);
  const code = room.id.toUpperCase();
  const a = client(find), b = client(find), c = client(find), d = client(find);
  a.hello(code, room.documentKey);
  await turn();
  const [welcome, ...rest] = a.take();
  assert.equal(welcome?.type, 2);
  assert.equal(welcome.peer, 0);
  assert.equal(welcome.unreliable, false);
  assert.deepEqual(rest, []);
  const seated = welcomeOf(welcome);
  assert.match(seated.token, /^[0-9a-f]{32}$/);
  assert.ok(Math.abs(seated.time - Date.now()) < 5000);
  assert.deepEqual({ ...seated, token: '', time: 0 },
    { id: 1, host: 1, token: '', time: 0, resumed: 0, caps: 0, peers: [], maxMsg: 1_048_576, revision: '', base: '' });

  b.hello(room.id, room.documentKey);
  await turn();
  assert.deepEqual({ ...welcomeOf(b.take()[0]!), token: '', time: 0 },
    { id: 2, host: 1, token: '', time: 0, resumed: 0, caps: 0, peers: [1], maxMsg: 1_048_576, revision: '', base: '' });
  assert.deepEqual(a.take().map((message) => [message.type, seatOf(message)]), [[3, 2]]);

  // To everyone else, the host or a seat, with the sender's seat and the type, flags and payload as they came.
  a.send({ type: 37, peer: 0, payload: [1, 2, 3] });
  b.send({ type: 40, peer: 255, payload: [4], unreliable: true });
  a.send({ type: 41, peer: 255, payload: [5] }, { type: 42, peer: 1, payload: [6] }, { type: 43, peer: 9, payload: [7] });
  a.send({ type: 44, peer: 2, payload: [] }, { type: 3, peer: 0, payload: [2] });
  await turn();
  assert.deepEqual(b.take(), [
    { type: 37, peer: 1, unreliable: false, payload: Uint8Array.of(1, 2, 3) },
    { type: 44, peer: 1, unreliable: false, payload: new Uint8Array() }]);
  assert.deepEqual(a.take(), [{ type: 40, peer: 2, unreliable: true, payload: Uint8Array.of(4) }]);

  // What is sent in one turn leaves in one frame, reliable messages first.
  a.send({ type: 50, peer: 0, payload: [1], unreliable: true });
  a.send({ type: 51, peer: 0, payload: [2] });
  await turn();
  assert.equal(b.frames.length, 1);
  assert.deepEqual(b.take().map((message) => [message.type, message.unreliable]), [[51, false], [50, true]]);

  // PING is answered with PONG: the client's time, then the host's.
  a.send({ type: 6, peer: 0, payload: new Writer().f64(123.5).view(), unreliable: true });
  await turn();
  const [pong] = a.take();
  assert.deepEqual([pong?.type, pong?.peer, pong?.unreliable], [7, 0, true]);
  const times = new Reader(pong!.payload);
  assert.equal(times.f64(), 123.5);
  assert.ok(Math.abs(times.f64() - Date.now()) < 5000);

  c.hello(code, room.documentKey);
  d.hello(code, room.documentKey);
  await turn();
  assert.equal(welcomeOf(c.take()[0]!).id, 3);
  assert.deepEqual(d.take().map(errorOf), [{ code: 2, message: 'room is full' }]);
  assert.equal(d.link.closed, 1008);
  a.take();
  b.take();

  // The host leaves: the next seat is host.
  a.gone(1000);
  await turn();
  for (const other of [b, c]) assert.deepEqual(other.take().map((message) => [message.type, seatOf(message)]), [[4, 1], [5, 2]]);
  // A new seat takes the lowest free number.
  const e = client(find);
  e.hello(code, room.documentKey);
  await turn();
  const joined = welcomeOf(e.take()[0]!);
  assert.deepEqual([joined.id, joined.host, joined.peers], [1, 2, [2, 3]]);
});

test('the relay turns away what is not a HELLO for one of its rooms', async (t) => {
  const { room, rooms, releases, projects, find } = netRoom(t);
  const refused = async (frame: Uint8Array) => {
    const link = client(find);
    join(link.link, frame, find);
    await turn();
    return { messages: link.take(), closed: link.link.closed };
  };
  // Something else first: closed with no ERROR. A frame of another kind is ignored.
  assert.deepEqual(await refused(frameOf({ type: 32, peer: 0, payload: [1] })), { messages: [], closed: 1008 });
  assert.deepEqual(await refused(frameOf()), { messages: [], closed: 1008 });
  assert.deepEqual(await refused(Uint8Array.of(1, 1, 0, 0)), { messages: [], closed: undefined });
  const error = async (frame: Uint8Array) => {
    const { messages, closed } = await refused(frame);
    assert.equal(closed, 1008);
    assert.deepEqual(messages.map((message) => [message.type, message.peer, message.unreliable]), [[9, 0, false]]);
    return errorOf(messages[0]!);
  };
  assert.deepEqual(await error(hello(room.id, room.documentKey, { version: 3 })), { code: 1, message: 'protocol v3 not supported, this host speaks v2' });
  assert.deepEqual(await error(hello('no room', room.documentKey)), { code: 3, message: 'bad game or room name' });
  assert.deepEqual(await error(hello(room.id, room.documentKey, { game: 'x'.repeat(33) })), { code: 3, message: 'bad game or room name' });
  assert.deepEqual(await error(frameOf({ type: 1, peer: 0, payload: [2, 4] })), { code: 3, message: 'bad game or room name' });
  const missing = { code: 6, message: 'no game with that code is running' };
  assert.deepEqual(await error(hello(room.id, room.documentKey.slice(1))), missing);
  assert.deepEqual(await error(hello(room.id, room.invite)), missing);
  assert.deepEqual(await error(hello('a'.repeat(12), room.documentKey)), missing);
  // A room of a game without netcode has no relay.
  const shared = rooms.create(releases.package(projects.createGame('Shared', { html: '<canvas></canvas>', maxPlayers: 2 }).id, 'main', rights, false), false);
  assert.equal(shared.relay, null);
  assert.deepEqual(await error(hello(shared.id, shared.documentKey)), missing);
  // A solo playtest seats one.
  const solo = rooms.create(room.release, true);
  const one = client(find);
  one.hello(solo.id, solo.documentKey);
  assert.deepEqual(await error(hello(solo.id, solo.documentKey)), { code: 2, message: 'room is full' });
  await turn();
  assert.equal(welcomeOf(one.take()[0]!).id, 1);

  // A message over the limit closes the connection.
  one.send({ type: 32, peer: 0, payload: new Uint8Array(1_048_577) });
  assert.equal(one.link.closed, 1009);
});

test('an away seat keeps its place: its messages queue, the host role moves on, and its token brings it back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { room, find } = netRoom(t);
  const a = client(find), b = client(find);
  a.hello(room.id, room.documentKey, { nonce: 'first' });
  b.hello(room.id, room.documentKey);
  await turn();
  const { token } = welcomeOf(a.take()[0]!);
  b.take();
  a.gone(1006);
  b.send({ type: 32, peer: 0, payload: [1] }, { type: 33, peer: 0, payload: [2], unreliable: true });
  await turn();
  assert.deepEqual(b.take().map((message) => [message.type, seatOf(message)]), [[10, 1]]);
  t.mock.timers.tick(2499);
  await turn();
  assert.deepEqual(b.take(), []);
  t.mock.timers.tick(1);
  await turn();
  assert.deepEqual(b.take().map((message) => [message.type, seatOf(message)]), [[5, 2]]);

  // Back on another connection: WELCOME, then what queued meanwhile; the others hear BACK.
  const again = client(find);
  again.hello(room.id, room.documentKey, { token, nonce: 'second' });
  await turn();
  const [welcome, ...queued] = again.take();
  assert.deepEqual({ ...welcomeOf(welcome!), time: 0 },
    { id: 1, host: 2, token, time: 0, resumed: 1, caps: 0, peers: [2], maxMsg: 1_048_576, revision: '', base: '' });
  assert.deepEqual(queued.map((message) => [message.type, message.peer, [...message.payload]]), [[32, 2, [1]], [5, 0, [2]]]);
  assert.deepEqual(b.take().map((message) => [message.type, seatOf(message)]), [[11, 1]]);

  // Away for good after 15 s; the host role stays where it is.
  again.gone(1001);
  t.mock.timers.tick(14_999);
  await turn();
  assert.deepEqual(b.take().map((message) => message.type), [10]);
  t.mock.timers.tick(1);
  await turn();
  assert.deepEqual(b.take().map((message) => [message.type, seatOf(message)]), [[4, 1]]);
  const late = client(find);
  late.hello(room.id, room.documentKey, { token, nonce: 'second' });
  await turn();
  assert.equal(welcomeOf(late.take()[0]!).resumed, 0, 'a seat that left is not resumed');

  // An away seat's queue holds up to 256 KB of whole messages: the message that doesn't fit makes it leave.
  const c = client(find);
  c.hello(room.id, room.documentKey);
  await turn();
  const seat = welcomeOf(c.take()[0]!).id;
  c.gone(1006);
  await turn();
  b.take();
  late.take();
  // Four messages of 65,536 bytes each: type, peer, a three-byte lenflags and 65,531 bytes.
  for (let i = 0; i < 4; i++) b.send({ type: 32, peer: seat, payload: new Uint8Array(65_531) });
  await turn();
  assert.deepEqual(b.take(), []);
  b.send({ type: 32, peer: seat, payload: [] });
  await turn();
  assert.deepEqual(b.take().map((message) => [message.type, seatOf(message)]), [[4, seat]]);
});

test('a token takes its seat over from a connection that is still open only with its nonce or once it is quiet', async (t) => {
  const { room, find } = netRoom(t);
  const a = client(find);
  a.hello(room.id, room.documentKey, { nonce: 'tab' });
  await turn();
  const { token } = welcomeOf(a.take()[0]!);
  // Another page with the same token, while the first still talks: a seat of its own.
  const other = client(find);
  other.hello(room.id, room.documentKey, { token, nonce: 'other' });
  await turn();
  assert.deepEqual([welcomeOf(other.take()[0]!).id, a.take().map((message) => message.type)], [2, [3]]);
  // The same page again: the old connection is dropped, and nobody sees it go.
  const same = client(find);
  same.hello(room.id, room.documentKey, { token, nonce: 'tab' });
  await turn();
  assert.equal(a.link.dropped, true);
  assert.deepEqual({ id: welcomeOf(same.take()[0]!).id, resumed: 1 }, { id: 1, resumed: 1 });
  assert.deepEqual(other.take(), []);
  a.gone(1006);
  await turn();
  assert.deepEqual(other.take(), []);
  // A quiet connection is taken over too.
  same.link.lastRx = performance.now() - 3001;
  const quiet = client(find);
  quiet.hello(room.id, room.documentKey, { token, nonce: 'later' });
  await turn();
  assert.equal(same.link.dropped, true);
  assert.equal(welcomeOf(quiet.take()[0]!).resumed, 1);
});

test('a room that closes ends its relay connections with the reason', async (t) => {
  const { room, rooms, find } = netRoom(t);
  const a = client(find), b = client(find);
  a.hello(room.id, room.documentKey);
  b.hello(room.id, room.documentKey);
  await turn();
  b.gone(1006);
  await turn();
  a.take();
  a.send({ type: 32, peer: 0, payload: [1] });
  rooms.close(room.id);
  assert.deepEqual(a.take().map((message) => message.type === 9 ? errorOf(message) : message.type), [{ code: 5, message: 'the room closed' }]);
  assert.equal(a.link.closed, 1001);
  assert.equal(a.link.relay, undefined);
  const late = client(find);
  late.hello(room.id, room.documentKey);
  assert.deepEqual(late.take().map(errorOf), [{ code: 6, message: 'no game with that code is running' }]);
});
