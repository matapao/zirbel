// One contract, two hosts: `node dist/server.mjs --host-only` and the native Go
// host (host/bin/zirbel-host, built by `pnpm build:host`). Both must behave
// the same for players, so every check below runs against each. Their rooms are rooms.contract.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostsUnderTest, importMap, sandboxPolicy, statusForHost, stopHost } from './helpers.ts';
import { builtFiles, exitOf, fixtures, startHost } from './host-fixture.ts';

const hosts = hostsUnderTest();

for (const host of hosts) {
  test(host.name + ' host serves the player pages, runtime files and room info', async (t) => {
    const data = fixtures(t);
    const started = await startHost(t, host.command, [
      '--data',
      join(data.root, 'data'),
      '--import',
      data.shared.file,
      '--release',
      data.shared.id,
    ]);
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
    const info = (await (
      await fetch(player + '/rooms/' + roomId + '/info', { headers: { authorization: 'Bearer ' + invite } })
    ).json()) as { id: string; status: string; seats: unknown[]; gameUrl: string; manifest: { title: string } };
    assert.equal(info.id, roomId);
    assert.equal(info.status, 'waiting');
    assert.deepEqual(info.seats, []);
    assert.equal(info.manifest.title, 'Shared');

    const game = await fetch(player + info.gameUrl, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(game.status, 200);
    const runtimeBase = player + '/runtime/' + roomId + '/';
    assert.equal(
      game.headers.get('content-security-policy'),
      sandboxPolicy(runtimeBase, player + info.gameUrl, "'self'"),
    );
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
    assert.equal(
      (await fetch(player + '/runtime/' + roomId + '/game-sdk.js')).headers.get('access-control-allow-origin'),
      '*',
    );
    assert.equal((await fetch(player + '/runtime/' + roomId + '/missing.js')).status, 404);

    // three.js's addons and the decoders they load, beside three.module.js and cached like it.
    for (const [name, type] of [
      ['loaders/GLTFLoader.js', 'application/javascript; charset=utf-8'],
      ['libs/draco/draco_decoder.wasm', 'application/wasm'],
      ['libs/basis/basis_transcoder.wasm', 'application/wasm'],
    ] as const) {
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
    for (const name of [
      '',
      'loaders',
      'loaders/',
      'libs/draco/README.md',
      'loaders/GLTFLoader.js.gz',
      'missing.js',
      '%2e%2e/three.module.js',
    ])
      assert.equal((await fetch(runtimeBase + 'three/addons/' + name)).status, 404, name);
  });

  test(host.name + " host serves a built game's files beside its document, in its sandbox", async (t) => {
    const data = fixtures(t);
    const started = await startHost(t, host.command, [
      '--data',
      join(data.root, 'data'),
      '--import',
      data.built.file,
      '--release',
      data.built.id,
    ]);
    const { player } = started;
    const [roomId, invite] = started.rooms[0]!.link.split('/join/')[1]!.split('#') as [string, string];
    const info = (await (
      await fetch(player + '/rooms/' + roomId + '/info', { headers: { authorization: 'Bearer ' + invite } })
    ).json()) as { gameUrl: string };
    assert.match(info.gameUrl, /^\/game\/[a-f0-9]{12}\/[\w-]+\/$/);
    const page = await fetch(player + info.gameUrl);
    const policy = page.headers.get('content-security-policy') ?? '';
    // The same policy as a single-document game's.
    assert.equal(policy, sandboxPolicy(player + '/runtime/' + roomId + '/', player + info.gameUrl, "'self'"));
    assert.match(await page.text(), /src="\.\/assets\/main\.js"/);
    // Its source is text: nosniff keeps a browser from running it.
    for (const [path, type] of [
      ['assets/main.js', 'text/javascript; charset=utf-8'],
      ['models/hero.glb', 'model/gltf-binary'],
      ['models/hero.obj', 'model/obj'],
      ['src/main.ts', 'text/plain; charset=utf-8'],
    ] as const) {
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

  test(host.name + ' host rejects tampered releases and shares the directory lock', async (t) => {
    const data = fixtures(t);
    const tampered = join(data.root, 'tampered.json');
    writeFileSync(
      tampered,
      JSON.stringify({ ...data.shared.release, game: { ...data.shared.release.game, html: '<p>changed</p>' } }),
    );
    const rejected = await exitOf(host.command, ['--data', join(data.root, 'one'), '--import', tampered]);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.errors, /content hash/i);

    const runtime = {
      ...data.shared.release,
      files: { ...data.shared.release.files, 'player.js': Buffer.from('alert(1)').toString('base64') },
    };
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
