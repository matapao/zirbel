// A Zirbel box in the browser: the first-run choice, agent access over MCP, Box settings with its switches, pairing
// another device with a one-time code, the claim the pairing page offers while no device has paired, and the box's own
// Wi-Fi with its name, password and QR code.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openEditor } from './browser-editor.mjs';

// Where the box's setup service would keep its own Wi-Fi's name and password, and the files that wake it.
const setup = mkdtempSync(join(tmpdir(), 'zirbel-browser-setup-'));
after(() => rmSync(setup, { recursive: true, force: true }));
mkdirSync(join(setup, 'run'));
process.env.ZIRBEL_OWN_NETWORK = join(setup, 'own-network.json');
process.env.ZIRBEL_SETUP_REQUEST = join(setup, 'run', 'request');

test('a box asks how to use it once, turns on agent access, and pairs another device with a code', { timeout: 60_000 }, async (t) => {
  const { page, editor, browser, errors } = await openEditor(t, async (_context, res) => res.end('{}'), ['--box', '--player-port', '0']);
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
