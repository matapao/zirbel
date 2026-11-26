/**
 * A network simulator for testing a game on a bad link: a WebSocket that adds delay, jitter, loss and a bandwidth
 * cap. Pass it to connect(), or turn it on in play() from the page's address: ?net=lag:120,jitter:30,loss:5,kbps:256.
 * Frames keep their order, as on a real WebSocket. Loss drops only unreliable app messages (stream()), never
 * reliable ones or the client's own pings.
 */
import { Writer } from './codec.ts';
import { clock, env, type WebSocketConstructor, type WebSocketLike } from './env.ts';
import { APP, Cursor } from './protocol.ts';

export interface NetSim {
  /** Added round trip in ms, half each way. */
  readonly lag?: number;
  /** Up to this many ms more each way, at random. */
  readonly jitter?: number;
  /** Percent of unreliable app messages dropped, each way. */
  readonly loss?: number;
  /** Kilobits per second each way; frames queue behind each other. */
  readonly kbps?: number;
}

export interface NetOptions extends NetSim {
  /** Shows the stats overlay. */
  readonly stats?: boolean;
}

/** A simulated WebSocket class; lost counts the messages it dropped. */
export type SimSocket = WebSocketConstructor & { lost: number };

/** One direction of the link: what is sent leaves in order, after the delay and behind what is still queued. */
class Lane {
  bytes = 0;
  readonly #q: [number, number, () => void][] = [];
  #free = 0;
  #last = 0;
  #armed = false;
  readonly #o: NetSim;

  constructor(o: NetSim) {
    this.#o = o;
  }

  push(n: number, run: () => void): void {
    const o = this.#o, now = clock();
    this.#free = Math.max(this.#free, now) + (o.kbps ? (n * 8) / o.kbps : 0);
    this.#last = Math.max(this.#last, this.#free + (o.lag ?? 0) / 2 + Math.random() * (o.jitter ?? 0));
    this.bytes += n;
    this.#q.push([this.#last, n, run]);
    this.#arm();
  }

  #arm(): void {
    const head = this.#q[0];
    if (this.#armed || !head) return;
    this.#armed = true;
    env.setTimeout(() => {
      this.#armed = false;
      while (this.#q.length && this.#q[0]![0] <= clock() + 1) {
        const [, n, run] = this.#q.shift()!;
        this.bytes -= n;
        run();
      }
      this.#arm();
    }, Math.max(0, head[0] - clock()));
  }
}

/** Unreliable app messages dropped at random; null when nothing is left of the frame. */
function lossy(f: Uint8Array, percent: number, S: { lost: number }): Uint8Array | null {
  if (!percent || f[0] !== 0) return f;
  const c = new Cursor().reset(f, 1, f.length), keep = new Writer(f.length).u8(0);
  let at = 1, lost = 0;
  while (c.next()) {
    if (c.unreliable && c.type >= APP && Math.random() * 100 < percent) lost++;
    else keep.raw(f.subarray(at, c.pos));
    at = c.pos;
  }
  if (!lost) return f;
  S.lost += lost;
  return keep.pos > 1 ? keep.view().slice() : null;
}

export function netsim(o: NetSim, WebSocket: WebSocketConstructor | undefined = env.WebSocket): SimSocket {
  if (!WebSocket) throw new Error('zirbel-net: this environment has no WebSocket');
  const WS = WebSocket, loss = o.loss ?? 0;
  const S = class implements WebSocketLike {
    static lost = 0;
    binaryType = 'arraybuffer';
    onopen: WebSocketLike['onopen'] = null;
    onmessage: WebSocketLike['onmessage'] = null;
    onclose: WebSocketLike['onclose'] = null;
    onerror: WebSocketLike['onerror'] = null;
    readonly #ws: WebSocketLike;
    readonly #up = new Lane(o);
    readonly #down = new Lane(o);

    constructor(url: string) {
      const ws = (this.#ws = new WS(url));
      ws.binaryType = 'arraybuffer';
      ws.onopen = (e) => this.#down.push(0, () => this.onopen?.(e));
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') return;
        const f = lossy(new Uint8Array(e.data as ArrayBuffer), loss, S);
        if (f) this.#down.push(f.length, () => this.onmessage?.({ data: f.buffer }));
      };
      ws.onclose = (e) => this.#down.push(0, () => this.onclose?.(e));
      ws.onerror = (e) => this.#down.push(0, () => this.onerror?.(e));
    }

    get readyState(): number {
      return this.#ws.readyState;
    }

    get bufferedAmount(): number {
      return this.#ws.bufferedAmount + this.#up.bytes;
    }

    send(data: ArrayBuffer | Uint8Array): void {
      const f = lossy(data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0)), loss, S);
      if (f) this.#up.push(f.length, () => this.#ws.send(f));
    }

    close(code?: number, reason?: string): void {
      this.#up.push(0, () => this.#ws.close(code, reason));
    }
  };
  return S;
}

const KEYS = ['lag', 'jitter', 'loss', 'kbps'] as const;

/**
 * What ?net= in a page's address asks for: lag, jitter, loss and kbps as name:number, and stats, separated by
 * commas. null when the address has none.
 */
export function netParams(search: string = env.location?.search ?? ''): NetOptions | null {
  const m = /[?&]net=([^&#]*)/.exec(search);
  if (!m) return null;
  let text = '';
  try {
    text = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  const o: Record<string, number | boolean> = {};
  for (const part of text.split(',')) {
    const [k = '', v = ''] = part.split(':');
    const n = Number(v);
    if (k === 'stats') o.stats = true;
    else if ((KEYS as readonly string[]).includes(k) && v !== '' && n >= 0 && n <= (k === 'loss' ? 100 : 1e6)) o[k] = n;
  }
  return o;
}

/** Whether o asks for any simulated trouble. */
export function troubled(o: NetSim | null | undefined): o is NetSim {
  return !!o && KEYS.some((k) => (o[k] ?? 0) > 0);
}
