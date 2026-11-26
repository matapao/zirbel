// Two real browsers join one room on each host (Node and, when built, Go) and
// see each other's shared state through the actual player page, game SDK,
// sandboxed frame and WebSocket. Run with `pnpm test:browser`.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
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

// The lobby on a phone-sized page: one person starts a session of the game the owner offers (lobby.json, as the editor
// keeps it) and reads its code out, or shows its QR code; another types it in, in lower case with a dash, and both play
// in one room. A phone that scans the QR code finds the code filled in.
for (const host of hosts) {
  test(host.name + ' host: one browser starts a session in the lobby and another joins it with its code', async (t) => {
    const root = tempDir(t, 'zirbel-host-lobby-');
    const projects = new Projects(join(root, 'source'));
    const release = new Releases(projects, 'dist/web').package(projects.createGame('Lobby game', { html: game, maxPlayers: 2 }).id,
      'main', rights, false);
    const file = join(root, 'release.json');
    writeFileSync(file, JSON.stringify(release));
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'lobby.json'), JSON.stringify({ version: 1, offered: [release.manifest.releaseId] }));
    const player = await launch(t, host.command, ['--host-only', '--player-port', '0', '--data', join(root, 'data'), '--import', file],
      (line) => typeof line.player === 'string' ? line.player : undefined).ready;

    const browser = await chromium.launch();
    t.after(() => browser.close());
    const [first, second] = await Promise.all([1, 2].map(async () =>
      (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage())) as [Page, Page];
    const failures: string[] = [];
    for (const page of [first, second]) {
      page.on('pageerror', (error) => failures.push(error.message));
      page.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text()); });
    }
    await first.goto(player + '/');
    await first.getByLabel('Your name').fill('Ada');
    await first.getByRole('button', { name: 'Start session of Lobby game' }).click();
    await first.getByRole('heading', { name: 'Your session is ready' }).waitFor();
    const code = await first.locator('#code').textContent() ?? '';
    assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    // Its QR code, drawn in the page, and the link under it: the lobby with the session's code.
    const qr = first.getByRole('img', { name: 'QR code that joins this session' });
    await qr.waitFor();
    assert.match(await qr.getAttribute('src') ?? '', /^data:image\/svg\+xml,/);
    assert.ok((await qr.boundingBox())!.width >= 200);
    const invitation = await first.locator('#session-link').getAttribute('href') ?? '';
    assert.deepEqual([invitation, await first.locator('#session-link').textContent()], [player + '/?code=' + code, invitation]);
    assert.deepEqual(await accessibility(first), []);
    await first.getByRole('link', { name: 'Go in' }).click();

    // A phone that scans it opens the lobby with the code filled in, at the name; and invites others to the lobby.
    const scanned = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
    scanned.on('pageerror', (error) => failures.push(error.message));
    scanned.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text()); });
    await scanned.goto(invitation);
    assert.equal(await scanned.getByLabel('Session code').inputValue(), code);
    assert.equal(await scanned.evaluate(() => document.activeElement?.id), 'name');
    const invite = scanned.getByRole('button', { name: 'Invite others' });
    await invite.click();
    await scanned.getByRole('img', { name: 'QR code that opens this lobby' }).waitFor();
    assert.deepEqual([await invite.getAttribute('aria-expanded'), await scanned.locator('#lobby-link').textContent()], ['true', player + '/']);
    assert.deepEqual(await accessibility(scanned), []);
    await invite.click();
    assert.equal(await scanned.locator('#invite').isHidden(), true);

    await second.goto(player + '/');
    await second.locator('#sessions li').filter({ hasText: 'Lobby game' }).waitFor();
    assert.equal(await second.locator('main').textContent().then((text) => text?.includes(code)), false);
    assert.deepEqual(await accessibility(second), []);
    await second.getByLabel('Your name').fill('Bo');
    await second.getByLabel('Session code').fill(code.toLowerCase().slice(0, 2) + '-' + code.toLowerCase().slice(2));
    await second.getByRole('button', { name: 'Join', exact: true }).click();
    for (const page of [first, second])
      await page.frameLocator('iframe').locator('#out').filter({ hasText: '2 players' }).waitFor({ timeout: 15_000 });
    assert.equal(await second.locator('#badge').textContent(), 'Code ' + code);
    assert.deepEqual(failures, []);
  });
}

