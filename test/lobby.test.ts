// The lobby (packages/core/lobby.ts): its codes, the offers it keeps in lobby.json, what it lists, the sessions it
// starts and their limits, the seats it hands out by code and its count of wrong codes; its address for other
// devices (packages/server/hosting.ts); and the page's links into a game (packages/web/lobby-link.ts).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CODE_LETTERS, LOBBY_SESSIONS, Lobby, newCode, readCode, SESSIONS_PER_ADDRESS, WRONG_CODES } from '../packages/core/lobby.ts';
import { Rooms } from '../packages/core/rooms.ts';
import { Players } from '../packages/server/hosting.ts';
import { playerLink } from '../packages/web/lobby-link.ts';
import { install, joinRoom, legacyProject, rights } from './helpers.ts';

function lobbyFor(t: TestContext, now = Date.now) {
  const { projects, releases, root } = install(t);
  const rooms = new Rooms();
  t.after(() => rooms.dispose());
  const publish = (id: string, permissions = rights) => releases.package(id, 'main', permissions, true).manifest;
  const shared = projects.createGame('Shared', { html: '<!doctype html><canvas></canvas>', maxPlayers: 2 });
  const games = {
    shared: publish(shared.id), sharedAgain: publish(shared.id),
    alone: publish(projects.createGame('Alone', { html: '<!doctype html><p>one</p>', maxPlayers: 1 }).id),
    tiles: publish(legacyProject(projects, 'tessellate').id),
    closed: publish(projects.createGame('Closed', { html: '<p>no</p>', maxPlayers: 2 }).id, { ...rights, play: false }),
  };
  return { root, rooms, projects, releases, games, lobby: new Lobby(rooms, releases, join(root, 'lobby.json'), now) };
}

test('codes are four letters without look-alikes, read in any case with spaces and dashes', () => {
  assert.equal(CODE_LETTERS.length, 32);
  assert.ok(!/[01IO]/.test(CODE_LETTERS));
  for (const typed of ['KQ7M', 'kq7m', 'kq-7m', ' K Q 7 M ', 'K-Q-7-M', '\tkQ7m', 'KQ7M\r\n']) assert.equal(readCode(typed), 'KQ7M', typed);
  for (const typed of ['', 'KQ7', 'KQ7MM', 'KQ70', 'KQ7O', 'KQ71', 'KQ7I', 'KQ_7M', 'ＫQ7M', 'KQ7M\u00a0', 'ſQ7M', 'KQ–7M'])
    assert.equal(readCode(typed), undefined, typed);
  let tries = 0;
  const code = newCode(() => ++tries < 5);
  assert.equal(tries, 5);
  assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
});

test('the owner offers one release per game, kept in lobby.json', (t) => {
  const { lobby, root, rooms, releases, games } = lobbyFor(t);
  assert.deepEqual(lobby.offered(), []);
  assert.deepEqual(lobby.offer(games.shared.releaseId, true), { offered: [games.shared.releaseId] });
  assert.deepEqual(lobby.offer(games.alone.releaseId, true).offered, [games.shared.releaseId, games.alone.releaseId]);
  // Another release of the same game takes the first one's place, last; one offered again goes last too.
  assert.deepEqual(lobby.offer(games.sharedAgain.releaseId, true).offered, [games.alone.releaseId, games.sharedAgain.releaseId]);
  assert.deepEqual(lobby.offer(games.alone.releaseId, true).offered, [games.sharedAgain.releaseId, games.alone.releaseId]);
  assert.deepEqual(lobby.offer(games.alone.releaseId, true).offered, [games.sharedAgain.releaseId, games.alone.releaseId]);
  assert.throws(() => lobby.offer(games.closed.releaseId, true), /disabled play/);
  assert.throws(() => lobby.offer('missing', true), /does not exist/);
  assert.deepEqual(lobby.offer('missing', false).offered, [games.sharedAgain.releaseId, games.alone.releaseId]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'lobby.json'), 'utf8')),
    { version: 1, offered: [games.sharedAgain.releaseId, games.alone.releaseId] });
  assert.deepEqual(lobby.offer(games.alone.releaseId, false).offered, [games.sharedAgain.releaseId]);
  // Another host on the same folder reads them back as it starts; a file that is no lobby stops it.
  assert.deepEqual(new Lobby(rooms, releases, join(root, 'lobby.json')).offered(), [games.sharedAgain.releaseId]);
  for (const file of [{ version: 1, offered: ['Not An Id'] }, { offered: [] }, { version: 1, offered: ['a', 'a'] }, 'not json']) {
    writeFileSync(join(root, 'lobby.json'), typeof file === 'string' ? file : JSON.stringify(file));
    assert.throws(() => new Lobby(rooms, releases, join(root, 'lobby.json')), /lobby\.json in the data directory is not a lobby/);
  }
});

