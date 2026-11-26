// The TV page in the browser, on the Node editor's player listener and its pads socket: the lobby's games and sessions
// as tiles, moved around with a remote's keys and with a phone's pad frames, a session started and joined by its code,
// into the game's player page with the same screen and back, the places and their QR codes, a place given to the next
// A, two places swapped and one let go, Show on TV from another screen, and a browser that can't play games here. The
// phone is a pad socket from this test (Node's own WebSocket), sending frames as the pad page does.
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

/** The built editor on free ports, and its player listener, where the lobby, the TV page and the pads socket are. */
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

/** A pad frame of the standard layout, with these buttons down (the host writes its place). */
function frame(buttons = [], axes = [0, 0, 0, 0]) {
  const bytes = Buffer.alloc(8 + 17 + axes.length * 2);
  bytes.writeUInt8(1, 1);
  bytes.writeUInt8(17, 2);
  bytes.writeUInt8(axes.length, 3);
  bytes.writeUInt32LE(buttons.reduce((bits, button) => bits | (1 << button), 0) >>> 0, 4);
  for (const button of buttons) bytes.writeUInt8(255, 8 + button);
  axes.forEach((axis, index) => bytes.writeInt16LE(Math.round(axis * 32767), 8 + 17 + index * 2));
  return bytes;
}

