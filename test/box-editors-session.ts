// The box contract's second scripted session: the editors of one game, from its edit code and the edit page to what an
// editor may and may not do and its session's end.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { client, editorToken, lan, token, type Started, type Step } from './box-contract-fixture.ts';

const ONE_GAME = 'This device edits one game only.';
const ENDED = 'This device’s edit access has ended. Ask the box’s owner for a new edit code.';
const SHOWN_CODE = /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
type Game = { id: string; title: string; branches: { main: string }; revisions: { game?: { html: string } }[] };

/** The editors of one game: the owner makes its code, other devices redeem it and edit that game alone, and their
 *  sessions end when the owner removes them, the code stops or expires, or the game goes. */
export async function editorsSession(_t: TestContext, { editor: base, account }: Started) {
  const steps: Step[] = [];
  const box = client(base);
  const record = async (step: Promise<Step>) => { const result = await step; steps.push(result); return result; };
  /** Its status alone: a page or a body the hosts build apart (the editor's page, a playtest's link). */
  const status = async (step: Promise<Step>) => { const result = await step; steps.push({ status: result.status, body: null }); return result; };
  const refused = async (step: Promise<Step>, error = ONE_GAME) => {
    const result = await record(step);
    assert.deepEqual([result.status, (result.body as { error: string }).error], [error === ENDED ? 401 : 403, error]);
  };
  await record(box('GET', '/api/me'));
  const meadow = (await box('POST', '/api/projects', { json: { title: 'Meadow' }, origin: true })).body as Game;
  const other = (await box('POST', '/api/projects', { json: { title: 'Other' }, origin: true })).body as Game;
  await record(box('GET', '/edit'));
  await record(box('GET', '/edit?code=nope'));
  // The box itself owns it: it makes codes, and redeems none.
  const local = await record(box('POST', '/api/projects/' + meadow.id + '/edit-code', { origin: true }));
  await record(box('POST', '/edit', { form: { code: (local.body as { code: string }).code, name: 'Box' }, origin: true }));
  if (!lan) return steps;

  const device = client(base.replace('127.0.0.1', lan));
  const at = base.replace('127.0.0.1', lan);
  const owner = token(await device('POST', '/pair', { form: { claim: '1' }, origin: true }));
  await record(device('GET', '/api/me', { session: owner }));
  const made = await record(device('POST', '/api/projects/' + meadow.id + '/edit-code', { session: owner, origin: true }));
  const { code, link, expiresAt } = made.body as { code: string; link: string; expiresAt: string };
  assert.match(code, SHOWN_CODE);
  assert.equal(link, at + '/edit?code=' + code.replace('-', ''));
  assert.ok(Math.abs(Date.parse(expiresAt) - Date.now() - 7 * 86_400_000) < 60_000, 'a code opens its game for a week');
  await record(device('POST', '/api/projects/' + meadow.id + '/edit-code', { session: owner }));
  await record(device('POST', '/api/projects/missing/edit-code', { session: owner, origin: true }));
  await record(device('POST', '/api/projects/' + meadow.id + '/edit-code', { origin: true }));
  await record(device('GET', '/api/projects/' + meadow.id + '/editors', { session: owner }));
  await record(device('GET', '/api/projects/' + meadow.id + '/edit-code', { session: owner }));

  // The edit page, opened by the code's link, and the lobby's link to it for those who have a code.
  await record(device('GET', '/edit?code=' + code.replace('-', '').toLowerCase()));
  const door = await device('GET', '/');
  const lobby = await record(client(door.location!.slice(0, -1))('GET', '/lobby/state'));
  assert.equal((lobby.body as { edit: string }).edit, at + '/edit');
  await record(device('POST', '/edit', { form: { code, name: 'Ada' } }));
  await record(device('POST', '/edit', { form: { code, name: 'Ada' }, origin: true, session: owner }));
  await record(device('POST', '/edit', { form: { code: 'ZZZ-ZZZ', name: 'Ada' }, origin: true }));
  for (const form of [{ code, name: ' ' }, { code, name: 'x'.repeat(25) }, { code }, { code, name: 'Ada', more: '1' }] as Record<string, string>[])
    await record(device('POST', '/edit', { form, origin: true }));
  await record(device('PUT', '/edit', { origin: true }));
  const ada = editorToken(await record(device('POST', '/edit', { form: { code: code.toLowerCase().replace('-', ' '), name: ' Ada ' }, origin: true })));
  // A code lets several people in.
  const bo = editorToken(await record(device('POST', '/edit', { form: { code, name: 'Bo' }, origin: true })));

  // An editor sees its game alone, and saves a change to it, which becomes a revision.
  await record(device('GET', '/api/me', { editor: ada }));
  await status(device('GET', '/', { editor: ada }));
  await status(device('GET', '/api/health', { editor: ada }));
  await record(device('GET', '/api/projects', { editor: ada }));
  const opened = await device('GET', '/api/projects/' + meadow.id, { editor: ada });
  const read = opened.body as Game;
  steps.push({ status: opened.status, body: { title: read.title, revisions: read.revisions.length } });
  await record(device('GET', '/api/lobby', { editor: ada }));
  await record(device('GET', '/api/rooms', { editor: ada }));
  const change = (html: string, baseRevision: string) => ({ json: { baseRevision, branch: 'main', label: 'Ada’s change',
    operations: [{ op: 'writeGame', game: { html } }] }, editor: ada, origin: true });
  const staged = await status(device('POST', '/api/projects/' + meadow.id + '/proposals', change('<p>Ada</p>', read.branches.main)));
  await status(device('POST', '/api/projects/' + meadow.id + '/apply/' + (staged.body as { proposal: { id: string } }).proposal.id,
    { json: {}, editor: ada, origin: true }));
  const reread = await device('GET', '/api/projects/' + meadow.id, { editor: ada });
  const saved = reread.body as Game;
  steps.push({ status: reread.status, body: { revisions: saved.revisions.length, html: saved.revisions.at(-1)?.game?.html } });
  // One made on the revision it had is refused: it refreshes first.
  await status(device('POST', '/api/projects/' + meadow.id + '/proposals', change('<p>Stale</p>', read.branches.main)));
  const asset = await status(device('POST', '/api/projects/' + meadow.id + '/asset', { json: { branch: 'main', baseRevision: saved.branches.main,
    name: 'Dot', author: 'Ada', source: 'https://example.com/dot.png', license: 'CC0-1.0', credit: '', media: 'image/png', data: png },
  editor: ada, origin: true }));
  await status(device('POST', '/api/projects/' + meadow.id + '/apply/' + (asset.body as { proposal: { id: string } }).proposal.id,
    { json: {}, editor: ada, origin: true }));
  const playtest = await status(device('POST', '/api/projects/' + meadow.id + '/playtest', { json: { branch: 'main' }, editor: ada, origin: true }));
  await record(device('POST', '/api/rooms/' + (playtest.body as { id: string }).id + '/close', { json: {}, editor: ada, origin: true }));
  await record(device('POST', '/api/rooms/' + (playtest.body as { id: string }).id + '/close', { json: {}, editor: ada, origin: true }));

  // Nothing else: another game, games, imports, releases, the lobby's offers, the box's settings, pairing, harnesses
  // (the Go host has none: refused alike), and the game's code and editors.
  const any = (method: string) => method === 'GET' ? { editor: ada } : { json: {}, editor: ada, origin: true };
  for (const [method, path] of [['GET', '/api/projects/' + other.id], ['POST', '/api/projects/' + other.id + '/proposals'],
    ['POST', '/api/projects'], ['POST', '/api/projects/import'], ['POST', '/api/projects/import-game'],
    ['POST', '/api/projects/' + meadow.id + '/remove'], ['POST', '/api/projects/' + meadow.id + '/release'],
    ['POST', '/api/projects/' + meadow.id + '/edit-code'], ['GET', '/api/projects/' + meadow.id + '/editors'],
    ['GET', '/api/box/settings'], ['PUT', '/api/box/settings'], ['GET', '/api/box/network'], ['POST', '/api/box/setup'],
    ['GET', '/api/box/controllers'], ['POST', '/api/box/controllers/scan'], ['POST', '/api/box/controllers/forget'],
    ['GET', '/api/pairing/devices'], ['POST', '/api/pairing'], ['GET', '/api/processors'], ['POST', '/api/chat'],
    ['POST', '/api/projects/' + meadow.id + '/prompt'], ['GET', '/api/projects/' + meadow.id + '/thread'],
    ['GET', '/api/releases'], ['POST', '/api/releases/import'], ['POST', '/api/lobby/offer'], ['POST', '/api/rooms']] as const)
    await refused(device(method, path, any(method)));

  // Its own agent, for this game, while the box's owner lets agents in over MCP.
  const grant = { json: { write: true, hours: 168 }, editor: ada, origin: true };
  await record(device('POST', '/api/projects/' + meadow.id + '/grants', grant));
  await box('PUT', '/api/box/settings', { json: { externalMcp: true } });
  const given = await record(device('POST', '/api/projects/' + meadow.id + '/grants', grant));
  const mcp = await fetch(at + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json',
    authorization: 'Bearer ' + (given.body as { token: string }).token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  await record(Promise.resolve({ status: mcp.status, body: await mcp.json() as unknown }));
  await box('PUT', '/api/box/settings', { json: { externalMcp: false } });

  // The owner sees who edits, and removes one: its next request is refused at once.
  const listed = await record(device('GET', '/api/projects/' + meadow.id + '/editors', { session: owner }));
  const removed = (listed.body as { editors: { id: string; name: string }[] }).editors.find((item) => item.name === 'Bo')!.id;
  await refused(device('DELETE', '/api/projects/' + meadow.id + '/editors/' + removed, { editor: ada, origin: true }));
  await record(device('DELETE', '/api/projects/' + meadow.id + '/editors/' + removed, { session: owner, origin: true }));
  await refused(device('GET', '/api/projects', { editor: bo }), ENDED);
  await record(device('GET', '/', { editor: bo }));
  await record(device('DELETE', '/api/projects/' + meadow.id + '/editors/' + removed, { session: owner, origin: true }));
  await record(device('DELETE', '/api/projects/' + meadow.id + '/editors/NOT_AN_ID', { session: owner, origin: true }));

  // A stopped code lets nobody new in, and those editing stay; a new code replaces the last.
  await record(device('POST', '/api/projects/' + meadow.id + '/edit-code/stop', { session: owner, origin: true }));
  await record(device('GET', '/api/projects/' + meadow.id + '/editors', { session: owner }));
  await record(device('POST', '/edit', { form: { code, name: 'Cy' }, origin: true }));
  await record(device('GET', '/api/me', { editor: ada }));
  const replaced = ((await record(device('POST', '/api/projects/' + meadow.id + '/edit-code', { session: owner, origin: true }))).body as { code: string }).code;
  const current = ((await record(device('POST', '/api/projects/' + meadow.id + '/edit-code', { session: owner, origin: true }))).body as { code: string }).code;
  if (replaced !== current) await record(device('POST', '/edit', { form: { code: replaced, name: 'Cy' }, origin: true }));
  // An expired code, as the account folder keeps it in both hosts.
  const file = join(account, 'box', 'editors.json');
  const kept = JSON.parse(readFileSync(file, 'utf8')) as { codes: { expiresAt: string }[]; editors: object[] };
  assert.deepEqual(Object.keys(kept), ['version', 'codes', 'editors']);
  assert.deepEqual(kept.codes.map((item) => Object.keys(item)), [['project', 'code', 'createdAt', 'expiresAt']]);
  assert.deepEqual(Object.keys(kept.editors[0]!), ['id', 'project', 'name', 'tokenHash', 'since', 'lastSeen']);
  kept.codes[0]!.expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(file, JSON.stringify(kept));
  await record(device('POST', '/edit', { form: { code: current, name: 'Cy' }, origin: true }));
  await record(device('GET', '/api/projects/' + meadow.id + '/editors', { session: owner }));

  // A device that redeems another game's code edits that game instead; one that pairs is an owner, and edits none.
  const otherCode = ((await device('POST', '/api/projects/' + other.id + '/edit-code', { session: owner, origin: true })).body as { code: string }).code;
  const moved = editorToken(await record(device('POST', '/edit', { form: { code: otherCode, name: 'Ada' }, origin: true, editor: ada })));
  await refused(device('GET', '/api/me', { editor: ada }), ENDED);
  await record(device('GET', '/api/me', { editor: moved }));
  const pairing = ((await device('POST', '/api/pairing', { json: {}, session: owner, origin: true })).body as { code: string }).code;
  const paired = await record(device('POST', '/pair', { form: { code: pairing }, origin: true, editor: moved }));
  assert.match(paired.cookie ?? '', /\nzirbel_editor=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/);
  await record(device('GET', '/api/me', { session: token(paired) }));
  await refused(device('GET', '/api/me', { editor: moved }), ENDED);

  // A removed game takes its code and its editors with it.
  const last = ((await device('POST', '/api/projects/' + meadow.id + '/edit-code', { session: owner, origin: true })).body as { code: string }).code;
  const cy = editorToken(await record(device('POST', '/edit', { form: { code: last, name: 'Cy' }, origin: true })));
  await record(device('POST', '/api/projects/' + meadow.id + '/remove', { json: {}, session: owner, origin: true }));
  await refused(device('GET', '/api/projects', { editor: cy }), ENDED);
  await record(device('GET', '/api/projects/' + meadow.id + '/editors', { session: owner }));
  await record(device('POST', '/edit', { form: { code: last, name: 'Cy' }, origin: true }));

  // Wrong codes from one address: ten in a minute, then none, for the right code too.
  for (let tries = 0; tries < 6; tries++) await record(device('POST', '/edit', { form: { code: 'ZZZ-ZZY', name: 'Cy' }, origin: true }));
  await record(device('POST', '/edit', { form: { code: otherCode, name: 'Cy' }, origin: true }));
  return steps;
}
