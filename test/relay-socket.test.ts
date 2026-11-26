// The relay over WebSocket on a player listener (packages/server/relay-socket.ts), played by zirbel-net's own client
// (packages/net), and the client bundle the listener serves beside it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { MAX_FRAME } from '../packages/core/relay.ts';
import { Rooms } from '../packages/core/rooms.ts';
import { connect, launchParams, ALL, HOST, type Connection } from '../packages/net/index.ts';
import { Players } from '../packages/server/hosting.ts';
import { gamePath } from '../packages/server/player-listener.ts';
import { relayOrigin } from '../packages/server/relay-socket.ts';
import { install, netGame, rights, sandboxPolicy } from './helpers.ts';

async function netPlayer(t: TestContext) {
  const { projects, releases } = install(t);
  const rooms = new Rooms();
  const players = new Players(rooms, releases, { playerPort: 0 });
  t.after(() => players.close());
  const { port } = await players.openLocal(0);
  const { room } = await players.start(releases.package(netGame(projects, 3).id, 'main', rights, true).manifest.releaseId, false)
    .then((described) => ({ room: rooms.get(described.id) }));
  return { player: 'http://127.0.0.1:' + port, room, rooms };
}

/** zirbel-net's client in a game page at this room's address, until it is seated. */
function player(base: string, room: { id: string; documentKey: string }) {
  const params = launchParams({ pathname: '/game/' + room.id + '/' + room.documentKey + '/', search: '?room=' + room.id + '&key=' + room.documentKey });
  const net = connect({ ...params, url: base.replace('http', 'ws') + '/mp', storage: null, reconnect: false });
  const events: unknown[][] = [];
  for (const name of ['peer', 'leave', 'away', 'back', 'host', 'close'] as const)
    net.on(name, (...args: unknown[]) => { events.push([name, ...args]); });
  const opened = new Promise<void>((resolve, reject) => {
    net.on('open', () => resolve());
    net.on('close', (code, message) => reject(new Error(code + ' ' + message)));
  });
  return { net, events, opened };
}

const until = async (check: () => boolean) => {
  for (let tries = 0; !check(); tries++) {
    if (tries > 200) throw new Error('Timed out');
    await new Promise((done) => setTimeout(done, 10));
  }
};

function messages(net: Connection) {
  const received: { from: number; type: number; text: string; reliable: boolean }[] = [];
  net.on('message', (from, type, r, reliable) => { received.push({ from, type, text: r.text(), reliable }); });
  return received;
}

test('zirbel-net clients play over a net room\'s relay, and the room closing ends them', async (t) => {
  const { player: base, room, rooms } = await netPlayer(t);
  assert.equal(launchParams({ search: '?room=' + room.id }).room, room.id.toUpperCase());
  const a = player(base, room);
  await a.opened;
  const b = player(base, room);
  await b.opened;
  assert.deepEqual([a.net.id, a.net.hostId, b.net.id, b.net.hostId, [...b.net.peers]], [1, 1, 2, 1, [[1, 'Player One']]]);
  await until(() => a.events.length > 0);
  assert.deepEqual(a.events, [['peer', 2, 'Player Two']]);
  assert.equal(a.net.isHost(), true);

  const atA = messages(a.net), atB = messages(b.net);
  a.net.send(ALL, 3, 'to everyone');
  b.net.send(HOST, 4, 'to the host');
  b.net.stream(1, 5, 'to seat one');
  await until(() => atA.length === 2 && atB.length === 1);
  assert.deepEqual(atB, [{ from: 1, type: 3, text: 'to everyone', reliable: true }]);
  assert.deepEqual(atA, [{ from: 2, type: 4, text: 'to the host', reliable: true }, { from: 2, type: 5, text: 'to seat one', reliable: false }]);
  await until(() => a.net.rtt > 0);

  // Leaving for good: the others see it at once, and the host role moves.
  a.net.close();
  await until(() => b.events.length === 2);
  assert.deepEqual(b.events, [['leave', 1], ['host', 2]]);

  rooms.close(room.id);
  await until(() => b.net.closed);
  assert.deepEqual(b.events.at(-1), ['close', 5, 'the room closed']);
});

test('the relay socket takes games\' opaque origin and its own, and nothing over its size', async (t) => {
  const { player: base, room } = await netPlayer(t);
  const url = base.replace('http', 'ws') + '/mp';
  const status = (headers: Record<string, string>) => new Promise<number>((resolve) => {
    const socket = new WebSocket(url, { headers });
    socket.once('open', () => { socket.terminate(); resolve(101); });
    socket.once('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0); socket.terminate(); });
    socket.once('error', () => {});
  });
  assert.equal(await status({ origin: 'http://evil.example' }), 403);
  assert.equal(await status({ origin: base.replace('127.0.0.1', 'localhost') }), 403);
  assert.equal(await status({ origin: 'not a url' }), 403);
  assert.equal(await status({ origin: 'null' }), 101);
  assert.equal(await status({ origin: base }), 101);
  assert.equal(await status({}), 101);
  assert.equal(relayOrigin({ headers: { host: 'Box.local:4174', origin: 'http://box.local:4174' } } as never), true);

  const socket = new WebSocket(url);
  t.after(() => socket.terminate());
  await new Promise((done) => socket.once('open', done));
  const closed = new Promise<number>((resolve) => socket.once('close', resolve));
  socket.send(Buffer.alloc(MAX_FRAME + 1));
  assert.equal(await closed, 1009);

  // The game page of a net room may import the client and open the relay, on its own origin only.
  const page = await fetch(base + gamePath(room));
  assert.equal(page.headers.get('content-security-policy'),
    sandboxPolicy(base + '/runtime/' + room.id + '/', base + gamePath(room), "'self'", base));
});

test('every player listener serves zirbel-net\'s client to games, cached like the runtime', async (t) => {
  const { player: base } = await netPlayer(t);
  const bytes = readFileSync('dist/web/zirbel-net.js');
  const etag = '"' + createHash('sha256').update(bytes).digest('base64url') + '"';
  const client = await fetch(base + '/zirbel-net.js');
  assert.equal(client.status, 200);
  assert.deepEqual(Object.fromEntries(['content-type', 'cache-control', 'etag', 'vary', 'access-control-allow-origin',
    'x-content-type-options', 'referrer-policy'].map((name) => [name, client.headers.get(name)])), {
    'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag,
    vary: 'accept-encoding', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  assert.deepEqual(Buffer.from(await client.arrayBuffer()), bytes);
  assert.equal((await fetch(base + '/zirbel-net.js', { headers: { 'if-none-match': etag } })).status, 304);
  assert.equal((await fetch(base + '/zirbel-net.js', { method: 'POST' })).status, 404);
  // The bundle is the client's ES module.
  const module = await import('data:text/javascript;base64,' + bytes.toString('base64')) as Record<string, unknown>;
  assert.equal(typeof module.connect, 'function');
  assert.deepEqual([module.ALL, module.HOST, module.VERSION], [0, 255, 2]);
});
