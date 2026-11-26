/**
 * A player's connection to the host's hub. One WebSocket carries everything; sends made during one
 * task leave as one frame. A dropped link reconnects by itself and resumes the same seat.
 */
import { Reader, Writer } from './codec.ts';
import type { ConnectOptions, Connection, Lane } from './connection.ts';
import { clock, env, randomHex, sessionStore, type StorageLike, type WebSocketConstructor, type WebSocketLike } from './env.ts';
import { DATA_FILE, type Revision } from './game.ts';
import { defaultUrl, fetchJson, launchParams, pageBase } from './launch.ts';
import { APP, Cursor, NAME, SYS, VERSION, playerName } from './protocol.ts';
import { Sender } from './sender.ts';

const BACKOFF = [100, 250, 500, 1000, 2000];

export function connect(options: ConnectOptions = {}): Connection {
  return new Net(options);
}

class Net extends Sender implements Connection {
  readonly url: string;
  readonly game: string;
  readonly room: string;
  readonly local = false;
  name = '';
  peers = new Map<number, string>();
  lane: Lane = 'none';
  closed = false;
  rtt = 0;
  jitter = 0;
  revision: Revision | null = null;

  private readonly key: string;
  private readonly reconnect: boolean;
  private readonly WS: WebSocketConstructor | undefined;
  private readonly nonce = randomHex(8);
  private readonly store: StorageLike | null;
  private readonly storeKey: string;
  private token: string;
  private readonly load: ((path: string) => Promise<unknown>) | undefined;

  private readonly sysReader = new Reader();
  private readonly cursor = new Cursor();

  private offset = 0;
  private offsetSet = false;
  private readonly samples: number[] = [];
  private lastRx = 0;
  private tries = 0;
  private pingTimer: unknown = null;
  private retryTimer: unknown = null;
  private readonly wake = (): void => this.checkAlive();

  constructor(o: ConnectOptions) {
    super(o.loopback ?? false, o.autoFlush ?? true);
    this.url = o.url ?? defaultUrl('/mp');
    this.game = o.game ?? 'game';
    this.room = o.room ?? 'lobby';
    if (!NAME.test(this.game) || !NAME.test(this.room)) {
      throw new RangeError('zirbel-net: game and room are 1 to 32 characters of A-Z, a-z, 0-9, _ . and -');
    }
    this.key = o.key ?? '';
    this.reconnect = o.reconnect ?? true;
    this.WS = o.WebSocket ?? env.WebSocket;
    this.store = o.storage === undefined ? sessionStore() : o.storage;
    this.storeKey = 'zirbel-net:' + this.url + '|' + this.game + '|' + this.room;
    this.token = this.loadToken();
    this.load = o.load;
    env.document?.addEventListener('visibilitychange', this.wake);
    env.addEventListener?.('online', this.wake);
    env.addEventListener?.('pageshow', this.wake);
    this.open();
  }

  isHost(): boolean {
    return this.id !== 0 && this.id === this.hostId;
  }

  now(): number {
    return clock() + this.offset;
  }