const focused = (page) => page.evaluate(() => document.activeElement?.dataset?.key ?? null);
async function until(check, what) {
  for (let tries = 0; tries < 100; tries++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(what);
}

/** A phone on the screen with code, as the pad page joins: its place as the host gives it, and frames to send, the
 *  last again every two seconds while still, as a pad does. */
async function phone(t, player, code) {
  const socket = new WebSocket(player.replace('http', 'ws') + '/pads?role=pad&code=' + code);
  socket.binaryType = 'arraybuffer';
  const messages = [];
  socket.addEventListener('message', ({ data }) => { if (typeof data === 'string') messages.push(JSON.parse(data)); });
  await once(socket, 'open');
  let last = frame();
  const still = setInterval(() => socket.send(last), 2000);
  const closed = new Promise((resolve) => socket.addEventListener('close', ({ code: closing }) => { clearInterval(still); resolve(closing); }));
  t.after(() => { clearInterval(still); socket.close(); });
  const pad = {
    closed,
    /** The place the host gave it last. */
    place: () => messages.filter((message) => message.type === 'pad').at(-1)?.slot,
    send(buttons, axes) { last = frame(buttons, axes); socket.send(last); },
    /** Presses and lets go. */
    press(buttons) { pad.send(buttons); pad.send([]); },
  };
  await until(async () => pad.place() !== undefined, 'the phone takes a place');
  return pad;
}

/** Another page's screen, as a laptop's player page opens one. */
async function laptop(t, player) {
  const socket = new WebSocket(player.replace('http', 'ws') + '/pads?role=screen');
  socket.binaryType = 'arraybuffer';
  const messages = [];
  socket.addEventListener('message', ({ data }) => { if (typeof data === 'string') messages.push(JSON.parse(data)); });
  t.after(() => socket.close());
  await once(socket, 'open');
  await until(async () => messages.some((message) => message.type === 'screen'), 'the laptop’s screen opens');
  return { messages, send: (message) => socket.send(JSON.stringify(message)) };
}

test('the TV page is a screen with places, moved around by keys and controllers, into a game and back', { timeout: 90_000 }, async (t) => {
  const { editor, player } = await startEditor(t);
  const garden = await offer(editor, 'Garden', 4);
  await offer(editor, 'Walk');
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(player + '/tv');

  // The lobby's games and sessions as tiles, the first in focus.
  await page.getByRole('button', { name: 'Start a session: Garden' }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Play: Walk' }).isVisible());
  assert.ok(await page.getByRole('button', { name: 'Enter a code: Join with a code' }).isVisible());
  assert.ok(await page.locator('#cannot').isHidden(), 'this browser plays the games');
  await until(async () => await focused(page) === 'game:' + garden, 'the first game in focus');

  // A screen: the next free place's QR code with the screen's code, and each place free with its own.
  await page.getByRole('img', { name: 'QR code that adds a phone at the next free place' }).waitFor();
  const code = await page.locator('.join .code').textContent();
  assert.match(code, CODE);
  assert.equal(await page.getByRole('img', { name: /^QR code that adds a phone at P\d$/ }).count(), 8);
  // A phone joins by the code and takes P1.
  const pad = await phone(t, player, code);
  assert.equal(pad.place(), 0);
  await page.getByRole('button', { name: 'P1: Phone' }).waitFor();
  assert.equal(await page.getByRole('img', { name: /^QR code that adds a phone at P\d$/ }).count(), 7);

  // A remote's arrows, then the phone's d-pad and stick: right to Walk, down to the sessions, back up and left.
  await page.keyboard.press('ArrowRight');
  assert.equal(await focused(page), await page.getByRole('button', { name: 'Play: Walk' }).getAttribute('data-key'));
  await page.keyboard.press('ArrowDown');
  assert.equal(await focused(page), 'join');
  pad.press([12]);
  await until(async () => (await focused(page))?.startsWith('game:'), 'the phone’s d-pad moves up');
  pad.send([], [-0.9, 0, 0, 0]);
  pad.send([]);
  await until(async () => await focused(page) === 'game:' + garden, 'the phone’s stick moves left');

  // A on the phone starts a session of Garden: its code for the others, and Go in.
  pad.press([0]);
  await page.getByRole('heading', { name: 'Your session is ready' }).waitFor();
  const session = await page.locator('#session-code').textContent();
  assert.match(session, CODE);
  assert.ok(await page.getByRole('img', { name: 'QR code that joins this session' }).isVisible());
  assert.equal(await focused(page), 'go-in');
  // B goes back to the lobby, where the session is playing now.
  pad.press([1]);
  await page.getByRole('button', { name: 'Join: Garden' }).waitFor();

  // Its code, typed: on the remote's letters, then the rest on a keyboard; the fourth letter joins.
  await page.getByRole('button', { name: 'Join: Garden' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Join Garden' }).waitFor();
  assert.equal(await focused(page), 'letter:2');
  await page.locator('[data-key="letter:' + session[0] + '"]').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('x');
  await page.keyboard.press('Backspace');
  for (const letter of session.slice(1).toLowerCase()) await page.keyboard.press(letter);
  await page.waitForURL(/\/join\/[a-f0-9]{12}\?screen=tv#seat=[\w-]{32}$/);
  // Leaving the game comes back to the TV page: the same screen, its code and its phone.
  await page.getByRole('button', { name: 'Leave' }).click();
  await page.waitForURL(player + '/tv');
  await page.getByRole('button', { name: 'P1: Phone' }).waitFor();
  assert.equal(await page.locator('.join .code').textContent(), code);

  // A place for the next controller's A: P2 waits, and A on the phone takes it there rather than choosing here.
  await page.getByRole('button', { name: 'P2: Free' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Press A to take P2' }).waitFor();
  assert.equal(await focused(page), 'menu:0');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /^P2: Press A · (30|29) s$/ }).waitFor();
  pad.press([0]);
  await page.getByRole('button', { name: 'P2: Phone' }).waitFor();
  await until(async () => pad.place() === 1, 'the phone hears its new place');
  assert.ok(await page.locator('.menu').isHidden(), 'A took the place and chose nothing here');

  // Two places swap, P2 with P4; then P4's phone is let go.
  await page.getByRole('button', { name: 'P2: Phone' }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await focused(page), 'menu:0');
  assert.equal(await page.getByRole('button', { name: 'Swap P2 with…' }).getAttribute('data-key'), 'menu:0');
  await page.keyboard.press('Enter');
  assert.ok(await page.getByText('Choose the place to swap P2 with.').isVisible());
  await page.getByRole('button', { name: 'P4: Free' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'P4: Phone' }).waitFor();
  await until(async () => pad.place() === 3, 'the phone hears it is at P4');
  await page.getByRole('button', { name: 'P4: Phone' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Let P4 go' }).waitFor();
  await page.keyboard.press('ArrowDown');
  assert.equal(await focused(page), await page.getByRole('button', { name: 'Let P4 go' }).getAttribute('data-key'));
  await page.keyboard.press('Enter');
  assert.equal(await pad.closed, 4000);
  await page.getByRole('button', { name: 'P4: Free' }).waitFor();
  // Back from the places goes to the lobby's tiles.
  await page.keyboard.press('Escape');
  assert.ok(!(await focused(page))?.startsWith('place:'));

  // Show on TV from a laptop's screen: the TV page, the box's own screen here (loopback), goes to its game, and the
  // laptop hears the TV's code.
  const other = await laptop(t, player);
  assert.equal(other.messages[0].tv, true);
  const started = await fetch(player + '/lobby/sessions', { method: 'POST', headers: { 'content-type': 'application/json', origin: player },
    body: JSON.stringify({ release: garden, name: 'Laptop' }) });
  const { link } = await started.json();
  other.send({ type: 'show', link: new URL(link).pathname + new URL(link).hash });
  await page.waitForURL(/\/join\/[a-f0-9]{12}\?screen=tv#seat=/);
  await until(async () => other.messages.some((message) => message.type === 'shown' && message.code === code), 'the laptop hears the TV’s code');
  assert.deepEqual(errors, []);
});

test('a TV browser that can’t play games here shows the lobby and sends its games to a phone', { timeout: 60_000 }, async (t) => {
  const { editor, player } = await startEditor(t);
  await offer(editor, 'Walk');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
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
