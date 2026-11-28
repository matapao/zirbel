// Whose a loopback connection is (packages/server/loopback-owner.ts), from the kernel's socket tables as Linux writes
// them: the box's own for the editor's user and root alone, and where the tables can't be read, every one.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { addressKey, ownLoopback, readSocketTables, socketOwner } from '../packages/server/loopback-owner.ts';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (n: number, local: string, remote: string, state: string, uid: number) =>
  `  ${n}: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 ${4000 + n} 1 0000000000000000 20 4 30 10 -1`;
// The editor (uid 1001) on port 80 (0050): its listening socket, its end of each connection, and the connecting ends:
// the TV's browser (1002) from port 54321 (D431), the setup service (root) from 54322 (D432).
const v4 =
  [
    HEADER,
    row(0, '00000000:0050', '00000000:0000', '0A', 1001),
    row(1, '0100007F:0050', '0100007F:D431', '01', 1001),
    row(2, '0100007F:D431', '0100007F:0050', '01', 1002),
    row(3, '0100007F:D432', '0100007F:0050', '01', 0),
    // Another port's connection from the same client port is not ours.
    row(4, '0100007F:D433', '0100007F:1F90', '01', 1001),
    row(5, '0100007F:D433', '0100007F:0050', '01', 1002),
  ].join('\n') + '\n';
// Over IPv6: ::1 from 45056 (B000) as the editor's user, and an IPv6 socket mapping 127.0.0.1 from 45057 (B001).
const v6 =
  [
    HEADER,
    row(0, '00000000000000000000000000000000:0050', '00000000000000000000000000000000:0000', '0A', 1001),
    row(1, '00000000000000000000000001000000:B000', '00000000000000000000000001000000:0050', '01', 1001),
    row(2, '0000000000000000FFFF00000100007F:B001', '0000000000000000FFFF00000100007F:0050', '01', 1002),
  ].join('\n') + '\n';

test('addresses are compared as sixteen bytes, an IPv4 one as IPv6 maps it', () => {
  const mapped = '00000000000000000000ffff7f000001';
  assert.equal(addressKey('127.0.0.1'), mapped);
  assert.equal(addressKey('::ffff:127.0.0.1'), mapped);
  assert.equal(addressKey('::FFFF:7f00:1'), mapped);
  assert.equal(addressKey('::1'), '0'.repeat(31) + '1');
  assert.equal(addressKey('[::1]'), '0'.repeat(31) + '1');
  assert.equal(addressKey('fe80::1%eth0'), 'fe80' + '0'.repeat(27) + '1');
  assert.equal(addressKey('1:2:3:4:5:6:7:8'), '00010002000300040005000600070008');
  for (const wrong of [
    '',
    'localhost',
    '1::2::3',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '::ffff:300.0.0.1',
    '12345::',
    '1:2:3:4:5:6:7::8',
  ])
    assert.equal(addressKey(wrong), undefined, wrong);
});

test('a loopback connection belongs to the user whose socket has its address and port and reaches ours', () => {
  const tables = { v4, v6 };
  assert.equal(socketOwner(tables, '127.0.0.1', 54321, 80, true), 1002);
  assert.equal(socketOwner(tables, '::ffff:127.0.0.1', 54321, 80, true), 1002);
  assert.equal(socketOwner(tables, '127.0.0.1', 54322, 80, true), 0);
  assert.equal(socketOwner(tables, '127.0.0.1', 54323, 80, true), 1002);
  assert.equal(socketOwner(tables, '::1', 45056, 80, true), 1001);
  assert.equal(socketOwner(tables, '::ffff:127.0.0.1', 45057, 80, true), 1002);
  // Not our own end of the connection (local port 80), and none that isn't there.
  assert.equal(socketOwner(tables, '127.0.0.1', 80, 54321, true), 1001);
  assert.equal(socketOwner(tables, '127.0.0.1', 54321, 8080, true), undefined);
  assert.equal(socketOwner(tables, '127.0.0.2', 54321, 80, true), undefined);
  assert.equal(socketOwner(tables, 'nowhere', 54321, 80, true), undefined);
  assert.equal(
    socketOwner({ v4: 'garbage\n  9: zz:zz yy:yy 01 x x x x\n', v6: '' }, '127.0.0.1', 54321, 80, true),
    undefined,
  );
  // A big-endian host writes each 32-bit word as it is.
  const big = {
    v4: row(0, '7F000001:D431', '7F000001:0050', '01', 1002),
    v6: row(0, '00000000000000000000000000000001:B000', '00000000000000000000000000000001:0050', '01', 1001),
  };
  assert.equal(socketOwner(big, '127.0.0.1', 54321, 80, false), 1002);
  assert.equal(socketOwner(big, '::1', 45056, 80, false), 1001);
  assert.equal(socketOwner(big, '127.0.0.1', 54321, 80, true), undefined);
});

test('the box’s own loopback is the editor’s user and root, any loopback where the tables can’t be read, and none they lack', () => {
  const tables = () => ({ v4, v6 });
  const connection = (remotePort: number, remoteAddress = '::ffff:127.0.0.1') => ({
    remoteAddress,
    remotePort,
    localPort: 80,
  });
  assert.equal(ownLoopback(connection(54321), tables, 1001), false);
  assert.equal(ownLoopback(connection(54322), tables, 1001), true);
  assert.equal(ownLoopback(connection(45056, '::1'), tables, 1001), true);
  assert.equal(ownLoopback(connection(54321), tables, 1002), true);
  assert.equal(ownLoopback(connection(60000), tables, 1001), false);
  assert.equal(
    ownLoopback(connection(54321), () => undefined, 1001),
    true,
  );
  // Asked once per connection.
  const kept = connection(54321);
  let reads = 0;
  const counted = () => {
    reads++;
    return { v4, v6 };
  };
  assert.equal(ownLoopback(kept, counted, 1001), false);
  assert.equal(ownLoopback(kept, counted, 1001), false);
  assert.equal(reads, 1);
});

test(
  'this system’s own tables name this user for a loopback connection, where it has them',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const server = createServer((socket) => socket.end());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const { port } = server.address() as AddressInfo;
    const client = createConnection(port, '127.0.0.1');
    await once(client, 'connect');
    t.after(() => client.destroy());
    const tables = readSocketTables();
    assert.ok(tables);
    assert.equal(socketOwner(tables, client.localAddress!, client.localPort!, port), process.getuid!());
  },
);