// A game with its own netcode: zirbel-net from its host, the room and key from its address, the relay at /mp.
const netGame = `<!doctype html><p id="out">waiting</p><script type="module">
  const zn = await import('/zirbel-net.js');
  const net = zn.connect(zn.launchParams());
  const out = document.getElementById('out');
  let heard = '';
  const show = () => { out.textContent = (net.peers.size + 1) + ' players, heard ' + heard; };
  net.on('open', () => { net.send(zn.ALL, 1, 'hi from ' + net.id); show(); });
  net.on('peer', (id) => { net.send(id, 1, 'hi from ' + net.id); show(); });
  net.on('message', (from, type, r) => { heard = r.text(); show(); });
  net.on('close', (code, message) => { out.textContent = 'closed ' + code + ' ' + message; });
</script>`;

for (const host of hosts) {
  test(host.name + ' host: two browsers play a game with its own netcode over the relay', async (t) => {
    const root = tempDir(t, 'zirbel-host-net-');
    const projects = new Projects(join(root, 'source'));
    const project = importGameFolder(projects, { title: 'Relay', files: encoded({ 'index.html': netGame, 'zirbel.json': '{"players":{"max":2}}' }) });
    const release = new Releases(projects, 'dist/web').package(project.id, 'main', rights, false);
    const file = join(root, 'release.json');
    writeFileSync(file, JSON.stringify(release));
    const link = await launch(t, host.command, ['--host-only', '--player-port', '0',
      '--data', join(root, 'data'), '--import', file, '--release', release.manifest.releaseId],
    (line) => typeof line.link === 'string' ? line.link : undefined).ready;
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const failures: string[] = [];
    const pages = await Promise.all([1, 2].map(async () => (await browser.newContext()).newPage()));
    for (const [index, page] of pages.entries()) {
      page.on('pageerror', (error) => failures.push(error.message));
      page.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text()); });
      await page.goto(link);
      await page.locator('#join-form input[name="name"]').fill('Player ' + (index + 1));
      await page.locator('#join-form button.primary').click();
      await page.frameLocator('iframe').locator('#out').filter({ hasText: '1 players' }).or(page.frameLocator('iframe')
        .locator('#out').filter({ hasText: '2 players' })).waitFor({ timeout: 15_000 });
    }
    for (const [index, page] of pages.entries())
      await page.frameLocator('iframe').locator('#out').filter({ hasText: '2 players, heard hi from ' + (2 - index) }).waitFor({ timeout: 15_000 });
    assert.deepEqual(failures, []);
  });
}

// A game that knows nothing of any host: hooks for who this screen is, who else plays and what they say. Its
// zirbel.json names the adapter beside it, which the game page loads after the game, and which alone talks to zirbel-net.
const hookedGame = {
  'index.html': '<!doctype html><p id="out">waiting</p><script type="module" src="./game.js"></script>',
  'game.js': `const out = document.getElementById('out');
    const others = new Set();
    let me = 1, heard = 'nothing';
    const draw = () => { out.textContent = (others.size + 1) + ' players, me ' + me + ', heard ' + heard; };
    globalThis.gameHooks = {
      me: (id) => { me = id; draw(); },
      join: (id) => { if (id !== me) others.add(id); draw(); },
      leave: (id) => { others.delete(id); draw(); },
      input: () => 'hello from ' + me,
      control: (id, input) => { heard = input; draw(); },
    };
    draw();`,
};
const tinyAdapter = `const game = globalThis.gameHooks;
  const zn = await import('/zirbel-net.js');
  const net = zn.connect(zn.launchParams());
  net.on('open', () => { game.me(net.id); for (const id of net.peers.keys()) game.join(id); net.send(zn.ALL, 1, game.input()); });
  net.on('peer', (id) => { game.join(id); net.send(id, 1, game.input()); });
  net.on('leave', (id) => game.leave(id));
  net.on('message', (from, type, r) => game.control(from, r.text()));`;

