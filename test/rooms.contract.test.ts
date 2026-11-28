// Rooms on both hosts, as the room protocol runs them over WebSocket: seats reserved by invite, shared-state rooms,
// and the built-in tile and valley games. The same checks run against each host.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { hostsUnderTest } from './helpers.ts';
import { fixtures, startHost } from './host-fixture.ts';

const hosts = hostsUnderTest();

type Message = { type: string; [key: string]: unknown };

function socket(player: string, room: string, origin = player) {
  const ws = new WebSocket(player.replace('http', 'ws') + '/rooms/' + room + '/socket', { origin });
  const messages: Message[] = [];
  const waiting: { check: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
  ws.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString('utf8')) as Message;
    messages.push(message);
    // Each message goes to the first waiter that wants it.
    const index = waiting.findIndex((item) => item.check(message));
    if (index >= 0) waiting.splice(index, 1)[0]!.resolve(message);
  });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const opened = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  return {
    ws, messages, closed, opened,
    send(value: object) { ws.send(JSON.stringify(value)); },
    next(check: (message: Message) => boolean, timeout = 3000) {
      const found = messages.find(check);
      if (found) { messages.splice(messages.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise<Message>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No matching message')), timeout);
        waiting.push({ check, resolve: (message) => { clearTimeout(timer); messages.splice(messages.indexOf(message), 1); resolve(message); } });
      });
    },
  };
}

async function reserveSeat(player: string, link: string, name: string) {
  const [room, invite] = link.split('/join/')[1]!.split('#') as [string, string];
  const response = await fetch(player + '/rooms/' + room + '/reserve', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: player }, body: JSON.stringify({ invite, name, role: 'player' }),
  });
  assert.equal(response.status, 201);
  const { ticket } = await response.json() as { ticket: string };
  return { room, invite, ticket };
}

