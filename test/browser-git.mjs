// A game as a git repository in the editor (docs/git-store.md): History reads git's log (what, who, when), and Clone
// with git… gives the command that clones the game as it is.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { answer, controls, openEditor, wordGame } from './browser-editor.mjs';

test('History shows who made each revision and when, and Clone with git clones the game', { timeout: 60_000 }, async (t) => {
  const { page, errors } = await openEditor(t, (context, res) => {
    if (context.message === 'Make a word game.')
      answer(res, { action: 'create', title: 'Word game', message: 'Made the word game.', game: { html: wordGame('First') } });
    else answer(res, { action: 'edit', message: 'Changed the word.', game: { html: wordGame('Second') } });
  });
  const ui = controls(page);
  await ui.send('Make a word game.');
  await ui.game.getByText('First').waitFor();
  await ui.send('Change the word.');
  await ui.game.getByText('Second').waitFor();

  await ui.more('History');
  const dialog = page.getByRole('dialog');
  const revisions = dialog.locator('article.item');
  await revisions.first().waitFor();
  const shown = await revisions.evaluateAll((items) => items.map((item) => [item.querySelector('strong')?.textContent,
    item.querySelector('small')?.textContent]));
  assert.deepEqual(shown.map(([label]) => label), ['Changed the word.', 'Created with harness']);
  for (const [, line] of shown) assert.match(line, /^[0-9a-f]{8} · Test harness · /);
  await page.keyboard.press('Escape');

  await ui.more('Clone with git…');
  const command = await dialog.getByRole('textbox', { name: 'Clone command' }).inputValue();
  assert.match(command, /^git clone http:\/\/127\.0\.0\.1:\d+\/git\/[0-9a-f-]{36}\.git$/);
  const work = await mkdtemp(join(tmpdir(), 'zirbel-browser-clone-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  execFileSync('git', [...command.split(' ').slice(1), 'game'], { cwd: work, stdio: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' } });
  assert.match(await readFile(join(work, 'game', 'index.html'), 'utf8'), /Second/);
  assert.deepEqual(errors, []);
});
