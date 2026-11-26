// The box's controllers in Box settings (box-controllers.ts): the controllers service's view with each gamepad's screen
// and place, the owner's requests relayed to it and answered with its next view, 503 without it, and editors of one game
// kept out.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { BoxControllers, NO_SERVICE, type ControllerService } from '../packages/server/box-controllers.ts';
import { boxRequest, type BoxContext } from '../packages/server/box-routes.ts';
import { checkRole } from '../packages/server/box-roles.ts';
import { boxFor, incoming, outgoing } from './box-fixtures.ts';

const VIEW = {
  type: 'controllers', scanning: false, bluetooth: true, pairing: null, error: null,
  devices: [
    { name: 'USB gamepad', kind: 'usb', connected: true, device: 0 },
    { name: 'Wireless Controller', kind: 'bluetooth', connected: true, device: 1, address: 'A0:B1:C2:D3:E4:F5' },
    { name: 'Arcade stick', kind: 'bluetooth', connected: false, address: '11:22:33:44:55:66' },
  ],
  found: [{ address: '77:88:99:AA:BB:CC', name: 'Pro pad' }],
};

/** The pads' local socket with a controllers service on it, which answers each request as told. */
function fakeService(answer?: (message: Record<string, unknown>) => unknown) {
  const listeners: ((message: unknown) => void)[] = [];
  const sent: Record<string, unknown>[] = [];
  const service = {
    on: true, sent,
    connected: () => service.on,
    send(message: Record<string, unknown>) {
      if (!service.on) return false;
      sent.push(message);
      const reply = answer?.(message);
      if (reply) queueMicrotask(() => service.emit(reply));
      return true;
    },
    onControl(listener: (message: unknown) => void) { listeners.push(listener); },
    screenOf: (device: number) => device === 1 ? { code: 'KQWZ', box: true, place: 1 } : undefined,
    emit(message: unknown) { for (const listener of listeners) listener(message); },
  };
  return service satisfies ControllerService;
}

function routes(t: TestContext, controllers?: BoxControllers) {
  const box: BoxContext = { ...boxFor(t), controllers };
  return async (method: string, action?: string, payload?: unknown) => {
    const { response, sent } = outgoing();
    const headers: Record<string, string> = { origin: 'http://zirbel.local', ...(payload ? { 'content-type': 'application/json' } : {}) };
    const handled = await boxRequest(box, incoming('192.168.1.20', method, '/', headers, payload ? JSON.stringify(payload) : ''), response,
      { local: false, device: 'owner' }, { resource: 'box', pathID: 'controllers', action }).catch((error: Error) => error);
    return { handled, status: sent.status, json: sent.body ? JSON.parse(sent.body) as Record<string, unknown> : undefined };
  };
}

test('the box’s controllers come with the screen and place each one has', async (t) => {
  const service = fakeService();
  const call = routes(t, new BoxControllers(service, 50));
  service.emit(VIEW);
  const { status, json } = await call('GET');
  assert.equal(status, 200);
  assert.deepEqual(json, { scanning: false, bluetooth: true, pairing: null, error: null, found: VIEW.found, devices: [
    { ...VIEW.devices[0], screen: null },
    { ...VIEW.devices[1], screen: { code: 'KQWZ', tv: true, place: 1 } },
    { ...VIEW.devices[2], screen: null },
  ] });
  // A view the service shouldn't have sent leaves the last one.
  service.emit({ ...VIEW, devices: [{ name: 'x', kind: 'serial', connected: true }] });
  service.emit({ type: 'device', device: 2, name: 'Other', standard: true, uid: 'usb-1' });
  assert.equal(((await call('GET')).json!.devices as unknown[]).length, 3);
});

test('the owner’s requests go to the service and are answered with its next view', async (t) => {
  const service = fakeService((message) => ({ ...VIEW, scanning: message.type === 'scan' && message.on === true,
    pairing: message.type === 'pair' ? message.address : null }));
  const call = routes(t, new BoxControllers(service, 50));
  assert.equal((await call('POST', 'scan', { on: true })).json!.scanning, true);
  assert.equal((await call('POST', 'pair', { address: '77:88:99:AA:BB:CC' })).json!.pairing, '77:88:99:AA:BB:CC');
  assert.equal((await call('POST', 'forget', { address: '11:22:33:44:55:66' })).status, 200);
  assert.deepEqual(service.sent, [{ type: 'scan', on: true }, { type: 'pair', address: '77:88:99:AA:BB:CC' },
    { type: 'forget', address: '11:22:33:44:55:66' }]);
  // Not an address, not a switch, or more: refused before anything reaches the service.
  for (const [action, payload] of [['pair', { address: '77:88:99:aa:bb:cc' }], ['forget', { address: '77:88:99:AA:BB' }],
    ['scan', { on: 'yes' }], ['scan', { on: true, more: 1 }], ['pair', {}]] as const)
    assert.match(String((await call('POST', action, payload)).handled), /ZodError|Invalid|Unrecognized/, action + JSON.stringify(payload));
  assert.equal(service.sent.length, 3);
  // Other routes are not these.
  for (const [method, action] of [['GET', 'scan'], ['POST', undefined], ['POST', 'connect'], ['PUT', 'pair']] as const)
    assert.equal((await call(method, action, {})).handled, false, method + ' ' + action);
});

test('a service that doesn’t answer in time leaves the view it had', async (t) => {
  const service = fakeService();
  const call = routes(t, new BoxControllers(service, 20));
  service.emit({ ...VIEW, scanning: false });
  assert.equal((await call('POST', 'scan', { on: true })).json!.scanning, false);
  // Connected, with no view yet and none coming: as good as no service.
  const quiet = routes(t, new BoxControllers(fakeService(), 20));
  assert.equal(((await quiet('GET')).handled as Error).message, NO_SERVICE);
});

test('without the controllers service the routes answer 503', async (t) => {
  for (const controllers of [undefined, (() => { const service = fakeService(); service.on = false; return new BoxControllers(service); })()]) {
    const call = routes(t, controllers);
    for (const [method, action, payload] of [['GET', undefined, undefined], ['POST', 'scan', { on: true }],
      ['POST', 'pair', { address: '77:88:99:AA:BB:CC' }]] as const) {
      const { handled } = await call(method, action, payload);
      assert.deepEqual([(handled as { status?: number }).status, (handled as Error).message], [503, NO_SERVICE]);
    }
  }
});

test('an editor of one game never reaches the box’s controllers', () => {
  const editor = { local: false, editor: { id: 'editor', game: 'meadow' } };
  for (const [method, action] of [['GET', undefined], ['POST', 'scan'], ['POST', 'pair'], ['POST', 'forget']] as const)
    assert.throws(() => checkRole(editor, { method, resource: 'box', pathID: 'controllers', action }, () => undefined),
      /This device edits one game only/);
  checkRole({ local: false, device: 'owner' }, { method: 'GET', resource: 'box', pathID: 'controllers' }, () => undefined);
});