for (const host of hosts) {
  test(host.name + ' host reserves seats and admits only invited players', async (t) => {
    const data = fixtures(t);
    const { player, rooms } = await startHost(t, host.command, ['--data', join(data.root, 'data'), '--import', data.shared.file, '--release', data.shared.id]);
    const [roomId, invite] = rooms[0]!.link.split('/join/')[1]!.split('#') as [string, string];
    const reserve = (body: object, headers: Record<string, string> = { 'content-type': 'application/json', origin: player }) =>
      fetch(player + '/rooms/' + roomId + '/reserve', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await reserve({ invite, name: 'A', role: 'player' }, { 'content-type': 'application/json' })).status, 403);
    assert.equal((await reserve({ invite, name: 'A', role: 'player' }, { 'content-type': 'text/plain', origin: player })).status, 415);
    assert.equal((await reserve({ invite: 'x'.repeat(32), name: 'A', role: 'player' })).status, 403);
    assert.equal((await reserve({ invite, name: '   ', role: 'player' })).status, 400);
    // Names are trimmed before their 24-character limit, as in Zod.
    assert.equal((await reserve({ invite, name: '  ' + 'n'.repeat(24) + '  ', role: 'spectator' })).status, 201);
    assert.equal((await reserve({ invite, name: 'n'.repeat(25), role: 'spectator' })).status, 400);
    assert.equal((await reserve({ invite, name: 'A', role: 'player', extra: 1 })).status, 400);
    assert.equal((await reserve({ invite, name: 'A', role: 'player' })).status, 201);
    assert.equal((await reserve({ invite, name: 'B', role: 'player' })).status, 201);
    assert.equal((await reserve({ invite, name: 'C', role: 'player' })).status, 409);
    assert.equal((await reserve({ invite, name: 'S', role: 'spectator' })).status, 201);
  });

  test(host.name + ' host runs shared-state rooms over WebSocket', async (t) => {
    const data = fixtures(t);
    const { player, rooms } = await startHost(t, host.command, ['--data', join(data.root, 'data'), '--import', data.shared.file, '--release', data.shared.id]);
    const link = rooms[0]!.link;
    const roomId = link.split('/join/')[1]!.split('#')[0]!;

    const stranger = socket(player, roomId, 'http://evil.example');
    await assert.rejects(stranger.opened);

    const intruder = socket(player, roomId);
    await intruder.opened;
    intruder.send({ type: 'hello', version: 1, credential: 'x'.repeat(32), releaseId: data.shared.id });
    assert.equal((await intruder.next((message) => message.type === 'error')).code, 'expired');
    assert.equal(await intruder.closed, 1008);
    // Data after the JSON value is invalid JSON, as JSON.parse reads it.
    const trailing = socket(player, roomId);
    await trailing.opened;
    trailing.ws.send('{"type":"resync"}}');
    assert.equal(await trailing.closed, 1007);

    const first = await reserveSeat(player, link, 'Ada');
    const second = await reserveSeat(player, link, 'Bo');
    const a = socket(player, roomId);
    const b = socket(player, roomId);
    t.after(() => { a.ws.terminate(); b.ws.terminate(); });
    await Promise.all([a.opened, b.opened]);
    a.send({ type: 'hello', version: 1, credential: first.ticket, releaseId: data.shared.id });
    const welcome = await a.next((message) => message.type === 'welcome');
    const seat = (welcome.seat as { id: string }).id;
    b.send({ type: 'hello', version: 1, credential: second.ticket, releaseId: data.shared.id });
    await b.next((message) => message.type === 'welcome');

    a.send({ type: 'action', sequence: 1, action: { x: 1, label: 'run' } });
    const update = await b.next((message) => message.type === 'snapshot' &&
      (message.state as Record<string, unknown> | null)?.[seat] !== undefined);
    assert.deepEqual((update.state as Record<string, unknown>)[seat], { x: 1, label: 'run' });
    assert.equal((update.seats as unknown[]).length, 2);

    a.send({ type: 'action', sequence: 1, action: { x: 2 } });
    assert.equal((await a.next((message) => message.type === 'error')).code, 'stale-action');
    a.send({ type: 'action', sequence: 2, action: { text: 'x'.repeat(5000) } });
    assert.equal((await a.next((message) => message.type === 'error')).code, 'invalid-action');
    // 3,000 three-byte characters fit the 4096-unit state limit (strings cap at
    // 2048 units each) but need about 9 KB of UTF-8, more than the old 8 KB frame.
    const wide = { a: '界'.repeat(1500), b: '界'.repeat(1500) };
    a.send({ type: 'action', sequence: 3, action: wide });
    const widened = await b.next((message) => message.type === 'snapshot' &&
      ((message.state as Record<string, { a?: string }> | null)?.[seat]?.a?.length ?? 0) === 1500);
    assert.deepEqual((widened.state as Record<string, unknown>)[seat], wide);
    a.send({ type: 'resync' });
    await a.next((message) => message.type === 'snapshot');
    a.send({ type: 'bogus' });
    assert.equal((await a.next((message) => message.type === 'error')).code, 'protocol');

    // Over 60 messages in a second closes the connection.
    for (let i = 0; i < 70; i++) b.send({ type: 'resync' });
    assert.equal(await b.closed, 1008);

    const resumed = socket(player, roomId);
    t.after(() => resumed.ws.terminate());
    await resumed.opened;
    resumed.send({ type: 'hello', version: 1, credential: welcome.resume as string, releaseId: data.shared.id });
    assert.equal(((await resumed.next((message) => message.type === 'welcome')).seat as { id: string }).id, seat);
    assert.equal(await a.closed, 4001);
  });

  test(host.name + ' host runs the built-in tile and valley games', async (t) => {
    const data = fixtures(t);
    const { player, rooms } = await startHost(t, host.command, ['--data', join(data.root, 'data'),
      '--import', data.tiles.file, '--import', data.moss.file, '--release', data.tiles.id, '--release', data.moss.id]);
    const tilesLink = rooms[0]!.link;
    const tilesRoom = tilesLink.split('/join/')[1]!.split('#')[0]!;
    const first = await reserveSeat(player, tilesLink, 'Ada');
    const second = await reserveSeat(player, tilesLink, 'Bo');
    const a = socket(player, tilesRoom);
    const b = socket(player, tilesRoom);
    t.after(() => { a.ws.terminate(); b.ws.terminate(); });
    await Promise.all([a.opened, b.opened]);
    a.send({ type: 'hello', version: 1, credential: first.ticket, releaseId: data.tiles.id });
    const seatA = ((await a.next((message) => message.type === 'welcome')).seat as { id: string }).id;
    b.send({ type: 'hello', version: 1, credential: second.ticket, releaseId: data.tiles.id });
    await b.next((message) => message.type === 'welcome');
    a.send({ type: 'action', sequence: 1, action: { type: 'place', cell: 4 } });
    const placed = await b.next((message) => message.type === 'snapshot' &&
      (message.state as { board: (string | null)[] }).board[4] === seatA);
    assert.notEqual((placed.state as { turn: string }).turn, seatA);
    a.send({ type: 'action', sequence: 2, action: { type: 'place', cell: 0 } });
    assert.equal((await a.next((message) => message.type === 'error')).message, 'Wait for your turn.');
    b.send({ type: 'action', sequence: 1, action: { type: 'place', cell: null } });
    assert.equal((await b.next((message) => message.type === 'error')).message, 'Choose an open tile.');

    const mossLink = rooms[1]!.link;
    const mossRoom = mossLink.split('/join/')[1]!.split('#')[0]!;
    const explorer = await reserveSeat(player, mossLink, 'Cy');
    const c = socket(player, mossRoom);
    t.after(() => c.ws.terminate());
    await c.opened;
    c.send({ type: 'hello', version: 1, credential: explorer.ticket, releaseId: data.moss.id });
    await c.next((message) => message.type === 'welcome');
    const start = await c.next((message) => message.type === 'snapshot');
    const x = (start.state as { explorers: { x: number }[] }).explorers[0]!.x;
    c.send({ type: 'action', sequence: 1, action: { type: 'move', x: 1, y: 0 } });
    const moved = await c.next((message) => message.type === 'snapshot' &&
      (message.state as { explorers: { x: number }[] }).explorers[0]!.x > x);
    assert.ok((moved.state as { explorers: { x: number }[] }).explorers[0]!.x > x);
    c.send({ type: 'action', sequence: 2, action: { type: 'move', x: 5, y: 0 } });
    assert.equal((await c.next((message) => message.type === 'error')).code, 'invalid-action');
    c.send({ type: 'action', sequence: 3, action: { type: 'move', x: null, y: null } });
    assert.equal((await c.next((message) => message.type === 'error')).code, 'invalid-action');

    // Spectators cannot act, and binary frames end the connection.
    const [mossId, mossInvite] = mossLink.split('/join/')[1]!.split('#') as [string, string];
    const watch = await fetch(player + '/rooms/' + mossId + '/reserve', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: player }, body: JSON.stringify({ invite: mossInvite, name: 'Eye', role: 'spectator' }) });
    const { ticket } = await watch.json() as { ticket: string };
    const s = socket(player, mossRoom);
    t.after(() => s.ws.terminate());
    await s.opened;
    s.send({ type: 'hello', version: 1, credential: ticket, releaseId: data.moss.id });
    await s.next((message) => message.type === 'welcome');
    s.send({ type: 'action', sequence: 1, action: { type: 'move', x: 1, y: 0 } });
    assert.equal((await s.next((message) => message.type === 'error')).code, 'forbidden');
    s.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    assert.equal(await s.closed, 1008);
  });
}