test('the lobby lists offered games by title and its listener’s sessions newest first, without codes', async (t) => {
  const { lobby, rooms, games } = lobbyFor(t);
  for (const game of [games.tiles, games.shared, games.alone]) lobby.offer(game.releaseId, true);
  assert.deepEqual(lobby.state('lan').games, [
    { release: games.alone.releaseId, title: 'Alone', players: { min: 1, max: 1 }, multiplayer: false },
    { release: games.shared.releaseId, title: 'Shared', players: { min: 1, max: 2 }, multiplayer: true },
    { release: games.tiles.releaseId, title: 'Tessellate', players: { min: 1, max: 2 }, multiplayer: true },
  ]);
  const first = await lobby.start('lan', '192.168.1.20', games.shared.releaseId, 'Ada');
  const second = await lobby.start('lan', '192.168.1.21', games.tiles.releaseId, 'Bo');
  const solo = await lobby.start('lan', '192.168.1.22', games.alone.releaseId, 'Cy');
  const elsewhere = await lobby.start('local', '127.0.0.1', games.shared.releaseId, 'Di');
  // An owner's LAN room is a session too; a room only on loopback isn't, nor is a solo one.
  const owned = rooms.create(first.room.release, false, 'lan');
  rooms.create(first.room.release, false, 'local');
  assert.match(owned.code ?? '', /^[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(solo.room.code, null);
  assert.equal(solo.room.solo, true);
  const state = lobby.state('lan');
  assert.deepEqual(state.sessions.map(({ id }) => id), [owned.session, second.room.session, first.room.session]);
  assert.deepEqual(state.sessions[1], { id: second.room.session, title: 'Tessellate', players: 0, max: 2,
    started: new Date(second.room.started).toISOString() });
  assert.deepEqual(lobby.state('local').sessions.map(({ id }) => id), [elsewhere.room.session]);
  const text = JSON.stringify(state);
  for (const room of [first.room, second.room, owned]) {
    assert.ok(!text.includes(room.code!) && !text.includes(room.id) && !text.includes(room.invite));
    assert.notEqual(room.session, room.id);
  }
  assert.equal(first.room.summary().code, first.room.code);
  assert.equal('code' in solo.room.summary(), false);
});

test('games are ordered by title, case aside and then by case', (t) => {
  const { lobby, projects, releases } = lobbyFor(t);
  for (const title of ['bravo', 'alpha', 'Bravo', 'Charlie']) lobby.offer(releases.package(projects.createGame(title,
    { html: '<p>one</p>', maxPlayers: 1 }).id, 'main', rights, true).manifest.releaseId, true);
  assert.deepEqual(lobby.state('lan').games.map(({ title }) => title), ['alpha', 'Bravo', 'bravo', 'Charlie']);
});

test('a session’s link seats its starter, and its code seats players, then spectators', async (t) => {
  const { lobby, games } = lobbyFor(t);
  lobby.offer(games.shared.releaseId, true);
  const { room, ticket } = await lobby.start('lan', '192.168.1.20', games.shared.releaseId, 'Ada');
  assert.equal(room.mayView(ticket), true);
  const ada = joinRoom(room, ticket);
  assert.deepEqual([ada.welcome.seat.name, ada.welcome.seat.role], ['Ada', 'player']);
  const code = room.code!;
  const bo = await lobby.join('lan', '192.168.1.21', code.toLowerCase().slice(0, 2) + '-' + code.toLowerCase().slice(2), 'Bo');
  assert.equal(bo.room, room);
  assert.equal(joinRoom(room, bo.ticket).welcome.seat.role, 'player');
  assert.equal(lobby.state('lan').sessions[0]!.players, 2);
  const eve = await lobby.join('lan', '192.168.1.22', ' ' + code + ' ', 'Eve');
  assert.equal(joinRoom(room, eve.ticket).welcome.seat.role, 'spectator');
  // A ticket is good once; the invitation is not needed and not handed out.
  assert.throws(() => joinRoom(room, ticket));
  for (let i = 0; i < 3; i++) await lobby.join('lan', '192.168.1.23', code, 'S' + i);
  await assert.rejects(() => lobby.join('lan', '192.168.1.23', code, 'Full'), /spectator seats are full/);
  // On the other listener, the code is no session's.
  await assert.rejects(() => lobby.join('local', '127.0.0.1', code, 'Di'), /No session has that code/);
  await assert.rejects(() => lobby.start('lan', '192.168.1.20', games.tiles.releaseId, 'Ada'), /not in the lobby/);
});

test('the lobby holds sixteen sessions, three of them from one address, the host’s own aside', async (t) => {
  const { lobby, rooms, games } = lobbyFor(t);
  lobby.offer(games.shared.releaseId, true);
  lobby.offer(games.alone.releaseId, true);
  for (let i = 0; i < SESSIONS_PER_ADDRESS; i++)
    await lobby.start('lan', i % 2 ? '::ffff:192.168.1.20' : '192.168.1.20', i ? games.alone.releaseId : games.shared.releaseId, 'Ada');
  await assert.rejects(() => lobby.start('lan', '192.168.1.20', games.shared.releaseId, 'Ada'), (error: Error & { status?: number }) =>
    error.status === 429 && error.message === 'You have three sessions open. Join one, or wait until one ends.');
  const first = rooms.open().find((room) => room.startedBy === '192.168.1.20')!;
  rooms.close(first.id);
  await lobby.start('lan', '192.168.1.20', games.shared.releaseId, 'Ada');
  // Rooms the owner opens don't count.
  rooms.create(first.release, false, 'lan');
  for (let i = SESSIONS_PER_ADDRESS; i < LOBBY_SESSIONS; i++) await lobby.start('local', '127.0.0.1', games.shared.releaseId, 'Box');
  await assert.rejects(() => lobby.start('lan', '10.0.0.9', games.shared.releaseId, 'Late'), (error: Error & { status?: number }) =>
    error.status === 429 && error.message === 'The lobby is full. Join a session, or try again when one ends.');
});

test('ten wrong codes in a minute stop an address for the rest of that minute', async (t) => {
  let now = 1_000_000;
  const { lobby, games } = lobbyFor(t, () => now);
  lobby.offer(games.shared.releaseId, true);
  const { room } = await lobby.start('lan', '192.168.1.20', games.shared.releaseId, 'Ada');
  const wrong = room.code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
  for (let i = 0; i < WRONG_CODES; i++) {
    now += 1000;
    await assert.rejects(() => lobby.join('lan', '192.168.1.30', i % 2 ? wrong : 'not a code', 'Mal'), /No session has that code/);
  }
  await assert.rejects(() => lobby.join('lan', '::ffff:192.168.1.30', room.code!, 'Mal'), /Too many wrong codes/);
  // Another address is unaffected, and so is this one once its minute is over.
  assert.equal((await lobby.join('lan', '192.168.1.31', room.code!, 'Bo')).room, room);
  // Its minute began at its first wrong code.
  now = 1_000_000 + 1000 + 60_000;
  await assert.rejects(() => lobby.join('lan', '192.168.1.30', wrong, 'Mal'), /No session has that code/);
  assert.equal((await lobby.join('lan', '192.168.1.30', room.code!, 'Mal')).room, room);
});

test('a lobby session closes once nobody has been in it for twenty minutes; an owner’s room waits for its invitation', async (t) => {
  const { lobby, rooms, games } = lobbyFor(t);
  lobby.offer(games.shared.releaseId, true);
  const { room } = await lobby.start('lan', '192.168.1.20', games.shared.releaseId, 'Ada');
  const owned = rooms.create(room.release, false, 'lan');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 21 * 60_000 });
  assert.equal(room.step(), false);
  assert.equal(owned.step(), true);
});

