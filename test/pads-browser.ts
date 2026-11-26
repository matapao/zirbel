// Screens and their controllers in a real browser, over the Node host: the player page as a screen (its Controllers
// panel, the game's frame given every controller as a gamepad at its place, a keyboard-only game its places' keys, Show on
// TV), and the pad page as a phone: first against a fake of the pads socket in the browser (Playwright's
// routeWebSocket), which says exactly what the pages send, then end to end over the Node host. Run with
// `pnpm test:browser`.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Frame, type Page, type WebSocketRoute } from 'playwright';
import { importGameFolder } from '../packages/core/game-files.ts';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { decodePad, encodePad } from '../packages/sdk/pads.ts';
import { lanAddresses } from '../packages/server/http.ts';
import { hostsUnderTest, launch, rights, tempDir } from './helpers.ts';

const node = [process.execPath, 'dist/server.mjs'];
const game = `<!doctype html><pre id="log"></pre><p id="pads"></p><script>
  const log = (line) => { document.getElementById('log').textContent += line + '\\n'; };
  addEventListener('gamepadconnected', (event) => log('connected ' + event.gamepad.index + ' ' + event.gamepad.id));
  addEventListener('gamepaddisconnected', (event) => log('disconnected ' + event.gamepad.index));
  addEventListener('keydown', (event) => log('keydown ' + event.code + ' ' + JSON.stringify(event.key) + ' ' + event.keyCode));
  addEventListener('keyup', (event) => log('keyup ' + event.code));
  globalThis.rumble = (index) => navigator.getGamepads()[index].vibrationActuator.playEffect('dual-rumble',
    { duration: 200, strongMagnitude: 1, weakMagnitude: 0.5 });
  setInterval(() => { document.getElementById('pads').textContent = navigator.getGamepads()
    .map((pad) => pad ? pad.index + ':' + pad.buttons.filter((button) => button.pressed).length : '-').join(' '); }, 30);
  try { zirbel.register('tree', { at: [1, 2] }); log('registered'); } catch (error) { log('register failed: ' + error.message); }
</script>`;
const encoded = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text).toString('base64')]));

async function startHost(t: TestContext, more: string[] = [], command = node) {
  const root = tempDir(t, 'zirbel-pads-browser-');
  const projects = new Projects(join(root, 'source'));
  const project = importGameFolder(projects, { title: 'Pads', files: encoded({ 'index.html': game, 'zirbel.json': JSON.stringify({
    players: { max: 2 }, controls: { players: [{ keys: { a: 'KeyF' }, name: 'Red car', color: '#d03030' }, { keys: { a: 'Space', up: 'ArrowUp' } }] },
  }) }) });
  const release = new Releases(projects, 'dist/web').package(project.id, 'main', rights, false);
  const file = join(root, 'release.json');
  writeFileSync(file, JSON.stringify(release));
  return launch(t, command, ['--host-only', ...more, '--player-port', '0', '--data', join(root, 'data'), '--import', file, '--release',
    release.manifest.releaseId], (line) => typeof line.link === 'string' ? line.link : undefined).ready;
}

/** A pads socket in the page: what each connection sent, as JSON or decoded pad state, and the route to answer it. */
async function fakePads(page: Page, role: 'screen' | 'pad', open: (socket: WebSocketRoute, url: URL) => void) {
  const sent: unknown[] = [];
  const urls: URL[] = [];
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket((url) => url.pathname === '/pads' && url.searchParams.get('role') === role, (route) => {
    socket = route;
    urls.push(new URL(route.url()));
    route.onMessage((message) => sent.push(typeof message === 'string' ? JSON.parse(message) : decodePad(new Uint8Array(message))));
    open(route, new URL(route.url()));
  });
  return { sent, urls, get socket() { return socket!; } };
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  const end = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() > end) throw new Error('Waited in vain for ' + what);
    await new Promise((done) => setTimeout(done, 25));
  }
}
const gameFrame = (page: Page) => page.frames().find((frame) => frame.url().includes('/game/'))!;
const logged = async (frame: Frame) => (await frame.locator('#log').textContent()) ?? '';
const standard = (pressed: number[], axes = [0, 0, 0, 0]) => ({ standard: true, axes,
  buttons: Array.from({ length: 17 }, (_, button) => ({ pressed: pressed.includes(button), value: pressed.includes(button) ? 1 : 0 })) });
