// Two real browsers play games with their own netcode on each host (Node and, when built, Go), in a space of the real
// spaces kernel: the net module from the host, and an adapter a game's zirbel.json names. Run with `pnpm test:browser`.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { importGameFolder } from '../packages/core/game-files.ts';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { launch, REAL_SPACES, rights, tempDir } from './helpers.ts';
import { encoded, hosts } from './host-browser-fixture.ts';

// A game with its own netcode: the net module from its host, in the space its player page shares with it.
const netGame = `<!doctype html><p id="out">waiting</p><script type="module">
  const zn = await import('/.skalet/net.js');
  const net = zn.connect({ via: 'parent' });
  const out = document.getElementById('out');
  let heard = '';
  const show = () => { out.textContent = (net.peers.size + 1) + ' players, heard ' + heard; };
  net.on('open', () => { net.send(zn.ALL, 16, 'hi from ' + net.id); show(); });
  net.on('peer', (id) => { net.send(id, 16, 'hi from ' + net.id); show(); });
  net.on('message', (from, channel, r) => { heard = r.text(); show(); });
  net.on('close', (reason, message) => { out.textContent = 'closed ' + reason + ' ' + message; });
</script>`;
/** Net games play in a space of the real kernel, which carries their messages: run once `pnpm run deps` built it. */
const realKernel = { skip: existsSync(REAL_SPACES) ? false : 'the spaces kernel is not built: run `pnpm run deps`' };

for (const host of hosts) {
  test(host.name + ' host: two browsers play a game with its own netcode in a space', realKernel, async (t) => {
    const root = tempDir(t, 'zirbel-host-net-');
    const projects = new Projects(join(root, 'source'));
    const project = importGameFolder(projects, {
      title: 'Net',
      files: encoded({ 'index.html': netGame, 'zirbel.json': '{"players":{"max":2}}' }),
    });
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
      { ZIRBEL_SPACES_BINARY: REAL_SPACES },
    ).ready;
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const failures: string[] = [];
    const pages = await Promise.all([1, 2].map(async () => (await browser.newContext()).newPage()));
    for (const [index, page] of pages.entries()) {
      page.on('pageerror', (error) => failures.push(error.message));
      page.on('console', (message) => {
        if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text());
      });
      await page.goto(link);
      await page.locator('#join-form input[name="name"]').fill('Player ' + (index + 1));
      await page.locator('#join-form button.primary').click();
      await page
        .frameLocator('iframe')
        .locator('#out')
        .filter({ hasText: '1 players' })
        .or(page.frameLocator('iframe').locator('#out').filter({ hasText: '2 players' }))
        .waitFor({ timeout: 15_000 });
    }
    for (const [index, page] of pages.entries())
      await page
        .frameLocator('iframe')
        .locator('#out')
        .filter({ hasText: '2 players, heard hi from ' + (2 - index) })
        .waitFor({ timeout: 15_000 });
    assert.deepEqual(failures, []);
  });
}

// A game that leaves its space, and loads itself again or not.
const leavingGame = `<!doctype html><p id="out">waiting</p><script type="module">
  const zn = await import('/.skalet/net.js');
  const net = zn.connect({ via: 'parent' });
  net.on('open', () => { document.getElementById('out').textContent = 'member ' + net.id + location.hash; });
  globalThis.leave = (again) => { net.close(); if (again) { location.hash = 'again'; location.reload(); } };
</script>`;

