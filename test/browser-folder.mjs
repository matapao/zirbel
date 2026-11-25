// The game as a folder the harness builds: a turn writes game/ (the page, its scripts, three.js and an addon from
// node_modules' package), or compiles its TypeScript with the TypeScript the folder provides, and the game plays;
// a game/ the editor can't keep says what is wrong.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answer, controls, openEditor } from './browser-editor.mjs';

const page = (script) =>
  `<!doctype html><html><body><p id="out">…</p><script type="module" src="${script}"></script></body></html>`;

test(
  'a turn builds a folder game in game/, which plays, and a later turn sees and changes its files',
  { timeout: 60_000 },
  async (t) => {
    const seen = [];
    const { page: tab, errors } = await openEditor(t, (context, res, run) => {
      seen.push(run.cwd);
      if (context.message === 'Build a folder game.') {
        answer(
          res,
          { action: 'create', title: 'Folder game', message: 'Built the folder game.' },
          {
            files: {
              'index.html': page('./js/main.js'),
              'js/main.js':
                "import { Vector3 } from 'three';\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nimport { label } from './label.js';\ndocument.querySelector('#out').textContent = label(new Vector3(3, 4, 0).length(), typeof OrbitControls);\n",
              'js/label.js': "export const label = (length, controls) => 'Length ' + length + ' · ' + controls;\n",
            },
          },
        );
        return;
      }
      answer(
        res,
        { action: 'edit', message: 'Changed the label.' },
        {
          files: {
            'js/label.js': "export const label = (length) => 'Changed ' + length;\n",
          },
        },
      );
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
  },
);

test(
  'a turn sees its game through its own MCP server’s view_game, rendered outside its sandbox',
  { timeout: 90_000 },
  async (t) => {
    const { page: tab, errors } = await openEditor(t, (context, res) =>
      answer(
        res,
        { action: 'create', title: 'Seen game', message: 'Looked at it.' },
        {
          files: {
            'index.html': page('./main.js'),
            'main.js': "document.querySelector('#out').textContent = 'Seen'; console.log('seen');",
          },
          view: { width: 320, height: 200 },
        },
      ),
    );
    const ui = controls(tab);
    await ui.send('Build it and look at it.');
    await tab.getByText('Looked at it.').waitFor();
    const step = tab.locator('.step[data-kind="notice"]').filter({ hasText: 'Viewed the game' });
    await step.getByRole('button').click();
    const seen = JSON.parse(await step.locator('.step-detail').textContent());
    assert.deepEqual(seen.tools, ['view_game'], 'the turn’s server has view_game alone');
    // A screenshot and the page's console where a browser is installed; where none is, it says so.
    if (seen.isError) assert.match(seen.content[0], /No browser available/);
    else {
      assert.equal(seen.content[0], 'image:image/png');
      assert.match(seen.content[1], /"console":\[[^\]]*"seen"/);
    }
    assert.deepEqual(errors, []);
  },
);

test(
  'a turn compiles TypeScript with the folder’s own TypeScript, and the built game plays',
  { timeout: 60_000 },
  async (t) => {
    const { page: tab, errors } = await openEditor(t, (context, res) =>
      answer(
        res,
        { action: 'create', title: 'Typed game', message: 'Compiled the game.' },
        {
          sources: {
            'src/main.ts':
              "const sides: number[] = [3, 4];\ndocument.querySelector('#out')!.textContent = 'Typed ' + Math.hypot(...sides);\n",
          },
          files: { 'index.html': page('./main.js') },
          compile: true,
        },
      ),
    );
    const ui = controls(tab);
    await ui.send('Build a typed game.');
    await tab.getByText('Compiled the game.').waitFor();
    await ui.game.getByText('Typed 5').waitFor();
    assert.deepEqual(errors, []);
  },
);

test('a game/ the editor can’t keep gives a clear error in the thread', { timeout: 30_000 }, async (t) => {
  const { page: tab } = await openEditor(t, (context, res) =>
    answer(
      res,
      { action: 'create', title: 'Broken', message: 'Done.' },
      { files: { 'index.html': page('./a.js'), 'art/ship.psd': 'x' } },
    ),
  );
  const ui = controls(tab);
  await ui.send('Build it with the layers file.');
  await ui.status.filter({ hasText: 'game/ holds what a game can’t: game/art/ship.psd' }).waitFor();
  assert.equal(await ui.title(), 'New game', 'no game was made');
});