type Sent = { buttons?: { pressed: boolean }[]; axes?: number[] };
/** The buttons a sent pad state holds down. */
const held = (state: unknown) => ((state as Sent).buttons ?? []).flatMap(({ pressed }, button) => (pressed ? [button] : []));

// A device's own gamepad, as both the page and the game's frame read it from the browser.
const ownGamepad = () => {
  const pad = { id: 'Test pad', index: 0, mapping: 'standard', connected: true, timestamp: 1, axes: [0, 0, 0, 0], vibrationActuator: null,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  Object.assign(globalThis, { testPad: pad, testPads: [] as unknown[] });
  Object.defineProperty(navigator, 'getGamepads', { value: () => (globalThis as unknown as { testPads: unknown[] }).testPads, configurable: true });
  // Chromium 94 and some TV browsers have no structuredClone: the game's frame registers objects without it.
  if (location.pathname.startsWith('/game/')) delete (globalThis as { structuredClone?: unknown }).structuredClone;
};
/** Plugs the device's gamepad in, A down or up (announced to the page, which places it), or unplugs it. */
const pressOwn = ({ down, announce }: { down?: boolean; announce: boolean }) => {
  const { testPad, testPads } = globalThis as unknown as { testPad: { buttons: object[] }; testPads: unknown[] };
  testPad.buttons[0] = { pressed: Boolean(down), touched: Boolean(down), value: down ? 1 : 0 };
  testPads.splice(0, 1, ...down === undefined ? [] : [testPad]);
  if (announce) dispatchEvent(new Event('gamepadconnected'));
};

test('the player page is a screen: its controllers at their places in the game, its panel, and Show on TV', { timeout: 90_000 }, async (t) => {
  const link = await startHost(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (/Content Security Policy|Refused to|permissions policy/i.test(message.text())) failures.push(message.text()); });
  await page.addInitScript(ownGamepad);
  const screen = await fakePads(page, 'screen', (socket) => {
    socket.send(JSON.stringify({ type: 'screen', id: 'one', code: 'K7QX', resume: 'r-one', box: false, tv: true }));
    socket.send(JSON.stringify({ type: 'pads', pads: [{ slot: 1, place: 1, kind: 'phone', name: 'Phone', connected: true, label: null }] }));
  });
  const tv = await fakePads(page, 'pad', (socket) =>
    socket.send(JSON.stringify({ type: 'pad', slot: 2, place: 2, screen: 'tv', resume: 'r-tv', label: { name: 'Blue car', color: '#3050d0' } })));
  await page.goto(link);
  await page.locator('#join-form input[name="name"]').fill('Ada');
  await page.locator('#join-form button.primary').click();
  await until(() => Boolean(gameFrame(page)) && screen.sent.length > 0, 'the screen and the game');
  const frame = gameFrame(page);
  assert.equal(await page.locator('iframe.authored-game').getAttribute('allow'), 'gamepad');
  await until(async () => (await logged(frame)).includes('registered'), 'the game to register an object');

  // The place's names and colours from zirbel.json reach the host; the phone at P2 is the game's gamepad 1 once it sends.
  await until(() => screen.sent.some((message) => (message as { type?: string }).type === 'labels'), 'labels');
  assert.deepEqual(screen.sent.find((message) => (message as { type?: string }).type === 'labels'),
    { type: 'labels', labels: [{ place: 0, name: 'Red car', color: '#d03030' }] });
  screen.socket.send(Buffer.from(encodePad({ slot: 1, ...standard([0]) })));
  await until(async () => (await logged(frame)).includes('connected 1 Zirbel phone 2 (STANDARD GAMEPAD)'), 'the phone as a gamepad');
  await until(async () => (await logged(frame)).includes('keydown Space " " 32'), 'P2\'s key');
  screen.socket.send(Buffer.from(encodePad({ slot: 1, ...standard([12]) })));
  await until(async () => /keyup Space\nkeydown ArrowUp "ArrowUp" 38/.test(await logged(frame)), 'the d-pad\'s key');
  await until(async () => await frame.locator('#pads').textContent() === '- 1:1 - -', 'the phone pressing one button');
  // The game rumbles the phone, through the page.
  await frame.evaluate(() => (globalThis as unknown as { rumble(index: number): Promise<unknown> }).rumble(1));
  await until(() => screen.sent.some((message) => (message as { type?: string }).type === 'rumble'), 'a rumble');
  assert.deepEqual(screen.sent.find((message) => (message as { type?: string }).type === 'rumble'),
    { type: 'rumble', slot: 1, duration: 200, strong: 1, weak: 0.5 });

  // The device's own gamepad takes the first free place when first pressed, P1, and presses P1's keys.
  await frame.evaluate(pressOwn, { down: true, announce: false });
  await page.evaluate(pressOwn, { down: true, announce: true });
  await until(async () => (await logged(frame)).includes('connected 0 Test pad'), 'the device\'s gamepad at P1');
  await until(async () => (await logged(frame)).includes('keydown KeyF "f" 70'), 'P1\'s key');
  assert.deepEqual(screen.sent.findLast((message) => (message as { type?: string }).type === 'local'), { type: 'local', places: [0] });

  // The panel: the code and its QR codes, each place with its controller and what it drives.
  await page.getByRole('button', { name: 'Controllers' }).click();
  const panel = page.locator('#controllers-panel');
  await panel.getByRole('heading', { name: 'Controllers' }).waitFor();
  assert.equal(await panel.locator('.pad-code').textContent(), 'K7QX');
  await panel.getByRole('img', { name: 'QR code that makes a phone a controller at the next free place' }).waitFor();
  assert.equal(await panel.getByRole('img', { name: /^QR code that makes a phone P\d$/ }).count(), 6);
  const rows = await panel.locator('.places li').allTextContents();
  assert.match(rows[0]!, /^P1Gamepad on this device: Test pad · Red car/);
  assert.match(rows[1]!, /^P2Phone: Phone/);
  assert.match(rows[2]!, /^P3EmptyPress A to take P3/);
  const accessibility = await new AxeBuilder({ page }).exclude('iframe').analyze();
  assert.deepEqual(accessibility.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical').map(({ id }) => id), []);
  // Press A to take P3, a swap, letting go, and a gamepad on the box.
  await panel.getByRole('button', { name: 'Press A to take P3' }).click();
  await panel.getByText('Press A on the controller that takes P3').waitFor();
  await panel.getByLabel('Swap P2 with').selectOption('P4');
  await panel.getByRole('button', { name: 'Let go of P2’s controller' }).click();
  await panel.getByRole('button', { name: 'Use a controller on the box' }).click();
  const asked = screen.sent.filter((message) => ['claim', 'move', 'release'].includes((message as { type: string }).type));
  assert.deepEqual(asked, [{ type: 'claim', place: 2 }, { type: 'move', from: 1, to: 3 }, { type: 'release', slot: 1 }, { type: 'claim' }]);

  // Show on TV: the seat goes to the box's screen, and this page becomes the TV's controller, its keyboard a pad.
  await panel.getByRole('button', { name: 'Show on TV' }).click();
  await until(() => screen.sent.some((message) => (message as { type?: string }).type === 'show'), 'show');
  const shown = screen.sent.find((message) => (message as { type?: string }).type === 'show') as { link: string };
  assert.match(shown.link, /^\/join\/[a-f0-9]{12}#seat=[\w-]{32}$/);
  screen.socket.send(JSON.stringify({ type: 'shown', code: 'TVTV' }));
  await page.getByRole('heading', { name: 'Your game is on the TV' }).waitFor();
  await page.locator('#tv-pad-place').filter({ hasText: 'P3 · Blue car' }).waitFor();
  assert.equal(tv.urls[0]!.searchParams.get('code'), 'TVTV');
  assert.equal(await page.locator('iframe').count(), 0);
  await page.evaluate(pressOwn, { announce: false });
  await page.keyboard.down('Space');
  await page.keyboard.down('KeyD');
  await until(() => tv.sent.some((state) => held(state).join() === '0' && (state as Sent).axes?.[0] === 1), 'the keyboard as a pad');
  assert.deepEqual(failures, []);
});

test('the pad page is a phone\'s controller: its code, its place, its fingers, and its place again after a drop', { timeout: 60_000 }, async (t) => {
  const link = await startHost(t);
  const player = new URL(link).origin;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true })).newPage();
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text()); });
  let answer = (socket: WebSocketRoute, url: URL) => socket.send(JSON.stringify({ type: 'pad', slot: Number(url.searchParams.get('place') ?? 0),
    place: Number(url.searchParams.get('place') ?? 0), screen: 'one', resume: 'r-phone', label: { name: 'Red car', color: '#d03030' } }));
  const pad = await fakePads(page, 'pad', (socket, url) => answer(socket, url));

  // No code in the address: the page asks for it; a code the host doesn't know sends it back to ask again.
  await page.goto(player + '/pad?place=1');
  answer = (socket) => { void socket.close({ code: 4404 }); };
  await page.getByLabel('The code on the screen').fill('k7-qx');
  await page.getByRole('button', { name: 'Join' }).click();
  await page.getByText('No screen has the code K7QX.').waitFor();
  assert.equal(new URL(page.url()).pathname, '/pad');
  const accessibility = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(accessibility.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical').map(({ id }) => id), []);

  // A screen that knows it: the pad at the place its link offered, in that place's name and colour.
  answer = (socket, url) => socket.send(JSON.stringify({ type: 'pad', slot: Number(url.searchParams.get('place') ?? 0),
    place: Number(url.searchParams.get('place') ?? 0), screen: 'one', resume: 'r-phone', label: { name: 'Red car', color: '#d03030' } }));
  assert.equal(await page.getByLabel('The code on the screen').inputValue(), '');
  await page.getByLabel('The code on the screen').fill('K7QX');
  await page.getByRole('button', { name: 'Join' }).click();
  const place = page.locator('#place');
  await place.filter({ hasText: 'P2 · Red car' }).waitFor();
  assert.equal(pad.urls.at(-1)!.searchParams.get('place'), '1');
  assert.equal(new URL(page.url()).pathname, '/pad/K7QX');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--place').trim()), '#d03030');
  await until(() => pad.sent.length > 0, 'the pad at rest');

  // Two fingers: A held while the stick goes right.
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  const a = await box('[data-button="0"]'), stick = await box('#stick');
  const client = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]) =>
    client.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const fingerA = { x: a.x + a.width / 2, y: a.y + a.height / 2, id: 1 };
  const centre = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2, id: 2 };
  await touch('touchStart', [fingerA]);
  await touch('touchStart', [fingerA, centre]);
  await touch('touchMove', [fingerA, { ...centre, x: centre.x + stick.width }]);
  await until(() => pad.sent.some((state) => held(state).join() === '0' && (state as Sent).axes?.[0] === 1),
    'A with the stick to the right');
  await touch('touchEnd', []);
  await until(() => {
    const last = pad.sent.at(-1);
    return held(last).length === 0 && (last as Sent).axes?.[0] === 0;
  }, 'the fingers lifted');

  // Another place: the host moves it, or says where it is.
  await place.click();
  await page.locator('#place-list').getByRole('button', { name: 'P4' }).click();
  await until(() => pad.sent.some((message) => (message as { type?: string }).type === 'place'), 'a move');
  assert.deepEqual(pad.sent.find((message) => (message as { type?: string }).type === 'place'), { type: 'place', place: 3 });
  pad.socket.send(JSON.stringify({ type: 'pad', slot: 3, place: 3, screen: 'one', resume: 'r-phone', label: null }));
  await place.filter({ hasText: /^P4$/ }).waitFor();

  // A dropped connection joins again with the same code, back at its place.
  await pad.socket.close({ code: 1011 });
  await until(() => pad.urls.length >= 3, 'joining again');
  assert.deepEqual([pad.urls.at(-1)!.searchParams.get('code'), pad.urls.at(-1)!.searchParams.get('resume')], ['K7QX', 'r-phone']);
  // A rumble vibrates the phone where it can; the screen letting it go sends it back to its code.
  await page.evaluate(() => { (globalThis as unknown as { buzz: unknown[] }).buzz = []; navigator.vibrate = (pattern) => { (globalThis as unknown as { buzz: unknown[] }).buzz.push(pattern); return true; }; });
  pad.socket.send(JSON.stringify({ type: 'rumble', duration: 300, strong: 1, weak: 0 }));
  await until(async () => (await page.evaluate(() => (globalThis as unknown as { buzz: unknown[] }).buzz)).length > 0, 'a vibration');
  await pad.socket.close({ code: 4000 });
  await page.getByText('The screen let this controller go.').waitFor();
  assert.equal(await page.getByLabel('The code on the screen').inputValue(), 'K7QX');
  assert.deepEqual(failures, []);
});