for (const host of hosts) {
  test(
    host.name +
      " host: a game's leaving ends its frame's view alone, and the page gives the place up only if it doesn't come back",
    { ...realKernel, timeout: 90_000 },
    async (t) => {
      const root = tempDir(t, 'zirbel-host-leave-');
      const projects = new Projects(join(root, 'source'));
      const project = importGameFolder(projects, {
        title: 'Leave',
        files: encoded({ 'index.html': leavingGame, 'zirbel.json': '{"players":{"max":2}}' }),
      });
      const release = new Releases(projects, 'dist/web').package(project.id, 'main', rights, false);
      writeFileSync(join(root, 'release.json'), JSON.stringify(release));
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
          join(root, 'release.json'),
          '--release',
          release.manifest.releaseId,
        ],
        (line) => (typeof line.link === 'string' ? line.link : undefined),
        { ZIRBEL_SPACES_BINARY: REAL_SPACES },
      ).ready;
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await (await browser.newContext()).newPage();
      await page.goto(link);
      await page.locator('#join-form input[name="name"]').fill('Ada');
      await page.locator('#join-form button.primary').click();
      const out = page.frameLocator('iframe').locator('#out');
      await out.filter({ hasText: /^member 1$/ }).waitFor({ timeout: 15_000 });
      const leave = (again: boolean) =>
        page
          .frame({ url: /\/game\// })!
          .evaluate((back) => (globalThis as { leave?: (again: boolean) => void }).leave?.(back), again);
      // The game leaves and loads again: the page kept its place, and the game's next page is the same member.
      await leave(true);
      await out.filter({ hasText: /^member 1#again$/ }).waitFor({ timeout: 15_000 });
      // It leaves for good: once its frame hasn't asked for the space again in 15 s, the page leaves too.
      await leave(false);
      await page.getByText('The game left the session.').waitFor({ timeout: 25_000 });
      assert.equal(await page.locator('iframe').count(), 0);
    },
  );
}

// A game that knows nothing of any host: hooks for who this screen is, who else plays and what they say. Its
// zirbel.json names the adapter beside it, which the game page loads after the game, and which alone talks to the net
// module.
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
  const zn = await import('/.skalet/net.js');
  const net = zn.connect({ via: 'parent' });
  net.on('open', () => { game.me(net.id); for (const id of net.peers.keys()) game.join(id); net.send(zn.ALL, 16, game.input()); });
  net.on('peer', (id) => { game.join(id); net.send(id, 16, game.input()); });
  net.on('leave', (id) => game.leave(id));
  net.on('message', (from, type, r) => game.control(from, r.text()));`;

for (const host of hosts) {
  test(
    host.name + ' host: two browsers play a game with no line about Zirbel, through the adapter its zirbel.json names',
    realKernel,
    async (t) => {
      assert.doesNotMatch(Object.values(hookedGame).join('\n'), /zirbel|location|import/i);
      const root = tempDir(t, 'zirbel-host-adapter-');
      const projects = new Projects(join(root, 'source'));
      const project = importGameFolder(projects, {
        title: 'Hooks',
        files: encoded({
          ...hookedGame,
          'net/adapter.js': tinyAdapter,
          'zirbel.json': JSON.stringify({ players: { max: 2 }, multiplayer: { adapter: 'net/adapter.js' } }),
        }),
      });
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
        { ZIRBEL_SPACES_BINARY: REAL_SPACES },
      ).ready;
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const failures: string[] = [];
      const pages = await Promise.all([1, 2].map(async () => (await browser.newContext()).newPage()));
      for (const [index, page] of pages.entries()) {
        page.on('pageerror', (error) => failures.push(error.message));
        page.on('console', (message) => {
          if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text());
        });
        await page.goto(link);
        await page.locator('#join-form input[name="name"]').fill('Player ' + (index + 1));
        await page.locator('#join-form button.primary').click();
      }
      // Two members, each screen its own, and each heard the other.
      const seen: string[] = [];
      for (const page of pages) {
        const out = page
          .frameLocator('iframe')
          .locator('#out')
          .filter({ hasText: /^2 players, me \d, heard hello from \d$/ });
        await out.waitFor({ timeout: 15_000 });
        const [, me, from] = /me (\d), heard hello from (\d)/.exec((await out.textContent()) ?? '')!;
        seen.push(me + '<' + from);
      }
      assert.deepEqual(seen.sort(), ['1<2', '2<1']);
      assert.deepEqual(failures, []);
    },
  );
}
