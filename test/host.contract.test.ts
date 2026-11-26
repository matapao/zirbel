// One contract, two hosts: `node dist/server.mjs --host-only` and the native Go
// host (host/bin/zirbel-host, built by `pnpm build:host`). Both must behave
// the same for players, so every check below runs against each.
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { importGameFolder } from '../packages/core/game-files.ts';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import type { Release } from '../packages/sdk/contracts.ts';
import { hostsUnderTest, importMap, launch, legacyProject, rights, sandboxPolicy, statusForHost, stopHost, tempDir } from './helpers.ts';

const hosts = hostsUnderTest();

// A built game: a document, a module script, models beside it, and its TypeScript source.
const builtFiles = {
  'index.html': '<!doctype html><script type="module" src="./assets/main.js"></script>',
  'assets/main.js': 'fetch("./models/hero.glb")',
  'models/hero.glb': Buffer.from([103, 108, 84, 70, 2, 0, 0, 0]),
  'models/hero.obj': 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  'src/main.ts': 'export const speed: number = 2;',
};

function fixtures(t: TestContext) {
  const root = tempDir(t, 'zirbel-contract-');
  const projects = new Projects(join(root, 'source'));
  const releases = new Releases(projects, 'dist/web');
  const write = (name: string, release: Release) => {
    const file = join(root, name + '.json');
    writeFileSync(file, JSON.stringify(release));
    return { file, id: release.manifest.releaseId, release };
  };
  const shared = projects.createGame('Shared', { html: '<!doctype html><canvas></canvas>', maxPlayers: 2 });
  return {
    root,
    shared: write('shared', releases.package(shared.id, 'main', rights, false)),
    tiles: write('tiles', releases.package(legacyProject(projects, 'tessellate').id, 'main', rights, false)),
    moss: write('moss', releases.package(legacyProject(projects, 'mosslight').id, 'main', rights, false)),
    built: write('built', releases.package(importGameFolder(projects, { title: 'Built', files: Object.fromEntries(
      Object.entries(builtFiles).map(([path, data]) => [path, Buffer.from(data).toString('base64')])) }).id, 'main', rights, false)),
  };
}

type Started = { process: ChildProcessWithoutNullStreams; player: string; rooms: { id: string; link: string; manifest: { releaseId: string } }[] };

// The host prints one line per room it opens, then the line naming its player address.
async function startHost(t: TestContext, command: string[], args: string[]): Promise<Started> {
  const rooms: Started['rooms'] = [];
  const { child, ready } = launch(t, command, ['--host-only', '--player-port', '0', ...args], (line) => {
    if (typeof line.player === 'string') return line.player;
    rooms.push(line as unknown as Started['rooms'][number]);
    return undefined;
  });
  return { process: child, player: await ready, rooms };
}

function exitOf(command: string[], args: string[]) {
  const child = spawn(command[0]!, [...command.slice(1), '--host-only', '--player-port', '0', ...args]);
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
  return new Promise<{ code: number | null; errors: string }>((resolve) => child.once('exit', (code) => resolve({ code, errors })));
}

type Message = { type: string; [key: string]: unknown };

function socket(player: string, room: string, origin = player) {
  const ws = new WebSocket(player.replace('http', 'ws') + '/rooms/' + room + '/socket', { origin });
  const messages: Message[] = [];
  const waiting: { check: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
  ws.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString('utf8')) as Message;
    messages.push(message);
    // Each message goes to the first waiter that wants it.
    const index = waiting.findIndex((item) => item.check(message));
    if (index >= 0) waiting.splice(index, 1)[0]!.resolve(message);
  });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const opened = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  return {
    ws, messages, closed, opened,
    send(value: object) { ws.send(JSON.stringify(value)); },
    next(check: (message: Message) => boolean, timeout = 3000) {
      const found = messages.find(check);
      if (found) { messages.splice(messages.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise<Message>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No matching message')), timeout);
        waiting.push({ check, resolve: (message) => { clearTimeout(timer); messages.splice(messages.indexOf(message), 1); resolve(message); } });
      });
    },
  };
}

async function reserveSeat(player: string, link: string, name: string) {
  const [room, invite] = link.split('/join/')[1]!.split('#') as [string, string];
  const response = await fetch(player + '/rooms/' + room + '/reserve', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: player }, body: JSON.stringify({ invite, name, role: 'player' }),
  });
  assert.equal(response.status, 201);
  const { ticket } = await response.json() as { ticket: string };
  return { room, invite, ticket };
}

