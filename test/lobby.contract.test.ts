// The lobby on both hosts: `node dist/server.mjs` and the Go host (host/bin/zirbel-host). The owner offers releases in
// the editor; anyone who reaches a player listener opens the lobby page at / (or the TV page at /tv), starts a session
// of an offered game and joins one by its code. Every check runs against each host, with the same answers.
// Its releases and the editor they are imported into are lobby-fixture.ts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { hostsUnderTest, launch } from './helpers.ts';
import { fixtures, startEditor } from './lobby-fixture.ts';

const hosts = hostsUnderTest();
const CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const PAGE_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

type Answer = { status: number; body: unknown; headers: Headers };
/** A request with the base's own origin unless headers say otherwise, its JSON body when it has one. */
async function call(base: string, method: string, path: string, json?: unknown, headers: Record<string, string> = { origin: base }): Promise<Answer> {
  const response = await fetch(base + path, { method, body: json === undefined ? null : JSON.stringify(json),
    headers: { ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* a page or a file */ }
  return { status: response.status, body, headers: response.headers };
}
const error = (answer: Answer) => [answer.status, (answer.body as { error?: string }).error];

type Link = { origin: string; room: string; ticket: string };
function seatLink(link: unknown): Link {
  const match = /^(http:\/\/127\.0\.0\.1:\d+)\/join\/([a-f0-9]{12})#seat=([\w-]{32})$/.exec(String(link));
  assert.ok(match, 'a seat link: ' + String(link));
  return { origin: match[1]!, room: match[2]!, ticket: match[3]! };
}

type Welcome = { type: string; code?: string; seat?: { name: string; role: string } };
const seated = (welcome: Welcome) => [welcome.seat?.name, welcome.seat?.role];
/** The seat a credential takes in its room: the room's welcome, or its error. The connection stays until the test ends. */
async function seat(t: TestContext, link: Link, releaseId: string, credential = link.ticket) {
  const ws = new WebSocket(link.origin.replace('http', 'ws') + '/rooms/' + link.room + '/socket', { origin: link.origin });
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const answer = new Promise<Welcome>((resolve) => ws.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString('utf8')) as Welcome;
    if (message.type === 'welcome' || message.type === 'error') resolve(message);
  }));
  ws.send(JSON.stringify({ type: 'hello', version: 1, credential, releaseId }));
  return answer;
}

