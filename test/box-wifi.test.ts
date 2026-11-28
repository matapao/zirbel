// The box's own Wi-Fi: its name and password as the setup service keeps them, the QR code that joins it, and the
// switch that wakes the setup service, only where the box can make it.
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { networkWake, readOwnNetwork, wifiJoinText } from '../packages/server/box-network.ts';
import { boxRequest } from '../packages/server/box-routes.ts';
import { boxFor, incoming, outgoing } from './box-fixtures.ts';

test('the box’s own Wi-Fi: read as the setup service keeps it, joined by a QR code, switched only where it can be', async (t) => {
  const box = boxFor(t);
  const wake = networkWake(box.setupRequest);
  assert.equal(wake, join(dirname(box.setupRequest), 'network'));
  const paired = { local: false, device: 'device' };
  const call = async (method: string, pathID: string, payload?: object) => {
    const { response, sent } = outgoing();
    const headers: Record<string, string> = { origin: 'http://zirbel.local', ...(payload ? { 'content-type': 'application/json' } : {}) };
    await boxRequest(box, incoming('10.42.0.20', method, '/', headers, payload ? JSON.stringify(payload) : ''), response, paired,
      { resource: 'box', pathID });
    return JSON.parse(sent.body || '{}');
  };
  // A box without its Wi-Fi setup has no network to make, and can't switch it on.
  assert.deepEqual(await call('GET', 'network'), { ownNetwork: false, network: null });
  await assert.rejects(call('PUT', 'settings', { ownNetwork: true }), /can’t make its own Wi-Fi/);
  assert.ok(!existsSync(wake));

  writeFileSync(box.ownNetwork, JSON.stringify({ version: 1, name: 'Zirbel 3F2A', password: 'abcd-efgh-jkmn' }));
  assert.deepEqual(await call('GET', 'network'), { ownNetwork: false,
    network: { name: 'Zirbel 3F2A', password: 'abcd-efgh-jkmn', qr: 'data:qr,' + encodeURIComponent('WIFI:T:WPA;S:Zirbel 3F2A;P:abcd-efgh-jkmn;;') } });
  // Switching it wakes the setup service, which changes the Wi-Fi; setting it to what it is wakes nothing.
  assert.equal((await call('PUT', 'settings', { ownNetwork: true })).ownNetwork, true);
  assert.ok(existsSync(wake));
  rmSync(wake);
  await call('PUT', 'settings', { ownNetwork: true, onboarded: true });
  assert.ok(!existsSync(wake));
  assert.equal((await call('GET', 'network')).ownNetwork, true);
  assert.equal(box.settings.read().setupRequested, false, 'the box’s own Wi-Fi is no setup request');
  assert.ok(!existsSync(box.setupRequest));
  assert.equal((await call('PUT', 'settings', { ownNetwork: false })).ownNetwork, false);
  assert.ok(existsSync(wake));

  // The kept file is checked as a network takes it.
  assert.equal(readOwnNetwork(join(dirname(box.ownNetwork), 'none.json')), undefined);
  for (const kept of [{ version: 1, name: 'Zirbel', password: 'short' }, { version: 1, name: 'x'.repeat(33), password: 'long enough' },
    { version: 1, name: 'Zirbel', password: 'naïve password' }, { version: 1, name: 'Zirbel', password: 'long enough', extra: 1 }]) {
    writeFileSync(box.ownNetwork, JSON.stringify(kept));
    assert.throws(() => readOwnNetwork(box.ownNetwork), /could not be read/, JSON.stringify(kept));
  }
  writeFileSync(box.ownNetwork, ' '.repeat(4097));
  assert.throws(() => readOwnNetwork(box.ownNetwork), /could not be read/);
  // The QR code's text escapes what the WIFI: scheme reserves.
  assert.equal(wifiJoinText({ name: 'A;B,C:D"E\\F', password: 'pass:word;' }), 'WIFI:T:WPA;S:A\\;B\\,C\\:D\\"E\\\\F;P:pass\\:word\\;;;');
});
