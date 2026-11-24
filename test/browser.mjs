import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { answer, controls, counterSource, openEditor } from './browser-editor.mjs';

test('chat creates and edits an original executable game with a live inspector', { timeout: 60_000 }, async (t) => {
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
  const ui = controls(page);
  const { feed, prompt, status, stop, game } = ui;
  const requestStarted = Promise.withResolvers();
  const releaseRequest = Promise.withResolvers();
  t.after(() => releaseRequest.resolve());
  await page.route(editor + '/api/chat', async (route) => {
    requestStarted.resolve();
    await releaseRequest.promise;
    await route.abort().catch(() => {});
  }, { times: 1 });
  const earlyPrompt = 'Stop this turn before the harness responds.';
  await ui.send(earlyPrompt);
  await requestStarted.promise;
  await stop.waitFor();
  await page.getByRole('button', { name: 'Send message' }).waitFor({ state: 'hidden' });
  await stop.click();
  await status.filter({ hasText: 'Turn stopped.' }).waitFor();
  await stop.waitFor({ state: 'hidden' });
  assert.equal(await prompt.inputValue(), earlyPrompt);
  assert.equal(calls.length, 0);
  releaseRequest.resolve();

  const build = 'Build a clickable photon counter using Three.js.';
  await ui.send(build);
  await feed.getByText(build, { exact: true }).waitFor();
  await status.filter({ hasText: 'Test harness is working…' }).waitFor();
  assert.match(await page.locator('#chat-elapsed').textContent(), /^\d+:\d\d$/);
  assert.equal(await prompt.inputValue(), '');
  allowBuild.resolve();
  await page.getByText(/Built the counter/).waitFor();
  await status.waitFor({ state: 'hidden' });
  assert.equal(await feed.getByText(build, { exact: true }).count(), 1);
  assert.equal(calls[0].game, null);
  await game.locator('#counter[data-seat="player"]').waitFor();
  // The game runs in the middle, with the thread beside it.
  const [stage, thread] = await Promise.all(['game', 'thread'].map((view) =>
    page.locator(`.vindu-pane[data-view="${view}"]`).boundingBox()));
  assert.ok(stage && thread && stage.x + stage.width <= thread.x && stage.width > thread.width * 2);
  assert.equal(await page.locator('#game-source').isVisible(), false);
  assert.equal(calls[0].registerObjects, true);
  await game.getByRole('button', { name: '14', exact: true }).click();
  await game.getByRole('button', { name: '15', exact: true }).waitFor();

  // Edit shows the source and the objects; the game keeps running and keeps its state.
  await ui.edit.click();
  const sourceToggle = page.getByRole('button', { name: 'Source', exact: true });
  await sourceToggle.click();
  const source = page.getByRole('textbox', { name: 'Game source' });
  await source.waitFor();
  assert.match(await source.inputValue(), /import \{ Vector3 \}/);
  assert.equal(await source.getAttribute('readonly'), null);
  await sourceToggle.click();
  await source.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await page.locator('#objects').getByRole('button', { name: 'Photon Counter' }).click();
  await page.locator('#inspector pre').filter({ hasText: '15' }).waitFor();
  await game.getByRole('button', { name: '15', exact: true }).waitFor();

  await ui.more('Settings');
  await page.getByRole('checkbox', { name: 'Register editable objects' }).uncheck();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const edit = 'Make each click add three.';
  await ui.send(edit);
  await feed.getByText(edit, { exact: true }).waitFor();
  await status.filter({ hasText: 'Test harness is working…' }).waitFor();
  allowEdit.resolve();
  await page.getByText(/Updated the counter/).waitFor();
  await status.waitFor({ state: 'hidden' });
  assert.equal(await feed.getByText(edit, { exact: true }).count(), 1);
  assert.deepEqual(calls[1].game.markedIds, ['prism.01']);
  assert.equal(calls[1].registerObjects, false);
  assert.equal(calls[1].game.registeredObjects[0].properties.facets, 15);
  assert.equal(calls[1].game.source.html, counterSource(1));
  await page.getByText('Object registration is off for this revision.').waitFor();
  // A click into the game leaves Edit, and the person plays.
  await page.locator('#playframe').click({ position: { x: 600, y: 500 } });
  await page.locator('#edit-toggle[aria-pressed="false"]').waitFor();
  await page.locator('#objects-drawer').waitFor({ state: 'hidden' });
  await game.getByRole('button', { name: '14', exact: true }).click();
  await game.getByRole('button', { name: '17', exact: true }).waitFor();
  const fail = 'Make the harness fail.';
  await ui.send(fail);
  await status.filter({ hasText: 'The harness connection could not complete the request.' }).waitFor();
  assert.equal(await feed.getByText(fail, { exact: true }).count(), 1);
  assert.equal(await prompt.inputValue(), fail);
  assert.equal(await game.getByRole('button', { name: '17', exact: true }).isVisible(), true);
  await ui.send('Keep building until I stop the turn.');
  await hostRunStarted.promise;
  await status.filter({ hasText: 'Test harness is working…' }).waitFor();
  await stop.click();
  await status.filter({ hasText: 'Turn stopped.' }).waitFor();
  await hostRunClosed.promise;
  assert.equal(await game.getByRole('button', { name: '17', exact: true }).isVisible(), true);

  const projectId = await ui.projectId('Prism counter');
  await restart();
  await page.reload();
  await feed.getByText(/Updated the counter/).waitFor();
  assert.equal(await ui.title(), 'Prism counter');
  await game.getByRole('button', { name: '14', exact: true }).waitFor();
  const fresh = await browser.newPage();
  try {
    await fresh.goto(editor);
    await controls(fresh).choose('Prism counter');
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

  await ui.choose('Library…');
  await page.locator('.library-project').filter({ hasText: 'Prism counter' }).getByRole('button', { name: 'Remove…' }).click();
  await page.getByRole('button', { name: 'Remove project', exact: true }).click();
  await page.getByRole('heading', { name: 'Game library' }).waitFor();
  assert.equal(await page.locator('.library-project').count(), 0);
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
  assert.equal((await page.request.get(editor + '/api/projects/' + projectId)).status(), 404);
  assert.equal(await ui.title(), 'New game');
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
  const prompt = page.getByRole('textbox', { name: 'Describe a game' });
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
  await page.mouse.click(700, 820);
  await panel.waitFor({ state: 'hidden' });

  await model.click();
  await panel.waitFor();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });

  await model.click();
  await panel.waitFor();
  await controls(page).more('Settings');
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
  const ui = controls(page);
  const { feed, prompt, stop } = ui;
  // While a turn runs, Send is hidden and Stop occupies the same control.
  const send = page.locator('#send');
  const working = page.locator('#chat-run').filter({ hasText: 'Test harness is working…' });
  const create = async (title) => {
    await ui.choose('Library…');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('textbox', { name: 'Game name' }).fill(title);
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.locator('#game-title').filter({ hasText: title }).waitFor();
    return ui.projectId(title);
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

  await ui.choose(first.title);
  await feed.getByText(first.prompt, { exact: true }).waitFor();
  assert.equal(await prompt.inputValue(), 'Unsent first-project draft');
  assert.equal(await send.isDisabled(), true);
  assert.equal(await send.isVisible(), false);
  assert.equal(await stop.isVisible(), true);
  await ui.choose(second.title);
  await feed.getByText(second.prompt, { exact: true }).waitFor();
  first.ready.resolve();
  // A background turn is complete when its assistant reply is in the project's history.
  await page.waitForFunction(async ({ id, reply }) => {
    const project = await (await fetch('/api/projects/' + id)).json();
    return project.notes.some(note => note.role === 'assistant' && note.text.startsWith(reply));
  }, { id: firstId, reply: first.reply }, { polling: 100 });
  assert.equal(await ui.title(), second.title);
  assert.equal(await send.isDisabled(), true);
  assert.equal(await stop.isVisible(), true);

  second.ready.resolve();
  await feed.getByText(second.reply).waitFor();
  await stop.waitFor({ state: 'hidden' });
  await ui.choose(first.title);
  await feed.getByText(first.reply).waitFor();
  assert.equal(await prompt.inputValue(), 'Unsent first-project draft');
  assert.equal(await stop.isVisible(), false);
  assert.notEqual(firstId, secondId);
  assert.deepEqual(errors, []);
});

