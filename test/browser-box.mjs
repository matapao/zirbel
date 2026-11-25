// A Zirbel box in the browser: the first-run choice, agent access over MCP, Box settings with its switches, pairing
// another device with a one-time code, and the claim the pairing page offers while no device has paired.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openEditor } from './browser-editor.mjs';

test('a box asks how to use it once, turns on agent access, and pairs another device with a code', { timeout: 60_000 }, async (t) => {
  const { page, editor, browser, errors } = await openEditor(t, async (_context, res) => res.end('{}'), ['--box']);
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
  assert.deepEqual(errors, []);
});
