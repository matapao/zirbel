import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { head } from '../packages/core/projects.ts';
import { Rooms } from '../packages/core/rooms.ts';
import { rights, legacyProject, install, joinRoom } from './helpers.ts';

test('a full host closes the oldest unwatched solo playtest instead of refusing', (t) => {
  const { projects, releases } = install(t);
  const project = legacyProject(projects, 'mosslight');
  const rooms = new Rooms();
  t.after(() => rooms.dispose());
  const release = releases.package(project.id, 'main', rights, false);
  const solo = Array.from({ length: 24 }, () => rooms.create(release, true));
  const shared = rooms.create(release, false);
  assert.throws(() => rooms.get(solo[0]!.id), /does not exist/);
  assert.equal(rooms.get(solo[1]!.id), solo[1]);
  assert.deepEqual(rooms.list().map(({ id }) => id), [shared.id]);
});

test('a development room pins the revision and admits only invited guests', (t) => {
  const { projects, releases } = install(t);
  const project = legacyProject(projects, 'mosslight');
  const initial = head(project, 'main');
  const rooms = new Rooms();
  t.after(() => rooms.dispose());
  const release = releases.package(project.id, 'main', { ...rights, download: false, remix: false }, false);
  const room = rooms.create(release, false, 'lan', true);
  assert.equal(room.summary().development, true);
  assert.equal(room.summary().access, 'lan');
  assert.equal(room.mayView('wrong'), false);
  assert.equal(room.mayView(room.invite), true);
  assert.throws(() => room.reserve('wrong', 'Stranger', 'player'), /invitation/);
  const player = joinRoom(room, room.reserve(room.invite, 'Ada', 'player'));
  player.send(1, { type: 'move', x: 1, y: 0 });
  for (let i = 0; i < 5; i++) room.step();
  const snapshot = player.messages.at(-1);
  assert.equal(snapshot?.type, 'snapshot');
  assert.equal(snapshot.ack, 1);
  room.disconnected(player.id, player.peer);
  const restored = joinRoom(room, player.welcome.resume);
  assert.equal(restored.id, player.id);
  assert.equal(restored.welcome.ack, 1);

  const draft = projects.submit(project.id, { branch: 'main', baseRevision: initial.id, label: 'Edit while hosting',
    operations: [{ op: 'update', id: 'campfire', changes: { color: '#fafafa' } }] });
  projects.commit(project.id, draft.proposal.id);
  assert.equal(room.release.manifest.sourceRevision, initial.id);
  assert.notEqual(room.release.manifest.sourceRevision, head(projects.read(project.id), 'main').id);
  assert.equal(releases.list().length, 0);
  rooms.close(room.id);
  assert.equal(restored.messages.at(-1)?.type, 'closed');
});

