// The desktop app as a person meets it, run from desktop/ on the checkout's built dist/ and driven by Playwright's
// Electron support. Every folder it writes is the test's own. Its windows show on the screen while it runs:
//   pnpm build (in the repository), then pnpm build && pnpm test here
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { checkHardening, checkPermissions, checkWayOut, openPlaytest, quit } from './checks.js';
import { alive, claim, folders, launchEnv, removeFolders, until } from './support.js';

const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;
const DESKTOP = path.join(import.meta.dirname, '..', '..');
const SERVER = path.join(DESKTOP, '..', 'dist', 'server.mjs');
const EXAMPLE = path.join(DESKTOP, '..', 'test', 'fixtures', 'moon-tiles.zirbel-project.json');
const made = folders('zirbel-desktop-app-');
const env = launchEnv(made);
// Chromium's fake camera and microphone, so that on a machine without them (CI's runners) asking for them still reaches
// the app's permission handler; never its fake UI, which would answer in the handler's place.
const launch = () =>
  electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, '--use-mock-keychain', '--use-fake-device-for-media-stream'],
    env,
  });

let app: ElectronApplication;
let page: Page;

// One app for the whole file, and its steps in this order (the last one quits it), whatever order --test-randomize
// gives the tests; each step has --test-timeout, the whole ten minutes.
test('the desktop app, run from desktop/ on the checkout’s built dist/', { timeout: 10 * 60_000 }, async (t) => {
  t.after(async () => {
    await app?.close().catch(() => undefined);
    removeFolders(made);
  });
  app = await launch();
  page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/, { timeout: 60_000 });

  await t.test(
    'the window opens the editor, which the app started from the built dist/ on a free loopback port',
    async () => {
      const owner = await until(() => claim(made.data), "the editor's claim on the data folder");
      assert.equal(page.url(), `http://127.0.0.1:${owner.port}/`);
      await page.locator('#host-status').waitFor();
      assert.match(await page.title(), /Zirbel/);
      const [parent, command] = execFileSync('ps', ['-o', 'ppid=', '-o', 'command=', '-p', String(owner.pid)], {
        encoding: 'utf8',
      })
        .trim()
        .split(/(?<=^\d+)\s+/);
      assert.equal(Number(parent), app.process().pid, 'the app started it');
      assert.equal(command, `${ELECTRON} ${SERVER} --port 0`, 'on its own program, as Node');
    },
  );

  await t.test(
    "the editor's page has no Node (require and process are undefined), no Web Bluetooth, no <webview>, and a sandboxed renderer",
    async () => {
      await checkHardening(app, page);
    },
  );

  await t.test(
    'outside addresses go to the system browser; other schemes and other loopback origins are refused',
    async () => {
      await checkWayOut(app, page);
    },
  );

  await t.test('a playtest opens in a child window on a loopback player origin, hardened the same way', async () => {
    const child = await openPlaytest(app, page, JSON.parse(readFileSync(EXAMPLE, 'utf8')));
    await checkHardening(app, child);
    await child.close();
  });

  await t.test('pages get no permission but fullscreen', async () => {
    await checkPermissions(app, page);
  });

  await t.test('quitting the app stops the editor it started', async () => {
    const owner = claim(made.data);
    assert.ok(owner && alive(owner.pid));
    await quit(app);
    assert.ok(!alive(owner.pid), 'the editor ended with the app');
    assert.equal(claim(made.data), undefined, 'it released the data folder, as a graceful stop does');
  });

  await t.test(
    'an editor that already owns the data folder is opened, and left running when the app quits',
    async () => {
      const running = spawn(process.execPath, [SERVER, '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
      try {
        const first = await createInterface({ input: running.stdout })[Symbol.asyncIterator]().next();
        const { editor } = JSON.parse(String(first.value)) as { editor: string };
        app = await launch();
        page = await app.firstWindow();
        await page.waitForURL(editor + '/', { timeout: 60_000 });
        await quit(app);
        assert.ok(running.exitCode === null && alive(running.pid!), 'the editor from the terminal goes on');
        assert.equal(claim(made.data)?.pid, running.pid);
      } finally {
        running.kill('SIGTERM');
        await until(
          () => running.exitCode !== null || running.signalCode !== null,
          'the editor from the terminal to stop',
        );
      }
    },
  );
});