for (const host of hosts) {
  test(host.name + ' host serves the lobby page and its files on the player listener', async (t) => {
    const data = fixtures(t);
    const { player } = await startEditor(t, host.command, data.data, []);
    const page = await fetch(player + '/');
    assert.equal(page.status, 200);
    assert.deepEqual(Object.fromEntries(['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options',
      'referrer-policy'].map((name) => [name, page.headers.get(name)])), {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': PAGE_POLICY,
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    assert.equal(await page.text(), readFileSync('dist/web/lobby.html', 'utf8'));
    assert.equal((await fetch(player + '/', { headers: { 'if-none-match': page.headers.get('etag')! } })).status, 304);
    for (const [file, type] of [['lobby.js', 'application/javascript; charset=utf-8'], ['lobby.css', 'text/css; charset=utf-8']] as const) {
      const served = await fetch(player + '/' + file);
      assert.deepEqual([served.status, served.headers.get('content-type'), served.headers.get('cache-control')], [200, type, 'no-cache'], file);
      assert.equal(await served.text(), readFileSync('dist/web/' + file, 'utf8'));
    }
    for (const path of ['/lobby/', '/lobby/nope', '/lobby/state/more', '/lobby.html'])
      assert.equal((await fetch(player + path)).status, 404, path);
    assert.deepEqual(error(await call(player, 'GET', '/lobby/sessions')), [404, 'Lobby route does not exist.']);
    assert.deepEqual(error(await call(player, 'POST', '/lobby/state', {})), [404, 'Lobby route does not exist.']);
  });

  test(host.name + ' host serves the pad page, a phone as a screen\'s controller, beside the lobby', async (t) => {
    const data = fixtures(t);
    const { player } = await startEditor(t, host.command, data.data, []);
    const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://" +
      new URL(player).host + "; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
    for (const path of ['/pad', '/pad/K7QX', '/pad/k7qx', '/pad/K7QX?place=2']) {
      const page = await fetch(player + path);
      assert.deepEqual([page.status, ...['content-type', 'cache-control', 'content-security-policy', 'referrer-policy']
        .map((name) => page.headers.get(name))], [200, 'text/html; charset=utf-8', 'no-cache', policy, 'no-referrer'], path);
      assert.equal(await page.text(), readFileSync('dist/web/pad.html', 'utf8'), path);
    }
    for (const [file, type] of [['pad.js', 'application/javascript; charset=utf-8'], ['pad.css', 'text/css; charset=utf-8']] as const) {
      const served = await fetch(player + '/' + file);
      assert.deepEqual([served.status, served.headers.get('content-type'), served.headers.get('cache-control')], [200, type, 'no-cache'], file);
      assert.equal(await served.text(), readFileSync('dist/web/' + file, 'utf8'));
    }
    for (const path of ['/pad.html', '/pad/', '/pad/K7QX/', '/pad/K7QX/more', '/pad/' + 'K'.repeat(17), '/pad/K%20X', '/pads'])
      assert.equal((await fetch(player + path)).status, 404, path);
    assert.equal((await fetch(player + '/pad', { method: 'POST', headers: { origin: player } })).status, 404);
  });

  test(host.name + ' host serves the TV page and its files on the player listener', async (t) => {
    const data = fixtures(t);
    const { player } = await startEditor(t, host.command, data.data, []);
    const page = await fetch(player + '/tv');
    // The lobby page's policy, and the pads socket on this host for the screen it is.
    const policy = PAGE_POLICY.replace("connect-src 'self'", "connect-src 'self' ws://" + new URL(player).host);
    assert.deepEqual([page.status, page.headers.get('content-type'), page.headers.get('cache-control'), page.headers.get('content-security-policy')],
      [200, 'text/html; charset=utf-8', 'no-cache', policy]);
    assert.equal(await page.text(), readFileSync('dist/web/tv.html', 'utf8'));
    for (const [file, type] of [['tv.js', 'application/javascript; charset=utf-8'], ['tv.css', 'text/css; charset=utf-8']] as const) {
      const served = await fetch(player + '/' + file);
      assert.deepEqual([served.status, served.headers.get('content-type'), served.headers.get('cache-control')], [200, type, 'no-cache'], file);
      assert.equal(await served.text(), readFileSync('dist/web/' + file, 'utf8'));
    }
    for (const path of ['/tv.html', '/tv/', '/tv/more']) assert.equal((await fetch(player + path)).status, 404, path);
    assert.equal((await fetch(player + '/tv', { method: 'POST' })).status, 404);
  });

  test(host.name + ' host gives the owner the lobby’s address for other devices while it shares on the network', async (t) => {
    const data = fixtures(t);
    const { editor } = await startEditor(t, host.command, data.data, ['--lan', '--player-host', 'Games.lan']);
    const answer = await call(editor, 'GET', '/api/lobby');
    const { link } = answer.body as { link: string };
    // On the LAN listener, by the player host name, its port the one it got.
    assert.deepEqual([answer.status, { ...answer.body as object, link: link.replace(/:\d+\/$/, ':<port>/') }],
      [200, { offered: [], link: 'http://games.lan:<port>/' }]);
    assert.notEqual(new URL(link).port, new URL(editor).port);
    const page = await fetch(link.replace('games.lan', '127.0.0.1'));
    assert.deepEqual([page.status, await page.text()], [200, readFileSync('dist/web/lobby.html', 'utf8')]);
    // The lobby there names the same address, for its pages' QR codes, even to a device that reached it by loopback.
    const state = await fetch(link.replace('games.lan', '127.0.0.1') + 'lobby/state');
    assert.equal((await state.json() as { link: string }).link, link);
  });

  test(host.name + ' host offers games in its lobby, starts sessions and seats players by their code', async (t) => {
    const data = fixtures(t);
    const { editor, player } = await startEditor(t, host.command, data.data, data.imports);
    const owner = (method: string, path: string, json?: unknown) => call(editor, method, '/api/' + path, json);
    const lobby = (path: string, json?: unknown, headers?: Record<string, string>) =>
      call(player, json === undefined ? 'GET' : 'POST', '/lobby/' + path, json, headers);

    // The owner's side: one release per game, only those that may be played. Other devices have no address for the
    // lobby while the host shares on no network.
    assert.deepEqual((await owner('GET', 'lobby')).body, { offered: [], link: null });
    assert.deepEqual((await owner('POST', 'lobby/offer', { release: data.shared.id, offered: true })).body, { offered: [data.shared.id] });
    assert.deepEqual((await owner('POST', 'lobby/offer', { release: data.alone.id, offered: true })).body,
      { offered: [data.shared.id, data.alone.id] });
    const replaced = await owner('POST', 'lobby/offer', { release: data.again.id, offered: true });
    assert.deepEqual([replaced.status, replaced.body], [200, { offered: [data.alone.id, data.again.id] }]);
    assert.deepEqual((await owner('POST', 'lobby/offer', { release: data.shared.id, offered: true })).body,
      { offered: [data.alone.id, data.shared.id] });
    // One offered again goes last.
    assert.deepEqual((await owner('POST', 'lobby/offer', { release: data.alone.id, offered: true })).body,
      { offered: [data.shared.id, data.alone.id] });
    assert.deepEqual(error(await owner('POST', 'lobby/offer', { release: data.closed.id, offered: true })),
      [403, 'The creator has disabled play for this release.']);
    assert.equal((await owner('POST', 'lobby/offer', { release: 'missing', offered: true })).status, 404);
    for (const input of [{ release: data.shared.id }, { release: 'Bad Id', offered: true }, { release: data.shared.id, offered: 'yes' },
      { release: data.shared.id, offered: true, extra: 1 }]) assert.equal((await owner('POST', 'lobby/offer', input)).status, 400);
    assert.deepEqual(JSON.parse(readFileSync(join(data.data, 'lobby.json'), 'utf8')), { version: 1, offered: [data.shared.id, data.alone.id] });

    // The lobby: games by title, no sessions yet, and no pairing or edit link outside a box.
    const empty = await lobby('state');
    assert.deepEqual([empty.headers.get('content-type'), empty.headers.get('cache-control'), empty.headers.get('x-content-type-options'),
      empty.headers.get('referrer-policy')], ['application/json; charset=utf-8', 'no-store', 'nosniff', 'no-referrer']);
    assert.deepEqual(empty.body, { games: [
      { release: data.alone.id, title: 'Alone', players: { min: 1, max: 1 }, multiplayer: false },
      { release: data.shared.id, title: 'Shared', players: { min: 1, max: 2 }, multiplayer: true },
    ], sessions: [], pair: null, edit: null, link: null, spaces: true });

    // Starting a session: from this listener's own page, of an offered game, for a name.
    const start = { release: data.shared.id, name: 'Ada' };
    assert.equal((await lobby('sessions', start, {})).status, 403);
    assert.equal((await lobby('sessions', start, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await call(player, 'POST', '/lobby/sessions', undefined, { origin: player, 'content-type': 'text/plain' })).status, 415);
    assert.deepEqual(error(await lobby('sessions', { release: data.tiles.id, name: 'Ada' })), [404, 'That game is not in the lobby.']);
    assert.deepEqual(error(await lobby('sessions', { release: data.again.id, name: 'Ada' })), [404, 'That game is not in the lobby.']);
    for (const input of [{ release: data.shared.id, name: '   ' }, { release: data.shared.id, name: 'n'.repeat(25) }, { release: data.shared.id },
      { ...start, extra: 1 }, { release: 'Bad Id', name: 'Ada' }]) assert.equal((await lobby('sessions', input)).status, 400);
    const started = await lobby('sessions', { release: data.shared.id, name: '  Ada  ' });
    assert.equal(started.status, 201);
    const { code, link } = started.body as { code: string; link: string };
    assert.match(code, CODE);
    const ada = seatLink(link);
    assert.equal(ada.origin, player);
    const solo = await lobby('sessions', { release: data.alone.id, name: 'Cy' });
    assert.equal(solo.status, 201);
    assert.equal((solo.body as { code: unknown }).code, null);
    const cy = seatLink((solo.body as { link: string }).link);

    // The lobby lists the multiplayer session alone, with no code, room or invitation in it.
    const listed = await lobby('state');
    const sessions = (listed.body as { sessions: { id: string; started: string }[] }).sessions;
    assert.equal(sessions.length, 1);
    assert.ok(Math.abs(Date.parse(sessions[0]!.started) - Date.now()) < 60_000);
    assert.match(sessions[0]!.started, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual({ ...sessions[0], id: '', started: '' }, { id: '', title: 'Shared', players: 0, max: 2, started: '' });
    assert.ok(typeof sessions[0]!.id === 'string' && sessions[0]!.id.length > 0);
    for (const secret of [code, ada.room, ada.ticket]) assert.ok(!JSON.stringify(listed.body).includes(secret), secret);

    // The link seats its starter straight away, by the ticket in it, once; the room's info carries the code.
    const info = await call(player, 'GET', '/rooms/' + ada.room + '/info', undefined, { authorization: 'Bearer ' + ada.ticket });
    assert.deepEqual([info.status, (info.body as { code?: string }).code, (info.body as { solo: boolean }).solo], [200, code, false]);
    assert.deepEqual(seated(await seat(t, ada, data.shared.id)), ['Ada', 'player']);
    assert.deepEqual(await seat(t, ada, data.shared.id).then(({ type, code: reason }) => [type, reason]), ['error', 'expired']);
    const players = async () => ((await lobby('state')).body as { sessions: { players: number }[] }).sessions.map((item) => item.players);
    assert.deepEqual(await players(), [1]);

    // Joining by the code, in any case, with a dash or spaces: a player's seat while there is one, then a spectator's.
    const dashed = code.toLowerCase().slice(0, 2) + '-' + code.toLowerCase().slice(2);
    assert.equal((await lobby('join', { code: dashed, name: 'Bo' }, {})).status, 403);
    for (const input of [{ code, name: ' ' }, { code }, { name: 'Bo' }, { code: 'x'.repeat(17), name: 'Bo' }, { code: 5, name: 'Bo' },
      { code, name: 'Bo', extra: 1 }]) assert.equal((await lobby('join', input)).status, 400, JSON.stringify(input));
    const bo = await lobby('join', { code: dashed, name: 'Bo' });
    assert.deepEqual([bo.status, Object.keys(bo.body as object)], [200, ['link']]);
    const boLink = seatLink((bo.body as { link: string }).link);
    assert.equal(boLink.room, ada.room);
    assert.deepEqual(seated(await seat(t, boLink, data.shared.id)), ['Bo', 'player']);
    const eve = await lobby('join', { code: ' ' + code.split('').join(' ') + ' ', name: 'Eve' });
    assert.deepEqual(seated(await seat(t, seatLink((eve.body as { link: string }).link), data.shared.id)), ['Eve', 'spectator']);
    assert.deepEqual(await players(), [2]);

    // The one-player session is its starter's alone, with no code.
    const alone = await call(player, 'GET', '/rooms/' + cy.room + '/info', undefined, { authorization: 'Bearer ' + cy.ticket });
    assert.deepEqual([alone.status, (alone.body as { solo: boolean }).solo, 'code' in (alone.body as object)], [200, true, false]);
    assert.deepEqual(seated(await seat(t, cy, data.alone.id)), ['Cy', 'player']);

    // The owner's rooms carry the session's code, and ending a session is closing its room.
    const rooms = (await owner('GET', 'rooms')).body as { id: string; code?: string }[];
    assert.deepEqual(rooms.map((room) => [room.id, room.code]), [[ada.room, code]]);
    assert.equal(((await owner('GET', 'rooms/' + ada.room + '/link')).body as { code?: string }).code, code);
    assert.equal((await owner('POST', 'rooms/' + ada.room + '/close', {})).status, 200);
    assert.deepEqual(await players(), []);
    assert.deepEqual(error(await lobby('join', { code, name: 'Late' })), [404, 'No session has that code.']);

    // Wrong codes: ten in a minute, then not even the right one, for the rest of that minute.
    for (const wrong of ['ZZZZ', 'not a code', '0000', '', 'ZZZ', 'Z-Z-Z-Y', 'zzzx', 'ZZZW', 'ZZZV'])
      assert.deepEqual(error(await lobby('join', { code: wrong, name: 'Mal' })), [404, 'No session has that code.'], wrong);
    const tooMany = [429, 'Too many wrong codes. Wait a minute and try again.'];
    assert.deepEqual(error(await lobby('join', { code: 'ZZZU', name: 'Mal' })), tooMany);
    const next = await lobby('sessions', { release: data.shared.id, name: 'Ada' });
    assert.equal(next.status, 201);
    assert.deepEqual(error(await lobby('join', { code: (next.body as { code: string }).code, name: 'Bo' })), tooMany);

    // A game taken out of the lobby leaves its sessions running.
    assert.deepEqual((await owner('POST', 'lobby/offer', { release: data.shared.id, offered: false })).body, { offered: [data.alone.id] });
    const after = (await lobby('state')).body as { games: { title: string }[]; sessions: unknown[] };
    assert.deepEqual([after.games.map(({ title }) => title), after.sessions.length], [['Alone'], 1]);
    assert.deepEqual(error(await lobby('sessions', start)), [404, 'That game is not in the lobby.']);
  });

  test(host.name + ' headless host serves its lobby from lobby.json and holds sixteen sessions', async (t) => {
    const data = fixtures(t);
    mkdirSync(data.data, { recursive: true });
    writeFileSync(join(data.data, 'lobby.json'), JSON.stringify({ version: 1, offered: [data.shared.id, data.alone.id] }));
    const player = await launch(t, host.command, ['--host-only', '--player-port', '0', '--data', data.data, ...data.imports],
      (line) => typeof line.player === 'string' ? line.player : undefined).ready;
    const titles = async () => ((await call(player, 'GET', '/lobby/state')).body as { games: { title: string }[] }).games.map(({ title }) => title);
    assert.deepEqual(await titles(), ['Alone', 'Shared']);
    for (let index = 0; index < 16; index++) {
      const release = index % 4 ? data.shared.id : data.alone.id;
      assert.equal((await call(player, 'POST', '/lobby/sessions', { release, name: 'P' + index })).status, 201, 'session ' + (index + 1));
    }
    assert.deepEqual(error(await call(player, 'POST', '/lobby/sessions', { release: data.shared.id, name: 'Late' })),
      [429, 'The lobby is full. Join a session, or try again when one ends.']);
    const state = (await call(player, 'GET', '/lobby/state')).body as { sessions: unknown[] };
    assert.equal(state.sessions.length, 12);

    // A lobby.json that is no lobby stops the host as it starts.
    const broken = data.data + '-broken';
    mkdirSync(broken);
    writeFileSync(join(broken, 'lobby.json'), JSON.stringify({ offered: 'none' }));
    const refused = spawn(host.command[0]!, [...host.command.slice(1), '--host-only', '--player-port', '0', '--data', broken]);
    let errors = '';
    refused.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
    t.after(() => refused.kill('SIGKILL'));
    assert.notEqual(await new Promise((resolve) => refused.once('exit', resolve)), 0);
    assert.match(errors, /lobby\.json/);
  });
}