  data(file: string, rev?: string): Promise<unknown> {
    if (!DATA_FILE.test(file)) return Promise.reject(new RangeError('zirbel-net: data() takes a file in data/, like town.json'));
    const id = rev ?? this.revision?.id ?? '';
    const path = (id ? '/' + this.game + '/@' + id + '/' : pageBase(this.game)) + 'data/' + file;
    return this.load ? this.load(path) : fetchJson(path, this.url);
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'bye');
    } catch {
      // already closing
    }
    this.clearToken();
    this.final(1000, 'closed');
  }

  /* ---- receiving ---- */

  private open(): void {
    const WS = this.WS;
    if (!WS) {
      env.setTimeout(() => this.final(0, 'this environment has no WebSocket'), 0);
      return;
    }
    let ws: WebSocketLike;
    try {
      // The room rides in the address too, so a proxy in front of several machines can route the socket to the room's.
      ws = new WS(this.url + (this.url.includes('?') ? '&' : '?') + 'r=' + encodeURIComponent(this.game + '/' + this.room));
    } catch (error) {
      // A malformed address, or ws:// from an https page: trying again would not help.
      env.setTimeout(() => this.final(0, 'cannot connect to ' + this.url + ': ' + String(error)), 0);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws === ws) this.hello();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || typeof event.data === 'string') return;
      this.lastRx = clock();
      this.recv(new Uint8Array(event.data as ArrayBuffer));
    };
    ws.onclose = ws.onerror = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
      this.lost();
    };
  }

  private hello(): void {
    const w = this.sys.reset();
    w.u8(VERSION).str(this.game).str(this.room).str(this.key).str(this.token).str(this.nonce).u8(0);
    const f = new Writer(w.pos + 8);
    f.u8(0).u8(SYS.HELLO).u8(0).varint(w.pos * 2).raw(w.view());
    this.lastRx = clock();
    this.wsSend(f.view());
  }

  private recv(u8: Uint8Array): void {
    this.stats.framesIn++;
    this.stats.bytesIn += u8.length;
    if (u8[0] !== 0) return;
    const c = this.cursor.reset(u8, 1, u8.length);
    while (c.next()) {
      if (c.type >= APP) this.dispatch(c.peer, c.type - APP, u8, c.start, c.end, !c.unreliable);
      else this.system(c.type, u8, c.start, c.end);
      if (this.closed) return;
    }
  }

  private system(type: number, b: Uint8Array, s: number, e: number): void {
    const r = this.sysReader.set(b, s, e);
    switch (type) {
      case SYS.WELCOME: {
        const me = r.u8(), host = r.u8(), token = r.str(), hubTime = r.f64(), resumed = r.u8();
        r.u8(); // the hub's capabilities: none are defined
        const peers = new Map<number, string>();
        const n = r.varint();
        for (let i = 0; i < n && !r.overrun; i++) {
          const id = r.u8();
          peers.set(id, playerName(id));
        }
        if (r.left() > 0) this.maxMsg = r.varint();
        const revId = r.left() > 0 ? r.str() : '', revBase = r.left() > 0 ? r.str() : '';
        this.revision = revId ? { id: revId, base: revBase, engine: false } : null;
        this.id = me;
        this.hostId = host;
        this.peers = peers;
        this.name = playerName(me);
        this.token = token;
        this.saveToken();
        if (!this.offsetSet) this.offset = hubTime - clock();
        this.connected = true;
        this.tries = 0;
        this.setLane('ws');
        this.startPing();
        if (resumed) this.emit('resume');
        else this.emit('open', { id: me, hostId: host, peers });
        // The room plays another revision than this page was opened at: it moved on meanwhile.
        const page = launchParams().rev;
        if (this.revision && page && this.revision.id !== page) this.onRevision({ ...this.revision, engine: true });
        this.flush();
        break;
      }
      case SYS.REVISION: {
        const id = r.str(), base = r.str(), engine = r.u8() === 1;
        if (r.overrun || !id) break;
        this.revision = { id, base, engine };
        this.onRevision(this.revision);
        break;
      }
      case SYS.JOIN: {
        const id = r.u8(), label = playerName(id);
        this.peers.set(id, label);
        this.emit('peer', id, label);
        break;
      }
      case SYS.LEAVE: {
        const id = r.u8();
        this.peers.delete(id);
        this.emit('leave', id);
        break;
      }
      case SYS.AWAY:
        this.emit('away', r.u8());
        break;
      case SYS.BACK:
        this.emit('back', r.u8());
        break;
      case SYS.HOST:
        this.hostId = r.u8();
        this.emit('host', this.hostId);
        break;
      case SYS.PONG:
        this.pong(r.f64(), r.f64());
        break;
      case SYS.ERROR: {
        const code = r.u8(), message = r.str();
        this.closed = true;
        const ws = this.ws;
        this.ws = null;
        try {
          ws?.close();
        } catch {
          // already closed
        }
        this.clearToken();
        this.final(code, message);
        break;
      }
      default:
        break; // unknown system messages are for newer clients
    }
  }

  // A game that listens loads the revision's data itself; one that doesn't is reloaded at the
  // revision's address, keeping its seat (the resume token survives the reload).
  private onRevision(rev: Revision): void {
    if (this.listeners('revision').length) return this.emit('revision', rev);
    const loc = env.location;
    if (loc?.assign && /^\/[\w.-]+\/@[^/]+\//.test(rev.base)) loc.assign(rev.base + (loc.search ?? ''));
  }

  /* ---- clock and liveness ---- */

  // NTP-style: of the last 8 samples, trust the one with the lowest round trip (least queueing),
  // and slew small corrections so time never jumps.
  private pong(t0: number, hubTime: number): void {
    const t = clock(), rtt = t - t0, s = this.samples;
    if (!(rtt >= 0 && rtt <= 10000)) return;
    this.rtt = this.rtt ? this.rtt + (rtt - this.rtt) * 0.125 : rtt;
    this.jitter += (Math.abs(rtt - this.rtt) - this.jitter) * 0.125;
    s.push(rtt, hubTime + rtt / 2 - t);
    if (s.length > 16) s.splice(0, 2);
    let best = 0;
    for (let i = 2; i < s.length; i += 2) if (s[i]! < s[best]!) best = i;
    const target = s[best + 1]!;
    if (!this.offsetSet || Math.abs(target - this.offset) > 25) {
      this.offset = target;
      this.offsetSet = true;
    } else this.offset += (target - this.offset) * 0.1;
  }

  private startPing(): void {
    env.clearTimeout(this.pingTimer);
    let n = 0;
    const tick = (): void => {
      if (!this.connected) return;
      if (clock() - this.lastRx > 5000) {
        this.drop(); // half-open link: nothing has come back for a while
        return;
      }
      const w = this.sys.reset().f64(clock());
      this.out(SYS.PING, 0, w.buf, 0, w.pos, true);
      this.flush();
      this.pingTimer = env.setTimeout(tick, ++n < 6 ? 100 : 1000); // quick samples first, for the clock
    };
    tick();
  }

  private checkAlive(): void {
    if (this.closed || env.document?.visibilityState === 'hidden') return;
    if (!this.connected) {
      if (this.retryTimer !== null) {
        env.clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.tries = 0;
        this.open();
      }
    } else if (clock() - this.lastRx > 3000) this.drop();
  }

  private drop(): void {
    const ws = this.ws;
    if (ws?.onclose) ws.onclose(undefined);
    else if (!ws) this.lost();
  }

  private lost(): void {
    const was = this.connected;
    this.connected = false;
    env.clearTimeout(this.pingTimer);
    this.setLane('none');
    if (this.closed) return;
    if (!this.reconnect) {
      this.final(1006, 'connection lost');
      return;
    }
    if (was) this.emit('disconnect');
    const base = BACKOFF[Math.min(this.tries++, BACKOFF.length - 1)]!;
    env.clearTimeout(this.retryTimer);
    this.retryTimer = env.setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) this.open();
    }, base * (0.8 + Math.random() * 0.4)); // jitter: a restarted hub isn't hit by everyone at once
  }

  private final(code: number, message: string): void {
    this.closed = true;
    this.connected = false;
    env.clearTimeout(this.pingTimer);
    env.clearTimeout(this.retryTimer);
    this.setLane('none');
    env.document?.removeEventListener('visibilitychange', this.wake);
    env.removeEventListener?.('online', this.wake);
    env.removeEventListener?.('pageshow', this.wake);
    this.emit('close', code, message);
  }

  private setLane(lane: Lane): void {
    if (this.lane !== lane) {
      this.lane = lane;
      this.emit('lane', lane);
    }
  }

  /* ---- the resume token: lets a reload keep its seat; forgotten when you leave ---- */

  private loadToken(): string {
    try {
      return this.store?.getItem(this.storeKey) ?? '';
    } catch {
      return '';
    }
  }

  private saveToken(): void {
    try {
      this.store?.setItem(this.storeKey, this.token);
    } catch {
      // storage full or blocked: resuming after a reload won't work, everything else does
    }
  }

  private clearToken(): void {
    this.token = '';
    try {
      this.store?.removeItem(this.storeKey);
    } catch {
      // blocked
    }
  }
}