test('the lobby’s address for other devices is on the LAN listener, by a name others can use', async (t) => {
  const { releases } = install(t);
  const players = new Players(new Rooms(), releases, { playerPort: 0, lanHost: 'games.lan' });
  t.after(() => players.close());
  await players.openLocal(0);
  assert.equal(players.lobbyLink(), null);
  assert.equal(players.lobbyLink('192.168.1.2'), null);
  await players.startLan();
  const port = players.lanPort!;
  // On a box, the address the editor was reached by, unless only the box itself reaches it by that, or it is a name
  // (a .local name a phone may not resolve); else the player host.
  for (const [reached, address] of [['192.168.1.2', '192.168.1.2'], ['zirbel.local', 'games.lan'], ['[fd00::2]', '[fd00::2]'],
    [undefined, 'games.lan'], ['127.0.0.1', 'games.lan'], ['127.1.2.3', 'games.lan'], ['localhost', 'games.lan'], ['[::1]', 'games.lan']])
    assert.equal(players.lobbyLink(reached), 'http://' + address + ':' + port + '/', String(reached));
});

test('the lobby page goes only to its own listener’s /join/ links, with the ?net= of its own address on them', () => {
  const lobby = 'http://192.168.1.2:4174/?code=AB&net=lag:120,jitter:30,stats';
  // Before the #, which holds the seat's ticket: the player page reads it there and hands it on to the game's frame.
  const link = playerLink('/join/r1#seat=t1', lobby);
  assert.equal(link, 'http://192.168.1.2:4174/join/r1?net=lag%3A120%2Cjitter%3A30%2Cstats#seat=t1');
  assert.equal(new URL(link).searchParams.get('net'), 'lag:120,jitter:30,stats');
  assert.equal(playerLink('http://192.168.1.2:4174/join/r1#seat=t1', 'http://192.168.1.2:4174/'), 'http://192.168.1.2:4174/join/r1#seat=t1');
  for (const elsewhere of ['http://elsewhere.test/join/r1#seat=t1', '/lobby/state', '//192.168.1.3:4174/join/r1'])
    assert.throws(() => playerLink(elsewhere, lobby), /unexpected link/, elsewhere);
});