// The real thing over each host's /pads: a laptop on the LAN listener is a screen, a phone joins it with its code and
// plays its game, and the laptop shows the game on the box's own screen (any screen from loopback: here a second player
// page standing in for the TV) and becomes its controller.
for (const host of hostsUnderTest()) test('over the ' + host.name + ' host, a phone plays a laptop\'s game, and the laptop shows it on ' +
  'the TV and controls it there', { timeout: 120_000 }, async (t) => {
  const address = lanAddresses()[0];
  if (!address) { t.skip('no LAN address to reach the listener from elsewhere than loopback'); return; }
  const link = await startHost(t, ['--lan'], host.command);
  const port = new URL(link).port, path = new URL(link).pathname + new URL(link).hash;
  const lan = 'http://' + address + ':' + port, loopback = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const failures: string[] = [];
  const open = async (options = {}) => {
    const page = await (await browser.newContext(options)).newPage();
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text()); });
    return page;
  };
  const seat = async (page: Page, origin: string, name: string) => {
    await page.goto(origin + path);
    await page.locator('#join-form input[name="name"]').fill(name);
    await page.locator('#join-form button.primary').click();
    await until(async () => Boolean(gameFrame(page)) && (await logged(gameFrame(page))).includes('registered'), name + '’s game');
  };

  const laptop = await open({ viewport: { width: 1280, height: 860 } });
  await seat(laptop, lan, 'Ada');
  await laptop.getByRole('button', { name: 'Controllers' }).click();
  const panel = laptop.locator('#controllers-panel');
  const code = (await panel.locator('.pad-code').textContent({ timeout: 10_000 }))!;
  assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
  assert.equal(await panel.getByRole('button', { name: 'Show on TV' }).count(), 0);

  // The phone takes the first free place, P1, with the name and colour the game gives it, and its A is P1's key.
  const phone = await open({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  await phone.addInitScript(() => {
    const buzz: unknown[] = [];
    Object.assign(globalThis, { buzz });
    navigator.vibrate = (pattern) => { buzz.push(pattern); return true; };
  });
  await phone.goto(lan + '/pad/' + code.toLowerCase());
  await phone.locator('#place').filter({ hasText: 'P1 · Red car' }).waitFor();
  const a = (await phone.locator('[data-button="0"]').boundingBox())!;
  const touch = await phone.context().newCDPSession(phone);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x + a.width / 2, y: a.y + a.height / 2, id: 1 }] });
  const laptopGame = gameFrame(laptop);
  await until(async () => (await logged(laptopGame)).includes('connected 0 Zirbel phone 1 (STANDARD GAMEPAD)'), 'the phone as gamepad 0');
  await until(async () => (await logged(laptopGame)).includes('keydown KeyF "f" 70'), 'P1’s key from the phone');
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(async () => (await logged(laptopGame)).includes('keyup KeyF'), 'P1’s key let go');
  await panel.locator('.places li').first().filter({ hasText: 'Phone: Phone 1 · Red car' }).waitFor();
  // The game rumbles the phone.
  await laptopGame.evaluate(() => (globalThis as unknown as { rumble(index: number): Promise<unknown> }).rumble(0));
  await until(async () => (await phone.evaluate(() => (globalThis as unknown as { buzz: unknown[] }).buzz)).includes(200), 'the phone to vibrate');

  // A screen from loopback is the box's own: the laptop may show its game there. The TV takes the laptop's seat, and
  // the laptop is the TV's controller: its keyboard plays P1.
  const tv = await open({ viewport: { width: 1280, height: 720 } });
  await seat(tv, loopback, 'TV');
  await panel.getByRole('button', { name: 'Show on TV' }).click();
  await laptop.getByRole('heading', { name: 'Your game is on the TV' }).waitFor();
  await laptop.locator('#tv-pad-place').filter({ hasText: 'P1 · Red car' }).waitFor();
  await until(async () => tv.url().includes('#seat=') && Boolean(gameFrame(tv)) &&
    (await logged(gameFrame(tv)).catch(() => '')).includes('registered'), 'the TV in the laptop’s seat');
  await laptop.keyboard.down('Space');
  await until(async () => (await logged(gameFrame(tv))).includes('keydown KeyF "f" 70'), 'P1’s key from the laptop on the TV');
  await laptop.keyboard.up('Space');
  // The laptop's screen ended with its game, and its phone heard.
  await phone.getByText('The screen closed.').waitFor();
  assert.deepEqual(failures, []);
});
