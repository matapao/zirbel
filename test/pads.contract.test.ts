// The pads socket on both hosts: `node dist/server.mjs --host-only` and the Go host (host/bin/zirbel-host). Screens and
// phones on /pads of the LAN listener, through the pages' own client (packages/web/pads-client.ts) and by hand, and the
// box's gamepads on its local socket (--pads-socket), with the same answers from each host.
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import { lanAddresses } from '../packages/server/http.ts';
import { decodePad, encodePad, openPad, openScreen, type PadInfo, type ScreenInfo } from '../packages/web/pads-client.ts';
import { hostsUnderTest, launch, rights, tempDir } from './helpers.ts';

const hosts = hostsUnderTest();
const CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
// The Unix socket's path, short enough for macOS's limit.
const unix = process.platform !== 'win32';

type Message = { type: string; [key: string]: unknown };
type Started = { lan: string; room: string; socket: string };

/** The host with --lan, one room open, and its local socket for the box's controller service. */
async function startHost(t: TestContext, command: string[]): Promise<Started> {
  const root = tempDir(t, 'zirbel-pads-');
  const projects = new Projects(join(root, 'source'));
  const release = new Releases(projects, 'dist/web').package(projects.createGame('Pads', { html: '<!doctype html><canvas></canvas>', maxPlayers: 2 }).id,
    'main', rights, false);
  const file = join(root, 'release.json');
  writeFileSync(file, JSON.stringify(release));
  const socket = join(root, 'host.sock');
  let room: { id: string; link: string } | undefined;
  const player = await launch(t, command, ['--host-only', '--lan', '--player-port', '0', '--data', join(root, 'data'), '--import', file,
    '--release', release.manifest.releaseId, ...(unix ? ['--pads-socket', socket] : [])], (line) => {
    if (typeof line.link === 'string') room = line as typeof room;
    return typeof line.player === 'string' ? line.player : undefined;
  }).ready;
  assert.ok(room && player);
  return { lan: 'http://127.0.0.1:' + new URL(room.link).port, room: room.id, socket };
}

/** Messages as they come, and a wait for the first that passes a check. */
function inbox<T>() {
  const items: T[] = [];
  let changed = () => {};
  return {
    items,
    push(item: T) { items.push(item); changed(); },
    async next(check: (item: T) => boolean = () => true, what = 'a message'): Promise<T> {
      const deadline = Date.now() + 4000;
      for (;;) {
        const index = items.findIndex(check);
        if (index >= 0) return items.splice(index, 1)[0]!;
        if (Date.now() > deadline) throw new Error('No ' + what + ' in ' + JSON.stringify(items));
        await new Promise<void>((resolve) => { changed = resolve; setTimeout(resolve, 50); });
      }
    },
  };
}
const ofType = (type: string) => (message: Message) => message.type === type;

/** A socket to /pads by hand: its JSON messages and frames, and the code it closed with. */
function raw(t: TestContext, origin: string, query: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(origin.replace('http', 'ws') + '/pads?' + query, { headers });
  t.after(() => ws.terminate());
  const messages = inbox<Message>(), frames = inbox<Uint8Array>();
  ws.on('message', (data: Buffer, binary) => {
    if (binary) frames.push(new Uint8Array(data));
    else messages.push(JSON.parse(data.toString('utf8')) as Message);
  });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const refused = new Promise<number>((resolve) => ws.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)));
  ws.on('error', () => {});
  return { ws, messages, frames, closed, refused, send(value: object | Uint8Array) { ws.send(value instanceof Uint8Array ? value : JSON.stringify(value)); } };
}

/** A screen through the pages' own client. */
function screen(t: TestContext, origin: string, resume?: string) {
  const screens = inbox<ScreenInfo>(), lists = inbox<PadInfo[]>(), frames = inbox<Uint8Array>(), opens = inbox<string>(), closes = inbox<number>();
  const held = openScreen({ origin, resume, onScreen: (info) => screens.push(info), onPads: (pads) => lists.push(pads),
    onFrame: (_pad, frame) => frames.push(frame.slice()), onOpen: (link) => opens.push(link), onClosed: (code) => closes.push(code) });
  t.after(() => held.close());
  return { held, screens, lists, frames, opens, closes };
}

const state = (pressed: number[] = [], slot = 0) => encodePad({ slot, standard: true, axes: [0.5, -1, 0, 0],
  buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: pressed.includes(index), value: pressed.includes(index) ? 1 : 0 })) });
