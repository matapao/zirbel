// Two real browsers join one room on each host (Node and, when built, Go) and
// see each other's shared state through the actual player page, game SDK,
// sandboxed frame and WebSocket. Run with `pnpm test:browser`.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Page } from 'playwright';
import { importGameFolder } from '../packages/core/game-files.ts';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { hostsUnderTest, launch, rights, tempDir, triangleGlb } from './helpers.ts';

const game = `<!doctype html><p id="out">waiting</p><script>
  zirbel.onRoom((room) => { document.getElementById('out').textContent = Object.keys(room.states).length + ' players'; });
  setInterval(() => zirbel.send({ at: Date.now() }), 30);
</script>`;

const hosts = hostsUnderTest();

// WCAG checks on a real page. Serious and critical violations fail the test;
// the game canvas is the author's content and is left out.
async function accessibility(page: Page) {
  const result = await new AxeBuilder({ page }).exclude('canvas').exclude('iframe').analyze();
  return result.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')
    .map((item) => item.id + ': ' + item.help + ' (' + item.nodes.map((node) => node.target.join(' ')).slice(0, 3).join(', ') + ')');
}

for (const host of hosts) {
  test(host.name + ' host: two browsers share state in one room', async (t) => {
    const root = tempDir(t, 'zirbel-host-browser-');
    const projects = new Projects(join(root, 'source'));
    const project = projects.createGame('Browsers', { html: game, maxPlayers: 2 });
    const release = new Releases(projects, 'dist/web').package(project.id, 'main', rights, false);
    const file = join(root, 'release.json');
    writeFileSync(file, JSON.stringify(release));
    const link = await launch(t, host.command, ['--host-only', '--player-port', '0',
      '--data', join(root, 'data'), '--import', file, '--release', release.manifest.releaseId],
    (line) => typeof line.link === 'string' ? line.link : undefined).ready;

    const browser = await chromium.launch();
    t.after(() => browser.close());
    const pages = await Promise.all([1, 2].map(async () => (await browser.newContext()).newPage()));
    const failures: string[] = [];
    for (const [index, page] of pages.entries()) {
      page.on('pageerror', (error) => failures.push(error.message));
      await page.goto(link);
      await page.locator('#join-form input[name="name"]').fill('Player ' + (index + 1));
      await page.locator('#join-form button.primary').click();
    }
    for (const page of pages) {
      await page.frameLocator('iframe').locator('#out').filter({ hasText: '2 players' }).waitFor({ timeout: 15_000 });
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(await accessibility(pages[0]!), []);
  });
}

// A built game in the sandbox: its stylesheet, a module importing a module, a fetch
// and an image all load from beside its document, and a request elsewhere is refused.
const dot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const builtGame: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="./style.css"><p id="out">waiting</p><script type="module" src="./assets/main.js"></script>',
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
async function playAlone(t: TestContext, host: { command: string[] }, game: { html: string } | { files: Record<string, string> }) {
  const root = tempDir(t, 'zirbel-host-game-');
  const projects = new Projects(join(root, 'source'));
  const project = 'html' in game ? projects.createGame('Game', { html: game.html, maxPlayers: 1 })
    : importGameFolder(projects, { title: 'Built', files: game.files });
  const release = new Releases(projects, 'dist/web').package(project.id, 'main', rights, false);
  const file = join(root, 'release.json');
  writeFileSync(file, JSON.stringify(release));
  const link = await launch(t, host.command, ['--host-only', '--player-port', '0',
    '--data', join(root, 'data'), '--import', file, '--release', release.manifest.releaseId],
  (line) => typeof line.link === 'string' ? line.link : undefined).ready;

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
const encoded = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text).toString('base64')]));

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
const answer = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11];
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
  test(host.name + ' host: every game loads three.js addons, WebAssembly and workers, and reaches no other origin', async (t) => {
    // Another server on loopback, which would answer any origin.
    let requests = 0;
    const other = createServer((_request, response) => { requests++; response.writeHead(200, { 'access-control-allow-origin': '*' }).end('reached'); });
    other.listen(0, '127.0.0.1');
    await once(other, 'listening');
    t.after(() => other.close());
    const { port } = other.address() as AddressInfo;
    const elsewhere = ['http://127.0.0.1:' + port + '/', 'http://localhost:' + port + '/'];
    const glb = triangleGlb();

    const single = await playAlone(t, host, { html: '<!doctype html><p id="out">waiting</p><script type="module">' +
      capabilities('data:model/gltf-binary;base64,' + glb.toString('base64'), elsewhere) + '</script>' });
    const built = await playAlone(t, host, { files: { ...encoded({
      'index.html': '<!doctype html><p id="out">waiting</p><script type="module" src="./assets/main.js"></script>',
      // A game's own TypeScript is text, so importing it as a module fails.
      'assets/main.js': capabilities('./models/tri.glb', elsewhere, "import('../src/main.ts').then(() => 'ran', () => 'unrun')"),
      'src/main.ts': 'export const speed: number = 2;',
    }), 'models/tri.glb': glb.toString('base64') } });
    for (const [game, expected] of [[single, 'Mesh 42 decoder 42 refused refused'], [built, 'Mesh 42 decoder 42 refused refused unrun']] as const) {
      const out = game.frame.locator('#out');
      await out.filter({ hasNotText: 'waiting' }).waitFor({ timeout: 15_000 });
      assert.equal(await out.textContent(), expected);
      assert.deepEqual(game.failures, []);
    }
    assert.equal(requests, 0);
  });
}

