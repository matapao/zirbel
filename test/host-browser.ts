// Two real browsers join one room on each host (Node and, when built, Go) and
// see each other's shared state through the actual player page, game SDK,
// sandboxed frame and WebSocket. Run with `pnpm test:browser`.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Page } from 'playwright';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { hostsUnderTest, launch, rights, tempDir } from './helpers.ts';

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

// The editor UI itself, served by each host: it loads, lists a project created
// through the API, and opens it without page errors or CSP violations.
for (const host of hosts) {
  test(host.name + ' host: the editor UI loads and opens a project', async (t) => {
    const editor = await launch(t, host.command, ['--data', join(tempDir(t, 'zirbel-editor-ui-'), 'data'), '--port', '0'],
      (line) => typeof line.editor === 'string' ? line.editor : undefined).ready;
    const created = await fetch(editor + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json', origin: editor },
      body: JSON.stringify({ title: 'Browser check' }) });
    const project = await created.json() as { id: string };

    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await (await browser.newContext()).newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text()); });
    page.on('response', (response) => { if (response.url().startsWith(editor) && response.status() >= 500) failures.push(response.status() + ' ' + response.url()); });
    await page.goto(editor + '/');
    await page.locator('#project option', { hasText: 'Browser check' }).waitFor({ state: 'attached', timeout: 15_000 });
    await page.locator('#project').selectOption(project.id);
    await page.waitForLoadState('networkidle');
    assert.deepEqual(failures, []);
    assert.deepEqual(await accessibility(page), []);
  });
}
