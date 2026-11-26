// The relay a net-v2 room runs for games with their own netcode: zirbel-net protocol v2 (packages/net/protocol.ts).
// Seats, resume, routing, the host role and the away grace live here; packages/server/relay-socket.ts carries the
// frames over WebSocket at /mp. The Go host runs the same relay, and test/host.contract.test.ts holds the two alike.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Reader, Writer } from '../net/codec.ts';
import { ALL, APP, Cursor, ERR, HOST, LIMITS, MAX_SEAT, NAME, SYS, VERSION } from '../net/protocol.ts';

/** The largest WebSocket message a relay connection takes: one message at the limit, with room for others. */
export const MAX_FRAME = LIMITS.message + 65_536;
/** How long a dropped seat is kept, and how long an away host keeps the role. */
const AWAY = 15_000;
const HOST_GRACE = 2_500;
/** What queues for an away seat, in bytes of whole messages, before it leaves instead. */
const QUEUE = 262_144;
/** A seat whose connection heard nothing for this long may be taken over by its own token. */
const QUIET = 3_000;
/** WebSocket close codes. */
const CLOSE = { normal: 1000, going: 1001, policy: 1008, tooBig: 1009 } as const;

/** One WebSocket, as the relay sees it. The socket code sets lastRx (performance.now()) for everything it receives. */
export type Link = {
  send(frame: Uint8Array): void;
  /** Bytes sent but not yet written out. */
  buffered(): number;
  /** Starts the closing handshake. */
  close(code: number): void;
  /** Ends the connection at once. */
  drop(): void;
  lastRx: number;
  /** The relay and seat it holds, once seated. */
  relay?: Relay;
  seat?: number;
};

type Seat = {
  readonly id: number;
  readonly token: string;
  nonce: string;
  link: Link | undefined;
  away: boolean;
  rel: Writer;
  readonly un: Writer;
  /** Bytes queued while away. */
  queued: number;
  awayTimer?: NodeJS.Timeout;
  hostTimer?: NodeJS.Timeout;
};

const same = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** One message: type, peer, lenflags and payload. */
function put(w: Writer, type: number, peer: number, payload: Uint8Array, unreliable: boolean) {
  w.u8(type).u8(peer).varint(payload.length * 2 + (unreliable ? 1 : 0)).raw(payload);
}

/** ERROR, then the closing handshake: the client shows the message and doesn't come back. */
function refuse(link: Link, code: number, message: string) {
  const w = new Writer(64).u8(0);
  put(w, SYS.ERROR, 0, new Writer(64).u8(code).str(message).view(), false);
  link.send(w.view().slice());
  link.close(CLOSE.policy);
}

/** Where a HELLO's room is: its relay and the document key that opens it. */
export type Door = { relay: Relay; key: string };

/**
 * A connection's first frame: HELLO, or the connection ends. A frame of another kind is ignored, and so is anything
 * after the HELLO in the same frame. find gets the room's id, lower-cased.
 */
export function join(link: Link, frame: Uint8Array, find: (room: string) => Door | undefined) {
  if (frame[0] !== 0) return;
  const c = new Cursor().reset(frame, 1, frame.length);
  if (!c.next() || c.type !== SYS.HELLO) { link.close(CLOSE.policy); return; }
  const r = new Reader(frame, c.start, c.end);
  const version = r.u8();
  if (version !== VERSION) { refuse(link, ERR.VERSION, `protocol v${version} not supported, this host speaks v${VERSION}`); return; }
  const game = r.str(), room = r.str(), key = r.str(), token = r.str(), nonce = r.str();
  if (r.overrun || !NAME.test(game) || !NAME.test(room)) { refuse(link, ERR.BAD, 'bad game or room name'); return; }
  const door = find(room.toLowerCase());
  if (!door || !same(door.key, key)) { refuse(link, ERR.DENIED, 'no game with that code is running'); return; }
  door.relay.admit(link, token, nonce);
}

export class Relay {
  private readonly seats = new Map<number, Seat>();
  private host = 0;
  private closed = false;
  private readonly dirty = new Set<Seat>();
  private scheduled = false;
  private readonly cursor = new Cursor();
  private readonly flushNow = () => this.flush();

  /** capacity: the room's players.max, 1 in a solo room. touch: relay traffic is the room's activity. */
  constructor(private readonly capacity: number, private readonly touch: () => void) {}

