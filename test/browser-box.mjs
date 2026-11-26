// A Zirbel box in the browser: the first-run choice, agent access over MCP, Box settings with its switches, pairing
// another device with a one-time code, the claim the pairing page offers while no device has paired, the lobby's
// address for players, the box's own Wi-Fi with its name, password and QR code, and a game's edit code, with which
// another device edits that game alone.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { controls, openEditor } from './browser-editor.mjs';

// Where the box's setup service would keep its own Wi-Fi's name and password, and the files that wake it.
const setup = mkdtempSync(join(tmpdir(), 'zirbel-browser-setup-'));
after(() => rmSync(setup, { recursive: true, force: true }));
mkdirSync(join(setup, 'run'));
process.env.ZIRBEL_OWN_NETWORK = join(setup, 'own-network.json');
process.env.ZIRBEL_SETUP_REQUEST = join(setup, 'run', 'request');

test('a box asks how to use it once, turns on agent access, and pairs another device with a code', { timeout: 60_000 }, async (t) => {
  const { page, editor, browser, errors } = await openEditor(t, async (_context, res) => res.end('{}'),
    ['--box', '--player-port', '0', '--player-host', 'games.lan']);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'How do you want to use Zirbel here?' }).waitFor();
  assert.ok(await dialog.getByText('Run harnesses on this box', { exact: true }).isVisible());
  await dialog.getByRole('button', { name: 'Turn on agent access' }).click();
  await dialog.getByRole('heading', { name: 'Agent access' }).waitFor();
  assert.equal(await dialog.getByRole('textbox', { name: 'MCP endpoint' }).inputValue(), editor + '/mcp');
  assert.ok(await dialog.getByText(/Make or import a game first/).isVisible());
  await page.keyboard.press('Escape');

  // Once chosen, the box doesn't ask again.
  await page.reload();
  await page.getByRole('textbox', { name: 'Describe a game' }).waitFor();
  const settings = async () => {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Box settings…' }).click();
    await dialog.getByRole('heading', { name: 'Box settings' }).waitFor();
  };
  await settings();
  assert.equal(await dialog.getByRole('checkbox', { name: 'Let agents on your network use this box over MCP' }).isChecked(), true);
  assert.equal(await dialog.getByRole('checkbox', { name: 'Run harnesses on this box' }).isChecked(), true);
  await dialog.getByRole('button', { name: 'Pair another device' }).click();
  const code = (await dialog.locator('.sign-in-code').textContent()) ?? '';
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok(await dialog.getByRole('img', { name: /^QR code for http:\/\/.+\.local:\d+\/pair\?code=/ }).isVisible());

  // Another device's browser: the pairing page offers the claim while no device has paired, and takes the code.
  const other = await browser.newPage();
  await other.goto(editor + '/pair');
  assert.ok(await other.getByRole('button', { name: 'Claim this box' }).isVisible());
  await other.getByRole('textbox', { name: /Pairing code/ }).fill(code.toLowerCase());
  await other.getByRole('button', { name: 'Pair this device' }).click();
  await other.getByRole('textbox', { name: 'Describe a game' }).waitFor();
  // A paired device that opens the pairing page again goes to the workspace.
  await other.goto(editor + '/pair');
  assert.equal(other.url(), editor + '/');
  await page.keyboard.press('Escape');
  await settings();
  await dialog.getByRole('button', { name: 'Remove' }).waitFor();
  assert.match((await dialog.locator('.item strong').first().textContent()) ?? '', /^Chrome on /);
  assert.ok(await dialog.getByText('This box can’t make its own Wi-Fi: it has no Wi-Fi setup.').isVisible());
  assert.ok(await dialog.getByRole('checkbox', { name: 'Make the box’s own Wi-Fi' }).isDisabled());
  // Players open the lobby with no pairing: its address on the box's LAN listener, as its player host names it from
  // the box itself, and its QR code.
  assert.ok(await dialog.getByRole('heading', { name: 'Players' }).isVisible());
  assert.match((await dialog.locator('.lobby-address').textContent()) ?? '', /^http:\/\/games\.lan:\d+\/$/);
  assert.ok(await dialog.getByRole('img', { name: 'QR code that opens the lobby' }).isVisible());
  assert.deepEqual(errors, []);
});

