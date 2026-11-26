// A box (--box) on both hosts: `node dist/server.mjs --box` and the Go host's --box. Each runs one scripted session,
// from the box itself (loopback) and from this computer's own network address, and their normalized answers must
// match: the door, the pairing page and its codes and claim, the paired devices, the switches, the setup flag, the
// box's own Wi-Fi, external MCP access, the lobby a device that isn't paired is sent to, and its address for other
// devices; and in a second session, the editors of one game: its edit code, the edit page, what an editor may and may
// not do, and its session's end. What the hosts differ in by design is compared by its form only: harnesses
// run in the Node editor alone, and only it draws a QR code, for a pairing link or for joining the box's own Wi-Fi.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { hostsUnderTest, launch, tempDir } from './helpers.ts';

const hosts = hostsUnderTest();
/** This computer's address on a private network, which reaches the box as a device on its network would. */
const lan = Object.values(networkInterfaces()).flat().find((item) => item && !item.internal && item.family === 'IPv4' &&
  /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
if (!lan) console.log('# No private network address: the box contract runs from loopback only.');

/** A box on loopback, with the files a setup request and a switch of the box's own Wi-Fi leave for the box's setup
 *  service, and where that service would keep the own Wi-Fi's name and password. */
async function startBox(t: TestContext, command: string[]) {
  const root = tempDir(t, 'zirbel-box-');
  const account = join(root, 'account');
  mkdirSync(account, { mode: 0o700 });
  mkdirSync(join(root, 'run'));
  const wake = join(root, 'run', 'request');
  const own = join(root, 'own-network.json');
  // Its LAN player listener, which a box runs from start-up, on any free port.
  const { ready } = launch(t, command, ['--data', join(root, 'data'), '--port', '0', '--player-port', '0', '--box'],
    (line) => typeof line.editor === 'string' ? line.editor : undefined,
    { ZIRBEL_ACCOUNT_DIR: account, ZIRBEL_SETUP_REQUEST: wake, ZIRBEL_OWN_NETWORK: own });
  return { editor: await ready, wake, own, network: join(root, 'run', 'network'), account };
}
type Started = Awaited<ReturnType<typeof startBox>>;

type Step = { status: number; body: unknown; location?: string | null; cookie?: string; headers?: Record<string, string | null> };
/** The pairing and edit pages' headers, which a browser's form and its Origin depend on. */
const PAGE_HEADERS = ['content-type', 'cache-control', 'referrer-policy', 'content-security-policy', 'x-content-type-options'];
/** session: an owner's, as its cookie carries it; editor: an editor's of one game. */
type Call = { json?: unknown; form?: Record<string, string>; origin?: boolean; session?: string; editor?: string; raw?: string };

function client(base: string) {
  return async (method: string, path: string, { json, form, origin, session, editor, raw }: Call = {}): Promise<Step> => {
    const headers: Record<string, string> = {};
    if (origin) headers.origin = base;
    const cookies = [...(session ? ['zirbel_session=' + session] : []), ...(editor ? ['zirbel_editor=' + editor] : [])];
    if (cookies.length) headers.cookie = cookies.join('; ');
    if (json !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const body = raw ?? (json !== undefined ? JSON.stringify(json) : form ? new URLSearchParams(form) : undefined);
    const response = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* the pairing or edit page */ }
    const page = /^\/(?:pair|edit)(?:\?|$)/.test(path) && response.status < 300
      ? Object.fromEntries(PAGE_HEADERS.map((name) => [name, response.headers.get(name)])) : undefined;
    return { status: response.status, body: parsed, location: response.headers.get('location'),
      cookie: response.headers.getSetCookie().join('\n') || undefined, headers: page };
  };
}

const token = (step: Step) => /zirbel_session=([\w-]{43})/.exec(step.cookie ?? '')?.[1] ?? '';
const editorToken = (step: Step) => /zirbel_editor=([\w-]{43})/.exec(step.cookie ?? '')?.[1] ?? '';
/** What only one host has, compared by its presence or form. */
const HOST_SPECIFIC = new Set(['harnesses', 'canRunHarnesses', 'harnessesUnavailable', 'qr']);

function normalizer() {
  const ids = new Map<string, string>();
  const text = (value: string) => value
    .replaceAll(lan ?? '\0', '<lan>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{40}\b/g, (id) => {
      if (!ids.has(id)) ids.set(id, '<id' + ids.size + '>');
      return ids.get(id)!;
    })
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g, '<date>')
    .replace(/((?:127\.0\.0\.1|localhost|<lan>|\.local)):\d+/g, '$1:<port>')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g, '<code>')
    .replace(/\b[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}\b/g, '<edit-code>')
    .replace(/\bcode=[2-9A-HJ-NP-Z]{6}\b/g, 'code=<edit-code>')
    .replace(/zirbel_(session|editor)=[\w-]{43}/g, 'zirbel_$1=<token>');
  const walk = (value: unknown, key = ''): unknown => {
    if (HOST_SPECIFIC.has(key)) return '<host-specific>';
    // A project grant: when it expires, and its secret.
    if (typeof value === 'number' && key === 'expires') return '<expires>';
    if (typeof value === 'string' && key === 'token') return text(value).replace(/\.[\w-]{32}$/, '.<secret>');
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.keys(value).filter((field) => !HOST_SPECIFIC.has(field) || field === 'harnesses' || field === 'qr')
        .sort().map((field) => [field, walk((value as Record<string, unknown>)[field], field)]));
    return value;
  };
  return (step: Step) => ({ status: step.status, location: step.location ? text(step.location) : null, cookie: step.cookie ? text(step.cookie) : null,
    headers: step.headers ?? null, ...(step.status >= 300 ? {} : { body: walk(step.body) }) });
}