  /** A HELLO for this room: the same seat again by its token, or a new one. */
  admit(link: Link, token: string, nonce: string) {
    if (this.closed) { refuse(link, ERR.DENIED, 'no game with that code is running'); return; }
    this.touch();
    const held = token ? [...this.seats.values()].find((seat) => same(seat.token, token)) : undefined;
    if (held && (held.away || held.nonce === nonce || !held.link || performance.now() - held.link.lastRx > QUIET)) {
      this.resume(held, link, nonce);
      return;
    }
    if (this.seats.size >= this.capacity) { refuse(link, ERR.FULL, 'room is full'); return; }
    let id = 1;
    while (this.seats.has(id)) id++;
    if (id > MAX_SEAT) { refuse(link, ERR.FULL, 'room is full'); return; }
    const seat: Seat = { id, token: randomBytes(16).toString('hex'), nonce, link, away: false,
      rel: new Writer(2048), un: new Writer(1024), queued: 0 };
    this.seats.set(id, seat);
    link.relay = this;
    link.seat = id;
    const host = this.host;
    if (!this.host) this.host = id;
    this.welcome(seat, false);
    this.everyone(SYS.JOIN, id, seat);
    if (this.host !== host && this.seats.size > 1) this.everyone(SYS.HOST, this.host, seat);
  }

  /** A seated connection's frame. */
  receive(link: Link, frame: Uint8Array) {
    const seat = this.seatOf(link);
    if (!seat) return;
    this.touch();
    if (frame[0] !== 0) return;
    const c = this.cursor.reset(frame, 1, frame.length);
    while (c.next()) {
      if (c.type >= APP) {
        if (c.end - c.start > LIMITS.message) { link.close(CLOSE.tooBig); return; }
        this.route(seat, c.type, c.peer, frame.subarray(c.start, c.end), c.unreliable);
      } else if (c.type === SYS.PING) {
        const pong = new Writer(16).f64(new Reader(frame, c.start, c.end).f64()).f64(Date.now());
        this.deliver(seat, SYS.PONG, 0, pong.view(), true);
      }
      if (seat.link !== link) return;
    }
  }

  /** A seated connection closed: with 1000 its seat leaves, otherwise it is away for a while. */
  gone(link: Link, code: number) {
    const seat = this.seatOf(link);
    if (!seat) return;
    link.relay = undefined;
    seat.link = undefined;
    if (code === CLOSE.normal) { this.leave(seat); return; }
    seat.away = true;
    seat.un.pos = 0;
    seat.queued = seat.rel.pos;
    this.dirty.delete(seat);
    this.everyone(SYS.AWAY, seat.id, seat);
    seat.awayTimer = setTimeout(() => this.leave(seat), AWAY).unref();
    if (this.host === seat.id) {
      seat.hostTimer = setTimeout(() => {
        if (!seat.away || this.host !== seat.id || this.seats.get(seat.id) !== seat) return;
        const next = this.elect(seat);
        if (!next) return;
        this.host = next;
        this.everyone(SYS.HOST, next);
      }, HOST_GRACE).unref();
    }
  }