for (const host of hosts) {
  test(host.name + ' host: two browsers play a game with no line about Zirbel, through the adapter its zirbel.json names', async (t) => {
    assert.doesNotMatch(Object.values(hookedGame).join('\n'), /zirbel|location|import/i);
    const root = tempDir(t, 'zirbel-host-adapter-');
    const projects = new Projects(join(root, 'source'));
    const project = importGameFolder(projects, { title: 'Hooks', files: encoded({ ...hookedGame, 'net/adapter.js': tinyAdapter,
      'zirbel.json': JSON.stringify({ players: { max: 2 }, multiplayer: { adapter: 'net/adapter.js' } }) }) });
    const release = new Releases(projects, 'dist/web').package(project.id, 'main', rights, false);
    const file = join(root, 'release.json');
    writeFileSync(file, JSON.stringify(release));
    const link = await launch(t, host.command, ['--host-only', '--player-port', '0',
      '--data', join(root, 'data'), '--import', file, '--release', release.manifest.releaseId],
    (line) => typeof line.link === 'string' ? line.link : undefined).ready;
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const failures: string[] = [];
    const pages = await Promise.all([1, 2].map(async () => (await browser.newContext()).newPage()));
    for (const [index, page] of pages.entries()) {
      page.on('pageerror', (error) => failures.push(error.message));
      page.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text()); });
      await page.goto(link);
      await page.locator('#join-form input[name="name"]').fill('Player ' + (index + 1));
      await page.locator('#join-form button.primary').click();
    }
    // Two seats, each screen its own, and each heard the other.
    const seen: string[] = [];
    for (const page of pages) {
      const out = page.frameLocator('iframe').locator('#out').filter({ hasText: /^2 players, me \d, heard hello from \d$/ });
      await out.waitFor({ timeout: 15_000 });
      const [, me, from] = /me (\d), heard hello from (\d)/.exec(await out.textContent() ?? '')!;
      seen.push(me + '<' + from);
    }
    assert.deepEqual(seen.sort(), ['1<2', '2<1']);
    assert.deepEqual(failures, []);
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
    const editor = await launch(t, host.command, ['--data', join(tempDir(t, 'zirbel-editor-ui-'), 'data'), '--port', '0',
      '--player-host', 'games.lan'], (line) => typeof line.editor === 'string' ? line.editor : undefined).ready;
    const post = (path: string, body: unknown) => fetch(editor + path, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: editor }, body: JSON.stringify(body) });
    await post('/api/projects', { title: 'Browser check' });
    const html = '<!doctype html><button id="go">Go</button><script>zirbel.register("go", { name: "Go button" })</script>';
    const built = await (await post('/api/projects/import-game', { title: 'Built check',
      files: { 'index.html': Buffer.from(html).toString('base64') } })).json() as { id: string };

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

    // The lobby, from the game menu: no address for other devices until the host shares on the network, then its QR
    // code and address, and a link that opens it.
    const lobby = async () => {
      await page.locator('#game-switcher').click();
      await page.getByRole('menu', { name: 'Games' }).getByRole('menuitem', { name: 'Lobby…' }).click();
      return page.getByRole('dialog', { name: 'Lobby' });
    };
    await (await lobby()).getByText(/^The lobby is on your local network once this host shares on it/).waitFor();
    await page.keyboard.press('Escape');
    const release = await (await post('/api/projects/' + built.id + '/release', { branch: 'main', permissions: rights })).json() as
      { releaseId: string };
    assert.equal((await post('/api/rooms', { releaseId: release.releaseId, lan: true })).status, 201);
    const shared = await lobby();
    const qr = shared.getByRole('img', { name: 'QR code that opens the lobby' });
    await qr.waitFor();
    assert.match(await qr.getAttribute('src') ?? '', /^data:image\/svg\+xml,/);
    const address = await shared.locator('.lobby-address').textContent() ?? '';
    assert.match(address, /^http:\/\/games\.lan:\d+\/$/);
    const opens = shared.getByRole('link', { name: 'Open the lobby' });
    assert.deepEqual([await opens.getAttribute('href'), await opens.getAttribute('target')], [address, '_blank']);
    assert.deepEqual(await accessibility(page), []);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await page.getByRole('dialog', { name: 'Assets' }).getByText('No imported assets yet.').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForLoadState('networkidle');
    assert.deepEqual(failures, []);
  });
}
