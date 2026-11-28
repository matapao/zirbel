// The workspace as the person meets it: no modes, Edit on demand, menus from the keyboard, the harness's steps in
// the thread, proposals as cards, and permission requests in plain language.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answer, controls, counterSource, openEditor, wordGame } from './browser-editor.mjs';

const steps = [
  { id: 'plan', kind: 'plan', title: 'Plan', detail: 'Completed · Sketch the board\nIn progress · Write the rules' },
  {
    id: 'tool:test',
    kind: 'tool',
    title: 'Bash',
    state: 'completed',
    detail: 'Run the tests\n\n$ npm test\n\n3 passing',
  },
  {
    id: 'tool:edit',
    kind: 'tool',
    title: 'Edit index.html',
    state: 'completed',
    diff: '--- index.html\n+++ index.html\n@@ line 1 @@\n-<p>old</p>\n+<p>new</p>',
  },
];

test(
  'the desk has no modes: Edit comes with E or its button and goes with a click into the game',
  { timeout: 45_000 },
  async (t) => {
    const { page, errors } = await openEditor(t, (context, res) =>
      answer(res, { action: 'create', title: 'Counter', message: 'Built it.', game: { html: counterSource(1) } }),
    );
    const ui = controls(page);
    // Before any game: one prompt, the folder import, and nothing else.
    for (const name of ['Edit', 'Context', 'Review', 'Play', 'Assets', 'Share']) {
      assert.equal(await page.getByRole('button', { name, exact: true }).isVisible(), false, name);
    }
    assert.equal(await page.locator('#workspace-modes, button[data-mode]').count(), 0);
    assert.equal(await page.getByRole('combobox', { name: 'Branch' }).count(), 0);
    await page.getByRole('button', { name: 'Import a game folder' }).waitFor();
    assert.equal(await page.locator('#chat-suggestions button').count(), 0);
    // A project without a game shows no suggestions either.
    await ui.choose('Library…');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.locator('#game-title').filter({ hasText: 'Untitled project' }).waitFor();
    await page.locator('#provider').filter({ hasText: 'Test harness' }).waitFor();
    assert.equal(await page.locator('#chat-suggestions button').count(), 0);
    assert.equal(await ui.edit.isVisible(), false);

    await ui.send('Build a counter.');
    await page.getByText('Built it.').waitFor();
    await ui.game.getByRole('button', { name: '14', exact: true }).waitFor();
    // Suggestions come once a game exists: neutral ones about the game on screen.
    assert.deepEqual(await page.locator('#chat-suggestions button').allTextContents(), [
      'Describe this game',
      'Suggest two changes',
      'Explain the controls',
    ]);
    // The object list is hidden until asked for, even in Edit.
    assert.equal(await page.locator('#objects-drawer').isVisible(), false);
    assert.equal(await ui.edit.getAttribute('aria-pressed'), 'false');
    await page.locator('#prompt').press('e');
    assert.equal(await ui.edit.getAttribute('aria-pressed'), 'false', 'E types in a text field');
    assert.equal(await page.locator('#prompt').inputValue(), 'e');
    await page.locator('#prompt').fill('');
    await ui.edit.focus();
    await page.keyboard.press('e');
    assert.equal(await ui.edit.getAttribute('aria-pressed'), 'true');
    await page.getByRole('toolbar', { name: 'Edit tools' }).waitFor();
    assert.equal(await page.locator('#objects-drawer').isVisible(), false);
    const objects = page.getByRole('button', { name: 'Objects', exact: true });
    assert.equal(await objects.getAttribute('aria-pressed'), 'false');
    await objects.click();
    await page.locator('#objects').getByRole('button', { name: 'Photon Counter' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await ui.edit.getAttribute('aria-pressed'), 'false');
    await page.locator('#objects-drawer').waitFor({ state: 'hidden' });

    await ui.edit.click();
    await page.locator('#objects-drawer').waitFor();
    // A click into the game hands it the focus: Edit ends and the click plays.
    await page.locator('#playframe').click({ position: { x: 600, y: 500 } });
    await page.locator('#edit-toggle[aria-pressed="false"]').waitFor();
    await page.getByRole('toolbar', { name: 'Edit tools' }).waitFor({ state: 'hidden' });
    await ui.game.getByRole('button', { name: '14', exact: true }).click();
    await ui.game.getByRole('button', { name: '15', exact: true }).waitFor();
    // The game kept its state through Edit: the same room, never reloaded.
    await ui.edit.click();
    await ui.game.getByRole('button', { name: '15', exact: true }).waitFor();
    // The thread folds away, and the game takes the whole desk.
    const width = async () => (await page.locator('.vindu-pane[data-view="game"]').boundingBox())?.width ?? 0;
    const split = await width();
    await page.getByRole('button', { name: 'Hide thread' }).click();
    await page.locator('.vindu-pane[data-view="thread"]').waitFor({ state: 'hidden' });
    assert.ok((await width()) > split);
    await page.getByRole('button', { name: 'Thread', exact: true }).click();
    await page.locator('.vindu-pane[data-view="thread"]').waitFor();
    assert.equal(Math.round(await width()), Math.round(split));
    await ui.game.getByRole('button', { name: '15', exact: true }).waitFor();
    assert.deepEqual(errors, []);
  },
);

test('the game switcher and the ⋯ menu work from the keyboard', { timeout: 30_000 }, async (t) => {
  const { page, errors } = await openEditor(t, (context, res) =>
    answer(res, { action: 'create', title: 'Keyboard game', message: 'Built it.', game: { html: wordGame('Hello') } }),
  );
  const ui = controls(page);
  await ui.send('Build a word.');
  await page.getByText('Built it.').waitFor();
  const switcher = page.locator('#game-switcher');
  await switcher.focus();
  await page.keyboard.press('ArrowDown');
  const games = page.getByRole('menu', { name: 'Games' });
  await games.waitFor();
  assert.equal(await switcher.getAttribute('aria-expanded'), 'true');
  const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim());
  assert.match(await focused(), /^Keyboard game/);
  assert.equal(await games.getByRole('menuitemradio', { name: 'Keyboard game' }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('ArrowDown');
  assert.equal(await focused(), 'New game');
  await page.keyboard.press('End');
  assert.match(await focused(), /^All threads/);
  assert.equal(await games.getByRole('menuitem', { name: /All threads/ }).getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Escape');
  await games.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'game-switcher');

  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'More' });
  await menu.waitFor();
  assert.equal(await focused(), 'History');
  const items = await menu.getByRole('menuitem').allTextContents();
  assert.deepEqual(items, [
    'History',
    'Clone with git…',
    'Export project',
    'Open game in a new window',
    'Harnesses',
    'Set up a Zirbel box…',
    'Settings',
  ]);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.equal(await focused(), 'Set up a Zirbel box…');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'History' }).waitFor();
  await page.getByText('Current branch').waitFor();
  await page.keyboard.press('Escape');
  // Setting up a box: through its own Wi-Fi, "Zirbel setup XXXX", and the page it opens.
  await more.click();
  await menu.getByRole('menuitem', { name: 'Set up a Zirbel box…' }).click();
  await page.getByRole('heading', { name: 'Set up a Zirbel box' }).waitFor();
  assert.match(await page.locator('#dialog-body').innerText(), /Join that Wi-Fi .* setup page opens/);
  await page.keyboard.press('Escape');

  await switcher.focus();
  await page.keyboard.press('Enter');
  await games.waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  // New game: the empty desk with its one prompt, which has the focus.
  await page.locator('#game-title').filter({ hasText: 'New game' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'prompt');
  await page.getByRole('button', { name: 'Keyboard game' }).waitFor();
  assert.deepEqual(errors, []);
});

