// The editor for the browser tests: the built distribution, with a harness whose replies come from the test.
// Only the provider reply is a fixture. The editor, player, SDK, Three.js and room transport all run as built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';

export function counterSource(step) {
  return `<button id="counter"></button><script type="module">
    import { Vector3 } from 'three';
    let count = new Vector3(1, 2, 3).lengthSq();
    const button = document.querySelector('#counter');
    function paint() {
      button.textContent = String(count);
      zirbel.register('prism.01', { name: 'Photon Counter', facets: count });
    }
    zirbel.onRoom(({ self }) => { button.dataset.seat = self.role; });
    button.onclick = () => { count += ${step}; paint() };
    paint();
  </script>`;
}

/** A game that shows one word, to tell revisions apart. */
export const wordGame = (word) =>
  `<p id="word" style="font:40px sans-serif;margin:40vh auto;text-align:center">${word}</p>`;

export function answer(res, result, extra = {}) {
  res.end(JSON.stringify({ task: 'fixture-turn', stopReason: 'end_turn', text: JSON.stringify(result), ...extra }));
}

export async function openEditor(t, run) {
  const data = await mkdtemp(join(tmpdir(), 'zirbel-browser-'));
  // The threads' working folders, apart from the projects as the account folder is.
  const account = await mkdtemp(join(tmpdir(), 'zirbel-browser-account-'));
  const harnessHost = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/access') {
      res.end(JSON.stringify({ app: 'zirbel', processors: [{ id: 'codex', name: 'Test harness' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const context = JSON.parse(body.prompt.slice(body.prompt.lastIndexOf('\n') + 1));
    // The run as the harness gets it: its thread folder (cwd), and the session it resumes, if it does.
    await run(context, res, body);
  });
  let host, browser;
  async function stopHost(signal = 'SIGTERM') {
    if (!host || host.exitCode !== null || host.signalCode !== null) return;
    const closed = once(host, 'exit');
    host.kill(signal);
    await closed;
  }
  async function startHost(port) {
    host = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        'test/fixture-editor.ts',
        '--port',
        port,
        '--data',
        data,
      ],
      {
        env: { ...process.env, FIXTURE_HARNESS_URL: 'http://127.0.0.1:' + harnessHost.address().port, ZIRBEL_ACCOUNT_DIR: account },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const lines = createInterface({ input: host.stdout });
    const first = await lines[Symbol.asyncIterator]().next();
    assert.ok(!first.done, 'The editor must start');
    return JSON.parse(first.value).editor;
  }
  t.after(async () => {
    await browser?.close();
    await stopHost();
    harnessHost.closeAllConnections();
    if (harnessHost.listening) await new Promise((resolve) => harnessHost.close(resolve));
    await rm(data, { recursive: true, force: true });
    await rm(account, { recursive: true, force: true });
  });
  harnessHost.listen(0, '127.0.0.1');
  await once(harnessHost, 'listening');
  const editor = await startHost('0');
  /** Stops the editor and starts it again on the same port: gracefully, or killed as in a crash (SIGKILL). */
  const restart = async (signal = 'SIGTERM') => {
    await stopHost(signal);
    assert.equal(await startHost(new URL(editor).port), editor);
  };
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(editor);
  await page.getByRole('textbox', { name: 'Describe a game' }).waitFor();
  return { page, editor, data, account, errors, browser, restart };
}

/** The editor's controls, by their names. */
export function controls(page) {
  const prompt = page.locator('#prompt');
  return {
    prompt,
    feed: page.locator('#messages'),
    status: page.locator('#chat-run'),
    stop: page.getByRole('button', { name: 'Stop turn' }),
    edit: page.getByRole('button', { name: 'Edit', exact: true }),
    switcher: page.locator('#game-switcher'),
    game: page.frameLocator('#playframe').frameLocator('iframe.authored-game'),
    async send(message) {
      await prompt.fill(message);
      await page.getByRole('button', { name: 'Send message' }).click();
    },
    /** Opens a game, or another entry, from the game switcher. */
    async choose(name) {
      await page.locator('#game-switcher').click();
      await page
        .getByRole('menu', { name: 'Games' })
        .getByRole(/^(?:Library|New game|Import)/.test(name) ? 'menuitem' : 'menuitemradio', { name, exact: true })
        .click();
    },
    async more(name) {
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name, exact: true }).click();
    },
    title: () => page.locator('#game-title').textContent(),
    projectId: (title) =>
      page.evaluate(
        async (title) => (await (await fetch('/api/projects')).json()).find((card) => card.title === title)?.id,
        title,
      ),
  };
}
