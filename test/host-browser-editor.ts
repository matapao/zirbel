// The editor's own page on each host (Node and, when built, Go), in a real browser. Run with `pnpm test:browser`.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { launch, rights, tempDir } from './helpers.ts';
import { accessibility, hosts } from './host-browser-fixture.ts';

// The editor UI itself, served by each host: it loads, opens a project created through the API from the game
// switcher, runs its game with Edit on demand, and stays accessible, without page errors or CSP violations. The Go
// editor has no harness chat, so the ⋯ menu leaves Harnesses out there.
for (const host of hosts) {
  test(host.name + ' host: the editor UI loads and opens a project', async (t) => {
    const editor = await launch(
      t,
      host.command,
      ['--data', join(tempDir(t, 'zirbel-editor-ui-'), 'data'), '--port', '0', '--player-host', 'games.lan'],
      (line) => (typeof line.editor === 'string' ? line.editor : undefined),
    ).ready;
    const post = (path: string, body: unknown) =>
      fetch(editor + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: editor },
        body: JSON.stringify(body),
      });
    await post('/api/projects', { title: 'Browser check' });
    const html =
      '<!doctype html><button id="go">Go</button><script>zirbel.register("go", { name: "Go button" })</script>';
    const built = (await (
      await post('/api/projects/import-game', {
        title: 'Built check',
        files: { 'index.html': Buffer.from(html).toString('base64') },
      })
    ).json()) as { id: string };

    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await (await browser.newContext()).newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text());
    });
    page.on('response', (response) => {
      if (response.url().startsWith(editor) && response.status() >= 500)
        failures.push(response.status() + ' ' + response.url());
    });
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
    await page
      .frameLocator('#playframe')
      .frameLocator('iframe.authored-game')
      .locator('#go')
      .waitFor({ timeout: 15_000 });
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
    const release = (await (
      await post('/api/projects/' + built.id + '/release', { branch: 'main', permissions: rights })
    ).json()) as { releaseId: string };
    assert.equal((await post('/api/rooms', { releaseId: release.releaseId, lan: true })).status, 201);
    const shared = await lobby();
    const qr = shared.getByRole('img', { name: 'QR code that opens the lobby' });
    await qr.waitFor();
    assert.match((await qr.getAttribute('src')) ?? '', /^data:image\/svg\+xml,/);
    const address = (await shared.locator('.lobby-address').textContent()) ?? '';
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
