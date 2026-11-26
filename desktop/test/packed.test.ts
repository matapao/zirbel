// The desktop app as packed (scripts/pack.mjs), started from its bundle with folders of the test's own and driven by
// Playwright's Electron support. The bundle is signed, holds the checkout's built dist/ and the Codex SDK the Codex
// harness runs the person's own Codex through, links to nothing outside itself, and carries nothing under Anthropic's
// terms. Started, it runs the editor inside the bundle, hardened as from desktop/, and stops the editor as it quits.
//   pnpm build (in the repository), then pnpm build && pnpm pack:app && pnpm test:packed here
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { checkHardening, checkWayOut, openPlaytest, quit } from './checks.js';
import { alive, claim, folders, launchEnv, removeFolders, until } from './support.js';

const DESKTOP = path.join(import.meta.dirname, '..', '..');
const REPO = path.join(DESKTOP, '..');
const BUNDLE = path.join(DESKTOP, 'out', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Zirbel.app');
const PROGRAM = path.join(BUNDLE, 'Contents', 'MacOS', 'Zirbel');
const EDITOR = path.join(BUNDLE, 'Contents', 'Resources', 'editor');
const made = folders('zirbel-desktop-packed-');

let app: ElectronApplication;
let page: Page;

/** Every file under a folder, relative to it. */
function files(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
}

// One app for the whole file, and its steps in this order (the last one quits it), whatever order --test-randomize
// gives the tests; each step has --test-timeout, the whole ten minutes.
test('the packed app, started from its bundle', { timeout: 10 * 60_000 }, async (t) => {
  t.after(async () => {
    await app?.close().catch(() => undefined);
    removeFolders(made);
  });
  if (process.platform !== 'darwin' || !fs.existsSync(PROGRAM))
    throw new Error(`No packed app at ${BUNDLE}: pnpm pack:app first.`);
  app = await electron.launch({ executablePath: PROGRAM, args: ['--use-mock-keychain'], env: launchEnv(made) });
  page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/, { timeout: 60_000 });

  await t.test('the bundle is signed, and holds the built dist/ and the Codex SDK, linked to nothing outside it', () => {
    assert.equal(spawnSync('codesign', ['--verify', '--deep', '--strict', BUNDLE]).status, 0, 'valid as signed');
    const built = files(path.join(REPO, 'dist')).filter((file) => !file.endsWith('.DS_Store'));
    const different = built.filter(
      (file) => !fs.readFileSync(path.join(EDITOR, file)).equals(fs.readFileSync(path.join(REPO, 'dist', file))),
    );
    assert.deepEqual(different, [], "the checkout's dist/, as built");
    const modules = path.join(EDITOR, 'node_modules');
    assert.ok(fs.existsSync(path.join(modules, '@openai', 'codex-sdk', 'package.json')), 'the Codex SDK');
    // What a harness turn's node_modules links to: three.js in the built dist/, TypeScript and esbuild with their binaries.
    assert.ok(fs.existsSync(path.join(EDITOR, 'web', 'three', 'package.json')), 'three.js as a package');
    for (const name of ['typescript', `@typescript/typescript-darwin-${process.arch}`, 'esbuild', `@esbuild/darwin-${process.arch}`])
      assert.ok(fs.existsSync(path.join(modules, name, 'package.json')), name);
    assert.ok(!fs.existsSync(path.join(modules, '@openai', `codex-darwin-${process.arch}`)), 'no copy of Codex: the person’s own runs');
    const scopes = fs.readdirSync(modules).filter((name) => name.startsWith('@'));
    const packages = scopes.flatMap((scope) =>
      fs.readdirSync(path.join(modules, scope)).map((name) => `${scope}/${name}`),
    );
    assert.ok(!packages.some((name) => name.startsWith('@anthropic-ai/')), "nothing under Anthropic's terms");
    const links = fs
      .readdirSync(path.join(BUNDLE, 'Contents', 'Resources'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isSymbolicLink())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((link) => !fs.existsSync(link) || !fs.realpathSync(link).startsWith(BUNDLE + path.sep));
    assert.deepEqual(links, [], 'no link out of the bundle');
    assert.ok(!fs.existsSync(path.join(BUNDLE, 'Contents', 'Resources', 'default_app.asar')), 'no Electron default app');
    const licences = ['LICENSE.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html'];
    for (const file of licences) assert.ok(fs.existsSync(path.join(BUNDLE, 'Contents', 'Resources', file)), file);
  });

  await t.test('started from its bundle, the app opens the editor that runs inside it', async () => {
    const owner = await until(() => claim(made.data), "the editor's claim on the data folder");
    assert.equal(page.url(), `http://127.0.0.1:${owner.port}/`);
    await page.locator('#host-status').waitFor();
    const [parent, command] = execFileSync('ps', ['-o', 'ppid=', '-o', 'command=', '-p', String(owner.pid)], {
      encoding: 'utf8',
    })
      .trim()
      .split(/(?<=^\d+)\s+/);
    assert.equal(Number(parent), app.process().pid, 'the app started it');
    assert.equal(
      command,
      `${PROGRAM} ${path.join(EDITOR, 'server.mjs')} --port 0`,
      "the bundle's editor, on the app's own program as Node",
    );
  });

  await t.test('the packed app is hardened as from desktop/', async () => {
    await checkHardening(app, page);
    await checkWayOut(app, page);
    const child = await openPlaytest(
      app,
      page,
      JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'moon-tiles.zirbel-project.json'), 'utf8')),
    );
    await checkHardening(app, child);
    await child.close();
  });

  await t.test('the editor offers the Codex harness where Codex is installed; Claude Code is unavailable', async () => {
    const listed = await page.evaluate(
      async () =>
        (await (await fetch('/api/processors')).json()) as {
          processors: { id: string; ready: boolean; signIn?: boolean; detail?: string }[];
        },
    );
    const codex = listed.processors.find((processor) => processor.id === 'codex');
    const claude = listed.processors.find((processor) => processor.id === 'claude');
    // The test's account folder has no sign-in: a Codex that runs says so, and one that isn't installed is unavailable.
    assert.ok(codex && (codex.ready || codex.signIn || codex.detail), `Codex is listed: ${JSON.stringify(codex)}`);
    // The bundle carries no Claude Agent SDK (above). From out/ in a checkout, Node still finds the checkout's own, so
    // what the list says depends on where the bundle is: here it is only not ready, as the test's account has no sign-in.
    assert.equal(claude?.ready, false);
  });

  await t.test('quitting the packed app stops its editor', async () => {
    const owner = claim(made.data);
    assert.ok(owner && alive(owner.pid));
    await quit(app);
    assert.ok(!alive(owner.pid), 'the editor ended with the app');
    assert.equal(claim(made.data), undefined, 'it released the data folder');
  });
});
