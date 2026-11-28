// Who is at the other end of a loopback connection, on Linux: the user that owns the connecting socket, as the kernel's
// socket tables say (/proc/net/tcp and tcp6, the uid column). On a box a loopback request is the box's own, with its
// owner's powers (box-routes.ts), only when that user is the editor's own or root (its setup service): a program
// another user runs on the box, such as the TV's browser as zirbel-tv, is a device on its network like any other.
// Where the tables can't be read (not Linux) every loopback request stays the box's own. host/loopback_owner.go reads
// them the same way.
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { endianness } from 'node:os';

/** The kernel's socket tables as text: /proc/net/tcp (IPv4) and /proc/net/tcp6. */
export type SocketTables = { v4: string; v6: string };

/** An address as 16 bytes in hex, an IPv4 one mapped into IPv6 (::ffff:a.b.c.d), or nothing for one that isn't. */
export function addressKey(address: string) {
  const plain = address.replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
  if (isIPv4(plain))
    return (
      '00000000000000000000ffff' +
      plain
        .split('.')
        .map((part) => Number(part).toString(16).padStart(2, '0'))
        .join('')
    );
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(plain);
  let text = plain;
  if (embedded) {
    if (!isIPv4(embedded[2]!)) return undefined;
    const [a, b, c, d] = embedded[2]!.split('.').map(Number) as [number, number, number, number];
    text = embedded[1] + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (half: string | undefined) => (half ? half.split(':') : []);
  const head = groups(halves[0]),
    tail = groups(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!all.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  return all.map((group) => group.toLowerCase().padStart(4, '0')).join('');
}

/** A table's address field (hex, each 32-bit word in the host's byte order) as addressKey gives it. */
function tableAddress(hex: string, littleEndian: boolean) {
  if (!/^(?:[0-9A-F]{8}|[0-9A-F]{32})$/i.test(hex)) return undefined;
  const words = hex.match(/.{8}/g)!.map((word) => (littleEndian ? word.match(/../g)!.reverse().join('') : word));
  return (words.length === 1 ? '00000000000000000000ffff' : '') + words.join('').toLowerCase();
}

/** The uid that owns the socket whose local address and port are the peer's and whose remote port is ours, in the
 *  tables, or nothing when neither has one. An IPv4 peer may be either an IPv4 socket or an IPv6 one mapped. */
export function socketOwner(
  tables: SocketTables,
  peer: string,
  peerPort: number,
  ourPort: number,
  littleEndian = endianness() === 'LE',
) {
  const want = addressKey(peer);
  if (!want) return undefined;
  for (const text of [tables.v4, tables.v6])
    for (const line of text.split('\n')) {
      const [slot, local, remote, , , , , uid] = line.trim().split(/\s+/);
      if (!slot || !/^\d+:$/.test(slot) || !local || !remote || !uid || !/^\d+$/.test(uid)) continue;
      const [address, port] = local.split(':'),
        remotePort = remote.split(':')[1];
      if (
        port &&
        remotePort &&
        parseInt(port, 16) === peerPort &&
        parseInt(remotePort, 16) === ourPort &&
        tableAddress(address ?? '', littleEndian) === want
      )
        return Number(uid);
    }
  return undefined;
}

/** The tables as this host reads them, or nothing where neither can be read (not Linux). */
export function readSocketTables(): SocketTables | undefined {
  const read = (file: string) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  };
  const v4 = read('/proc/net/tcp'),
    v6 = read('/proc/net/tcp6');
  return v4 === undefined && v6 === undefined ? undefined : { v4: v4 ?? '', v6: v6 ?? '' };
}

type Connection = {
  remoteAddress?: string | undefined;
  remotePort?: number | undefined;
  localPort?: number | undefined;
};

// Asked once per connection: a kept-alive one stays whose it was.
const owned = new WeakMap<object, boolean>();
/** Whether a loopback connection is the box's own: its other end belongs to this user or root, or the tables can't be
 *  read. One the tables don't have is not. */
export function ownLoopback(connection: Connection, read = readSocketTables, me = process.getuid?.()) {
  const known = owned.get(connection);
  if (known !== undefined) return known;
  const tables = read();
  let mine = true;
  if (tables) {
    const uid = socketOwner(
      tables,
      connection.remoteAddress ?? '',
      connection.remotePort ?? -1,
      connection.localPort ?? -1,
    );
    mine = uid !== undefined && (uid === 0 || uid === me);
  }
  owned.set(connection, mine);
  return mine;
}
