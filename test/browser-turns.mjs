// A turn as the editor owns it: closing the page leaves it running, a page that opens the thread follows it from
// where it is (its steps, a request waiting) to its end; an editor that ended mid-turn leaves it interrupted, and
// Continue resumes its session; and a request says why it asks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answer, controls, openEditor, wordGame } from './browser-editor.mjs';

const allow = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

test('closing the page leaves a turn running; the page that comes back follows it to its end', { timeout: 60_000 }, async (t) => {
  const released = Promise.withResolvers();
  const started = Promise.withResolvers();
  t.after(() => released.resolve());
  const { page, errors } = await openEditor(t, async (context, res) => {
    if (context.message === 'Build a long game.') {
      started.resolve();
      await released.promise;
      answer(res, { action: 'create', title: 'Long game', message: 'Built the long game.', game: { html: wordGame('Long') } });
      return;
    }
    answer(res, { action: 'reply', message: 'Checked the build.' }, {
      activity: [{ id: 'tool:check', kind: 'tool', title: 'Bash', detail: 'Check the build', state: 'completed' }],
      asks: [{ call: 'check', tool: 'Bash', title: 'npm test', input: { command: 'npm test', description: 'Run the tests' }, options: allow }],
    });
  });
  await controls(page).send('Build a long game.');
  await started.promise;
  await page.locator('#chat-run').filter({ hasText: 'Test harness is working…' }).waitFor();
  // The page goes away, as a closed window does: it unloads, and its stream ends with it.
  const address = page.url();
  await page.goto('about:blank');

  // The chat before a project: its own thread, which the page keeps, finds the running turn.
  await page.goto(address);
  const ui = controls(page);
  await ui.feed.getByText('Build a long game.', { exact: true }).waitFor();
  await ui.status.filter({ hasText: 'Test harness' }).waitFor();
  await ui.stop.waitFor();
  released.resolve();
  await page.getByText('Built the long game.').waitFor();
  await ui.game.getByText('Long').waitFor();
  assert.equal(await ui.title(), 'Long game');

  // A turn waiting on the person: the page that comes back shows its steps and the request, and the answer ends it.
  await ui.send('Check the build.');
  await page.locator('.ask-card').waitFor();
  await page.goto('about:blank');
  await page.goto(address);
  await ui.feed.getByText('Check the build.', { exact: true }).waitFor();
  const steps = page.getByRole('list', { name: 'Harness steps' }).last();
  await steps.getByText('Bash', { exact: true }).waitFor();
  const waiting = page.locator('.ask-card');
  await waiting.waitFor();
  assert.equal(await waiting.locator('.ask-title').textContent(), 'Run the tests');
  await waiting.getByRole('button', { name: 'Allow once' }).click();
  await page.getByText('Checked the build.').waitFor();
  await ui.status.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
});

test('a turn its editor ended mid-way is interrupted, and Continue resumes the same session', { timeout: 60_000 }, async (t) => {
  const runs = [];
  const started = Promise.withResolvers();
  const { page, errors, restart } = await openEditor(t, async (context, res, run) => {
    runs.push({ message: context.message, resume: run.resume, sessionId: run.sessionId, cwd: run.cwd });
    if (context.message === 'Make the first game.') {
      answer(res, { action: 'create', title: 'Resumed game', message: 'Made it.', game: { html: wordGame('First') } });
      return;
    }
    if (context.message === 'Add a long level.') {
      started.resolve();
      return; // never answered: the editor ends while it runs
    }
    answer(res, { action: 'reply', message: 'Went on from where I was.' });
  });
  const ui = controls(page);
  await ui.send('Make the first game.');
  await page.getByText('Made it.').waitFor();
  await ui.send('Add a long level.');
  await started.promise;
  // The editor ends as in a crash: the next start finds the turn it was running.
  await restart('SIGKILL');
  await page.reload();
  const row = page.locator('.interrupted');
  await row.getByText('Interrupted', { exact: true }).waitFor();
  await ui.feed.getByText('Add a long level.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText('Went on from where I was.').waitFor();
  await ui.feed.getByText('The previous turn was interrupted. Continue where you left off.', { exact: true }).waitFor();
  assert.equal(await row.count(), 0);
  const [first, long, resumed] = runs;
  assert.equal(first.resume, false);
  assert.deepEqual([long.resume, long.sessionId, long.cwd], [true, first.sessionId, first.cwd]);
  assert.deepEqual([resumed.message, resumed.resume, resumed.sessionId, resumed.cwd],
    ['The previous turn was interrupted. Continue where you left off.', true, first.sessionId, first.cwd]);
  assert.deepEqual(errors, []);
});

test('a request shows why the harness asks, as plain text under its headline', { timeout: 30_000 }, async (t) => {
  const reason = 'The sandbox keeps this command from writing <b>outside</b> the folder.\nIt asks once.';
  const { page, errors } = await openEditor(t, (context, res) =>
    answer(res, { action: 'reply', message: 'Asked.' }, {
      asks: [{ call: 'write', tool: 'Bash', title: 'cp a /etc/b', reason, input: { command: 'cp a /etc/b' }, options: allow }],
    }),
  );
  await controls(page).send('Copy the file.');
  const card = page.locator('.ask-card');
  await card.waitFor();
  const line = card.locator('.ask-reason');
  await line.getByText('Why it’s asking', { exact: true }).waitFor();
  assert.equal(await line.locator('.ask-reason-text').textContent(), reason);
  assert.equal(await line.locator('b').count(), 0, 'never read as HTML');
  // It comes right under the headline.
  assert.equal(await card.evaluate((node) => node.querySelector('.ask-title')?.nextElementSibling?.className), 'ask-reason');
  await card.getByRole('button', { name: 'Reject' }).click();
  await page.getByText('Asked.').waitFor();
  assert.deepEqual(errors, []);
});