  /** The room closed: every connection hears why, and the seats go. */
  close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Writer(32).u8(ERR.SHUTDOWN).str('the room closed').view();
    for (const seat of this.seats.values()) {
      clearTimeout(seat.awayTimer);
      clearTimeout(seat.hostTimer);
      const link = seat.link;
      if (!link) continue;
      this.deliver(seat, SYS.ERROR, 0, error, false);
      this.flushSeat(seat);
      link.relay = undefined;
      seat.link = undefined;
      link.close(CLOSE.going);
    }
    this.seats.clear();
    this.dirty.clear();
  }

  private seatOf(link: Link) {
    const seat = link.relay === this && link.seat ? this.seats.get(link.seat) : undefined;
    return seat?.link === link ? seat : undefined;
  }

  // The new connection takes the seat; the old one, if any, is dropped without the seat noticing.
  private resume(seat: Seat, link: Link, nonce: string) {
    const old = seat.link, away = seat.away;
    if (old && old !== link) {
      old.relay = undefined;
      old.drop();
    }
    clearTimeout(seat.awayTimer);
    clearTimeout(seat.hostTimer);
    seat.link = link;
    seat.nonce = nonce;
    seat.away = false;
    seat.queued = 0;
    seat.un.pos = 0;
    link.relay = this;
    link.seat = seat.id;
    const waiting = seat.rel;
    seat.rel = new Writer(Math.max(2048, waiting.pos + 256));
    this.welcome(seat, true);
    seat.rel.raw(waiting.view());
    if (away) this.everyone(SYS.BACK, seat.id, seat);
  }

  private welcome(seat: Seat, resumed: boolean) {
    const others = [...this.seats.keys()].filter((id) => id !== seat.id).sort((a, b) => a - b);
    const w = new Writer(64).u8(seat.id).u8(this.host).str(seat.token).f64(Date.now()).u8(resumed ? 1 : 0).u8(0)
      .varint(others.length);
    for (const id of others) w.u8(id);
    w.varint(LIMITS.message).str('').str('');
    this.deliver(seat, SYS.WELCOME, 0, w.view(), false);
  }

  // An app message keeps its type, lenflags and payload, and carries its sender's seat.
  private route(from: Seat, type: number, to: number, payload: Uint8Array, unreliable: boolean) {
    if (to === ALL) {
      for (const seat of this.seats.values()) if (seat !== from) this.deliver(seat, type, from.id, payload, unreliable);
      return;
    }
    const seat = this.seats.get(to === HOST ? this.host : to);
    if (seat && seat !== from) this.deliver(seat, type, from.id, payload, unreliable);
  }

  // A system message about seat to every seat but except.
  private everyone(type: number, seat: number, except?: Seat) {
    const payload = Uint8Array.of(seat);
    for (const other of this.seats.values()) if (other !== except) this.deliver(other, type, 0, payload, false);
  }

  private deliver(seat: Seat, type: number, peer: number, payload: Uint8Array, unreliable: boolean) {
    if (seat.away) {
      if (unreliable) return;
      const before = seat.rel.pos;
      put(seat.rel, type, peer, payload, false);
      seat.queued += seat.rel.pos - before;
      if (seat.queued > QUEUE) {
        seat.rel.pos = before;
        this.leave(seat);
      }
      return;
    }
    if (!seat.link) return;
    put(unreliable ? seat.un : seat.rel, type, peer, payload, unreliable);
    this.dirty.add(seat);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(this.flushNow);
    }
  }

  // Once per event-loop turn: everything routed to a seat leaves as one frame, reliable messages first.
  private flush() {
    this.scheduled = false;
    const seats = [...this.dirty];
    this.dirty.clear();
    for (const seat of seats) this.flushSeat(seat);
  }

  private flushSeat(seat: Seat) {
    const link = seat.link, { rel, un } = seat;
    if (seat.away || !link) { un.pos = 0; return; }
    // Stale state is worthless: unreliable messages don't queue behind a backed-up socket.
    if (un.pos && link.buffered() > LIMITS.highWater) un.pos = 0;
    if (!rel.pos && !un.pos) return;
    const frame = new Uint8Array(1 + rel.pos + un.pos);
    frame.set(rel.view(), 1);
    frame.set(un.view(), 1 + rel.pos);
    rel.pos = 0;
    un.pos = 0;
    if (rel.buf.length > 65_536) rel.buf = new Uint8Array(2048);
    if (un.buf.length > 65_536) un.buf = new Uint8Array(1024);
    link.send(frame);
  }

  private leave(seat: Seat) {
    if (this.seats.get(seat.id) !== seat) return;
    clearTimeout(seat.awayTimer);
    clearTimeout(seat.hostTimer);
    this.seats.delete(seat.id);
    this.dirty.delete(seat);
    const link = seat.link;
    seat.link = undefined;
    if (link) {
      link.relay = undefined;
      link.drop();
    }
    this.everyone(SYS.LEAVE, seat.id);
    if (this.host === seat.id) {
      this.host = this.elect(seat);
      if (this.host) this.everyone(SYS.HOST, this.host);
    }
  }

  // Among the seats but the one going: one that isn't away, then the lowest seat.
  private elect(going: Seat) {
    let best: Seat | undefined;
    for (const seat of this.seats.values()) {
      if (seat === going) continue;
      if (!best || (best.away && !seat.away) || (best.away === seat.away && seat.id < best.id)) best = seat;
    }
    return best?.id ?? 0;
  }
}
