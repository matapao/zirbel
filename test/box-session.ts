// The box contract's first scripted session: from the box itself and from a device on its network, the door, pairing,
// the paired devices, the switches, the setup flag, the box's own Wi-Fi, its TV, external MCP access and the lobby.
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { client, lan as address, token, type Started, type Step } from './box-contract-fixture.ts';

/** This computer's private address, held in this module so that the session's check of it holds in its closures too. */
const lan = address;

export async function session(_t: TestContext, { editor: base, wake, own, network, tv }: Started) {
  const steps: Step[] = [];
  const box = client(base);
  const record = async (step: Promise<Step>) => {
    const result = await step;
    steps.push(result);
    return result;
  };
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
  // The TV: switching it wakes the box's console service, which follows it.
  await record(box('PUT', '/api/box/settings', { json: { tv: false } }));
  await record(box('PUT', '/api/box/settings', { json: { tv: true } }));
  assert.ok(existsSync(tv), 'switching the TV wakes the console service');
  rmSync(tv);
  await record(box('PUT', '/api/box/settings', { json: { tv: true } }));
  assert.ok(!existsSync(tv), 'a TV switch kept as it was wakes nothing');
  await record(box('PUT', '/api/box/settings', { json: { tv: 1 } }));
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
  const code = (
    (await record(device('POST', '/api/pairing', { json: {}, session: first, origin: true }))).body as { code: string }
  ).code;
  await record(device('POST', '/pair', { form: { code: 'ZZZZ-ZZZZ' }, origin: true }));
  await record(device('POST', '/pair', { form: { code: code.toLowerCase().replace('-', '') }, origin: true }));
  const second = token(steps.at(-1)!);
  await record(device('POST', '/pair', { form: { code }, origin: true }));
  const listed = await record(device('GET', '/api/pairing/devices', { session: second }));
  const secondId = (listed.body as { devices: { id: string; current: boolean }[] }).devices.find(
    (item) => item.current,
  )!.id;
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
  await record(
    box('POST', '/api/projects/' + project.id + '/grants', { json: { write: false, hours: 1 }, origin: true }),
  );
  await record(box('PUT', '/api/box/settings', { json: { externalMcp: true } }));
  const grant = (
    await record(
      box('POST', '/api/projects/' + project.id + '/grants', { json: { write: false, hours: 1 }, origin: true }),
    )
  ).body as { token: string };
  const mcp = (credential: string) =>
    fetch(base.replace('127.0.0.1', lan) + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credential },
      body: JSON.stringify(ping),
    }).then(async (response) => ({ status: response.status, body: (await response.json()) as unknown }));
  await record(mcp(grant.token));
  await record(mcp('nope'));
  await record(box('PUT', '/api/box/settings', { json: { externalMcp: false } }));
  await record(mcp(grant.token));

  // Wrong codes from one address: ten in a minute, then none.
  for (let tries = 0; tries < 10; tries++)
    await record(device('POST', '/pair', { form: { code: 'ZZZZ-ZZZY' }, origin: true }));
  return steps;
}