for (const host of hosts) {
  test(host.name + ' host serves the player pages, runtime files and room info', async (t) => {
    const data = fixtures(t);
    const started = await startHost(t, host.command, ['--data', join(data.root, 'data'), '--import', data.shared.file, '--release', data.shared.id]);
    const { player } = started;
    const room = started.rooms[0]!;
    assert.equal(room.manifest.releaseId, data.shared.id);
    const [roomId, invite] = room.link.split('/join/')[1]!.split('#') as [string, string];

    assert.deepEqual(await (await fetch(player + '/health')).json(), { status: 'ok', role: 'player' });
    assert.equal(await statusForHost(player + '/health', 'evil.example'), 403);
    assert.equal((await fetch(player + '/rooms/nope/info')).status, 404);

    const page = await fetch(player + '/join/' + roomId);
    assert.equal(page.status, 200);
    assert.match(await page.text(), new RegExp('<base href="/runtime/' + roomId + '/">'));
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

    assert.equal((await fetch(player + '/rooms/' + roomId + '/info')).status, 403);
    const info = await (await fetch(player + '/rooms/' + roomId + '/info', { headers: { authorization: 'Bearer ' + invite } }))
      .json() as { id: string; status: string; seats: unknown[]; gameUrl: string; manifest: { title: string } };
    assert.equal(info.id, roomId);
    assert.equal(info.status, 'waiting');
    assert.deepEqual(info.seats, []);
    assert.equal(info.manifest.title, 'Shared');

    const game = await fetch(player + info.gameUrl, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(game.status, 200);
    const runtimeBase = player + '/runtime/' + roomId + '/';
    assert.equal(game.headers.get('content-security-policy'), sandboxPolicy(runtimeBase, player + info.gameUrl, "'self'"));
    const html = await game.text();
    assert.match(html, /^<!doctype html><meta charset="utf-8">/);
    assert.ok(html.includes(importMap(runtimeBase)), html);
    assert.match(html, /game-sdk\.js"><\/script><canvas><\/canvas>$/);
    assert.equal((await fetch(player + '/game/' + roomId + '/wrong-key')).status, 404);
    // The page is built once per room and origin, gzipped or not.
    const again = await fetch(player + info.gameUrl);
    assert.equal(await again.text(), html);
    assert.equal(again.headers.get('content-security-policy'), game.headers.get('content-security-policy'));
    assert.equal((await fetch(player + '/runtime/' + roomId + '/assets/' + 'a'.repeat(64))).status, 404);

    const runtime = player + '/runtime/' + roomId + '/three.module.js';
    let three = await fetch(runtime, { headers: { 'accept-encoding': 'gzip' } });
    for (let tries = 0; three.headers.get('content-encoding') !== 'gzip' && tries < 100; tries++) {
      await new Promise((done) => setTimeout(done, 20));
      three = await fetch(runtime, { headers: { 'accept-encoding': 'gzip' } });
    }
    assert.equal(three.headers.get('content-encoding'), 'gzip');
    assert.match(three.headers.get('cache-control') ?? '', /immutable/);
    const etag = three.headers.get('etag')!;
    assert.equal((await fetch(runtime, { headers: { 'if-none-match': etag } })).status, 304);
    assert.equal((await fetch(player + '/runtime/' + roomId + '/game-sdk.js')).headers.get('access-control-allow-origin'), '*');
    assert.equal((await fetch(player + '/runtime/' + roomId + '/missing.js')).status, 404);

    // three.js's addons and the decoders they load, beside three.module.js and cached like it.
    for (const [name, type] of [['loaders/GLTFLoader.js', 'application/javascript; charset=utf-8'],
      ['libs/draco/draco_decoder.wasm', 'application/wasm'], ['libs/basis/basis_transcoder.wasm', 'application/wasm']]) {
      const url = runtimeBase + 'three/addons/' + name;
      const bytes = readFileSync('dist/web/three/examples/jsm/' + name);
      let addon = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
      for (let tries = 0; addon.headers.get('content-encoding') !== 'gzip' && tries < 100; tries++) {
        await new Promise((done) => setTimeout(done, 20));
        addon = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
      }
      assert.equal(addon.status, 200, name);
      assert.equal(addon.headers.get('content-type'), type);
      assert.equal(addon.headers.get('content-encoding'), 'gzip');
      assert.match(addon.headers.get('cache-control') ?? '', /immutable/);
      assert.equal(addon.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(addon.headers.get('access-control-allow-origin'), '*');
      assert.equal(addon.headers.get('etag'), '"' + createHash('sha256').update(bytes).digest('base64url') + '"');
      assert.deepEqual(Buffer.from(await addon.arrayBuffer()), bytes);
      const plain = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
      assert.equal(plain.headers.get('content-encoding'), null);
      assert.deepEqual(Buffer.from(await plain.arrayBuffer()), bytes);
      assert.equal((await fetch(url, { headers: { 'if-none-match': addon.headers.get('etag')! } })).status, 304);
    }
    for (const name of ['', 'loaders', 'loaders/', 'libs/draco/README.md', 'loaders/GLTFLoader.js.gz', 'missing.js', '%2e%2e/three.module.js'])
      assert.equal((await fetch(runtimeBase + 'three/addons/' + name)).status, 404, name);
  });

  test(host.name + ' host serves a built game\'s files beside its document, in its sandbox', async (t) => {
    const data = fixtures(t);
    const started = await startHost(t, host.command, ['--data', join(data.root, 'data'), '--import', data.built.file, '--release', data.built.id]);
    const { player } = started;
    const [roomId, invite] = started.rooms[0]!.link.split('/join/')[1]!.split('#') as [string, string];
    const info = await (await fetch(player + '/rooms/' + roomId + '/info', { headers: { authorization: 'Bearer ' + invite } }))
      .json() as { gameUrl: string };
    assert.match(info.gameUrl, /^\/game\/[a-f0-9]{12}\/[\w-]+\/$/);
    const page = await fetch(player + info.gameUrl);
    const policy = page.headers.get('content-security-policy') ?? '';
    // The same policy as a single-document game's.
    assert.equal(policy, sandboxPolicy(player + '/runtime/' + roomId + '/', player + info.gameUrl, "'self'"));
    assert.match(await page.text(), /src="\.\/assets\/main\.js"/);
    // Its source is text: nosniff keeps a browser from running it.
    for (const [path, type] of [['assets/main.js', 'text/javascript; charset=utf-8'], ['models/hero.glb', 'model/gltf-binary'],
      ['models/hero.obj', 'model/obj'], ['src/main.ts', 'text/plain; charset=utf-8']] as const) {
      const file = await fetch(player + info.gameUrl + path);
      assert.equal(file.status, 200, path);
      assert.equal(file.headers.get('content-type'), type);
      assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(file.headers.get('access-control-allow-origin'), '*');
      assert.equal(file.headers.get('content-security-policy'), policy, 'a file opened on its own stays sandboxed');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(builtFiles[path]));
    }
    for (const path of ['assets/missing.js', 'index.html', '__proto__'])
      assert.equal((await fetch(player + info.gameUrl + path)).status, 404, path);
    // No game is at /game/@<room>/<key>/, the earlier client's shape of a game's address.
    assert.equal((await fetch(player + info.gameUrl.replace('/game/', '/game/@'))).status, 404);
  });

  test(host.name + ' host reserves seats and admits only invited players', async (t) => {
    const data = fixtures(t);
    const { player, rooms } = await startHost(t, host.command, ['--data', join(data.root, 'data'), '--import', data.shared.file, '--release', data.shared.id]);
    const [roomId, invite] = rooms[0]!.link.split('/join/')[1]!.split('#') as [string, string];
    const reserve = (body: object, headers: Record<string, string> = { 'content-type': 'application/json', origin: player }) =>
      fetch(player + '/rooms/' + roomId + '/reserve', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await reserve({ invite, name: 'A', role: 'player' }, { 'content-type': 'application/json' })).status, 403);
    assert.equal((await reserve({ invite, name: 'A', role: 'player' }, { 'content-type': 'text/plain', origin: player })).status, 415);
    assert.equal((await reserve({ invite: 'x'.repeat(32), name: 'A', role: 'player' })).status, 403);
    assert.equal((await reserve({ invite, name: '   ', role: 'player' })).status, 400);
    // Names are trimmed before their 24-character limit, as in Zod.
    assert.equal((await reserve({ invite, name: '  ' + 'n'.repeat(24) + '  ', role: 'spectator' })).status, 201);
    assert.equal((await reserve({ invite, name: 'n'.repeat(25), role: 'spectator' })).status, 400);
    assert.equal((await reserve({ invite, name: 'A', role: 'player', extra: 1 })).status, 400);
    assert.equal((await reserve({ invite, name: 'A', role: 'player' })).status, 201);
    assert.equal((await reserve({ invite, name: 'B', role: 'player' })).status, 201);
    assert.equal((await reserve({ invite, name: 'C', role: 'player' })).status, 409);
    assert.equal((await reserve({ invite, name: 'S', role: 'spectator' })).status, 201);
  });

  test(host.name + ' host runs shared-state rooms over WebSocket', async (t) => {
    const data = fixtures(t);
    const { player, rooms } = await startHost(t, host.command, ['--data', join(data.root, 'data'), '--import', data.shared.file, '--release', data.shared.id]);
    const link = rooms[0]!.link;
    const roomId = link.split('/join/')[1]!.split('#')[0]!;

    const stranger = socket(player, roomId, 'http://evil.example');
    await assert.rejects(stranger.opened);

    const intruder = socket(player, roomId);
    await intruder.opened;
    intruder.send({ type: 'hello', version: 1, credential: 'x'.repeat(32), releaseId: data.shared.id });
    assert.equal((await intruder.next((message) => message.type === 'error')).code, 'expired');
    assert.equal(await intruder.closed, 1008);
    // Data after the JSON value is invalid JSON, as JSON.parse reads it.
    const trailing = socket(player, roomId);
    await trailing.opened;
    trailing.ws.send('{"type":"resync"}}');
    assert.equal(await trailing.closed, 1007);

    const first = await reserveSeat(player, link, 'Ada');
    const second = await reserveSeat(player, link, 'Bo');
    const a = socket(player, roomId);
    const b = socket(player, roomId);
    t.after(() => { a.ws.terminate(); b.ws.terminate(); });
    await Promise.all([a.opened, b.opened]);
    a.send({ type: 'hello', version: 1, credential: first.ticket, releaseId: data.shared.id });
    const welcome = await a.next((message) => message.type === 'welcome');
    const seat = (welcome.seat as { id: string }).id;
    b.send({ type: 'hello', version: 1, credential: second.ticket, releaseId: data.shared.id });
    await b.next((message) => message.type === 'welcome');

    a.send({ type: 'action', sequence: 1, action: { x: 1, label: 'run' } });
    const update = await b.next((message) => message.type === 'snapshot' &&
      (message.state as Record<string, unknown> | null)?.[seat] !== undefined);
    assert.deepEqual((update.state as Record<string, unknown>)[seat], { x: 1, label: 'run' });
    assert.equal((update.seats as unknown[]).length, 2);

    a.send({ type: 'action', sequence: 1, action: { x: 2 } });
    assert.equal((await a.next((message) => message.type === 'error')).code, 'stale-action');
    a.send({ type: 'action', sequence: 2, action: { text: 'x'.repeat(5000) } });
    assert.equal((await a.next((message) => message.type === 'error')).code, 'invalid-action');
    // 3,000 three-byte characters fit the 4096-unit state limit (strings cap at
    // 2048 units each) but need about 9 KB of UTF-8, more than the old 8 KB frame.
    const wide = { a: '界'.repeat(1500), b: '界'.repeat(1500) };
    a.send({ type: 'action', sequence: 3, action: wide });
    const widened = await b.next((message) => message.type === 'snapshot' &&
      ((message.state as Record<string, { a?: string }> | null)?.[seat]?.a?.length ?? 0) === 1500);
    assert.deepEqual((widened.state as Record<string, unknown>)[seat], wide);
    a.send({ type: 'resync' });
    await a.next((message) => message.type === 'snapshot');
    a.send({ type: 'bogus' });
    assert.equal((await a.next((message) => message.type === 'error')).code, 'protocol');

    // Over 60 messages in a second closes the connection.
    for (let i = 0; i < 70; i++) b.send({ type: 'resync' });
    assert.equal(await b.closed, 1008);

    const resumed = socket(player, roomId);
    t.after(() => resumed.ws.terminate());
    await resumed.opened;
    resumed.send({ type: 'hello', version: 1, credential: welcome.resume as string, releaseId: data.shared.id });
    assert.equal(((await resumed.next((message) => message.type === 'welcome')).seat as { id: string }).id, seat);
    assert.equal(await a.closed, 4001);
  });

  test(host.name + ' host runs the built-in tile and valley games', async (t) => {
    const data = fixtures(t);
    const { player, rooms } = await startHost(t, host.command, ['--data', join(data.root, 'data'),
      '--import', data.tiles.file, '--import', data.moss.file, '--release', data.tiles.id, '--release', data.moss.id]);
    const tilesLink = rooms[0]!.link;
    const tilesRoom = tilesLink.split('/join/')[1]!.split('#')[0]!;
    const first = await reserveSeat(player, tilesLink, 'Ada');
    const second = await reserveSeat(player, tilesLink, 'Bo');
    const a = socket(player, tilesRoom);
    const b = socket(player, tilesRoom);
    t.after(() => { a.ws.terminate(); b.ws.terminate(); });
    await Promise.all([a.opened, b.opened]);
    a.send({ type: 'hello', version: 1, credential: first.ticket, releaseId: data.tiles.id });
    const seatA = ((await a.next((message) => message.type === 'welcome')).seat as { id: string }).id;
    b.send({ type: 'hello', version: 1, credential: second.ticket, releaseId: data.tiles.id });
    await b.next((message) => message.type === 'welcome');
    a.send({ type: 'action', sequence: 1, action: { type: 'place', cell: 4 } });
    const placed = await b.next((message) => message.type === 'snapshot' &&
      (message.state as { board: (string | null)[] }).board[4] === seatA);
    assert.notEqual((placed.state as { turn: string }).turn, seatA);
    a.send({ type: 'action', sequence: 2, action: { type: 'place', cell: 0 } });
    assert.equal((await a.next((message) => message.type === 'error')).message, 'Wait for your turn.');
    b.send({ type: 'action', sequence: 1, action: { type: 'place', cell: null } });
    assert.equal((await b.next((message) => message.type === 'error')).message, 'Choose an open tile.');

    const mossLink = rooms[1]!.link;
    const mossRoom = mossLink.split('/join/')[1]!.split('#')[0]!;
    const explorer = await reserveSeat(player, mossLink, 'Cy');
    const c = socket(player, mossRoom);
    t.after(() => c.ws.terminate());
    await c.opened;
    c.send({ type: 'hello', version: 1, credential: explorer.ticket, releaseId: data.moss.id });
    await c.next((message) => message.type === 'welcome');
    const start = await c.next((message) => message.type === 'snapshot');
    const x = (start.state as { explorers: { x: number }[] }).explorers[0]!.x;
    c.send({ type: 'action', sequence: 1, action: { type: 'move', x: 1, y: 0 } });
    const moved = await c.next((message) => message.type === 'snapshot' &&
      (message.state as { explorers: { x: number }[] }).explorers[0]!.x > x);
    assert.ok((moved.state as { explorers: { x: number }[] }).explorers[0]!.x > x);
    c.send({ type: 'action', sequence: 2, action: { type: 'move', x: 5, y: 0 } });
    assert.equal((await c.next((message) => message.type === 'error')).code, 'invalid-action');
    c.send({ type: 'action', sequence: 3, action: { type: 'move', x: null, y: null } });
    assert.equal((await c.next((message) => message.type === 'error')).code, 'invalid-action');

    // Spectators cannot act, and binary frames end the connection.
    const [mossId, mossInvite] = mossLink.split('/join/')[1]!.split('#') as [string, string];
    const watch = await fetch(player + '/rooms/' + mossId + '/reserve', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: player }, body: JSON.stringify({ invite: mossInvite, name: 'Eye', role: 'spectator' }) });
    const { ticket } = await watch.json() as { ticket: string };
    const s = socket(player, mossRoom);
    t.after(() => s.ws.terminate());
    await s.opened;
    s.send({ type: 'hello', version: 1, credential: ticket, releaseId: data.moss.id });
    await s.next((message) => message.type === 'welcome');
    s.send({ type: 'action', sequence: 1, action: { type: 'move', x: 1, y: 0 } });
    assert.equal((await s.next((message) => message.type === 'error')).code, 'forbidden');
    s.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    assert.equal(await s.closed, 1008);
  });

  test(host.name + ' host rejects tampered releases and shares the directory lock', async (t) => {
    const data = fixtures(t);
    const tampered = join(data.root, 'tampered.json');
    writeFileSync(tampered, JSON.stringify({ ...data.shared.release, game: { ...data.shared.release.game, html: '<p>changed</p>' } }));
    const rejected = await exitOf(host.command, ['--data', join(data.root, 'one'), '--import', tampered]);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.errors, /content hash/i);

    const runtime = { ...data.shared.release, files: { ...data.shared.release.files, 'player.js': Buffer.from('alert(1)').toString('base64') } };
    const swapped = join(data.root, 'swapped.json');
    writeFileSync(swapped, JSON.stringify(runtime));
    const refused = await exitOf(host.command, ['--data', join(data.root, 'two'), '--import', swapped]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.errors, /verified build/i);

    // Any host holding a data directory locks out the other implementation.
    const shared = join(data.root, 'shared');
    const owner = await startHost(t, host.command, ['--data', shared]);
    for (const other of hosts) {
      const blocked = await exitOf(other.command, ['--data', shared]);
      assert.notEqual(blocked.code, 0);
      assert.match(blocked.errors, /owned by process/i);
    }
    await stopHost(owner.process);
    assert.equal(existsSync(join(shared, 'service.json')), false);
  });
}
