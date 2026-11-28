// The box's controllers in Box settings (box-controllers.ts), over the pads' routing (core/pads.ts) with a fake controller
// service: its view with each gamepad's screen and place, the owner's requests relayed to it and answered with its next
// view, 503 without it, editors of one game kept out, and a box gamepad that goes and comes back by its uid keeping its
// place.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { PAD_RESUME, Pads, type PadsLink } from '../packages/core/pads.ts';
import { BoxControllers, NO_SERVICE } from '../packages/server/box-controllers.ts';
import { boxRequest, type BoxContext } from '../packages/server/box-routes.ts';
import { checkRole } from '../packages/server/box-roles.ts';
import { encodePad } from '../packages/sdk/pads.ts';
import { boxFor, incoming, outgoing } from './box-fixtures.ts';

const VIEW = {
  type: 'controllers',
  scanning: false,
  bluetooth: true,
  pairing: null,
  error: null,
  devices: [
    { name: 'USB gamepad', kind: 'usb', connected: true, device: 0 },
    { name: 'Wireless Controller', kind: 'bluetooth', connected: true, device: 1, address: 'A0:B1:C2:D3:E4:F5' },
    { name: 'Arcade stick', kind: 'bluetooth', connected: false, address: '11:22:33:44:55:66' },
  ],
  found: [{ address: '77:88:99:AA:BB:CC', name: 'Pro pad' }],
} as const;

type Sent = { type: string; [key: string]: unknown };
/** A socket as the pads see it, keeping what it was sent. */
function link(answer?: (message: Sent) => void) {
  const texts: Sent[] = [];
  return {
    texts,
    text(message: object) {
      texts.push(structuredClone(message) as Sent);
      answer?.(message as Sent);
    },
    binary() {},
    close() {},
  } satisfies PadsLink & { texts: Sent[] };
}
const device = (number: number, uid?: string) => ({
  type: 'device' as const,
  device: number,
  name: 'Pad ' + number,
  standard: true,
  ...(uid ? { uid } : {}),
});
const press = encodePad({ standard: true, buttons: [{ pressed: true, value: 1 }], axes: [] });

