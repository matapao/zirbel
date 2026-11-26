// The TV page in the browser, on the Node editor's player listener: the lobby's games and sessions as tiles, moved
// around with a remote's keys and with a controller's pad frames, a session started and joined by its code, into the
// game's player page with the same screen and back, the places and their QR codes, a place given to the next A, two
// places swapped and one let go, Show on TV from another page, and a browser that can't play games here. The pads
// socket is the host's (/pads); this test answers it as the host does, from the screen messages it sends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { chromium } from 'playwright';

const CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;

/** The built editor on free ports, and its player listener, where the lobby and the TV page are. */
async function startEditor(t) {
  const root = await mkdtemp(join(tmpdir(), 'zirbel-browser-tv-'));
  const host = spawn(process.execPath, ['dist/server.mjs', '--data', join(root, 'data'), '--port', '0', '--player-port', '0'],
    { env: { ...process.env, ZIRBEL_ACCOUNT_DIR: join(root, 'account') }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(async () => {
    if (host.exitCode === null) { host.kill(); await once(host, 'exit'); }
    await rm(root, { recursive: true, force: true });
  });
  const first = await createInterface({ input: host.stdout })[Symbol.asyncIterator]().next();
  return JSON.parse(first.value);
}

/** A built game folder, published and offered in the lobby; players.max over 1 makes it a multiplayer game. */
async function offer(editor, title, players = 1) {
  const send = async (path, body) => {
    const response = await fetch(editor + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: editor },
      body: JSON.stringify(body) });
    assert.ok(response.ok, path + ': ' + response.status);
    return response.json();
  };
  const files = { 'index.html': Buffer.from(`<!doctype html><title>${title}</title><p id="word">${title}</p>`).toString('base64'),
    ...(players > 1 ? { 'zirbel.json': Buffer.from(JSON.stringify({ players: { max: players } })).toString('base64') } : {}) };
  const { id } = await send('projects/import-game', { title, files });
  const { releaseId } = await send('projects/' + id + '/release', { permissions: { play: true, download: false, remix: false } });
  await send('lobby/offer', { release: releaseId, offered: true });
  return releaseId;
}

/** A pad frame as the host sends a screen: a standard gamepad at a place, with these buttons down. */
function frame(place, buttons = [], axes = [0, 0, 0, 0]) {
  const bytes = Buffer.alloc(8 + 17 + axes.length * 2);
  bytes.writeUInt8(place, 0);
  bytes.writeUInt8(1, 1);
  bytes.writeUInt8(17, 2);
  bytes.writeUInt8(axes.length, 3);
  bytes.writeUInt32LE(buttons.reduce((bits, button) => bits | (1 << button), 0) >>> 0, 4);
  for (const button of buttons) bytes.writeUInt8(255, 8 + button);
  axes.forEach((axis, index) => bytes.writeInt16LE(Math.round(axis * 32767), 8 + 17 + index * 2));
  return bytes;
}

const phone = (place, name = 'Phone', label = null) => ({ slot: place, place, kind: 'phone', name, connected: true, label });

/** The host's side of the pads socket for every page of a context: each screen opened, the messages it sent, and a
 *  way to answer it. */
async function fakePads(context) {
  const screens = [];
  await context.routeWebSocket(/\/pads\?/, (socket) => {
    const url = new URL(socket.url());
    const screen = { url, sent: [], socket, send: (message) => socket.send(typeof message === 'string' ? message : JSON.stringify(message)) };
    socket.onMessage((message) => screen.sent.push(JSON.parse(String(message))));
    screens.push(screen);
    screen.send({ type: 'screen', id: 'screen-1', code: 'KM4P', resume: 'resume-1', box: false, tv: false });
  });
  return screens;
}

