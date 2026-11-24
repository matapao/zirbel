import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { chromium } from 'playwright';

// Only the provider reply is a fixture. The editor, player, SDK, Three.js and
// room transport all run from the built distribution.
function counterSource(step) {
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

async function openEditor(t, run) {
  const data = await mkdtemp(join(tmpdir(), 'zirbel-browser-'));
  const harnessHost = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/access') {
      res.end(JSON.stringify({ app: 'zirbel', processors: [{ id: 'codex', name: 'Test harness' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { prompt } = JSON.parse(Buffer.concat(chunks));
    const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    await run(context, res);
  });
  let host, browser;
  async function stopHost() {
    if (!host || host.exitCode !== null || host.signalCode !== null) return;
    const closed = once(host, 'exit');
    host.kill();
    await closed;
  }
  async function startHost(port) {
    host = spawn(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning',
      'test/fixture-editor.ts', '--port', port, '--data', data], {
      env: { ...process.env, FIXTURE_HARNESS_URL: 'http://127.0.0.1:' + harnessHost.address().port },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
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
  });
  harnessHost.listen(0, '127.0.0.1');
  await once(harnessHost, 'listening');
  const editor = await startHost('0');
  const restart = async () => {
    await stopHost();
    assert.equal(await startHost(new URL(editor).port), editor);
  };
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(editor);
  await page.getByText('Describe a game in Activity to get started.').waitFor();
  return { page, editor, data, errors, browser, restart };
}

function answer(res, result) {
  res.end(JSON.stringify({ task: 'fixture-turn', stopReason: 'end_turn', text: JSON.stringify(result) }));
}

test('chat creates and edits an original executable game with a live inspector', { timeout: 45_000 }, async (t) => {
  const calls = [];
  const allowBuild = Promise.withResolvers();
  const allowEdit = Promise.withResolvers();
  const hostRunStarted = Promise.withResolvers();
  const hostRunClosed = Promise.withResolvers();
  t.after(() => {
    allowBuild.resolve();
    allowEdit.resolve();
  });
  const { page, editor, data, errors, browser, restart } = await openEditor(t, async (context, res) => {
    calls.push(context);
    if (context.message === 'Make the harness fail.') {
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'Fixture failure' }));
      return;
    }
    if (context.message === 'Keep building until I stop the turn.') {
      res.once('close', hostRunClosed.resolve);
      hostRunStarted.resolve();
      return;
    }
    await (context.game ? allowEdit.promise : allowBuild.promise);
    answer(res, context.game ? { action: 'edit', message: 'Updated the counter.', game: { html: counterSource(3) } } :
      { action: 'create', title: 'Prism counter', message: 'Built the counter.', game: { html: counterSource(1) } });
  });
  await page.waitForFunction(() => {
    const panes = ['objects', 'scene', 'activity'].map((view) =>
      document.querySelector(`.vindu-pane[data-view="${view}"]`)?.getBoundingClientRect());
    return panes.every((box, i) => box?.width && (!i || panes[i - 1].right <= box.left));
  });
  const feed = page.locator('#messages');
  const projectPicker = page.getByRole('combobox', { name: 'Current project' });
  await projectPicker.waitFor();
  const progress = page.locator('#chat-run');
  const prompt = page.getByRole('textbox', { name: 'Describe a change' });
  const send = async (message) => {
    await prompt.fill(message);
    await page.getByRole('button', { name: 'Send message' }).click();
  };
  const requestStarted = Promise.withResolvers();
  const releaseRequest = Promise.withResolvers();
  t.after(() => releaseRequest.resolve());
  await page.route(editor + '/api/chat', async (route) => {
    requestStarted.resolve();
    await releaseRequest.promise;
    await route.abort().catch(() => {});
  }, { times: 1 });
  const earlyPrompt = 'Stop this turn before the harness responds.';
  await send(earlyPrompt);
  await requestStarted.promise;
  const stop = page.getByRole('button', { name: 'Stop turn' });
  await stop.waitFor();
  await page.getByRole('button', { name: 'Send message' }).waitFor({ state: 'hidden' });
  await stop.click();
  await progress.filter({ hasText: 'Turn stopped.' }).waitFor();
  await stop.waitFor({ state: 'hidden' });
  assert.equal(await prompt.inputValue(), earlyPrompt);
  assert.equal(calls.length, 0);
  releaseRequest.resolve();

  const build = 'Build a clickable photon counter using Three.js.';
  await send(build);
  await feed.getByText(build, { exact: true }).waitFor();
  await progress.filter({ hasText: 'Test harness is working…' }).waitFor();
  assert.equal(await prompt.inputValue(), '');
  allowBuild.resolve();
  await page.getByText(/Built the counter/).waitFor();
  await progress.waitFor({ state: 'hidden' });
  assert.equal(await feed.getByText(build, { exact: true }).count(), 1);
  assert.equal(calls[0].game, null);
  const game = page.frameLocator('#playframe').frameLocator('iframe.authored-game');
  await game.locator('#counter[data-seat="player"]').waitFor();
  assert.equal(await page.locator('#game-source').isVisible(), false);
  assert.equal(calls[0].registerObjects, true);
  await game.getByRole('button', { name: '14', exact: true }).click();
  await game.getByRole('button', { name: '15', exact: true }).waitFor();
  const sourceToggle = page.getByRole('button', { name: 'Source', exact: true });
  await sourceToggle.click();
  const source = page.getByRole('textbox', { name: 'Game source' });
  await source.waitFor();
  assert.match(await source.inputValue(), /import \{ Vector3 \}/);
  assert.equal(await page.locator('#playframe').isVisible(), false);
  await sourceToggle.click();
  await game.getByRole('button', { name: '15', exact: true }).waitFor();
  await page.locator('#objects').getByRole('button', { name: 'Photon Counter' }).click();
  await page.locator('#inspector pre').filter({hasText: '15'}).waitFor();
  const edit = 'Make each click add three.';
  await page.getByRole('checkbox', { name: 'Register editable objects' }).uncheck();
  await send(edit);
  await feed.getByText(edit, { exact: true }).waitFor();
  await progress.filter({ hasText: 'Test harness is working…' }).waitFor();
  allowEdit.resolve();
  await page.getByText(/Updated the counter/).waitFor();
  await progress.waitFor({ state: 'hidden' });
  assert.equal(await feed.getByText(edit, { exact: true }).count(), 1);
  assert.deepEqual(calls[1].game.markedIds, ['prism.01']);
  assert.equal(calls[1].registerObjects, false);
  assert.equal(calls[1].game.registeredObjects[0].properties.facets, 15);
  assert.equal(calls[1].game.source.html, counterSource(1));
  await game.getByRole('button', { name: '14', exact: true }).click();
  await game.getByRole('button', { name: '17', exact: true }).waitFor();
  await page.getByText('Object registration is off for this revision.').waitFor();
  const fail = 'Make the harness fail.';
  await send(fail);
  await progress.filter({ hasText: 'The harness connection could not complete the request.' }).waitFor();
  assert.equal(await feed.getByText(fail, { exact: true }).count(), 1);
  assert.equal(await prompt.inputValue(), fail);
  assert.equal(await game.getByRole('button', { name: '17', exact: true }).isVisible(), true);
  await send('Keep building until I stop the turn.');
  await hostRunStarted.promise;
  await progress.filter({ hasText: 'Test harness is working…' }).waitFor();
  await stop.click();
  await progress.filter({ hasText: 'Turn stopped.' }).waitFor();
  await hostRunClosed.promise;
  assert.equal(await game.getByRole('button', { name: '17', exact: true }).isVisible(), true);

  const projectId = await projectPicker.inputValue();
  await restart();
  await page.reload();
  await feed.getByText(/Updated the counter/).waitFor();
  assert.equal(await projectPicker.inputValue(), projectId);
  await game.getByRole('button', { name: '14', exact: true }).waitFor();
  const fresh = await browser.newPage();
  try {
    await fresh.goto(editor);
    await fresh.getByRole('combobox', { name: 'Current project' }).selectOption({ label: 'Prism counter' });
    await fresh.locator('#messages').getByText(/Updated the counter/).waitFor();
  } finally { await fresh.close(); }

  const published = await page.request.post(editor + '/api/projects/' + projectId + '/release', {
    data: { branch: 'main', permissions: { play: true, remix: true, download: true } },
  });
  assert.equal(published.status(), 201);
  const { releaseId } = await published.json();
  const packagePath = join(data, 'releases', releaseId + '.json');
  const savedPackage = JSON.parse(await readFile(packagePath, 'utf8'));
  savedPackage.files['player.js'] = Buffer.from('Retired version of player.js').toString('base64');
  await writeFile(packagePath, JSON.stringify(savedPackage));
  const opened = await page.request.post(editor + '/api/releases/' + releaseId + '/play');
  assert.equal(opened.status(), 201);
  const { id, link } = await opened.json();
  const runtime = await page.request.get(new URL('/runtime/' + id + '/player.js', link).href);
  assert.equal(runtime.status(), 200);
  assert.deepEqual(await runtime.body(), await readFile('dist/web/player.js'));

  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.locator('.library-project').filter({ hasText: 'Prism counter' }).getByRole('button', { name: 'Remove…' }).click();
  await page.getByRole('button', { name: 'Remove project', exact: true }).click();
  await page.getByRole('heading', { name: 'Game library' }).waitFor();
  assert.equal(await page.locator('.library-project').count(), 0);
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
  assert.equal((await page.request.get(editor + '/api/projects/' + projectId)).status(), 404);
  assert.deepEqual(errors, []);
});

test('model settings dismiss without getting in the way of chat', { timeout: 30_000 }, async (t) => {
  const { page, editor } = await openEditor(t, (_context, res) => res.writeHead(400).end('{}'));
  const changed = Promise.withResolvers();
  t.after(() => changed.resolve());
  const choices = {
    model: { name: 'Model', currentValue: 'default',
      options: [{ value: 'default', name: 'Default model' }, { value: 'alternate', name: 'Alternate model' }] },
    effort: { name: 'Reasoning effort', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] },
  };
  await page.route(editor + '/api/processors', (route) => route.fulfill({
    json: { processors: [{ id: 'codex', name: 'Test harness', modelSettings: true }] },
  }));
  await page.route(editor + '/api/processors/codex/model-settings', async (route) => {
    if (route.request().postDataJSON().model === 'alternate') await changed.promise;
    await route.fulfill({ json: choices });
  });
  await page.reload();
  const model = page.getByLabel('Model settings', { exact: true });
  const close = page.getByRole('button', { name: 'Close model settings' });
  const panel = page.locator('.model-picker-panel');
  const prompt = page.getByRole('textbox', { name: 'Describe a change' });
  await prompt.fill('Unsent prompt');

  await model.click();
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('alternate');
  await close.click();
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await model.evaluate((summary) => summary === document.activeElement), true);
  changed.resolve();
  await page.locator('#model-picker-label').filter({ hasText: 'Alternate model' }).waitFor();

  await model.click();
  await panel.waitFor();
  await page.locator('#activity-feed').click({ position: { x: 10, y: 8 } });
  await panel.waitFor({ state: 'hidden' });

  await model.click();
  await panel.waitFor();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });

  await model.click();
  await panel.waitFor();
  await page.getByRole('button', { name: 'Chat settings' }).click();
  await page.getByRole('heading', { name: 'Chat settings' }).waitFor();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await prompt.inputValue(), 'Unsent prompt');
});