/** The pads with a controller service on them, which answers each request as told, and the routes over them. */
function setup(t: TestContext, answer?: (message: Sent) => object | undefined, answerMs = 50) {
  let now = 1_000_000;
  const pads = new Pads(() => now);
  const service = link((message) => {
    const reply = answer?.(message);
    if (reply) queueMicrotask(() => pads.serviceMessage(service, reply as never));
  });
  pads.attachService(service);
  const box: BoxContext = { ...boxFor(t), controllers: new BoxControllers(pads, answerMs) };
  const call = async (method: string, action?: string, payload?: unknown) => {
    const { response, sent } = outgoing();
    const headers: Record<string, string> = {
      origin: 'http://zirbel.local',
      ...(payload ? { 'content-type': 'application/json' } : {}),
    };
    const handled = await boxRequest(
      box,
      incoming('192.168.1.20', method, '/', headers, payload ? JSON.stringify(payload) : ''),
      response,
      { local: false, device: 'owner' },
      { resource: 'box', pathID: 'controllers', action },
    ).catch((error: Error) => error);
    return {
      handled,
      status: sent.status,
      json: sent.body ? (JSON.parse(sent.body) as Record<string, unknown>) : undefined,
    };
  };
  return {
    pads,
    service,
    call,
    box,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('the box’s controllers come with the screen and place each one has', async (t) => {
  const { pads, service, call } = setup(t);
  pads.serviceMessage(service, device(0));
  // The TV takes the box's gamepads; the second is in its second place.
  const tv = link();
  const screen = pads.openScreen(tv, 'local', true)!;
  pads.serviceMessage(service, device(1));
  pads.serviceMessage(service, VIEW);
  const { status, json } = await call('GET');
  assert.equal(status, 200);
  assert.deepEqual(json, {
    scanning: false,
    bluetooth: true,
    pairing: null,
    error: null,
    found: VIEW.found,
    devices: [
      { ...VIEW.devices[0], screen: { code: screen.code, tv: true, place: 0 } },
      { ...VIEW.devices[1], screen: { code: screen.code, tv: true, place: 1 } },
      { ...VIEW.devices[2], screen: null },
    ],
  });
  // A view the contract refuses is as good as none.
  pads.serviceMessage(service, { ...VIEW, devices: [{ name: 'x', kind: 'serial', connected: true }] });
  assert.equal(((await call('GET')).handled as Error).message, NO_SERVICE);
});

test('the owner’s requests go to the service and are answered with its next view', async (t) => {
  const { service, call } = setup(t, (message) => ({
    ...VIEW,
    scanning: message.type === 'scan' && message.on === true,
    pairing: message.type === 'pair' ? message.address : null,
  }));
  assert.equal((await call('POST', 'scan', { on: true })).json!.scanning, true);
  assert.equal((await call('POST', 'pair', { address: '77:88:99:AA:BB:CC' })).json!.pairing, '77:88:99:AA:BB:CC');
  assert.equal((await call('POST', 'forget', { address: '11:22:33:44:55:66' })).status, 200);
  assert.deepEqual(service.texts, [
    { type: 'scan', on: true },
    { type: 'pair', address: '77:88:99:AA:BB:CC' },
    { type: 'forget', address: '11:22:33:44:55:66' },
  ]);
  // Not an address, not a switch, or more: refused before anything reaches the service.
  for (const [action, payload] of [
    ['pair', { address: '77:88:99:aa:bb:cc' }],
    ['forget', { address: '77:88:99:AA:BB' }],
    ['scan', { on: 'yes' }],
    ['scan', { on: true, more: 1 }],
    ['pair', {}],
  ] as const)
    assert.match(
      String((await call('POST', action, payload)).handled),
      /ZodError|Invalid|Unrecognized/,
      action + JSON.stringify(payload),
    );
  assert.equal(service.texts.length, 3);
  for (const [method, action] of [
    ['GET', 'scan'],
    ['POST', undefined],
    ['POST', 'connect'],
    ['PUT', 'pair'],
  ] as const)
    assert.equal((await call(method, action, {})).handled, false, method + ' ' + action);
});

test('a service that doesn’t answer in time leaves the view it had, and one with no view yet is none', async (t) => {
  const { pads, service, call } = setup(t, undefined, 20);
  assert.equal(((await call('GET')).handled as Error).message, NO_SERVICE);
  pads.serviceMessage(service, VIEW);
  assert.equal((await call('POST', 'scan', { on: true })).json!.scanning, false);
});

test('without the controllers service the routes answer 503', async (t) => {
  const { pads, service, call } = setup(t);
  pads.serviceMessage(service, VIEW);
  pads.serviceGone(service);
  const none = boxFor(t);
  for (const route of [
    call,
    async (method: string, action?: string, payload?: unknown) => {
      const { response } = outgoing();
      const headers: Record<string, string> = { origin: 'http://zirbel.local', 'content-type': 'application/json' };
      return {
        handled: await boxRequest(
          none,
          incoming('192.168.1.20', method, '/', headers, payload ? JSON.stringify(payload) : ''),
          response,
          { local: false, device: 'owner' },
          { resource: 'box', pathID: 'controllers', action },
        ).catch((error: Error) => error),
      };
    },
  ]) {
    for (const [method, action, payload] of [
      ['GET', undefined, undefined],
      ['POST', 'scan', { on: true }],
      ['POST', 'pair', { address: '77:88:99:AA:BB:CC' }],
    ] as const) {
      const { handled } = await route(method, action, payload);
      assert.deepEqual([(handled as { status?: number }).status, (handled as Error).message], [503, NO_SERVICE]);
    }
  }
});

test('an editor of one game never reaches the box’s controllers', () => {
  const editor = { local: false, editor: { id: 'editor', game: 'meadow' } };
  for (const [method, action] of [
    ['GET', undefined],
    ['POST', 'scan'],
    ['POST', 'pair'],
    ['POST', 'forget'],
  ] as const)
    assert.throws(
      () => checkRole(editor, { method, resource: 'box', pathID: 'controllers', action }, () => undefined),
      /This device edits one game only/,
    );
  checkRole(
    { local: false, device: 'owner' },
    { method: 'GET', resource: 'box', pathID: 'controllers' },
    () => undefined,
  );
});

test('a box gamepad that goes and comes back by its uid keeps its place, within a minute and while it is free', (t) => {
  const { pads, service, advance } = setup(t);
  const laptop = link();
  const screen = pads.openScreen(laptop, 'lan', false)!;
  pads.screenMessage(screen, laptop, { type: 'claim', place: 2 });
  pads.serviceMessage(service, device(0, 'A0:B1:C2:D3:E4:F5'));
  pads.serviceInput(service, 0, press);
  assert.deepEqual(pads.screenOf(0), { code: screen.code, box: false, place: 2 });
  // It drops (a Bluetooth gamepad reconnecting), and comes back as another number: the same place.
  pads.serviceMessage(service, { type: 'gone', device: 0 });
  assert.equal(pads.screenOf(0), undefined);
  pads.serviceMessage(service, device(3, 'A0:B1:C2:D3:E4:F5'));
  assert.deepEqual(pads.screenOf(3), { code: screen.code, box: false, place: 2 });
  // The service restarting is a reconnect too.
  pads.serviceGone(service);
  const again = link();
  pads.attachService(again);
  pads.serviceMessage(again, device(0, 'A0:B1:C2:D3:E4:F5'));
  assert.deepEqual(pads.screenOf(0), { code: screen.code, box: false, place: 2 });
  // Its place taken meanwhile, gone longer than a minute, or without a uid: it waits for a button, as a new gamepad does.
  pads.serviceMessage(again, { type: 'gone', device: 0 });
  const phone = pads.openPad(link(), 'lan', '192.168.1.30', screen.code, 2)!;
  pads.serviceMessage(again, device(0, 'A0:B1:C2:D3:E4:F5'));
  assert.equal(pads.screenOf(0), undefined);
  pads.padGone(phone, false);
  pads.screenMessage(screen, laptop, { type: 'claim', place: 2 });
  pads.serviceInput(again, 0, press);
  assert.deepEqual(pads.screenOf(0), { code: screen.code, box: false, place: 2 });
  pads.serviceMessage(again, { type: 'gone', device: 0 });
  advance(PAD_RESUME);
  pads.serviceMessage(again, device(0, 'A0:B1:C2:D3:E4:F5'));
  assert.equal(pads.screenOf(0), undefined);
  pads.serviceMessage(again, device(1));
  pads.serviceMessage(again, { type: 'gone', device: 1 });
  pads.serviceMessage(again, device(1));
  assert.equal(pads.screenOf(1), undefined);
  assert.equal(pads.connected, true);
});