test('two independent stores run the same release and enforce the turn-based rules', (t) => {
  const a = install(t);
  const b = install(t);
  const project = legacyProject(a.projects, 'tessellate');
  const original = a.releases.package(project.id, 'main', rights, true);
  const imported = b.releases.import(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(imported.manifest, original.manifest);
  const broken = structuredClone(original);
  broken.files['player.js'] = Buffer.from('unverified file').toString('base64');
  assert.throws(() => b.releases.import(broken), /requires a verified build/);
  const hosts = [new Rooms(), new Rooms()];
  t.after(() => { for (const host of hosts) host.dispose(); });
  const [left, right] = [hosts[0]!.create(original, false), hosts[1]!.create(imported, false)];
  for (const room of [left, right]) {
    const alice = joinRoom(room, room.reserve(room.invite, 'Alice', 'player'));
    const bob = joinRoom(room, room.reserve(room.invite, 'Bob', 'player'));
    const viewer = joinRoom(room, room.reserve(room.invite, 'Viewer', 'spectator'));
    assert.throws(() => room.reserve(room.invite, 'Full', 'player'), /seats are reserved/);
    bob.send(1, { type: 'place', cell: 3 });
    assert.ok(bob.messages.some((entry) => entry.type === 'error' && entry.code === 'invalid-action'));
    viewer.send(1, { type: 'place', cell: 3 });
    assert.ok(viewer.messages.some((entry) => entry.type === 'error' && entry.code === 'forbidden'));
    alice.send(1, { type: 'place', cell: 0 });
    bob.send(2, { type: 'place', cell: 3 });
    alice.send(2, { type: 'place', cell: 1 });
    bob.send(3, { type: 'place', cell: 4 });
    alice.send(3, { type: 'place', cell: 2 });
    const last = alice.messages.at(-1);
    assert.equal(last?.type, 'snapshot');
    assert.equal((last.state as { winner: string }).winner, alice.id);
  }
});

test('authored multiplayer snapshots attribute arbitrary state to the sending seat', (t) => {
  const { projects, releases } = install(t);
  const p = projects.createGame('Two hands', { html: '<canvas></canvas>', maxPlayers: 2 });
  const release = releases.package(p.id, 'main', rights, false);
  const rooms = new Rooms();
  t.after(() => rooms.dispose());
  const room = rooms.create(release, false, 'lan');
  const alice = joinRoom(room, room.reserve(room.invite, 'Alice', 'player'));
  const bob = joinRoom(room, room.reserve(room.invite, 'Bob', 'player'));
  const watcher = joinRoom(room, room.reserve(room.invite, 'Guest', 'spectator'));
  const state = { hand: ['violet'], phases: { dawn: true } };
  alice.send(1, state);
  watcher.send(1, { hand: ['green'] });
  room.step();
  const snap = bob.messages.at(-1);
  assert.equal(snap?.type, 'snapshot');
  assert.deepEqual(snap.state, { [alice.id]: state });
  assert.ok(watcher.messages.some((message) => message.type === 'error' && message.code === 'forbidden'));
  room.disconnected(alice.id, alice.peer);
  const resumed = joinRoom(room, alice.welcome.resume);
  const restored = resumed.messages.at(-1);
  assert.equal(restored?.type, 'snapshot');
  assert.deepEqual(restored.state, snap.state);
});

test('game documents carry an HTTP sandbox and only the room-scoped game SDK', async (t) => {
  const { gamePage } = await import('../packages/server/game-page.ts');
  const { projects, releases } = install(t);
  const game = { html: '<main>original source</main>', maxPlayers: 1 };
  const p = projects.createGame('Independent game', game);
  const page = gamePage(releases.package(p.id, 'main', rights, false), 'http://localhost:4000/runtime/test/', "'self'", 'http://localhost:4000/game/test/key/');
  assert.match(page.policy, /sandbox allow-scripts allow-pointer-lock;/);
  // WebAssembly compiles ('wasm-unsafe-eval'); strings never run as code.
  assert.doesNotMatch(page.policy, /allow-same-origin|'unsafe-eval'/);
  assert.match(page.policy, /connect-src http:\/\/localhost:4000\/game\/test\/key\/ http:\/\/localhost:4000\/runtime\/test\/three\/addons\/ data: blob:;/);
  assert.match(page.html, /runtime\/test\/three\.module\.js/);
  assert.ok(page.html.endsWith(game.html));
});

test('a release to import is checked and read through one handle: only a file under 48 MB imports', async (t) => {
  const { importReleases } = await import('../packages/server/hosting.ts');
  const { PORTABLE_FILE_LIMIT } = await import('../packages/sdk/contracts.ts');
  const { root } = install(t);
  const imported: unknown[] = [];
  const releases = { import: (release: unknown) => imported.push(release) } as unknown as Parameters<typeof importReleases>[0];
  const file = join(root, 'release.json');
  writeFileSync(file, '{"manifest":{}}');
  importReleases(releases, [file]);
  assert.deepEqual(imported, [{ manifest: {} }]);
  const large = join(root, 'large.json');
  writeFileSync(large, '');
  truncateSync(large, PORTABLE_FILE_LIMIT + 1);
  const refused = [root, large];
  if (process.platform !== 'win32') {
    // A named pipe is refused at once, not waited on for a writer.
    execFileSync('mkfifo', [join(root, 'pipe')]);
    refused.push(join(root, 'pipe'));
  }
  for (const path of refused) assert.throws(() => importReleases(releases, [path]), /under 48 MB/, path);
  assert.equal(imported.length, 1);
});

test('a service claim is exclusive and an old owner cannot release its successor', async (t) => {
  const { claimDirectory } = await import('../packages/server/service-lock.ts');
  const { newId } = await import('../packages/core/projects.ts');
  const { root } = install(t);
  // The parent is a live process other than this one.
  const metadata = { pid: process.ppid, port: 4173, boot: newId(), editor: true };
  const first = claimDirectory(root, metadata);
  assert.ok(first.owner);
  assert.equal(claimDirectory(root, { ...metadata, boot: newId() }).owner, false);
  first.release();
  const next = claimDirectory(root, { ...metadata, boot: newId() });
  assert.ok(next.owner);
  first.release();
  assert.equal(claimDirectory(root, { ...metadata, boot: newId() }).owner, false);
  next.release();
  // A claim cut short by a crash is stale, not a permanent lock.
  writeFileSync(join(root, 'service.json'), '');
  const afterCrash = claimDirectory(root, { ...metadata, boot: newId() });
  assert.ok(afterCrash.owner);
  afterCrash.release();
  // So is a recovery file left by a process killed mid-recovery.
  const stale = { ...metadata, pid: 2 ** 22, boot: newId() };
  writeFileSync(join(root, 'service.json'), JSON.stringify(stale));
  writeFileSync(join(root, 'recover-' + stale.boot + '.json'), '');
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(root, 'recover-' + stale.boot + '.json'), old, old);
  const recovered = claimDirectory(root, { ...metadata, boot: newId() });
  assert.ok(recovered.owner);
  recovered.release();
  // A leftover claim with this PID (container restart, PID reuse) is stale.
  claimDirectory(root, { ...metadata, pid: process.pid });
  const restarted = claimDirectory(root, { ...metadata, pid: process.pid, boot: newId() });
  assert.ok(restarted.owner);
  restarted.release();
});

