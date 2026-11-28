// A box (--box) on both hosts: `node dist/server.mjs --box` and the Go host's --box. Each runs one scripted session,
// from the box itself (loopback) and from this computer's own network address, and their normalized answers must
// match: the door, the pairing page and its codes and claim, the paired devices, the switches, the setup flag, the
// box's own Wi-Fi, its TV, external MCP access, the lobby a device that isn't paired is sent to, and its address for
// other devices; and in a second session, the editors of one game: its edit code, the edit page, what an editor may
// and may not do, and its session's end; and in a third, the box's controllers in Box settings. What the hosts differ
// in by design is compared by its form only: harnesses run in the Node editor alone, and only it draws a QR code, for a
// pairing link or for joining the box's own Wi-Fi.
// The first two sessions are box-session.ts and box-editors-session.ts, over box-contract-fixture.ts.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { client, normalizer, startBox, type Started, type Step } from './box-contract-fixture.ts';
import { editorsSession } from './box-editors-session.ts';
import { session } from './box-session.ts';
import { hostsUnderTest } from './helpers.ts';
import { padsService } from './pads-service.ts';

const hosts = hostsUnderTest();

const VIEW = { type: 'controllers', scanning: false, bluetooth: true, pairing: null, error: null,
  devices: [{ name: 'USB gamepad', kind: 'usb', connected: true, device: 0 },
    { name: 'Arcade stick', kind: 'bluetooth', connected: false, address: '11:22:33:44:55:66' }],
  found: [{ address: '77:88:99:AA:BB:CC', name: 'Pro pad' }] };

/** The box's controllers (box-controllers.ts), which owners list and pair in Box settings: with no controller service on
 *  the box, there are none to list or pair (503), and a request is checked first; with one on its local socket, its
 *  view with each gamepad's screen and place, and each request relayed to it and answered with its next view. */
async function controllersSession(t: TestContext, { editor: base, pads }: Started) {
  const steps: Step[] = [];
  const box = client(base);
  const record = async (step: Promise<Step>) => { const result = await step; steps.push(result); return result; };
  const none = await record(box('GET', '/api/box/controllers'));
  assert.deepEqual(none.body, { error: 'The box’s controller service isn’t running.' });
  await record(box('POST', '/api/box/controllers/scan', { json: { on: true }, origin: true }));
  await record(box('POST', '/api/box/controllers/pair', { json: { address: 'A0:B1:C2:D3:E4:F5' }, origin: true }));
  await record(box('POST', '/api/box/controllers/forget', { json: { address: 'a0:b1:c2:d3:e4:f5' }, origin: true }));
  await record(box('POST', '/api/box/controllers/scan', { json: { on: 'yes' }, origin: true }));
  await record(box('POST', '/api/box/controllers/pair', { raw: '{"address":"A0:B1:C2:D3:E4:F5","more":1}', origin: true }));
  await record(box('GET', '/api/box/controllers/scan'));
  await record(box('POST', '/api/box/controllers/connect', { json: {}, origin: true }));
  if (process.platform === 'win32') return steps;
  const service = await padsService(t, pads, (message) => message.type === 'device' || message.type === 'controllers' ? undefined
    : { ...VIEW, scanning: message.type === 'scan' && message.on === true, pairing: message.type === 'pair' ? message.address : null });
  service.json({ type: 'device', device: 0, name: 'USB gamepad', standard: true, uid: 'usb-0000:01:00.0-1.2/input0' });
  service.json(VIEW);
  // The box's own screen (the TV), on its LAN listener from loopback, takes the box's gamepad.
  const lobby = new URL(((await box('GET', '/api/lobby')).body as { link: string }).link);
  const tv = new WebSocket('ws://127.0.0.1:' + lobby.port + '/pads?role=screen');
  t.after(() => tv.terminate());
  const code = await new Promise<string>((resolve) => tv.on('message', (data: Buffer, binary) => {
    const message = binary ? undefined : JSON.parse(data.toString('utf8')) as { type: string; code?: string };
    if (message?.type === 'screen') resolve(message.code!);
  }));
  const listed = async (step: Promise<Step>) => {
    const result = await step;
    steps.push({ ...result, body: JSON.parse(JSON.stringify(result.body).replaceAll('"' + code + '"', '"<screen>"')) });
    return result;
  };
  const seen = await listed(box('GET', '/api/box/controllers'));
  assert.deepEqual((seen.body as { devices: { screen: unknown }[] }).devices.map((item) => item.screen),
    [{ code, tv: true, place: 0 }, null]);
  assert.equal(((await listed(box('POST', '/api/box/controllers/scan', { json: { on: true }, origin: true }))).body as
    { scanning: boolean }).scanning, true);
  await listed(box('POST', '/api/box/controllers/pair', { json: { address: '77:88:99:AA:BB:CC' }, origin: true }));
  await listed(box('POST', '/api/box/controllers/forget', { json: { address: '11:22:33:44:55:66' }, origin: true }));
  assert.deepEqual(service.heard, [{ type: 'scan', on: true }, { type: 'pair', address: '77:88:99:AA:BB:CC' },
    { type: 'forget', address: '11:22:33:44:55:66' }]);
  // The service gone, its controllers go with it.
  await service.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await record(box('GET', '/api/box/controllers'));
  return steps;
}

const SESSIONS = [['session', session], ['editors session', editorsSession], ['controllers session', controllersSession]] as const;

// Each host's run is a step of one test, and the comparison its last: steps keep their order, whatever order
// --test-randomize gives the file's tests.
for (const [name, run] of SESSIONS) {
  test('every box runs the scripted ' + name + ', and both answer it identically', async (t) => {
    const kept = new Map<string, Step[]>();
    for (const host of hosts) {
      await t.test(host.name + ' box runs the scripted ' + name, async (t) => {
        const steps = await run(t, await startBox(t, host.command));
        // No controllers service runs beside these hosts: its routes say so.
        for (const [index, step] of steps.entries()) assert.ok(step.status < 500 || (step.status === 503 && name === 'controllers session'),
          'step ' + index + ': ' + step.status + ' ' + JSON.stringify(step.body));
        kept.set(host.name, steps);
      });
    }
    if (hosts.length < 2) return;
    await t.test('both boxes answer the ' + name + ' identically', (t) => {
      const node = kept.get('node')!.map(normalizer());
      const go = kept.get('go')!.map(normalizer());
      t.diagnostic(node.length + ' steps: ' + node.map(({ status }) => status).join(' '));
      assert.equal(go.length, node.length);
      for (const [index, step] of node.entries()) assert.deepEqual(go[index], step, 'step ' + index);
    });
  });
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