test('new projects can start turns while another project is building', { timeout: 45_000 }, async (t) => {
  const fixture = (order) => ({
    title: 'Project ' + order, prompt: 'Build game ' + order + '.', reply: 'Built game ' + order + '.',
    reached: Promise.withResolvers(), ready: Promise.withResolvers(),
  });
  const first = fixture(1);
  const second = fixture(2);
  const runs = new Map([first, second].map((run) => [run.prompt, run]));
  t.after(() => { for (const run of runs.values()) run.ready.resolve(); });
  const { page, errors } = await openEditor(t, async (context, res) => {
    const run = runs.get(context.message);
    if (!run) { res.writeHead(400).end('{}'); return; }
    run.reached.resolve(context.game?.title);
    await run.ready.promise;
    answer(res, { action: 'edit', message: run.reply, game: { html: counterSource(1) } });
  });
  const projects = page.locator('#project');
  const feed = page.locator('#messages');
  const prompt = page.getByRole('textbox', { name: 'Describe a change' });
  // While a turn runs, Send is hidden and Stop occupies the same control.
  const send = page.locator('#send');
  const stop = page.getByRole('button', { name: 'Stop turn' });
  const working = page.locator('#chat-run').filter({ hasText: 'Test harness is working…' });
  const create = async (title) => {
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('textbox', { name: 'Game name' }).fill(title);
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.waitForFunction((title) => document.querySelector('#project').selectedOptions[0]?.label === title, title);
    return projects.inputValue();
  };

  const firstId = await create(first.title);
  await prompt.fill(first.prompt);
  await send.click();
  await working.waitFor();
  await stop.waitFor();
  await prompt.fill('Unsent first-project draft');

  const secondId = await create(second.title);
  assert.equal(await stop.isVisible(), false);
  assert.equal(await prompt.inputValue(), '');
  assert.equal(await feed.getByText(first.prompt).count(), 0);
  await prompt.fill(second.prompt);
  await send.click();
  await working.waitFor();
  await stop.waitFor();
  assert.equal(await first.reached.promise, first.title);
  assert.equal(await second.reached.promise, second.title);

  await projects.selectOption(firstId);
  await feed.getByText(first.prompt, { exact: true }).waitFor();
  assert.equal(await prompt.inputValue(), 'Unsent first-project draft');
  assert.equal(await send.isDisabled(), true);
  assert.equal(await send.isVisible(), false);
  assert.equal(await stop.isVisible(), true);
  await projects.selectOption(secondId);
  await feed.getByText(second.prompt, { exact: true }).waitFor();
  first.ready.resolve();
  // A background turn is complete when its assistant reply is in the project's history.
  await page.waitForFunction(async ({ id, reply }) => {
    const project = await (await fetch('/api/projects/' + id)).json();
    return project.notes.some(note => note.role === 'assistant' && note.text.startsWith(reply));
  }, { id: firstId, reply: first.reply }, { polling: 100 });
  assert.equal(await projects.inputValue(), secondId);
  assert.equal(await send.isDisabled(), true);
  assert.equal(await stop.isVisible(), true);

  second.ready.resolve();
  await feed.getByText(second.reply).waitFor();
  await stop.waitFor({ state: 'hidden' });
  await projects.selectOption(firstId);
  await feed.getByText(first.reply).waitFor();
  assert.equal(await prompt.inputValue(), 'Unsent first-project draft');
  assert.equal(await stop.isVisible(), false);
  assert.deepEqual(errors, []);
});