test('the harness’s steps show inline in the thread and survive a reload', { timeout: 30_000 }, async (t) => {
  const { page, errors } = await openEditor(t, (context, res) =>
    answer(
      res,
      { action: 'create', title: 'Stepped game', message: 'Built it.', game: { html: wordGame('Steps') } },
      { activity: steps },
    ),
  );
  const ui = controls(page);
  await ui.send('Build a game in steps.');
  await page.getByText('Built it.').waitFor();
  const shown = async () => {
    const list = page.getByRole('list', { name: 'Harness steps' });
    // A kept turn loads when it comes into view.
    await list.locator('.step-title').nth(2).waitFor();
    assert.equal(await page.locator('#messages details').count(), 0, 'no collapsed wrapper');
    assert.deepEqual(await list.locator('.step-title').allTextContents(), ['1 of 2 done', 'Bash', 'Edit index.html']);
    const test = list.getByRole('button', { name: /Bash/ });
    assert.equal(await test.getAttribute('aria-expanded'), 'false');
    await test.click();
    await list.getByText('3 passing').waitFor();
    await list.getByRole('button', { name: /Edit index\.html/ }).click();
    await list.locator('.diff .add').filter({ hasText: '+<p>new</p>' }).waitFor();
  };
  await shown();
  await page.reload();
  await page.getByText('Built it.').waitFor();
  await shown();
  assert.deepEqual(errors, []);
});