test('the player gzips and caches runtime files, and the headless host starts without the editor', async (t) => {
  const { Players } = await import('../packages/server/hosting.ts');
  const { spawn } = await import('node:child_process');
  const { root, projects, releases } = install(t);
  const project = projects.createGame('Cache', { html: '<canvas></canvas>', maxPlayers: 2 });
  const players = new Players(new Rooms(), releases, { playerPort: 0 });
  t.after(() => players.close());
  const local = await players.openLocal(0);
  const { link } = players.solo(releases.package(project.id, 'main', rights, false, true));
  const room = link.split('/join/')[1]!.split('#')[0];
  const url = 'http://127.0.0.1:' + local.port + '/runtime/' + room + '/three.module.js';
  let response = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
  // Compression runs off the event loop, so the first responses may be plain.
  for (let tries = 0; response.headers.get('content-encoding') !== 'gzip' && tries < 50; tries++) {
    await new Promise((done) => setTimeout(done, 20));
    response = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
  }
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.match(response.headers.get('cache-control') ?? '', /immutable/);
  assert.equal((await response.arrayBuffer()).byteLength > 0, true);
  const etag = response.headers.get('etag')!;
  assert.equal((await fetch(url, { headers: { 'if-none-match': etag } })).status, 304);
  // three.js's addons come from the same build, each read on its first request, and only the files there.
  const addon = url.replace('three.module.js', 'three/addons/libs/draco/draco_decoder.wasm');
  response = await fetch(addon, { headers: { 'accept-encoding': 'gzip' } });
  for (let tries = 0; response.headers.get('content-encoding') !== 'gzip' && tries < 50; tries++) {
    await new Promise((done) => setTimeout(done, 20));
    response = await fetch(addon, { headers: { 'accept-encoding': 'gzip' } });
  }
  assert.equal(response.headers.get('content-type'), 'application/wasm');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync('dist/web/three/examples/jsm/libs/draco/draco_decoder.wasm'));
  for (const name of ['libs/draco/README.md', 'libs', 'nothing.js'])
    assert.equal((await fetch(url.replace('three.module.js', 'three/addons/' + name))).status, 404, name);
  const { threeAddons } = await import('../packages/server/runtime-files.ts');
  assert.throws(() => threeAddons(root), /missing three/);

  const host = spawn(process.execPath, ['dist/server.mjs', '--host-only', '--data', join(root, 'host'), '--player-port', '0'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => host.kill());
  const started = await new Promise<{ editor: null; player: string }>((resolve, reject) => {
    let output = '';
    host.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const line = output.split('\n').find((item) => item.includes('"player"'));
      if (line) resolve(JSON.parse(line) as { editor: null; player: string });
    });
    host.once('exit', (code) => reject(new Error('The host exited with ' + code)));
  });
  assert.equal(started.editor, null);
  assert.equal((await fetch(started.player + '/health')).ok, true);
});

test('the player runtime in releases contains no editor code', () => {
  // Every runtime chunk must be reachable from the player entry points.
  const imports = (file: string) => [...readFileSync(join('dist/web', file), 'utf8').matchAll(/["'](?:\.\/)?(chunks\/[\w.-]+\.js|[\w-]+\.js)["']/g)]
    .map((match) => match[1]!.startsWith('chunks/') ? match[1]! : 'chunks/' + match[1]!);
  const reached = new Set<string>();
  const visit = (file: string) => {
    for (const chunk of imports(file)) {
      if (!existsSync(join('dist/web', chunk)) || reached.has(chunk)) continue;
      reached.add(chunk);
      visit(chunk);
    }
  };
  visit('player.js');
  visit('garden-3d.js');
  const shipped = readdirSync('dist/web/chunks').filter((file) => file.endsWith('.js')).map((file) => 'chunks/' + file);
  assert.deepEqual(shipped.filter((chunk) => !reached.has(chunk)), []);
});
