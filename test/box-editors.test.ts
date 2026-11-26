// Editors of one game on a box (box mode): each game's edit code, the sessions of those who redeemed one, what an
// editor may do in the editor's API, the /edit page at the box's door, and the owners' API for codes and editors.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Projects } from '../packages/core/projects.ts';
import { EDIT_CODE_MS, EDITORS_PER_GAME, editCode, editorName, editorToken, Editors, ENDED, ONE_GAME, plainEditCode,
  WRONG_EDIT_CODE } from '../packages/server/box-editors.ts';
import { editorsRequest, OWNS } from '../packages/server/box-edit-routes.ts';
import { WRONG_CODES } from '../packages/server/box-pairing.ts';
import { checkRole, whoIs, type ApiRoute } from '../packages/server/box-roles.ts';
import { boxDoor, boxName, type Access } from '../packages/server/box-routes.ts';
import { at, boxFor, incoming, outgoing } from './box-fixtures.ts';
import { tempDir } from './helpers.ts';

const SHOWN = /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/;
const GAME = 'game-a';
const OTHER = 'game-b';
const cookie = (token: string) => 'zirbel_editor=' + token;

test('an edit code is six unambiguous characters, typed in any case, and one game has one at a time', (t) => {
  let now = Date.parse('2026-11-25T12:00:00Z');
  const folder = tempDir(t, 'zirbel-editors-');
  const editors = new Editors(folder, () => now);
  const first = editors.createCode(GAME);
  assert.match(first.code, SHOWN);
  assert.equal(first.plain, first.code.replace('-', ''));
  assert.equal(first.expiresAt, new Date(now + EDIT_CODE_MS).toISOString());
  assert.equal(plainEditCode(' ' + first.code.toLowerCase().replace('-', ' - ') + ' '), first.plain);
  assert.equal(editCode('abcdef'), 'ABC-DEF');
  for (const wrong of ['ABC-DE', 'ABCDEFG', 'ABC-DE0', 'ABC-DE1', 'ABC-DEI', 'ABC-DEO', 'ABC_DEF', '']) assert.equal(plainEditCode(wrong), undefined, wrong);
  // A new code replaces the old one; another game keeps its own.
  const second = editors.createCode(GAME);
  const other = editors.createCode(OTHER);
  assert.deepEqual(editors.code(GAME), second);
  assert.deepEqual(editors.code(OTHER), other);
  assert.throws(() => editors.redeem(first.code, 'Ada', '10.0.0.5'), { status: 403, message: WRONG_EDIT_CODE });
  // Kept in the account folder beside the paired devices, in the format both hosts read.
  const kept = JSON.parse(readFileSync(join(folder, 'editors.json'), 'utf8'));
  assert.deepEqual(Object.keys(kept), ['version', 'codes', 'editors']);
  assert.deepEqual(kept.codes.map((code: { project: string; code: string }) => [code.project, code.code]), [[GAME, second.plain], [OTHER, other.plain]]);
  assert.deepEqual(Object.keys(kept.codes[0]), ['project', 'code', 'createdAt', 'expiresAt']);
  // It opens its game for a week, then not; stopped, it opens it no more.
  now += EDIT_CODE_MS - 1;
  assert.ok(editors.code(GAME));
  now += 1;
  assert.equal(editors.code(GAME), undefined);
  assert.throws(() => editors.redeem(second.code, 'Ada', '10.0.0.5'), /doesn't open a game/);
  editors.createCode(OTHER);
  assert.equal(JSON.parse(readFileSync(join(folder, 'editors.json'), 'utf8')).codes.length, 1, 'expired codes are not kept');
  editors.stopCode(OTHER);
  assert.equal(editors.code(OTHER), undefined);
});

test('a code lets several people in under their names, as hashed sessions that end when they are removed', (t) => {
  const folder = tempDir(t, 'zirbel-editors-');
  const editors = new Editors(folder);
  const { code } = editors.createCode(GAME);
  const ada = editors.redeem(code.toLowerCase(), '  Ada  ', '10.0.0.5');
  const bo = editors.redeem(code, 'Bo', '10.0.0.6');
  assert.match(ada.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!readFileSync(join(folder, 'editors.json'), 'utf8').includes(ada.token));
  assert.equal(editorToken('theme=dark; ' + cookie(ada.token)), ada.token);
  assert.equal(editorToken(cookie('short')), undefined);
  assert.equal(editors.session(cookie(ada.token))?.project, GAME);
  assert.equal(editors.session(cookie('A'.repeat(43))), undefined);
  assert.deepEqual(editors.list(GAME).map(({ name }) => name), ['Ada', 'Bo']);
  assert.deepEqual(Object.keys(editors.list(GAME)[0]!), ['id', 'name', 'since', 'lastSeen']);
  assert.deepEqual(editors.list(OTHER), []);
  editors.remove(GAME, bo.editor.id);
  assert.equal(editors.session(cookie(bo.token)), undefined);
  assert.throws(() => editors.remove(GAME, bo.editor.id), { status: 404 });
  assert.throws(() => editors.remove(OTHER, ada.editor.id), { status: 404 });
  // A device that redeems another game's code edits that game instead: its session for the first one ends.
  const other = editors.createCode(OTHER);
  const moved = editors.redeem(other.code, 'Ada', '10.0.0.5', cookie(ada.token));
  assert.equal(editors.session(cookie(ada.token)), undefined);
  assert.equal(editors.session(cookie(moved.token))?.project, OTHER);
  editors.end(cookie(moved.token));
  assert.equal(editors.session(cookie(moved.token)), undefined);
  // A removed game takes its code and its editors with it.
  const kept = editors.redeem(code, 'Cy', '10.0.0.7');
  editors.removeProject(GAME);
  assert.equal(editors.session(cookie(kept.token)), undefined);
  assert.equal(editors.code(GAME), undefined);
  assert.ok(editors.code(OTHER));
});

test('a name is 1 to 24 characters, a game keeps so many editors, and wrong codes are limited per address', (t) => {
  // Trimmed, and counted as Zod counts, in code points.
  assert.equal(editorName.parse('  ' + '😀'.repeat(24) + ' '), '😀'.repeat(24));
  for (const wrong of ['', '   ', 'x'.repeat(25), '😀'.repeat(25)]) assert.equal(editorName.safeParse(wrong).success, false, wrong);
  let now = Date.parse('2026-11-25T12:00:00Z');
  const editors = new Editors(tempDir(t, 'zirbel-editors-'), () => now);
  const { code } = editors.createCode(GAME);
  for (let editor = 0; editor < EDITORS_PER_GAME; editor++) editors.redeem(code, 'Editor ' + editor, '10.0.0.' + editor);
  assert.throws(() => editors.redeem(code, 'One more', '10.0.1.1'), { status: 409 });
  // A code made now is never another game's.
  assert.notEqual(editors.createCode(OTHER).plain, editors.code(GAME)?.plain);
  for (let attempt = 1; attempt < WRONG_CODES; attempt++) assert.throws(() => editors.redeem('ZZZ-ZZZ', 'Ada', '10.0.2.1'), { status: 403 });
  assert.throws(() => editors.redeem('nope', 'Ada', '10.0.2.1'), { status: 403 });
  // The limit holds for the right code too, from that address, until a minute has passed.
  assert.throws(() => editors.redeem(code, 'Ada', '10.0.2.1'), { status: 429 });
  now += 60_000;
  assert.throws(() => editors.redeem('ZZZ-ZZZ', 'Ada', '10.0.2.1'), { status: 403 });
});

test('an editor uses its own game’s routes alone; owners and the box use them all', () => {
  const editor: Access = { local: false, editor: { id: 'e', game: GAME } };
  const rooms: Record<string, string> = { mine: GAME, theirs: OTHER };
  const may = (route: ApiRoute) => { try { checkRole(editor, route, (room) => rooms[room]); return true; } catch (error) {
    assert.deepEqual([(error as { status: number }).status, (error as Error).message], [403, ONE_GAME]);
    return false;
  } };
  const game = (method: string, action?: string, tail?: string) => ({ method, resource: 'projects', pathID: GAME, action, tail });
  for (const route of [{ method: 'GET', resource: 'health' }, { method: 'GET', resource: 'me' }, { method: 'GET', resource: 'lobby' },
    { method: 'GET', resource: 'projects' }, game('GET'), game('GET', 'proposals'), game('GET', 'proposals', 'p'), game('POST', 'proposals'),
    game('POST', 'apply', 'p'), game('POST', 'discard', 'p'), game('POST', 'restore'), game('POST', 'asset'), game('GET', 'export'),
    game('POST', 'playtest'), game('POST', 'development-room'), game('POST', 'title'), game('POST', 'notes'), game('POST', 'media'),
    game('GET', 'media', 'm'), game('POST', 'grants'), game('GET', 'grants'), game('POST', 'grants', 'g'),
    // What a route answers past its method and action is the route's own: apply without a proposal is a bad request.
    game('POST', 'apply'), { method: 'POST', resource: 'health' }, { method: 'GET', resource: 'health', pathID: 'x' },
    { method: 'GET', resource: 'rooms' }, { method: 'GET', resource: 'rooms', pathID: 'mine', action: 'link' },
    { method: 'POST', resource: 'rooms', pathID: 'mine', action: 'close' }, { method: 'POST', resource: 'rooms', pathID: 'gone', action: 'close' },
    { method: 'GET', resource: 'rooms', pathID: 'gone', action: 'link' }])
    assert.ok(may(route), JSON.stringify(route));
  for (const route of [{ method: 'POST', resource: 'projects' }, { method: 'POST', resource: 'projects', pathID: 'import' },
    { method: 'POST', resource: 'projects', pathID: 'import-game' }, { method: 'GET', resource: 'projects', pathID: OTHER },
    { method: 'POST', resource: 'projects', pathID: OTHER, action: 'proposals' }, game('POST', 'remove'), game('GET', 'title'),
    game('POST', 'release'), game('POST', 'prompt'), game('GET', 'thread'), game('GET', 'activity', 'n'), game('GET', 'notes'),
    game('DELETE', 'media', 'm'), game('POST', 'edit-code'), game('POST', 'edit-code', 'stop'),
    game('GET', 'editors'), game('DELETE', 'editors', 'e'), game('GET', 'apply', 'p'), game('PUT'),
    { method: 'GET', resource: 'processors' }, { method: 'POST', resource: 'chat' }, { method: 'POST', resource: 'chat', pathID: 't', action: 'stop' },
    { method: 'GET', resource: 'box', pathID: 'settings' }, { method: 'GET', resource: 'pairing', pathID: 'devices' }, { method: 'POST', resource: 'pairing' },
    { method: 'GET', resource: 'releases' }, { method: 'POST', resource: 'releases', pathID: 'r', action: 'play' }, { method: 'POST', resource: 'lobby', pathID: 'offer' },
    { method: 'POST', resource: 'rooms' }, { method: 'GET', resource: 'rooms', pathID: 'theirs', action: 'link' },
    { method: 'POST', resource: 'rooms', pathID: 'theirs', action: 'close' }, { method: 'POST', resource: 'rooms', pathID: 'mine', action: 'close', tail: 'x' },
    { method: 'GET', resource: 'lobby', pathID: 'x' }, { method: 'GET', resource: 'nothing' }])
    assert.ok(!may(route), JSON.stringify(route));
  for (const owner of [{ local: true }, { local: false, device: 'd' }]) checkRole(owner, { method: 'POST', resource: 'box', pathID: 'settings' }, () => undefined);
  assert.deepEqual(whoIs(editor), { role: 'editor', game: GAME });
  assert.deepEqual(whoIs({ local: true }), { role: 'box' });
  assert.deepEqual(whoIs({ local: false, device: 'd' }), { role: 'owner' });
});

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  [{ origin: 'http://zirbel.local', 'content-type': 'application/x-www-form-urlencoded', ...headers }, new URLSearchParams(fields).toString()] as const;

test('the edit page takes a code and a name, refuses owners, and its session opens the door to one game', async (t) => {
  const box = boxFor(t);
  const { code, plain } = box.editors.createCode(GAME);
  const shown = outgoing();
  await boxDoor(box, incoming('192.168.1.20', 'GET', '/edit?code=' + plain.toLowerCase()), shown.response, at('/edit?code=' + plain.toLowerCase()));
  assert.equal(shown.sent.status, 200);
  assert.match(shown.sent.body, new RegExp('<input id="code" name="code"[^>]* value="' + code + '" required>'));
  assert.match(shown.sent.body, /<input id="name" name="name" autocomplete="nickname" maxlength="24" value="" required>/);
  assert.equal(shown.sent.headers['referrer-policy'], 'same-origin');
  const post = async (address: string, fields: Record<string, string>, headers: Record<string, string> = {}) => {
    const sent = outgoing();
    const [sentHeaders, text] = form(fields, headers);
    await boxDoor(box, incoming(address, 'POST', '/edit', sentHeaders, text), sent.response, at('/edit'));
    return sent.sent;
  };
  await assert.rejects(boxDoor(box, incoming('192.168.1.20', 'POST', '/edit', ...form({ code, name: 'Ada' }, { origin: 'http://evil.example' })),
    outgoing().response, at('/edit')), /Cross-origin/);
  const wrong = await post('192.168.1.20', { code: 'ZZZ-ZZZ', name: 'Ada' });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body, /That code doesn&#39;t open a game\./);
  assert.match(wrong.body, /value="Ada"/);
  // The form is read as Zod reads it, its issues joined as both hosts join them.
  const blank = await post('192.168.1.20', { code, name: ' ' });
  assert.equal(blank.status, 400);
  assert.match(blank.body, /<p class="error" role="alert">name · Too small: expected string to have &#62;=1 characters<\/p>/);
  // A form that isn't read is shown again empty.
  assert.match(blank.body, /<input id="name" name="name" autocomplete="nickname" maxlength="24" value="" required>/);
  assert.equal((await post('192.168.1.20', { code })).status, 400);
  assert.equal((await post('192.168.1.20', { code, name: 'Ada', extra: '1' })).status, 400);
  // The box itself and its paired devices own it, and edit every game already.
  const owner = box.pairing.claim();
  for (const [address, headers] of [['127.0.0.1', {}], ['192.168.1.30', { cookie: 'zirbel_session=' + owner }]] as const) {
    const refused = await post(address, { code, name: 'Owner' }, headers);
    assert.equal(refused.status, 409);
    assert.ok(refused.body.includes(OWNS));
  }
  const redeemed = await post('192.168.1.20', { code: plain.toLowerCase(), name: 'Ada' });
  assert.deepEqual([redeemed.status, redeemed.headers.location], [303, '/']);
  const set = String(redeemed.headers['set-cookie']);
  assert.match(set, /^zirbel_editor=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/);
  const session = set.split(';')[0]!;
  const access = await boxDoor(box, incoming('192.168.1.20', 'GET', '/api/projects', { cookie: session }), outgoing().response, at('/api/projects'));
  assert.equal(access?.editor?.game, GAME);
  assert.equal(access?.device, undefined);
  // Its / is the editor; once removed, it is told its access has ended.
  assert.equal((await boxDoor(box, incoming('192.168.1.20', 'GET', '/', { cookie: session }), outgoing().response, at('/')))?.editor?.game, GAME);
  box.editors.remove(GAME, access?.editor?.id ?? '');
  await assert.rejects(boxDoor(box, incoming('192.168.1.20', 'GET', '/api/projects', { cookie: session }), outgoing().response, at('/api/projects')),
    { status: 401, message: ENDED });

  // An editor that pairs is an owner from then on: its editor's session ends, and its cookie goes.
  const again = (await post('192.168.1.20', { code, name: 'Ada' })).headers['set-cookie'] as string;
  const pairing = box.pairing.createCode();
  const paired = outgoing();
  await boxDoor(box, incoming('192.168.1.20', 'POST', '/pair', ...form({ code: pairing.code }, { cookie: again.split(';')[0]! })), paired.response, at('/pair'));
  assert.equal(paired.sent.status, 303);
  const cookies = paired.sent.headers['set-cookie'] as string[];
  assert.match(cookies[0]!, /^zirbel_session=/);
  assert.equal(cookies[1], 'zirbel_editor=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  assert.deepEqual(box.editors.list(GAME), []);
});

test('the owners’ API makes, shows and stops a game’s code, lists its editors and removes one', async (t) => {
  const box = boxFor(t, undefined, 0, undefined, (host) => host === 'zirbel.local' ? '192.168.1.2' : host);
  const projects = new Projects(tempDir(t, 'zirbel-editors-data-'));
  const { id: game } = projects.createGame('Meadow');
  const call = async (access: Access, method: string, path: string, host = 'zirbel.local') => {
    const { response, sent } = outgoing();
    const url = new URL(path, 'http://' + host);
    const [, , , pathID, action, tail] = url.pathname.split('/');
    const answered = await editorsRequest(box, projects, incoming('192.168.1.20', method, path, { origin: 'http://' + host, host }), response,
      access, url, { pathID, action, tail });
    return { answered, status: sent.status, json: sent.body ? JSON.parse(sent.body) : undefined };
  };
  const owner = { local: false, device: 'd' };
  const made = await call(owner, 'POST', '/api/projects/' + game + '/edit-code');
  assert.equal(made.status, 201);
  assert.deepEqual(Object.keys(made.json), ['code', 'link', 'expiresAt', 'qr']);
  assert.match(made.json.code, SHOWN);
  const link = 'http://192.168.1.2/edit?code=' + made.json.code.replace('-', '');
  assert.equal(made.json.link, link);
  assert.equal(made.json.qr, 'data:qr,' + encodeURIComponent(link));
  // On the address the owner reached the box by, where others can use it.
  assert.equal((await call(owner, 'GET', '/api/projects/' + game + '/editors', '10.0.0.9')).json.code.link,
    'http://10.0.0.9/edit?code=' + made.json.code.replace('-', ''));
  box.editors.redeem(made.json.code, 'Ada', '192.168.1.20');
  const listed = await call({ local: true }, 'GET', '/api/projects/' + game + '/editors');
  assert.deepEqual(listed.json.code, { code: made.json.code, link, expiresAt: made.json.expiresAt });
  assert.deepEqual(listed.json.editors.map(({ name }: { name: string }) => name), ['Ada']);
  await assert.rejects(call({ local: false, editor: { id: 'e', game } }, 'GET', '/api/projects/' + game + '/editors'), { status: 403 });
  await assert.rejects(call(owner, 'POST', '/api/projects/missing/edit-code'), { status: 404 });
  assert.deepEqual((await call(owner, 'POST', '/api/projects/' + game + '/edit-code/stop')).json, {});
  assert.equal((await call(owner, 'GET', '/api/projects/' + game + '/editors')).json.code, null);
  assert.deepEqual((await call(owner, 'DELETE', '/api/projects/' + game + '/editors/' + listed.json.editors[0].id)).json, {});
  await assert.rejects(call(owner, 'DELETE', '/api/projects/' + game + '/editors/' + listed.json.editors[0].id), { status: 404 });
  assert.equal((await call(owner, 'GET', '/api/projects/' + game + '/edit-code')).answered, false);
  assert.equal((await call(owner, 'POST', '/api/projects/' + game + '/editors')).answered, false);
  // A box with no address others can use links by its name.
  const alone = boxFor(t, undefined, 0, undefined, () => undefined);
  const { response, sent } = outgoing();
  await editorsRequest(alone, projects, incoming('127.0.0.1', 'POST', '/', { origin: 'http://zirbel.local' }), response, { local: true },
    at('/'), { pathID: game, action: 'edit-code' });
  assert.match(JSON.parse(sent.body).link, new RegExp('^http://' + boxName().replaceAll('.', '\\.') + '/edit\\?code=[2-9A-HJ-NP-Z]{6}$'));
});