test('a proposal card flips the game before and after, applies and discards', { timeout: 45_000 }, async (t) => {
  let proposal = 0;
  const { page, errors } = await openEditor(t, (context, res) =>
    answer(
      res,
      !context.game
        ? { action: 'create', title: 'Words', message: 'Built it.', game: { html: wordGame('Alpha') } }
        : {
            action: 'edit',
            message: 'Here is option ' + ++proposal + '.',
            game: { html: wordGame(proposal === 1 ? 'Beta' : 'Gamma') },
          },
    ),
  );
  const ui = controls(page);
  const word = (text) => ui.game.locator('#word').filter({ hasText: text }).waitFor();
  await ui.send('Build a word.');
  await word('Alpha');
  await ui.send('Propose a new word.');
  const card = page.getByRole('region', { name: 'Proposed change' });
  await card.waitFor();
  const after = card.getByRole('button', { name: 'After', exact: true });
  const before = card.getByRole('button', { name: 'Before', exact: true });
  await word('Beta');
  assert.equal(await after.getAttribute('aria-pressed'), 'true');
  await before.click();
  await word('Alpha');
  assert.equal(await before.getAttribute('aria-pressed'), 'true');
  await after.click();
  await word('Beta');
  await card.getByRole('button', { name: 'Apply', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  await word('Beta');

  await ui.send('Propose another word.');
  await card.waitFor();
  await word('Gamma');
  await card.getByRole('button', { name: 'Discard', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  await word('Beta');
  // Branches live in History: a staged proposal can go to a new branch there.
  await ui.send('Propose a third word.');
  await card.waitFor();
  await ui.more('History');
  await page.getByRole('button', { name: 'Apply to a new branch…' }).click();
  await page.getByRole('textbox', { name: 'Branch name' }).fill('experiment');
  await page.getByRole('button', { name: 'Create branch' }).click();
  await page.locator('#thread-title').filter({ hasText: 'experiment' }).waitFor();
  assert.deepEqual(errors, []);
});

test(
  'a permission request reads in plain language, with its command in the closed details',
  { timeout: 30_000 },
  async (t) => {
    const command =
      'cd /work/zirbel/turn-fixture && sed -n 1,40p src/draw.c && cc -O2 -o draw src/draw.c && ./draw --only ships --only buildings > out.txt';
    const description = 'Render only the ship draws and only the buildings to find the black polygon';
    const asks = [
      {
        call: 'shell',
        tool: 'Bash',
        kind: 'execute',
        title: command,
        input: { command, description },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
      {
        call: 'issue',
        tool: 'mcp__github__create_issue',
        kind: 'other',
        title: 'Create an issue',
        input: { title: 'Bug' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    ];
    // A long step, as a harness's own message often is, which must not push the thread sideways.
    const activity = [
      {
        id: 'message:1',
        kind: 'message',
        title:
          'The title screen shows a black polygon under the ship, so I will render the draws one by one, find the draw that makes it and then fix the mesh that draw comes from.',
      },
    ];
    const { page, errors } = await openEditor(t, (context, res) =>
      answer(res, { action: 'reply', message: 'Done asking.' }, { asks, activity }),
    );
    const ui = controls(page);
    await ui.send('Find the black polygon.');
    const card = page.locator('.ask-card');
    await card.waitFor();
    assert.equal(await card.locator('.ask-title').textContent(), description);
    assert.equal(await card.getByText('Sandboxed', { exact: true }).isVisible(), true);
    await card
      .getByText('Runs in this turn’s folder on this computer, with no network and no access to your files.')
      .waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ask-card')), true);
    await page
      .locator('#announcer')
      .filter({ hasText: 'Test harness asks: ' + description })
      .waitFor();
    // The raw command is only in the details, which start closed.
    const details = card.locator('details.ask-details');
    assert.equal(await details.evaluate((box) => box.open), false);
    assert.equal(await card.locator('pre.command').textContent(), command);
    assert.equal(await card.locator('pre.command').isVisible(), false);
    assert.equal(await page.locator('#messages').getByText(command, { exact: true }).isVisible(), false);
    await card.locator('details.ask-details > summary').click();
    assert.equal(await card.locator('pre.command').isVisible(), true);
    await card.getByText('Folder: the turn’s folder').waitFor();
    // Long steps, the card and its command wrap inside the thread: nothing pushes it sideways.
    const fits = await page.locator('#activity-feed').evaluate((feed) => ({
      wide: feed.scrollWidth <= feed.clientWidth,
      left: feed.scrollLeft,
      card: feed.querySelector('.ask-card').getBoundingClientRect().right <= feed.getBoundingClientRect().right,
    }));
    assert.deepEqual(fits, { wide: true, left: 0, card: true });
    await card.getByRole('button', { name: 'Allow once' }).click();

    const outside = page.locator('.ask-card').filter({ hasText: 'Create an issue (github)' });
    await outside.waitFor();
    await outside.getByText('Outside the sandbox', { exact: true }).waitFor();
    await outside.getByText('Reaches github').waitFor();
    await outside.getByRole('button', { name: 'Reject' }).click();
    await page.getByText('Done asking.').waitFor();
    const answered = page.locator('.step[data-kind="request"] .step-state');
    assert.deepEqual(await answered.allTextContents(), ['Answered: Allow once', 'Answered: Reject']);
    assert.deepEqual(errors, []);
  },
);
