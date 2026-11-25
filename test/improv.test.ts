// The Improv Wi-Fi client's packets (packages/web/improv.ts): the protocol's own example, parts of 20 bytes, results
// checked before they are read, and the box's own service (pi/setup) reading what the client sends and the client
// reading what the box answers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  checksum,
  chunks,
  COMMAND,
  finishLink,
  parseResult,
  rpcPacket,
  scannedNetworks,
  wifiSettings,
} from '../packages/web/improv.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

test('wifi settings are the protocol’s own example, with its checksum', () => {
  const packet = wifiSettings('MyWirelessAP', 'mysecurepassword');
  assert.deepEqual([...packet.subarray(0, 3)], [0x01, 0x1e, 0x0c]);
  assert.equal(packet[3 + 12], 0x10);
  assert.equal(packet.at(-1), checksum(packet.subarray(0, -1)));
  assert.equal(new TextDecoder().decode(packet.subarray(3, 15)), 'MyWirelessAP');
  assert.throws(() => wifiSettings('', 'password'), /1 to 32 bytes/);
  assert.throws(() => wifiSettings('x'.repeat(33), 'password'), /1 to 32 bytes/);
  assert.throws(() => wifiSettings('Home', 'p'.repeat(65)), /at most 64/);
  assert.equal(hex(rpcPacket(COMMAND.identify)), '020002');
});

test('a packet goes in writes of 20 bytes, which put back together are the packet', () => {
  const packet = wifiSettings('A network with a long name', 'and a long enough password');
  const parts = chunks(packet);
  assert.ok(parts.length > 2 && parts.every((part) => part.length <= 20));
  assert.equal(hex(Buffer.concat(parts)), hex(packet));
});

test('a result is read only when its length and checksum add up, and a finish link only if a browser may open it', () => {
  const result = (command: number, strings: string[]) => {
    const data = Buffer.concat(
      strings.map((value) => Buffer.concat([Buffer.from([Buffer.byteLength(value)]), Buffer.from(value)])),
    );
    return rpcPacket(command, data);
  };
  assert.deepEqual(parseResult(result(4, ['Home', '-40', 'WPA2', 'Café', '-60', 'NO'])), {
    command: 4,
    strings: ['Home', '-40', 'WPA2', 'Café', '-60', 'NO'],
  });
  const damaged = result(1, ['http://zirbel.local/pair?code=AB']);
  damaged[damaged.length - 1]! ^= 0xff;
  assert.throws(() => parseResult(damaged), /damaged/);
  assert.throws(() => parseResult(Uint8Array.from([1, 9, 0, 0])), /does not add up/);
  assert.throws(() => parseResult(rpcPacket(1, Uint8Array.from([9, 0x41]))), /does not add up/);
  assert.equal(finishLink(['http://zirbel.local/pair?code=ABCD-EFGH']), 'http://zirbel.local/pair?code=ABCD-EFGH');
  for (const link of ['javascript:alert(1)', 'file:///etc/passwd', 'http://user:pass@zirbel.local/', ''])
    assert.equal(finishLink([link]), undefined, link);
});

test('scanned networks are the strongest of each name, strongest first', () => {
  assert.deepEqual(
    scannedNetworks(['Home', '-70', 'WPA2', 'Cafe', '-50', 'NO', 'Home', '-40', 'WPA2/WPA3', 'Odd', 'x', 'WPA']),
    [
      { ssid: 'Home', rssi: -40, auth: 'WPA2/WPA3' },
      { ssid: 'Cafe', rssi: -50, auth: 'NO' },
      { ssid: 'Odd', rssi: -100, auth: 'WPA' },
    ],
  );
});

test('the box’s own service reads what the client sends, and the client reads what the box answers', (t) => {
  const python = (script: string, ...args: string[]) => {
    try {
      return execFileSync('python3', ['-I', '-B', '-c', script, resolve('pi/setup'), ...args], { encoding: 'utf8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const packet = wifiSettings('Hjem 5G', 'correct horse battery');
  const read = python(
    'import sys; sys.path.insert(0, sys.argv[1]); import improv\n' +
      'reader = improv.PacketReader(); parts = [bytes.fromhex(part) for part in sys.argv[2:]]\n' +
      'found = [reader.feed(part) for part in parts][-1]\n' +
      'print(found[0], *improv.wifi_settings(found[1]))',
    ...chunks(packet).map(hex),
  );
  if (read === undefined) return t.skip('no python3 here');
  assert.equal(read.trim(), "1 b'Hjem 5G' b'correct horse battery'");
  const answered = python(
    'import sys; sys.path.insert(0, sys.argv[1]); import improv\n' +
      "print(improv.scan_result([improv.Network(b'Home', -40, 'WPA2'), improv.Network(b'Cafe', -61, 'NO')]).hex())",
  )!;
  assert.deepEqual(scannedNetworks(parseResult(Buffer.from(answered.trim(), 'hex')).strings), [
    { ssid: 'Home', rssi: -40, auth: 'WPA2' },
    { ssid: 'Cafe', rssi: -61, auth: 'NO' },
  ]);
});