test('a box makes its own Wi-Fi only after showing its name and password, then shows them with a code that joins it', { timeout: 60_000 }, async (t) => {
  writeFileSync(process.env.ZIRBEL_OWN_NETWORK, JSON.stringify({ version: 1, name: 'Zirbel 3F2A', password: 'abcd-efgh-jkmn' }));
  t.after(() => rmSync(process.env.ZIRBEL_OWN_NETWORK, { force: true }));
  const woken = join(setup, 'run', 'network');
  const { page, errors } = await openEditor(t, async (_context, res) => res.end('{}'), ['--box', '--player-port', '0']);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Not now' }).click();
  const settings = async () => {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Box settings…' }).click();
    await dialog.getByRole('heading', { name: 'Box settings' }).waitFor();
  };
  const own = dialog.getByRole('checkbox', { name: 'Make the box’s own Wi-Fi' });
  /** The switch once the page has put it back, or not. */
  const settled = async (checked) => {
    for (let tries = 0; tries < 50 && await own.isChecked() !== checked; tries++) await page.waitForTimeout(100);
    return own.isChecked();
  };
  await settings();
  assert.equal(await own.isChecked(), false);
  // Switching it on shows the network to join first; Cancel leaves it off.
  await own.check();
  await dialog.getByRole('button', { name: 'Make it now' }).waitFor();
  assert.equal(await dialog.locator('.sign-in-code').textContent(), 'Zirbel 3F2A');
  assert.equal(await dialog.getByRole('textbox', { name: 'Wi-Fi password' }).inputValue(), 'abcd-efgh-jkmn');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await own.isChecked(), false);
  assert.ok(!existsSync(woken));
  await own.check();
  await dialog.getByRole('button', { name: 'Make it now' }).click();
  await dialog.getByText('The box is making its own Wi-Fi. Join it on this device:').waitFor();
  const there = await dialog.getByRole('link', { name: /^http:\/\/10\.42\.0\.1(?::\d+)?\/pair\?code=/ }).textContent();
  assert.match(there ?? '', /code=[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok(existsSync(woken), 'the switch wakes the setup service');
  rmSync(woken);

  // While it is on, Box settings shows its name, its password and a QR code that joins it.
  await page.keyboard.press('Escape');
  await settings();
  assert.equal(await own.isChecked(), true);
  assert.ok(await dialog.getByRole('img', { name: 'QR code that joins Zirbel 3F2A' }).isVisible());
  assert.equal(await dialog.getByRole('textbox', { name: 'Wi-Fi password' }).inputValue(), 'abcd-efgh-jkmn');
  // Switching it off asks first: declined, it stays on.
  page.once('dialog', (confirm) => void confirm.dismiss());
  await own.click();
  assert.equal(await settled(true), true, 'declining keeps it on');
  assert.ok(!existsSync(woken));
  page.once('dialog', (confirm) => void confirm.accept());
  await own.click();
  await page.getByText('The box ends its own Wi-Fi.').waitFor();
  assert.equal(await own.isChecked(), false);
  assert.ok(existsSync(woken), 'switching it off wakes the setup service too');
  assert.deepEqual(errors, []);
});

// Another device reaches the box on this computer's network address, as a phone on the box's network would: loopback
// is the box itself, which owns it.
const networkAddress = Object.values(networkInterfaces()).flat().some((item) => item && !item.internal && item.family === 'IPv4' &&
  /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/.test(item.address));

test('an edit code lets another device edit that one game, until the owner removes it', { timeout: 90_000, skip: !networkAddress }, async (t) => {
  const { page, browser, errors } = await openEditor(t, async (_context, res) => res.end('{}'), ['--box', '--player-port', '0']);
  const ui = controls(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Not now' }).click();
  const secret = await page.evaluate(async () => {
    const post = async (path, body) => (await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) })).json();
    const meadow = await post('/api/projects', { title: 'Meadow' });
    const staged = await post('/api/projects/' + meadow.id + '/proposals', { baseRevision: meadow.branches.main, branch: 'main',
      label: 'Start', operations: [{ op: 'writeGame', game: { html: '<p id="word">Meadow</p>' } }] });
    await post('/api/projects/' + meadow.id + '/apply/' + staged.proposal.id, {});
    return (await post('/api/projects', { title: 'Secret' })).id;
  });
  await page.reload();
  await page.locator('#prompt').waitFor();
  await ui.choose('Meadow');
  await ui.game.locator('#word').filter({ hasText: 'Meadow' }).waitFor();

  // The owner opens the game's code: big, with its link and its QR code.
  await ui.more('Invite editors…');
  await dialog.getByRole('heading', { name: 'Invite editors · Meadow' }).waitFor();
  await dialog.getByText('No edit code is open.', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'New code' }).click();
  await dialog.locator('.edit-code').waitFor();
  const code = (await dialog.locator('.edit-code').textContent()) ?? '';
  assert.match(code, /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/);
  const link = (await dialog.getByRole('link', { name: /\/edit\?code=/ }).textContent()) ?? '';
  assert.match(link, new RegExp('^http://[\\d.]+:\\d+/edit\\?code=' + code.replace('-', '') + '$'));
  assert.ok(await dialog.getByRole('img', { name: 'QR code that opens ' + link }).isVisible());
  await page.keyboard.press('Escape');

  // A device that isn't paired finds the edit page from the lobby too.
  const origin = new URL(link).origin;
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(origin + '/');
  const toEdit = visitor.getByRole('link', { name: 'Have an edit code?' });
  await toEdit.waitFor();
  assert.equal(await toEdit.getAttribute('href'), origin + '/edit');

  // Another device opens the link, gives its name, and edits that game.
  const other = await (await browser.newContext()).newPage();
  const otherErrors = [];
  other.on('pageerror', (error) => otherErrors.push(error.message));
  await other.goto(link);
  assert.equal(await other.getByRole('textbox', { name: /^Edit code/ }).inputValue(), code);
  await other.getByRole('textbox', { name: /^Your name/ }).fill('Ada');
  await other.getByRole('button', { name: 'Start editing' }).click();
  await other.locator('#game-title').filter({ hasText: 'Meadow' }).waitFor();
  const theirs = controls(other);
  await theirs.game.locator('#word').filter({ hasText: 'Meadow' }).waitFor();
  await other.getByText('The AI on this box is its owner’s.', { exact: false }).waitFor();
  assert.ok(await other.getByText(/Its owner can turn on agent access/).isVisible());
  assert.equal(await other.locator('#prompt-form').isVisible(), false);
  // Its menus have its game alone, and nothing of the box's.
  await theirs.switcher.click();
  const games = other.getByRole('menu', { name: 'Games' });
  assert.deepEqual(await games.getByRole('menuitemradio').allTextContents(), ['Meadow']);
  assert.deepEqual(await games.getByRole('menuitem').allTextContents(), ['Lobby…']);
  await other.keyboard.press('Escape');
  await other.getByRole('button', { name: 'More', exact: true }).click();
  const more = await other.getByRole('menu', { name: 'More' }).getByRole('menuitem').allTextContents();
  assert.ok(more.includes('History') && !more.some((item) => /Box settings|Invite editors|Harnesses|Set up a Zirbel box/.test(item)), more.join(', '));
  await other.keyboard.press('Escape');
  await other.getByRole('button', { name: 'Share', exact: true }).click();
  await other.getByRole('dialog').getByText('Development multiplayer').waitFor();
  assert.equal(await other.getByText('Publish a release').count(), 0);
  await other.keyboard.press('Escape');
  // Its change to the source becomes a revision of the game, which the owner sees.
  await theirs.edit.click();
  await other.getByRole('button', { name: 'Source', exact: true }).click();
  await other.getByRole('textbox', { name: 'Game source' }).fill('<p id="word">Ada was here</p>');
  await other.getByRole('button', { name: 'Save source' }).click();
  await theirs.game.locator('#word').filter({ hasText: 'Ada was here' }).waitFor();
  const labels = await page.evaluate(async (id) => (await (await fetch('/api/projects/' + id)).json()).revisions.map(({ label }) => label),
    await ui.projectId('Meadow'));
  assert.equal(labels.at(-1), 'Edit game source');
  assert.equal(await other.evaluate((id) => fetch('/api/projects/' + id).then((response) => response.status), secret), 403);

  // The owner sees who edits, and removes them: their next request is refused.
  await ui.more('Invite editors…');
  await dialog.getByText('Ada', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await dialog.getByText('Nobody is editing this game with a code.').waitFor();
  assert.equal(await other.evaluate(() => fetch('/api/projects').then((response) => response.status)), 401);
  assert.deepEqual([...errors, ...otherErrors], []);
});
