/**
 * The sending half of a player's connection: sends made during one task leave as one frame, reliable
 * messages first, and a message to yourself goes round through the loopback queue.
 */
import { Reader, Writer, toBytes, utf8len, utf8write, type Payload } from './codec.ts';
import type { ClientEvents, Stats } from './connection.ts';
import { Emitter } from './emitter.ts';
import { report, type WebSocketLike } from './env.ts';
import { ALL, APP, Cursor, HOST, LIMITS, MAX_TYPE } from './protocol.ts';

const OPEN = 1;

export abstract class Sender extends Emitter<ClientEvents> {
  id = 0;
  hostId = 0;
  connected = false;
  maxMsg: number = LIMITS.message;
  readonly stats: Stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, dropped: 0 };

  protected ws: WebSocketLike | null = null;
  protected readonly sys = new Writer(256);
  private readonly loopback: boolean;
  private readonly autoFlush: boolean;
  private readonly rel = new Writer(2048);
  private readonly un = new Writer(2048);
  private lb = new Writer(256);
  private lb2 = new Writer(256);
  private readonly user = new Writer(512);
  private readonly reader = new Reader();
  private readonly lbCursor = new Cursor();
  private inLoopback = false;
  private queued = false;
  private readonly flushNow = (): void => this.flush();

  constructor(loopback: boolean, autoFlush: boolean) {
    super();
    this.loopback = loopback;
    this.autoFlush = autoFlush;
  }

  begin(): Writer {
    return shrink(this.user).reset();
  }

  send(to: number, type: number, data?: Payload): void {
    this.app(to, type, data, false);
  }

  stream(to: number, type: number, data?: Payload): void {
    this.app(to, type, data, true);
  }

  flush(): void {
    this.queued = false;
    const ws = this.ws, rel = this.rel, un = this.un;
    if (this.connected && ws && ws.readyState === OPEN) {
      if (un.pos && ws.bufferedAmount > LIMITS.highWater) {
        un.pos = 0;
        this.stats.dropped++;
      }
      const n = rel.pos + un.pos;
      if (n && n < LIMITS.frame) {
        // The usual case: everything in one frame, kind 0 first.
        const f = new Uint8Array(n + 1);
        f.set(rel.buf.subarray(0, rel.pos), 1);
        f.set(un.buf.subarray(0, un.pos), 1 + rel.pos);
        this.wsSend(f);
      } else if (n) {
        this.split(rel);
        this.split(un);
      }
      rel.pos = 0;
      un.pos = 0;
    } else un.pos = 0;
    if (this.lb.pos) this.runLoopback();
    if (!this.queued) {
      shrink(un);
      if (!rel.pos) shrink(rel);
      shrink(this.lb2);
      shrink(this.sys);
    }
  }

  private app(to: number, type: number, data: Payload | undefined, unreliable: boolean): void {
    if (!Number.isInteger(type) || type < 0 || type > MAX_TYPE) throw new RangeError('zirbel-net: message type must be 0 to ' + MAX_TYPE);
    if (!Number.isInteger(to) || to < 0 || to > 255) throw new RangeError('zirbel-net: to must be ALL, HOST or a seat');
    if (typeof data === 'string') {
      const w = this.sys.reset();
      w.ensure(utf8len(data));
      w.pos = utf8write(data, w.buf, 0);
      this.out(type + APP, to, w.buf, 0, w.pos, unreliable);
    } else {
      const b = toBytes(data);
      this.out(type + APP, to, b, 0, b.length, unreliable);
    }
  }

  // Queue one message. A message to yourself goes to the loopback queue only.
  protected out(wt: number, to: number, b: Uint8Array, s: number, e: number, unreliable: boolean): void {
    const len = e - s;
    const self = this.id !== 0 && (to === this.id || (to === HOST && this.id === this.hostId));
    if (len > this.maxMsg && !self) throw new RangeError(`zirbel-net: a message of ${len} bytes is over the hub's limit of ${this.maxMsg}`);
    if (unreliable && len > LIMITS.unreliablePayload) unreliable = false;
    if (this.loopback && wt >= APP && (self || to === ALL)) put(this.lb, wt, this.id, b, s, len, unreliable);
    if (!self) {
      if (unreliable && !this.connected) this.stats.dropped++;
      else {
        if (!this.connected && this.rel.pos > LIMITS.message) this.rel.pos = 0; // bound what waits while offline
        put(unreliable ? this.un : this.rel, wt, to, b, s, len, unreliable);
      }
    }
    if (this.autoFlush && !this.queued) {
      this.queued = true;
      void Promise.resolve().then(this.flushNow);
    }
  }

  protected wsSend(f: Uint8Array): void {
    try {
      this.ws?.send(f);
      this.stats.framesOut++;
      this.stats.bytesOut += f.length;
    } catch {
      // the close handler deals with it
    }
  }

  // A big batch goes out as several frames, cut between messages, so no frame is much larger than
  // the largest single message (the hub enforces that).
  private split(w: Writer): void {
    const c = new Cursor().reset(w.buf, 0, w.pos);
    let start = 0;
    let last = 0;
    while (c.next()) {
      if (c.pos - start + 1 > LIMITS.frame && last > start) {
        this.wsSend(frame(w.buf, start, last));
        start = last;
      }
      last = c.pos;
    }
    if (last > start) this.wsSend(frame(w.buf, start, last));
  }

  private runLoopback(): void {
    if (this.inLoopback) return; // a handler that flushes: its messages wait for the next round
    this.inLoopback = true;
    const w = this.lb;
    this.lb = this.lb2; // swap: handlers may send while this one is read
    this.lb2 = w;
    const end = w.pos;
    w.pos = 0;
    const c = this.lbCursor.reset(w.buf, 0, end);
    try {
      while (c.next()) this.dispatch(c.peer, c.type - APP, w.buf, c.start, c.end, !c.unreliable);
    } finally {
      this.inLoopback = false;
    }
  }

  // The hot path: one Reader, rewound for each listener, nothing allocated.
  protected dispatch(from: number, type: number, b: Uint8Array, s: number, e: number, reliable: boolean): void {
    const r = this.reader;
    for (const fn of this.listeners('message')) {
      r.set(b, s, e);
      try {
        fn(from, type, r, reliable);
      } catch (error) {
        report(error);
      }
    }
  }
}

function put(w: Writer, wt: number, peer: number, b: Uint8Array, s: number, len: number, unreliable: boolean): void {
  w.ensure(len + 10);
  const buf = w.buf, p = w.pos;
  buf[p] = wt;
  buf[p + 1] = peer;
  w.pos = p + 2;
  w.varint(len * 2 + (unreliable ? 1 : 0));
  if (len) {
    w.buf.set(s === 0 && len === b.length ? b : b.subarray(s, s + len), w.pos);
    w.pos += len;
  }
}

function frame(b: Uint8Array, start: number, end: number): Uint8Array {
  const f = new Uint8Array(1 + end - start);
  f.set(b.subarray(start, end), 1);
  return f;
}

// A writer that grew for one big message goes back to its normal size once it is empty.
function shrink(w: Writer): Writer {
  if (w.pos === 0 && w.buf.length > 65536) w.buf = new Uint8Array(2048);
  return w;
}
