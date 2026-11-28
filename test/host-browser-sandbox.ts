// A game in its sandboxed frame on each host (Node and, when built, Go): what it loads from beside its document, what
// every game can run there, and the requests elsewhere that are refused. Run with `pnpm test:browser`.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { chromium } from 'playwright';
import { importGameFolder } from '../packages/core/game-files.ts';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { launch, rights, tempDir, triangleGlb } from './helpers.ts';
import { encoded, hosts } from './host-browser-fixture.ts';

// A built game in the sandbox: its stylesheet, a module importing a module, a fetch
// and an image all load from beside its document, and a request elsewhere is refused.
const dot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const builtGame: Record<string, string> = {
  'index.html':
    '<!doctype html><link rel="stylesheet" href="./style.css"><p id="out">waiting</p><script type="module" src="./assets/main.js"></script>',
  'style.css': '#out { color: rgb(1, 2, 3); }',
  'assets/main.js': `import { word } from './word.js';
    const level = await (await fetch('./data/level.json')).json();
    const image = new Image(); image.src = './img/dot.png'; await image.decode();
    const elsewhere = await fetch('/health').then(() => 'reached', () => 'refused');
    const color = getComputedStyle(document.getElementById('out')).color;
    document.getElementById('out').textContent = [word, level.rooms, image.width, color, elsewhere].join(' ');`,
  'assets/word.js': "export const word = 'loaded';",
  'data/level.json': '{"rooms":3}',
};

// One player joins a one-player game on a host and gets the game's frame: a single document (html), or a built
// folder (files, as text or base64).
async function playAlone(
  t: TestContext,
  host: { command: string[] },
  game: { html: string } | { files: Record<string, string> },
) {
  const root = tempDir(t, 'zirbel-host-game-');
  const projects = new Projects(join(root, 'source'));
  const project =
    'html' in game
      ? projects.createGame('Game', { html: game.html, maxPlayers: 1 })
      : importGameFolder(projects, { title: 'Built', files: game.files });
  const release = new Releases(projects, 'dist/web').package(project.id, 'main', rights, false);
  const file = join(root, 'release.json');
  writeFileSync(file, JSON.stringify(release));
  const link = await launch(
    t,
    host.command,
    [
      '--host-only',
      '--player-port',
      '0',
      '--data',
      join(root, 'data'),
      '--import',
      file,
      '--release',
      release.manifest.releaseId,
    ],
    (line) => (typeof line.link === 'string' ? line.link : undefined),
  ).ready;

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(link);
  await page.locator('#join-form input[name="name"]').fill('Player');
  await page.locator('#join-form button.primary').click();
  return { frame: page.frameLocator('iframe'), failures };
}

for (const host of hosts) {
  test(host.name + ' host: a built game loads its own files in the sandbox', async (t) => {
    const { frame, failures } = await playAlone(t, host, { files: { ...encoded(builtGame), 'img/dot.png': dot } });
    await frame.locator('#out').filter({ hasText: 'loaded 3 1 rgb(1, 2, 3) refused' }).waitFor({ timeout: 15_000 });
    assert.deepEqual(failures, []);
  });
}

// What every game can do in its sandbox, a single document and a built folder alike: load a model with a three.js
// addon, compile WebAssembly, fetch a decoder the addons load at runtime (as DRACOLoader does) and run a worker. A
// request to another origin, another loopback port among them, is refused before it leaves the browser.
// (module (func (export "answer") (result i32) i32.const 42))
const answer = [
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0, 10,
  6, 1, 4, 0, 65, 42, 11,
];
function capabilities(model: string, elsewhere: string[], extra = 'undefined') {
  return `import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
    const out = document.getElementById('out');
    try {
      const gltf = await new GLTFLoader().loadAsync(${JSON.stringify(model)});
      const { instance } = await WebAssembly.instantiate(new Uint8Array(${JSON.stringify(answer)}));
      const decoder = await WebAssembly.compileStreaming(fetch(import.meta.resolve('three/addons/libs/draco/draco_decoder.wasm')));
      const worker = new Worker(URL.createObjectURL(new Blob(['postMessage(6 * 7)'], { type: 'text/javascript' })));
      const message = await new Promise((resolve, reject) => { worker.onmessage = (event) => resolve(event.data); worker.onerror = reject; });
      const reached = await Promise.all(${JSON.stringify(elsewhere)}.map((url) => fetch(url).then(() => 'reached', () => 'refused')));
      out.textContent = [gltf.scene.getObjectByName('Tri')?.type, instance.exports.answer(),
        WebAssembly.Module.imports(decoder).length > 0 ? 'decoder' : 'empty', message, ...reached, await ${extra}]
        .filter((part) => part !== undefined).join(' ');
    } catch (error) { out.textContent = 'failed: ' + error; }`;
}

for (const host of hosts) {
  test(
    host.name + ' host: every game loads three.js addons, WebAssembly and workers, and reaches no other origin',
    async (t) => {
      // Another server on loopback, which would answer any origin.
      let requests = 0;
      const other = createServer((_request, response) => {
        requests++;
        response.writeHead(200, { 'access-control-allow-origin': '*' }).end('reached');
      });
      other.listen(0, '127.0.0.1');
      await once(other, 'listening');
      t.after(() => other.close());
      const { port } = other.address() as AddressInfo;
      const elsewhere = ['http://127.0.0.1:' + port + '/', 'http://localhost:' + port + '/'];
      const glb = triangleGlb();

      const single = await playAlone(t, host, {
        html:
          '<!doctype html><p id="out">waiting</p><script type="module">' +
          capabilities('data:model/gltf-binary;base64,' + glb.toString('base64'), elsewhere) +
          '</script>',
      });
      const built = await playAlone(t, host, {
        files: {
          ...encoded({
            'index.html':
              '<!doctype html><p id="out">waiting</p><script type="module" src="./assets/main.js"></script>',
            // A game's own TypeScript is text, so importing it as a module fails.
            'assets/main.js': capabilities(
              './models/tri.glb',
              elsewhere,
              "import('../src/main.ts').then(() => 'ran', () => 'unrun')",
            ),
            'src/main.ts': 'export const speed: number = 2;',
          }),
          'models/tri.glb': glb.toString('base64'),
        },
      });
      for (const [game, expected] of [
        [single, 'Mesh 42 decoder 42 refused refused'],
        [built, 'Mesh 42 decoder 42 refused refused unrun'],
      ] as const) {
        const out = game.frame.locator('#out');
        await out.filter({ hasNotText: 'waiting' }).waitFor({ timeout: 15_000 });
        assert.equal(await out.textContent(), expected);
        assert.deepEqual(game.failures, []);
      }
      assert.equal(requests, 0);
    },
  );
}