const slotted = (frame: Uint8Array, slot: number) => [slot, ...frame.subarray(1)];

/** The box's controller service on the local socket: u16 length (LE), then 0 and JSON, or 1, a device and a pad state. */
async function service(t: TestContext, path: string) {
  const socket: Socket = connect(path);
  t.after(() => socket.destroy());
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const messages = inbox<Message>();
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2 && pending.length >= 2 + pending.readUInt16LE(0)) {
      const frame = pending.subarray(2, 2 + pending.readUInt16LE(0));
      pending = pending.subarray(2 + frame.length);
      if (frame[0] === 0) messages.push(JSON.parse(frame.subarray(1).toString('utf8')) as Message);
    }
  });
  const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const frame = (payload: Buffer) => {
    const head = Buffer.alloc(2);
    head.writeUInt16LE(payload.length);
    socket.write(Buffer.concat([head, payload]));
  };
  return {
    socket, messages, ended, frame,
    json(value: object) { frame(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value))])); },
    input(device: number, pad: Uint8Array) { frame(Buffer.concat([Buffer.from([1, device]), pad])); },
  };
}

for (const host of hosts) {
  test(host.name + ' host opens screens on /pads and seats phones on them by their code', async (t) => {
    const { lan } = await startHost(t, host.command);
    const tv = raw(t, lan, 'role=screen');
    const about = await tv.messages.next();
    assert.deepEqual(Object.keys(about), ['type', 'id', 'code', 'resume', 'box', 'tv']);
    assert.match(String(about.id), /^[a-f0-9]{12}$/);
    assert.match(String(about.code), CODE);
    assert.match(String(about.resume), /^[\w-]{32}$/);
    // From loopback: the box's own screen, so a TV is open.
    assert.deepEqual([about.type, about.box, about.tv], ['screen', true, true]);
    assert.deepEqual(await tv.messages.next(), { type: 'pads', pads: [] });

    // A phone joins by the code as a person types it, and its frames reach the screen with its slot.
    const phone = raw(t, lan, 'role=pad&code=' + encodeURIComponent(' ' + String(about.code).toLowerCase()));
    const answer = await phone.messages.next();
    assert.deepEqual(answer, { type: 'pad', slot: 0, screen: about.id, resume: answer.resume, label: null });
    assert.match(String(answer.resume), /^[\w-]{32}$/);
    assert.deepEqual(await tv.messages.next(), { type: 'pads', pads: [{ slot: 0, place: 0, kind: 'phone', name: 'Phone 1', connected: true, label: null }] });
    phone.send(state([0, 3], 6));
    assert.deepEqual([...await tv.frames.next()], slotted(state([0, 3]), 0));
    tv.send({ type: 'rumble', slot: 0, duration: 120, strong: 1, weak: 0.5 });
    assert.deepEqual(await phone.messages.next(), { type: 'rumble', slot: 0, duration: 120, strong: 1, weak: 0.5 });

    // Eight at most; then the screen lets one go.
    const more = Array.from({ length: 7 }, () => raw(t, lan, 'role=pad&code=' + String(about.code)));
    // They connect at once: which gets which place is the host's to say.
    const taken = await Promise.all(more.map(async (item) => (await item.messages.next()).slot as number));
    assert.deepEqual(taken.toSorted(), [1, 2, 3, 4, 5, 6, 7]);
    await tv.messages.next((message) => message.type === 'pads' && (message.pads as unknown[]).length === 8, 'all eight');
    tv.messages.items.length = 0;
    const ninth = raw(t, lan, 'role=pad&code=' + String(about.code));
    assert.equal(await ninth.closed, 4409);
    tv.send({ type: 'release', slot: 0 });
    assert.equal(await phone.closed, 4000);
    const list = await tv.messages.next((message) => message.type === 'pads' && (message.pads as unknown[]).length === 7);
    assert.deepEqual((list.pads as PadInfo[]).map((pad) => pad.slot), [1, 2, 3, 4, 5, 6, 7]);
    // A phone sends pad frames and its own control messages.
    more[0]!.send({ type: 'claim' });
    more[1]!.send(new Uint8Array([0, 0, 1, 0, 0, 0, 0, 0]));
    more[2]!.send(new Uint8Array(57));
    more[3]!.send(new Uint8Array(1025));
    assert.deepEqual(await Promise.all(more.slice(0, 4).map((item) => item.closed)), [1008, 1003, 1003, 1009]);
    await tv.messages.next((message) => message.type === 'pads' && (message.pads as unknown[]).length === 3, 'the list without them');

    // A screen sends control messages, and pad frames never.
    for (const [send, code] of [[(s: ReturnType<typeof raw>) => s.ws.send(new Uint8Array(8)), 1003], [(s: ReturnType<typeof raw>) => s.ws.send('{'), 1007],
      [(s: ReturnType<typeof raw>) => s.send({ type: 'release', slot: 8 }), 1008], [(s: ReturnType<typeof raw>) => s.send({ type: 'claim', more: 1 }), 1008],
      [(s: ReturnType<typeof raw>) => s.send({ type: 'show', link: 'http://evil.example/join/x' }), 1008],
      [(s: ReturnType<typeof raw>) => s.send({ type: 'labels', labels: [{ place: 0, name: 'Red', color: 'red' }] }), 1008],
      [(s: ReturnType<typeof raw>) => s.send({ type: 'labels', labels: [{ place: 0, name: 'n'.repeat(25), color: '#ff0000' }] }), 1008],
      [(s: ReturnType<typeof raw>) => s.send({ type: 'local', places: [0, 1, 2, 3, 4, 5, 6, 7, 0] }), 1008],
      [(s: ReturnType<typeof raw>) => s.send({ type: 'move', from: 0 }), 1008],
      [(s: ReturnType<typeof raw>) => s.ws.send(JSON.stringify({ type: 'claim', pad: 'x'.repeat(1024) })), 1009]] as const) {
      const other = raw(t, lan, 'role=screen');
      await other.messages.next(ofType('pads'));
      send(other);
      assert.equal(await other.closed, code);
    }

    // Who may open it: pages of this listener, and no game's frame.
    for (const origin of ['http://evil.example', 'null']) assert.equal(await raw(t, lan, 'role=screen', { origin }).refused, 403, origin);
    assert.ok(await raw(t, lan, 'role=screen', { origin: lan }).messages.next(ofType('screen')));
    for (const query of ['', 'role=tv', 'role=Screen']) assert.equal(await raw(t, lan, query).refused, 400, query);
    const page = await fetch(lan + '/pads');
    assert.deepEqual([page.status, await page.json()], [404, { error: 'Open the invitation link from the host.' }]);

    // Wrong codes count against the address, ten in a minute.
    for (let i = 0; i < 10; i++) assert.equal(await raw(t, lan, 'role=pad&code=' + (i % 2 ? 'nope' : '')).closed, 4404);
    assert.equal(await raw(t, lan, 'role=pad&code=' + String(about.code)).closed, 4429);
  });

  test(host.name + ' host keeps a screen for its resume, with its code and controllers, and ends one that closes itself', async (t) => {
    const { lan } = await startHost(t, host.command);
    const first = raw(t, lan, 'role=screen');
    const about = await first.messages.next(ofType('screen'));
    const phone = raw(t, lan, 'role=pad&code=' + String(about.code));
    await phone.messages.next(ofType('pad'));
    // The page navigates; the next one resumes it through the client.
    first.ws.terminate();
    const next = screen(t, lan, String(about.resume));
    assert.deepEqual(await next.screens.next(), { id: about.id, code: about.code, resume: about.resume, box: true, tv: true });
    assert.deepEqual(await next.lists.next(), [{ slot: 0, place: 0, kind: 'phone', name: 'Phone 1', connected: true, label: null }]);
    phone.send(state([1]));
    assert.deepEqual([...await next.frames.next()], slotted(state([1]), 0));
    // A page that resumes it while it is open takes it over; the one it was on stops.
    const taken = raw(t, lan, 'role=screen&resume=' + String(about.resume));
    assert.equal((await taken.messages.next(ofType('screen'))).code, about.code);
    assert.equal(await next.closes.next(), 4001);
    // A token no screen has opens a new one.
    const fresh = await raw(t, lan, 'role=screen&resume=nothing').messages.next(ofType('screen'));
    assert.notEqual(fresh.code, about.code);
    // Its own close ends it: its phones are told, and its code is no one's.
    taken.ws.close(1000);
    assert.deepEqual(await phone.messages.next(), { type: 'closed' });
    assert.equal(await phone.closed, 1000);
    assert.equal(await raw(t, lan, 'role=pad&code=' + String(about.code)).closed, 4404);

    // A phone through the client: it repeats its state while still, and hears its screen end.
    const other = screen(t, lan);
    const code = (await other.screens.next()).code;
    const joined = inbox<number>(), ended = inbox<number>();
    const pad = openPad(code, { origin: lan, onPad: ({ slot }) => joined.push(slot), onClosed: (closed) => ended.push(closed) });
    t.after(() => pad.close());
    assert.equal(await joined.next(), 0);
    pad.send({ standard: true, buttons: [{ pressed: true, value: 1 }], axes: [0.25] });
    const sent = await other.frames.next();
    assert.deepEqual(decodePad(sent)?.buttons, [{ pressed: true, value: 1 }]);
    assert.deepEqual([...await other.frames.next()], [...sent], 'again while still');
    other.held.close();
    assert.equal(await ended.next(), 1000);
  });

  test(host.name + ' host shows a player page on the box’s own screen, and tells the others while one is open', async (t) => {
    const address = lanAddresses()[0];
    if (!address) { t.skip('no LAN address to reach the listener from elsewhere than loopback'); return; }
    const { lan, room } = await startHost(t, host.command);
    const elsewhere = lan.replace('127.0.0.1', address);
    const laptop = screen(t, elsewhere);
    const mine = await laptop.screens.next();
    assert.deepEqual([mine.box, mine.tv], [false, false]);
    await assert.rejects(laptop.held.show('/join/' + room), /No TV/);
    const tv = screen(t, lan);
    const box = await tv.screens.next();
    assert.deepEqual([box.box, box.tv], [true, true]);
    assert.deepEqual(await laptop.screens.next(), { ...mine, tv: true });
    const link = '/join/' + room + '#seat=' + 'a'.repeat(32);
    assert.equal(await laptop.held.show(link), box.code);
    assert.equal(await tv.opens.next(), link);
    // Its page becomes a pad of the TV.
    const pad = openPad(box.code, { origin: elsewhere });
    t.after(() => pad.close());
    assert.deepEqual((await tv.lists.next((pads) => pads.length === 1))[0], { slot: 0, place: 0, kind: 'phone', name: 'Phone 1', connected: true, label: null });
    tv.held.close();
    assert.deepEqual(await laptop.screens.next(), { ...mine, tv: false });
  });

  test(host.name + ' host gives each controller a place: the one it asks for, its old one back, a free one it moves to', async (t) => {
    const { lan } = await startHost(t, host.command);
    const tv = raw(t, lan, 'role=screen');
    const about = await tv.messages.next(ofType('screen'));
    const code = String(about.code);
    const pad = (query = '') => raw(t, lan, 'role=pad&code=' + code + query);
    const placeOf = async (item: ReturnType<typeof raw>) => (await item.messages.next(ofType('pad'))).slot;
    // Through the pages' client: the place in its link.
    const places = inbox<{ slot: number; label: unknown }>();
    const first = openPad(code, { origin: lan, place: 2, onPad: ({ slot, label }) => places.push({ slot, label }) });
    t.after(() => first.close());
    assert.deepEqual(await places.next(), { slot: 2, label: null });
    // Taken, or none: the first free one.
    const second = pad('&place=2');
    assert.equal(await placeOf(second), 0);
    assert.equal(await placeOf(pad('&place=9')), 1);
    // Each place's label, and each phone hears its own.
    tv.send({ type: 'labels', labels: [{ place: 2, name: 'Red car', color: '#ff0000' }, { place: 6, name: 'Blue', color: '#0000ff' }] });
    assert.deepEqual(await places.next(), { slot: 2, label: { name: 'Red car', color: '#ff0000' } });
    const labelled = await tv.messages.next((message) => message.type === 'pads' && JSON.stringify(message).includes('Red car'));
    assert.deepEqual(labelled.pads, [0, 1, 2].map((place) => ({ slot: place, place, kind: 'phone', name: 'Phone ' + (place + 1), connected: true,
      label: place === 2 ? { name: 'Red car', color: '#ff0000' } : null })));
    // The screen's own gamepads' places go to no phone.
    tv.send({ type: 'local', places: [3] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await placeOf(pad('&place=3')), 4);
    // A phone moves to a free place; the screen swaps two.
    first.place(3);
    first.place(5);
    assert.deepEqual(await places.next(), { slot: 5, label: null });
    tv.send({ type: 'move', from: 5, to: 6 });
    assert.deepEqual(await places.next(), { slot: 6, label: { name: 'Blue', color: '#0000ff' } });
    tv.messages.items.length = 0;
    // A dropped phone takes its old place back with its resume, and so does one whose old socket isn't yet seen to go.
    const dropped = pad('&place=7');
    const held = await dropped.messages.next(ofType('pad'));
    assert.equal(held.slot, 7);
    dropped.ws.terminate();
    await dropped.closed;
    const back = pad('&place=1&resume=' + String(held.resume));
    assert.deepEqual(await back.messages.next(ofType('pad')), held);
    const over = pad('&resume=' + String(held.resume));
    assert.deepEqual(await over.messages.next(ofType('pad')), held);
    assert.equal(await back.closed, 4001);
    // Press A to take a place: the next controller whose A goes down takes it.
    tv.send({ type: 'claim', place: 5 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    second.send(state([1]));
    second.send(state([1, 0]));
    assert.equal(await placeOf(second), 5);
    assert.deepEqual([(await tv.frames.next())[0], (await tv.frames.next())[0]], [0, 5]);
  });

  test(host.name + ' host takes the box’s own gamepads from its controller service on the local socket', { skip: !unix }, async (t) => {
    const { lan, socket } = await startHost(t, host.command);
    assert.equal(statSync(socket).mode & 0o777, 0o660);
    const tv = screen(t, lan);
    await tv.screens.next();
    await tv.lists.next();
    const box = await service(t, socket);
    box.json({ type: 'device', device: 2, name: 'Test pad', standard: true });
    assert.deepEqual(await tv.lists.next(), [{ slot: 0, place: 0, kind: 'box', name: 'Test pad', connected: true, label: null }]);
    box.input(2, state([0], 5));
    assert.deepEqual([...await tv.frames.next()], slotted(state([0]), 0));
    tv.held.rumble(0, { duration: 250, strong: 0.75, weak: 0.25 });
    assert.deepEqual(await box.messages.next(), { type: 'rumble', device: 2, duration: 250, strong: 0.75, weak: 0.25 });

    // Let go, it joins the screen that claims one when its button goes down, and goes back when that screen ends.
    const other = screen(t, lan);
    await other.lists.next();
    other.held.claim();
    await new Promise((resolve) => setTimeout(resolve, 200));
    tv.held.release(0);
    assert.deepEqual(await tv.lists.next(), []);
    box.input(2, state([0]));
    box.input(2, state([0, 1]));
    assert.deepEqual(await other.lists.next((pads) => pads.length === 1), [{ slot: 0, place: 0, kind: 'box', name: 'Test pad', connected: true, label: null }]);
    assert.deepEqual([...await other.frames.next()], slotted(state([0, 1]), 0));
    other.held.close();
    assert.deepEqual(await tv.lists.next(), [{ slot: 0, place: 0, kind: 'box', name: 'Test pad', connected: true, label: null }]);
    // Press A to take a place.
    tv.held.claim(4);
    await new Promise((resolve) => setTimeout(resolve, 200));
    box.input(2, state([1]));
    box.input(2, state([0, 1]));
    assert.deepEqual(await tv.lists.next(), [{ slot: 4, place: 4, kind: 'box', name: 'Test pad', connected: true, label: null }]);
    box.json({ type: 'gone', device: 2 });
    assert.deepEqual(await tv.lists.next(), []);

    // One service at a time: a new connection replaces the old, whose gamepads are gone.
    box.json({ type: 'device', device: 4, name: 'Old pad', standard: false });
    await tv.lists.next((pads) => pads.length === 1);
    const again = await service(t, socket);
    await box.ended;
    assert.deepEqual(await tv.lists.next(), []);
    again.json({ type: 'controllers', devices: [], found: [], scanning: false });
    again.json({ type: 'device', device: 15, name: 'New pad', standard: true });
    assert.deepEqual(await tv.lists.next(), [{ slot: 0, place: 0, kind: 'box', name: 'New pad', connected: true, label: null }]);
    // A frame that isn't one ends the connection.
    again.json({ type: 'device', device: 16, name: 'Too many', standard: true });
    await again.ended;
    assert.deepEqual(await tv.lists.next(), []);
    const third = await service(t, socket);
    third.frame(Buffer.from([1, 0, 0, 0]));
    await third.ended;
  });
}