test('a built game folder imports from the empty desk and opens as a project', { timeout: 45_000 }, async (t) => {
  const { page, errors } = await openEditor(t, (_context, res) => res.writeHead(400).end('{}'));
  const parent = await mkdtemp(join(tmpdir(), 'zirbel-folder-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const folder = join(parent, 'Lantern Run');
  await mkdir(join(folder, 'assets'), { recursive: true });
  await writeFile(join(folder, 'index.html'), '<!doctype html><p>built</p><script type="module" src="./assets/main.js"></script>');
  await writeFile(join(folder, 'assets', 'main.js'), 'document.body.dataset.ready = "yes";');
  await writeFile(join(folder, '.DS_Store'), 'not a game file');
  await page.getByRole('button', { name: 'Import a game folder' }).click();
  await page.getByLabel('Built game folder', { exact: true }).setInputFiles(folder);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('#status').filter({ hasText: 'Imported 2 files. Skipped: .DS_Store.' }).waitFor();
  // The new project is the one the switcher shows, and it runs.
  await page.locator('#game-title').filter({ hasText: 'Lantern Run' }).waitFor();
  await page.frameLocator('#playframe').frameLocator('iframe.authored-game').locator('body[data-ready="yes"]').waitFor();
  assert.deepEqual(errors, []);
});