async function session({ editor: base, wake, own, network }: Started) {
  const steps: Step[] = [];
  const box = client(base);
  const record = async (step: Promise<Step>) => { const result = await step; steps.push(result); return result; };
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  // From the box itself, as its setup service asks: no pairing.
  const status = await box('GET', '/api/box/status');
  assert.equal(typeof (status.body as { capabilities: { memoryMB: unknown } }).capabilities.memoryMB, 'number');
  await record(Promise.resolve(status));
  const health = await box('GET', '/api/health');
  await record(Promise.resolve({ ...health, body: (health.body as { box: unknown }).box }));
  await record(box('GET', '/api/box/settings'));
  await record(box('PUT', '/api/box/settings', { json: { onboarded: true } }));
  await record(box('PUT', '/api/box/settings', { json: { nope: true } }));
  await record(box('PUT', '/api/box/settings', { json: { externalMcp: 'yes' } }));
  await record(box('PUT', '/api/box/settings', { raw: '{"onboarded":null}' }));
  await record(box('POST', '/api/box/setup', { json: { requested: true }, origin: true }));
  // The request wakes the box's setup service through its file.
  assert.ok(existsSync(wake), 'a setup request leaves the file that wakes the setup service');
  rmSync(wake);
  await record(box('POST', '/api/box/setup', { json: {}, origin: true }));

  // The box's own Wi-Fi: none to make until the setup service keeps a name and password; switching it wakes the service.
  await record(box('GET', '/api/box/network'));
  await record(box('PUT', '/api/box/settings', { json: { ownNetwork: true } }));
  assert.ok(!existsSync(network), 'a box with no network to make wakes nothing');
  writeFileSync(own, JSON.stringify({ version: 1, name: 'Zirbel 3F2A', password: 'abcd-efgh-jkmn' }));
  await record(box('GET', '/api/box/network'));
  await record(box('PUT', '/api/box/settings', { json: { ownNetwork: true } }));
  assert.ok(existsSync(network), 'switching the box’s own Wi-Fi wakes the setup service');
  rmSync(network);
  await record(box('PUT', '/api/box/settings', { json: { ownNetwork: true } }));
  assert.ok(!existsSync(network) && !existsSync(wake), 'a setting kept as it was wakes nothing');
  await record(box('PUT', '/api/box/settings', { json: { ownNetwork: 'on' } }));
  await record(box('GET', '/api/box/network'));
  await record(box('GET', '/api/box/status'));
  await record(box('POST', '/api/pairing', { json: {}, origin: true }));
  await record(box('GET', '/pair'));
  await record(box('GET', '/pair?code=abcd%20efgh'));
  await record(box('PUT', '/pair'));
  const project = (await box('POST', '/api/projects', { json: { title: 'Box' }, origin: true })).body as { id: string };
  if (!lan) return steps;

  // From a device on the box's network.
  const device = client(base.replace('127.0.0.1', lan));
  await record(device('GET', '/api/projects'));
  // Playing needs no pairing: the box's / sends a device to the lobby on its LAN player listener, by the name it asked
  // for, and the lobby there links to pairing for those who own the box.
  const door = await record(device('GET', '/'));
  assert.match(door.location ?? '', new RegExp('^http://' + lan.replaceAll('.', '\\.') + ':\\d+/$'));
  const lobby = client(door.location!.slice(0, -1));
  await record(lobby('GET', '/'));
  await record(lobby('GET', '/lobby/state'));
  await record(device('GET', '/workspace.js'));
  await record(device('GET', '/api/box/status'));
  await record(device('POST', '/pair', { form: { claim: '1' } }));
  await record(device('POST', '/pair', { form: { claim: '1' }, origin: true }));
  const first = token(steps.at(-1)!);
  await record(device('POST', '/pair', { form: { claim: '1' }, origin: true }));
  await record(device('POST', '/pair', { form: { claim: '2' }, origin: true }));
  await record(device('GET', '/pair', { session: first }));
  await record(device('GET', '/api/pairing/devices', { session: first }));
  await record(device('GET', '/api/box/status', { session: first }));
  // The lobby's address for other devices: on the name this device reached the box by, at the LAN listener's port.
  const lobbyAddress = await record(device('GET', '/api/lobby', { session: first }));
  assert.equal((lobbyAddress.body as { link: string }).link, door.location);
  await record(device('PUT', '/api/box/settings', { json: { onboarded: false }, session: first }));
  await record(device('PUT', '/api/box/settings', { json: { onboarded: false }, session: first, origin: true }));
  const code = ((await record(device('POST', '/api/pairing', { json: {}, session: first, origin: true }))).body as { code: string }).code;
  await record(device('POST', '/pair', { form: { code: 'ZZZZ-ZZZZ' }, origin: true }));
  await record(device('POST', '/pair', { form: { code: code.toLowerCase().replace('-', '') }, origin: true }));
  const second = token(steps.at(-1)!);
  await record(device('POST', '/pair', { form: { code }, origin: true }));
  const listed = await record(device('GET', '/api/pairing/devices', { session: second }));
  const secondId = (listed.body as { devices: { id: string; current: boolean }[] }).devices.find((item) => item.current)!.id;
  await record(device('DELETE', '/api/pairing/devices/' + secondId, { session: first, origin: true }));
  await record(device('GET', '/api/projects', { session: second }));
  await record(device('DELETE', '/api/pairing/devices/' + secondId, { session: first, origin: true }));
  await record(device('DELETE', '/api/pairing/devices/NOT_AN_ID', { session: first, origin: true }));
  await record(device('POST', '/api/box/setup', { json: { requested: false }, session: first, origin: true }));
  await record(device('POST', '/api/box/setup', { json: { requested: true }, session: first, origin: true }));
  assert.ok(existsSync(wake), 'a paired device’s setup request wakes the setup service too');
  // Only a paired device sees the box's own Wi-Fi's password, and switches it.
  await record(device('GET', '/api/box/network'));
  await record(device('GET', '/api/box/network', { session: first }));
  await record(device('PUT', '/api/box/settings', { json: { ownNetwork: false }, session: first, origin: true }));
  assert.ok(existsSync(network), 'a paired device’s switch wakes the setup service');
  await record(device('POST', '/turn-mcp', { json: ping, session: first, origin: true }));

  // External MCP access: off, the network gets no MCP; on, a project grant opens it.
  await record(device('POST', '/mcp', { json: ping }));
  await record(box('POST', '/api/projects/' + project.id + '/grants', { json: { write: false, hours: 1 }, origin: true }));
  await record(box('PUT', '/api/box/settings', { json: { externalMcp: true } }));
  const grant = (await record(box('POST', '/api/projects/' + project.id + '/grants', { json: { write: false, hours: 1 }, origin: true }))).body as { token: string };
  const mcp = (credential: string) => fetch(base.replace('127.0.0.1', lan) + '/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credential }, body: JSON.stringify(ping) })
    .then(async (response) => ({ status: response.status, body: await response.json() as unknown }));
  await record(mcp(grant.token));
  await record(mcp('nope'));
  await record(box('PUT', '/api/box/settings', { json: { externalMcp: false } }));
  await record(mcp(grant.token));

  // Wrong codes from one address: ten in a minute, then none.
  for (let tries = 0; tries < 10; tries++) await record(device('POST', '/pair', { form: { code: 'ZZZZ-ZZZY' }, origin: true }));
  return steps;
}

const ONE_GAME = 'This device edits one game only.';
const ENDED = 'This device’s edit access has ended. Ask the box’s owner for a new edit code.';
const SHOWN_CODE = /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
type Game = { id: string; title: string; branches: { main: string }; revisions: { game?: { html: string } }[] };

/** The editors of one game: the owner makes its code, other devices redeem it and edit that game alone, and their
 *  sessions end when the owner removes them, the code stops or expires, or the game goes. */
async function editorsSession({ editor: base, account }: Started) {
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

const results = new Map<string, Step[]>();
const editing = new Map<string, Step[]>();

for (const host of hosts) {
  for (const [name, run, kept] of [['session', session, results], ['editors session', editorsSession, editing]] as const) {
    test(host.name + ' box runs the scripted ' + name, async (t) => {
      const steps = await run(await startBox(t, host.command));
      for (const [index, step] of steps.entries()) assert.ok(step.status < 500, 'step ' + index + ': ' + step.status + ' ' + JSON.stringify(step.body));
      kept.set(host.name, steps);
    });
  }
}

if (hosts.length > 1) {
  for (const [name, kept] of [['session', results], ['editors session', editing]] as const) {
    test('both boxes answer the ' + name + ' identically', (t) => {
      const node = kept.get('node')!.map(normalizer());
      const go = kept.get('go')!.map(normalizer());
      t.diagnostic(node.length + ' steps: ' + node.map(({ status }) => status).join(' '));
      assert.equal(go.length, node.length);
      for (const [index, step] of node.entries()) assert.deepEqual(go[index], step, 'step ' + index);
    });
  }
}

test('the Go box runs no harnesses and says why', { skip: !hosts.some((host) => host.name === 'go') }, async (t) => {
  const { editor } = await startBox(t, hosts.find((host) => host.name === 'go')!.command);
  const box = client(editor);
  const status = (await box('GET', '/api/box/status')).body as { capabilities: { harnesses: boolean }; settings: { harnesses: boolean } };
  assert.equal(status.capabilities.harnesses, false);
  assert.equal(status.settings.harnesses, false);
  const refused = await box('PUT', '/api/box/settings', { json: { harnesses: true } });
  assert.equal(refused.status, 409);
  assert.match((refused.body as { error: string }).error, /Use your own agent over MCP instead\./);
  assert.deepEqual((await box('GET', '/api/processors')).body, { processors: [] });
});
