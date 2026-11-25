// The game as a folder the harness builds: a turn writes game/ (the page, its scripts, three.js and an addon from
// node_modules' package), or compiles its TypeScript with the TypeScript the folder provides, and the game plays;
// a game/ the editor can't keep says what is wrong.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answer, controls, openEditor } from './browser-editor.mjs';

const page = (script) => `<!doctype html><html><body><p id="out">…</p><script type="module" src="${script}"></script></body></html>`;

test('a turn builds a folder game in game/, which plays, and a later turn sees and changes its files', { timeout: 60_000 }, async (t) => {
  const seen = [];
  const { page: tab, errors } = await openEditor(t, (context, res, run) => {
    seen.push(run.cwd);
    if (context.message === 'Build a folder game.') {
      answer(res, { action: 'create', title: 'Folder game', message: 'Built the folder game.' }, { files: {
        'index.html': page('./js/main.js'),
        'js/main.js': "import { Vector3 } from 'three';\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nimport { label } from './label.js';\ndocument.querySelector('#out').textContent = label(new Vector3(3, 4, 0).length(), typeof OrbitControls);\n",
        'js/label.js': "export const label = (length, controls) => 'Length ' + length + ' · ' + controls;\n",
      } });
      return;
    }
    answer(res, { action: 'edit', message: 'Changed the label.' }, { files: {
      'js/label.js': "export const label = (length) => 'Changed ' + length;\n",
    } });
  });
  const ui = controls(tab);
  await ui.send('Build a folder game.');
  await tab.getByText('Built the folder game.').waitFor();
  await ui.game.getByText('Length 5 · function').waitFor();
  // The next turn starts from the saved files in the same folder; the harness changes one of them.
  await ui.send('Change the label.');
  await tab.getByText(/Changed the label/).waitFor();
  await ui.game.getByText('Changed 5').waitFor();
  assert.equal(seen[0], seen[1], 'one folder for the thread');
  assert.deepEqual(errors, []);
});

test('a turn compiles TypeScript with the folder’s own TypeScript, and the built game plays', { timeout: 60_000 }, async (t) => {
  const { page: tab, errors } = await openEditor(t, (context, res) =>
    answer(res, { action: 'create', title: 'Typed game', message: 'Compiled the game.' }, {
      sources: { 'src/main.ts': "const sides: number[] = [3, 4];\ndocument.querySelector('#out')!.textContent = 'Typed ' + Math.hypot(...sides);\n" },
      files: { 'index.html': page('./main.js') },
      commands: [['node', 'node_modules/typescript/bin/tsc', '--target', 'es2022', '--module', 'es2022', '--outDir', 'game', 'src/main.ts']],
    }),
  );
  const ui = controls(tab);
  await ui.send('Build a typed game.');
  await tab.getByText('Compiled the game.').waitFor();
  await ui.game.getByText('Typed 5').waitFor();
  assert.deepEqual(errors, []);
});

test('a game/ the editor can’t keep gives a clear error in the thread', { timeout: 30_000 }, async (t) => {
  const { page: tab } = await openEditor(t, (context, res) =>
    answer(res, { action: 'create', title: 'Broken', message: 'Done.' }, { files: { 'index.html': page('./a.js'), 'art/ship.psd': 'x' } }),
  );
  const ui = controls(tab);
  await ui.send('Build it with the layers file.');
  await ui.status.filter({ hasText: 'game/ holds what a game can’t: game/art/ship.psd' }).waitFor();
  assert.equal(await ui.title(), 'New game', 'no game was made');
});
