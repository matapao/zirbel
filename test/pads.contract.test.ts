// The pads socket on both hosts: `node dist/server.mjs --host-only` and the Go host (host/bin/zirbel-host). Screens and
// phones on /pads of the LAN listener, through the pages' own client (packages/web/pads-client.ts) and by hand, and the
// box's gamepads on its local socket (--pads-socket), with the same answers from each host.
// The host, the sockets and the fake controller service are pads-contract-fixture.ts.
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { test } from 'node:test';
import { lanAddresses } from '../packages/server/http.ts';
import { decodePad, openPad, type PadInfo } from '../packages/web/pads-client.ts';
import { hostsUnderTest } from './helpers.ts';
import { inbox, ofType, raw, screen, service, slotted, startHost, state, unix } from './pads-contract-fixture.ts';

const hosts = hostsUnderTest();
const CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;

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
    assert.deepEqual(await tv.messages.next(), {
      type: 'pads',
      pads: [{ slot: 0, place: 0, kind: 'phone', name: 'Phone 1', connected: true, label: null }],
    });
    phone.send(state([0, 3], 6));
    assert.deepEqual([...(await tv.frames.next())], slotted(state([0, 3]), 0));
    tv.send({ type: 'rumble', slot: 0, duration: 120, strong: 1, weak: 0.5 });
    assert.deepEqual(await phone.messages.next(), { type: 'rumble', slot: 0, duration: 120, strong: 1, weak: 0.5 });

    // Eight at most; then the screen lets one go.
    const more = Array.from({ length: 7 }, () => raw(t, lan, 'role=pad&code=' + String(about.code)));
    // They connect at once: which gets which place is the host's to say.
    const taken = await Promise.all(more.map(async (item) => (await item.messages.next()).slot as number));
    assert.deepEqual(
      taken.toSorted((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7],
    );
    await tv.messages.next(
      (message) => message.type === 'pads' && (message.pads as unknown[]).length === 8,
      'all eight',
    );
    tv.messages.items.length = 0;
    const ninth = raw(t, lan, 'role=pad&code=' + String(about.code));
    assert.equal(await ninth.closed, 4409);
    tv.send({ type: 'release', slot: 0 });
    assert.equal(await phone.closed, 4000);
    const list = await tv.messages.next(
      (message) => message.type === 'pads' && (message.pads as unknown[]).length === 7,
    );
    assert.deepEqual(
      (list.pads as PadInfo[]).map((pad) => pad.slot),
      [1, 2, 3, 4, 5, 6, 7],
    );
    // A phone sends pad frames and its own control messages.
    more[0]!.send({ type: 'claim' });
    more[1]!.send(new Uint8Array([0, 0, 1, 0, 0, 0, 0, 0]));
    more[2]!.send(new Uint8Array(57));
    more[3]!.send(new Uint8Array(1025));
    assert.deepEqual(await Promise.all(more.slice(0, 4).map((item) => item.closed)), [1008, 1003, 1003, 1009]);
    await tv.messages.next(
      (message) => message.type === 'pads' && (message.pads as unknown[]).length === 3,
      'the list without them',
    );

    // A screen sends control messages, and pad frames never.
    for (const [send, code] of [
      [(s: ReturnType<typeof raw>) => s.ws.send(new Uint8Array(8)), 1003],
      [(s: ReturnType<typeof raw>) => s.ws.send('{'), 1007],
      [(s: ReturnType<typeof raw>) => s.send({ type: 'release', slot: 8 }), 1008],
      [(s: ReturnType<typeof raw>) => s.send({ type: 'claim', more: 1 }), 1008],
      [(s: ReturnType<typeof raw>) => s.send({ type: 'show', link: 'http://evil.example/join/x' }), 1008],
      [
        (s: ReturnType<typeof raw>) => s.send({ type: 'labels', labels: [{ place: 0, name: 'Red', color: 'red' }] }),
        1008,
      ],
      [
        (s: ReturnType<typeof raw>) =>
          s.send({ type: 'labels', labels: [{ place: 0, name: 'n'.repeat(25), color: '#ff0000' }] }),
        1008,
      ],
      [(s: ReturnType<typeof raw>) => s.send({ type: 'local', places: [0, 1, 2, 3, 4, 5, 6, 7, 0] }), 1008],
      [(s: ReturnType<typeof raw>) => s.send({ type: 'move', from: 0 }), 1008],
      [(s: ReturnType<typeof raw>) => s.ws.send(JSON.stringify({ type: 'claim', pad: 'x'.repeat(1024) })), 1009],
    ] as const) {
      const other = raw(t, lan, 'role=screen');
      await other.messages.next(ofType('pads'));
      send(other);
      assert.equal(await other.closed, code);
    }

    // Who may open it: pages of this listener, and no game's frame.
    for (const origin of ['http://evil.example', 'null'])
      assert.equal(await raw(t, lan, 'role=screen', { origin }).refused, 403, origin);
    assert.ok(await raw(t, lan, 'role=screen', { origin: lan }).messages.next(ofType('screen')));
    for (const query of ['', 'role=tv', 'role=Screen']) assert.equal(await raw(t, lan, query).refused, 400, query);
    const page = await fetch(lan + '/pads');
    assert.deepEqual([page.status, await page.json()], [404, { error: 'Open the invitation link from the host.' }]);

    // Wrong codes count against the address, ten in a minute.
    for (let i = 0; i < 10; i++) assert.equal(await raw(t, lan, 'role=pad&code=' + (i % 2 ? 'nope' : '')).closed, 4404);
    assert.equal(await raw(t, lan, 'role=pad&code=' + String(about.code)).closed, 4429);
  });

  test(
    host.name + ' host keeps a screen for its resume, with its code and controllers, and ends one that closes itself',
    async (t) => {
      const { lan } = await startHost(t, host.command);
      const first = raw(t, lan, 'role=screen');
      const about = await first.messages.next(ofType('screen'));
      const phone = raw(t, lan, 'role=pad&code=' + String(about.code));
      await phone.messages.next(ofType('pad'));
      // The page navigates; the next one resumes it through the client.
      first.ws.terminate();
      const next = screen(t, lan, String(about.resume));
      assert.deepEqual(await next.screens.next(), {
        id: about.id,
        code: about.code,
        resume: about.resume,
        box: true,
        tv: true,
      });
      assert.deepEqual(await next.lists.next(), [
        { slot: 0, place: 0, kind: 'phone', name: 'Phone 1', connected: true, label: null },
      ]);
      phone.send(state([1]));
      assert.deepEqual([...(await next.frames.next())], slotted(state([1]), 0));
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
      const joined = inbox<number>(),
        ended = inbox<number>();
      const pad = openPad(code, {
        origin: lan,
        onPad: ({ slot }) => joined.push(slot),
        onClosed: (closed) => ended.push(closed),
      });
      t.after(() => pad.close());
      assert.equal(await joined.next(), 0);
      pad.send({ standard: true, buttons: [{ pressed: true, value: 1 }], axes: [0.25] });
      const sent = await other.frames.next();
      assert.deepEqual(decodePad(sent)?.buttons, [{ pressed: true, value: 1 }]);
      assert.deepEqual([...(await other.frames.next())], [...sent], 'again while still');
      other.held.close();
      assert.equal(await ended.next(), 1000);
    },
  );

  test(
    host.name + ' host shows a player page on the box’s own screen, and tells the others while one is open',
    async (t) => {
      const address = lanAddresses()[0];
      if (!address) {
        t.skip('no LAN address to reach the listener from elsewhere than loopback');
        return;
      }
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
      assert.deepEqual((await tv.lists.next((pads) => pads.length === 1))[0], {
        slot: 0,
        place: 0,
        kind: 'phone',
        name: 'Phone 1',
        connected: true,
        label: null,
      });
      tv.held.close();
      assert.deepEqual(await laptop.screens.next(), { ...mine, tv: false });
    },
  );

  test(
    host.name + ' host gives each controller a place: the one it asks for, its old one back, a free one it moves to',
    async (t) => {
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
      tv.send({
        type: 'labels',
        labels: [
          { place: 2, name: 'Red car', color: '#ff0000' },
          { place: 6, name: 'Blue', color: '#0000ff' },
        ],
      });
      assert.deepEqual(await places.next(), { slot: 2, label: { name: 'Red car', color: '#ff0000' } });
      const labelled = await tv.messages.next(
        (message) => message.type === 'pads' && JSON.stringify(message).includes('Red car'),
      );
      assert.deepEqual(
        labelled.pads,
        [0, 1, 2].map((place) => ({
          slot: place,
          place,
          kind: 'phone',
          name: 'Phone ' + (place + 1),
          connected: true,
          label: place === 2 ? { name: 'Red car', color: '#ff0000' } : null,
        })),
      );
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
    },
  );

  test(
    host.name + ' host takes the box’s own gamepads from its controller service on the local socket',
    { skip: !unix },
    async (t) => {
      const { lan, socket } = await startHost(t, host.command);
      assert.equal(statSync(socket).mode & 0o777, 0o660);
      const tv = screen(t, lan);
      await tv.screens.next();
      await tv.lists.next();
      const box = await service(t, socket);
      box.json({ type: 'device', device: 2, name: 'Test pad', standard: true });
      assert.deepEqual(await tv.lists.next(), [
        { slot: 0, place: 0, kind: 'box', name: 'Test pad', connected: true, label: null },
      ]);
      box.input(2, state([0], 5));
      assert.deepEqual([...(await tv.frames.next())], slotted(state([0]), 0));
      tv.held.rumble(0, { duration: 250, strong: 0.75, weak: 0.25 });
      assert.deepEqual(await box.messages.next(), {
        type: 'rumble',
        device: 2,
        duration: 250,
        strong: 0.75,
        weak: 0.25,
      });

      // Let go, it joins the screen that claims one when its button goes down, and goes back when that screen ends.
      const other = screen(t, lan);
      await other.lists.next();
      other.held.claim();
      await new Promise((resolve) => setTimeout(resolve, 200));
      tv.held.release(0);
      assert.deepEqual(await tv.lists.next(), []);
      box.input(2, state([0]));
      box.input(2, state([0, 1]));
      assert.deepEqual(await other.lists.next((pads) => pads.length === 1), [
        { slot: 0, place: 0, kind: 'box', name: 'Test pad', connected: true, label: null },
      ]);
      assert.deepEqual([...(await other.frames.next())], slotted(state([0, 1]), 0));
      other.held.close();
      assert.deepEqual(await tv.lists.next(), [
        { slot: 0, place: 0, kind: 'box', name: 'Test pad', connected: true, label: null },
      ]);
      // Press A to take a place.
      tv.held.claim(4);
      await new Promise((resolve) => setTimeout(resolve, 200));
      box.input(2, state([1]));
      box.input(2, state([0, 1]));
      assert.deepEqual(await tv.lists.next(), [
        { slot: 4, place: 4, kind: 'box', name: 'Test pad', connected: true, label: null },
      ]);
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
      assert.deepEqual(await tv.lists.next(), [
        { slot: 0, place: 0, kind: 'box', name: 'New pad', connected: true, label: null },
      ]);
      // A frame that isn't one ends the connection.
      again.json({ type: 'device', device: 16, name: 'Too many', standard: true });
      await again.ended;
      assert.deepEqual(await tv.lists.next(), []);
      const third = await service(t, socket);
      third.frame(Buffer.from([1, 0, 0, 0]));
      await third.ended;
    },
  );
}
