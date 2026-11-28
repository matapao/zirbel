// Screens and their controllers end to end over each host's /pads (Node and, when built, Go): a phone plays a laptop's
// game, and the laptop shows it on the TV, a game with its own netcode among them. Run with `pnpm test:browser`.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { importGameFolder } from '../packages/core/game-files.ts';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { lanAddresses } from '../packages/server/http.ts';
import { hostsUnderTest, launch, REAL_SPACES, rights, tempDir } from './helpers.ts';
import { encoded, gameFrame, logged, startHost, until } from './pads-browser-fixture.ts';

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

// Show on TV of a game with its own netcode: the TV takes the laptop's member of the game's space, its number and all,
// by the hand-over the laptop's page asks the kernel for; the laptop becomes its controller.
const netGame = `<!doctype html><p id="out">waiting</p><script type="module">
  const zn = await import('/.skalet/net.js');
  const net = zn.connect({ via: 'parent' });
  net.on('open', ({ id }) => { document.getElementById('out').textContent = 'member ' + id; });
</script>`;
for (const host of hostsUnderTest()) test('over the ' + host.name + ' host, Show on TV hands a net game\'s member to the TV',
  { timeout: 90_000, skip: existsSync(REAL_SPACES) ? false : 'the spaces kernel is not built: run `pnpm run deps`' }, async (t) => {
  const address = lanAddresses()[0];
  if (!address) { t.skip('no LAN address to reach the listener from elsewhere than loopback'); return; }
  const root = tempDir(t, 'zirbel-pads-net-');
  const projects = new Projects(join(root, 'source'));
  const project = importGameFolder(projects, { title: 'Net', files: encoded({ 'index.html': netGame, 'zirbel.json': '{"players":{"max":2}}' }) });
  const release = new Releases(projects, 'dist/web').package(project.id, 'main', rights, false);
  writeFileSync(join(root, 'release.json'), JSON.stringify(release));
  const link = new URL(await launch(t, host.command, ['--host-only', '--lan', '--player-port', '0', '--data', join(root, 'data'),
    '--import', join(root, 'release.json'), '--release', release.manifest.releaseId],
  (line) => typeof line.link === 'string' ? line.link : undefined, { ZIRBEL_SPACES_BINARY: REAL_SPACES }).ready);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const failures: string[] = [];
  const enter = async (origin: string, name: string, member: string) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text()); });
    await page.goto(origin + link.pathname + link.hash);
    await page.locator('#join-form input[name="name"]').fill(name);
    await page.locator('#join-form button.primary').click();
    await page.frameLocator('iframe').locator('#out').filter({ hasText: member }).waitFor({ timeout: 15_000 });
    return page;
  };
  const laptop = await enter('http://' + address + ':' + link.port, 'Ada', 'member 1');
  // A player page from loopback is the box's own screen, standing in for the TV.
  const tv = await enter('http://127.0.0.1:' + link.port, 'TV', 'member 2');
  await laptop.getByRole('button', { name: 'Controllers' }).click();
  await laptop.locator('#controllers-panel').getByRole('button', { name: 'Show on TV' }).click();
  await laptop.getByRole('heading', { name: 'Your game is on the TV' }).waitFor();
  await tv.frameLocator('iframe').locator('#out').filter({ hasText: 'member 1' }).waitFor({ timeout: 15_000 });
  assert.match(tv.url(), /#skalet\.space=[0-9a-f]{12}$/);
  assert.deepEqual(failures, []);
});
