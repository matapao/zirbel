// Two real browsers join one room on each host (Node and, when built, Go) and see each other's shared state through
// the actual player page, game SDK, sandboxed frame and WebSocket: by an invitation, and by a session's code in the
// lobby. Run with `pnpm test:browser`, as are games with their own netcode (host-browser-net.ts), what a game loads and
// runs in its sandbox (host-browser-sandbox.ts) and the editor's page (host-browser-editor.ts).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { launch, rights, tempDir } from './helpers.ts';
import { accessibility, hosts } from './host-browser-fixture.ts';

const game = `<!doctype html><p id="out">waiting</p><script>
  zirbel.onRoom((room) => { document.getElementById('out').textContent = Object.keys(room.states).length + ' players'; });
  setInterval(() => zirbel.send({ at: Date.now() }), 30);
</script>`;

for (const host of hosts) {
  test(host.name + ' host: two browsers share state in one room', async (t) => {
    const root = tempDir(t, 'zirbel-host-browser-');
    const projects = new Projects(join(root, 'source'));
    const project = projects.createGame('Browsers', { html: game, maxPlayers: 2 });
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
// in one room. A phone that scans the QR code finds the code filled in. A lobby opened with ?net= (a simulated network,
// for testing) carries it on the player links it goes to.
for (const host of hosts) {
  test(host.name + ' host: one browser starts a session in the lobby and another joins it with its code', async (t) => {
    const root = tempDir(t, 'zirbel-host-lobby-');
    const projects = new Projects(join(root, 'source'));
    const release = new Releases(projects, 'dist/web').package(
      projects.createGame('Lobby game', { html: game, maxPlayers: 2 }).id,
      'main',
      rights,
      false,
    );
    const file = join(root, 'release.json');
    writeFileSync(file, JSON.stringify(release));
    mkdirSync(join(root, 'data'));
    writeFileSync(
      join(root, 'data', 'lobby.json'),
      JSON.stringify({ version: 1, offered: [release.manifest.releaseId] }),
    );
    const player = await launch(
      t,
      host.command,
      ['--host-only', '--player-port', '0', '--data', join(root, 'data'), '--import', file],
      (line) => (typeof line.player === 'string' ? line.player : undefined),
    ).ready;

    const browser = await chromium.launch();
    t.after(() => browser.close());
    const [first, second] = (await Promise.all(
      [1, 2].map(async () =>
        (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage(),
      ),
    )) as [Page, Page];
    const failures: string[] = [];
    for (const page of [first, second]) {
      page.on('pageerror', (error) => failures.push(error.message));
      page.on('console', (message) => {
        if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text());
      });
    }
    await first.goto(player + '/?net=stats');
    await first.getByLabel('Your name').fill('Ada');
    await first.getByRole('button', { name: 'Start session of Lobby game' }).click();
    await first.getByRole('heading', { name: 'Your session is ready' }).waitFor();
    const code = (await first.locator('#code').textContent()) ?? '';
    assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    // Its QR code, drawn in the page, and the link under it: the lobby with the session's code.
    const qr = first.getByRole('img', { name: 'QR code that joins this session' });
    await qr.waitFor();
    assert.match((await qr.getAttribute('src')) ?? '', /^data:image\/svg\+xml,/);
    assert.ok((await qr.boundingBox())!.width >= 200);
    const invitation = (await first.locator('#session-link').getAttribute('href')) ?? '';
    assert.deepEqual(
      [invitation, await first.locator('#session-link').textContent()],
      [player + '/?code=' + code, invitation],
    );
    assert.deepEqual(await accessibility(first), []);
    assert.match(
      (await first.getByRole('link', { name: 'Go in' }).getAttribute('href')) ?? '',
      /\/join\/[^?#]+\?net=stats#seat=/,
    );
    await first.getByRole('link', { name: 'Go in' }).click();

    // A phone that scans it opens the lobby with the code filled in, at the name; and invites others to the lobby.
    const scanned = await (
      await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
    ).newPage();
    scanned.on('pageerror', (error) => failures.push(error.message));
    scanned.on('console', (message) => {
      if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text());
    });
    await scanned.goto(invitation);
    assert.equal(await scanned.getByLabel('Session code').inputValue(), code);
    assert.equal(await scanned.evaluate(() => document.activeElement?.id), 'name');
    const invite = scanned.getByRole('button', { name: 'Invite others' });
    await invite.click();
    await scanned.getByRole('img', { name: 'QR code that opens this lobby' }).waitFor();
    assert.deepEqual(
      [await invite.getAttribute('aria-expanded'), await scanned.locator('#lobby-link').textContent()],
      ['true', player + '/'],
    );
    assert.deepEqual(await accessibility(scanned), []);
    await invite.click();
    assert.equal(await scanned.locator('#invite').isHidden(), true);

    await second.goto(player + '/?net=lag:20');
    await second.locator('#sessions li').filter({ hasText: 'Lobby game' }).waitFor();
    assert.equal(
      await second
        .locator('main')
        .textContent()
        .then((text) => text?.includes(code)),
      false,
    );
    assert.deepEqual(await accessibility(second), []);
    await second.getByLabel('Your name').fill('Bo');
    await second.getByLabel('Session code').fill(code.toLowerCase().slice(0, 2) + '-' + code.toLowerCase().slice(2));
    await second.getByRole('button', { name: 'Join', exact: true }).click();
    for (const page of [first, second])
      await page.frameLocator('iframe').locator('#out').filter({ hasText: '2 players' }).waitFor({ timeout: 15_000 });
    assert.equal(await second.locator('#badge').textContent(), 'Code ' + code);
    assert.match(second.url(), /\/join\/[^?#]+\?net=lag%3A20#/);
    assert.deepEqual(failures, []);
  });
}