const focused = (page) => page.evaluate(() => document.activeElement?.dataset?.key ?? null);
async function until(check, what) {
  for (let tries = 0; tries < 100; tries++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(what);
}

test('the TV page is a screen with places, moved around by keys and controllers, into a game and back', { timeout: 90_000 }, async (t) => {
  const { editor, player } = await startEditor(t);
  const garden = await offer(editor, 'Garden', 4);
  await offer(editor, 'Walk');
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const screens = await fakePads(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(player + '/tv');

  // The lobby's games and sessions as tiles, the first in focus; the screen opened with no resume yet.
  await page.getByRole('button', { name: 'Start a session: Garden' }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Play: Walk' }).isVisible());
  assert.ok(await page.getByRole('button', { name: 'Enter a code: Join with a code' }).isVisible());
  assert.ok(await page.locator('#cannot').isHidden(), 'this browser plays the games');
  await until(async () => await focused(page) === 'game:' + garden, 'the first game in focus');
  assert.equal(screens[0].url.searchParams.get('role'), 'screen');
  assert.equal(screens[0].url.searchParams.get('resume'), null);

  // The places: the next free one's QR code and the screen's code, and each place free with its own.
  await page.getByRole('img', { name: 'QR code that adds a phone at the next free place' }).waitFor();
  assert.equal(await page.locator('.join .code').textContent(), 'KM4P');
  assert.equal(await page.getByRole('img', { name: /^QR code that adds a phone at P\d$/ }).count(), 8);
  screens[0].send({ type: 'pads', pads: [phone(0, 'Phone', { name: 'Red car', color: '#d03030' })] });
  await page.getByRole('button', { name: 'P1: Red car · Phone' }).waitFor();
  assert.equal(await page.getByRole('img', { name: /^QR code that adds a phone at P\d$/ }).count(), 7);
  assert.equal(await page.getByRole('button', { name: 'P1: Red car · Phone' }).evaluate((node) => node.style.getPropertyValue('--place')), '#d03030');

  // A remote's arrows, then the phone's d-pad and stick: right to Walk, down to the sessions, back up and left.
  await page.keyboard.press('ArrowRight');
  assert.equal(await focused(page), await page.getByRole('button', { name: 'Play: Walk' }).getAttribute('data-key'));
  await page.keyboard.press('ArrowDown');
  assert.equal(await focused(page), 'join');
  screens[0].socket.send(frame(0, [12]));
  screens[0].socket.send(frame(0, []));
  await until(async () => (await focused(page))?.startsWith('game:'), 'the phone’s d-pad moves up');
  screens[0].socket.send(frame(0, [], [-0.9, 0, 0, 0]));
  screens[0].socket.send(frame(0, []));
  await until(async () => await focused(page) === 'game:' + garden, 'the phone’s stick moves left');

  // A on the phone starts a session of Garden: its code for the others, and Go in.
  screens[0].socket.send(frame(0, [0]));
  screens[0].socket.send(frame(0, []));
  await page.getByRole('heading', { name: 'Your session is ready' }).waitFor();
  const code = await page.locator('#session-code').textContent();
  assert.match(code, CODE);
  assert.ok(await page.getByRole('img', { name: 'QR code that joins this session' }).isVisible());
  assert.equal(await focused(page), 'go-in');
  // B goes back to the lobby, where the session is playing now.
  screens[0].socket.send(frame(0, [1]));
  screens[0].socket.send(frame(0, []));
  await page.getByRole('button', { name: 'Join: Garden' }).waitFor();

  // Its code, typed: on the remote's letters, then the rest on a keyboard; the fourth letter joins.
  await page.getByRole('button', { name: 'Join: Garden' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Join Garden' }).waitFor();
  assert.equal(await focused(page), 'letter:2');
  await page.locator('[data-key="letter:' + code[0] + '"]').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('x');
  await page.keyboard.press('Backspace');
  for (const letter of code.slice(1).toLowerCase()) await page.keyboard.press(letter);
  await page.waitForURL(/\/join\/[a-f0-9]{12}\?screen=tv#seat=[\w-]{32}$/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('zirbel-screen')), 'resume-1');
  // Leaving the game comes back to the TV page, the screen resumed.
  await page.getByRole('button', { name: 'Leave' }).click();
  await page.waitForURL(player + '/tv');
  await until(() => screens.length === 2, 'the TV page opens its screen again');
  assert.equal(screens[1].url.searchParams.get('resume'), 'resume-1');

  // A place for the next controller's A: P2 waits, and A on the phone takes it there rather than choosing here.
  const tv = screens[1];
  tv.send({ type: 'pads', pads: [phone(0)] });
  await page.getByRole('button', { name: 'P2: Free' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Press A to take P2' }).waitFor();
  assert.equal(await focused(page), 'menu:0');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /^P2: Press A · (30|29) s$/ }).waitFor();
  assert.deepEqual(tv.sent.at(-1), { type: 'claim', place: 1 });
  tv.socket.send(frame(0, [0]));
  tv.socket.send(frame(0, []));
  tv.send({ type: 'pads', pads: [phone(1, 'Phone')] });
  await page.getByRole('button', { name: 'P2: Phone' }).waitFor();
  assert.ok(await page.locator('.menu').isHidden(), 'A took the place and chose nothing here');

  // Two places swap, P2 with P4; then P4's phone is let go.
  await page.getByRole('button', { name: 'P2: Phone' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Swap P2 with…' }).click();
  assert.ok(await page.getByText('Choose the place to swap P2 with.').isVisible());
  await page.getByRole('button', { name: 'P4: Free' }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(tv.sent.at(-1), { type: 'move', from: 1, to: 3 });
  tv.send({ type: 'pads', pads: [phone(3)] });
  await page.getByRole('button', { name: 'P4: Phone' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Let P4 go' }).click();
  assert.deepEqual(tv.sent.at(-1), { type: 'release', slot: 3 });
  // Back from the places goes to the lobby's tiles.
  await page.keyboard.press('Escape');
  assert.ok(!(await focused(page))?.startsWith('place:'));

  // Show on TV, from another page: a link of this listener's comes here; any other is refused.
  tv.send({ type: 'open', link: 'http://elsewhere.example/join/abc#seat=x' });
  await page.getByText('The lobby answered with an unexpected link.').waitFor();
  const started = await fetch(player + '/lobby/sessions', { method: 'POST', headers: { 'content-type': 'application/json', origin: player },
    body: JSON.stringify({ release: garden, name: 'Laptop' }) });
  const { link } = await started.json();
  tv.send({ type: 'open', link: new URL(link).pathname + new URL(link).hash });
  await page.waitForURL(/\/join\/[a-f0-9]{12}\?screen=tv#seat=/);
  assert.deepEqual(errors, []);
});

test('a TV browser that can’t play games here shows the lobby and sends its games to a phone', { timeout: 60_000 }, async (t) => {
  const { editor, player } = await startEditor(t);
  await offer(editor, 'Walk');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await fakePads(context);
  // As a browser without import maps.
  await context.addInitScript(() => { delete HTMLScriptElement.supports; });
  const page = await context.newPage();
  await page.goto(player + '/tv');
  await page.getByRole('button', { name: 'Play on a phone: Walk' }).waitFor();
  assert.ok(await page.locator('#cannot').isVisible());
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Play Walk on a phone or a laptop' }).waitFor();
  assert.ok(await page.getByRole('img', { name: 'QR code that opens the lobby' }).isVisible());
  await page.keyboard.press('Backspace');
  await page.getByRole('heading', { name: 'Games' }).waitFor();
});