// The editor UI itself, served by each host: it loads, opens a project created through the API from the game
// switcher, runs its game with Edit on demand, and stays accessible, without page errors or CSP violations. The Go
// editor has no harness chat, so the ⋯ menu leaves Harnesses out there.
for (const host of hosts) {
  test(host.name + ' host: the editor UI loads and opens a project', async (t) => {
    const editor = await launch(t, host.command, ['--data', join(tempDir(t, 'zirbel-editor-ui-'), 'data'), '--port', '0'],
      (line) => typeof line.editor === 'string' ? line.editor : undefined).ready;
    const post = (path: string, body: unknown) => fetch(editor + path, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: editor }, body: JSON.stringify(body) });
    await post('/api/projects', { title: 'Browser check' });
    const html = '<!doctype html><button id="go">Go</button><script>zirbel.register("go", { name: "Go button" })</script>';
    await post('/api/projects/import-game', { title: 'Built check', files: { 'index.html': Buffer.from(html).toString('base64') } });

    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await (await browser.newContext()).newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text()); });
    page.on('response', (response) => { if (response.url().startsWith(editor) && response.status() >= 500) failures.push(response.status() + ' ' + response.url()); });
    await page.goto(editor + '/');
    const prompt = page.getByRole('textbox', { name: 'Describe a game' });
    await prompt.waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('#workspace-modes, button[data-mode]').count(), 0);
    assert.deepEqual(await accessibility(page), []);

    const open = async (title: string) => {
      await page.locator('#game-switcher').click();
      await page.getByRole('menu', { name: 'Games' }).getByRole('menuitemradio', { name: title, exact: true }).click();
      await page.locator('#game-title').filter({ hasText: title }).waitFor();
    };
    await open('Browser check');
    await prompt.waitFor();
    await page.waitForLoadState('networkidle');
    assert.deepEqual(await accessibility(page), []);

    await open('Built check');
    await page.frameLocator('#playframe').frameLocator('iframe.authored-game').locator('#go').waitFor({ timeout: 15_000 });
    const edit = page.getByRole('button', { name: 'Edit', exact: true });
    await edit.click();
    await page.getByRole('button', { name: 'Objects', exact: true }).click();
    await page.locator('#objects').getByRole('button', { name: 'Go button' }).waitFor();
    assert.deepEqual(await accessibility(page), []);
    await page.locator('#playframe').click({ position: { x: 500, y: 400 } });
    await page.locator('#edit-toggle[aria-pressed="false"]').waitFor();

    await page.getByRole('button', { name: 'More', exact: true }).click();
    const items = await page.getByRole('menu', { name: 'More' }).getByRole('menuitem').allTextContents();
    assert.equal(items.includes('Harnesses'), host.name === 'node');
    assert.deepEqual(await accessibility(page), []);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await page.getByRole('dialog', { name: 'Assets' }).getByText('No imported assets yet.').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForLoadState('networkidle');
    assert.deepEqual(failures, []);
  });
}
