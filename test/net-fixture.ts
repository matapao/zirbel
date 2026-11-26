// For the play() tests: the relay a net-v2 room runs (packages/core/relay.ts) behind in-memory WebSockets, so
// zirbel-net's own client talks to it with no sockets or ports; and small games that expose play()'s hooks.
import { join, Relay, type Link } from '../packages/core/relay.ts';
import type { WebSocketConstructor, WebSocketLike } from '../packages/net/env.ts';
import type { ConnectOptions, Hooks } from '../packages/net/index.ts';

export const ROOM = 'ROOM1', KEY = 'room-key';

/** Waits until check passes, polling. */
export async function until(check: () => boolean, ms = 3000, what = 'the condition') {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for ' + what);
    await new Promise((done) => setTimeout(done, 5));
  }
}

export const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One relay room for up to capacity players, and the WebSocket class that reaches it. */
export function memoryRelay(capacity = 8) {
  const relay = new Relay(capacity, () => {});
  const find = (room: string) => (room === ROOM.toLowerCase() ? { relay, key: KEY } : undefined);
  const sockets = new Set<Socket>();

  class Socket implements WebSocketLike {
    binaryType = 'arraybuffer';
    readyState = 0;
    bufferedAmount = 0;
    onopen: WebSocketLike['onopen'] = null;
    onmessage: WebSocketLike['onmessage'] = null;
    onclose: WebSocketLike['onclose'] = null;
    onerror: WebSocketLike['onerror'] = null;
    /** Frames each way, for tests that read the wire. */
    readonly sent: Uint8Array[] = [];
    readonly received: Uint8Array[] = [];
    readonly link: Link;

    constructor(readonly url: string) {
      sockets.add(this);
      this.link = {
        lastRx: performance.now(),
        send: (frame) => {
          if (this.readyState !== 1) return;
          // Later, as from a real socket: the relay finishes what it is doing first, and what it sent before
          // closing still arrives before the close.
          const copy = frame.slice();
          queueMicrotask(() => {
            this.received.push(copy);
            this.onmessage?.({ data: copy.buffer });
          });
        },
        buffered: () => 0,
        close: () => this.end(),
        drop: () => this.end(),
      };
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({});
      }, 0);
    }

    send(data: ArrayBuffer | Uint8Array) {
      if (this.readyState !== 1) return;
      const frame = (data instanceof Uint8Array ? data : new Uint8Array(data)).slice();
      this.sent.push(frame);
      this.link.lastRx = performance.now();
      if (this.link.relay) this.link.relay.receive(this.link, frame);
      else join(this.link, frame, find);
    }

    // Without a code, as a browser's: the relay hears 1005 (no status), and keeps the seat a while.
    close(code = 1005) {
      if (this.readyState > 1) return;
      this.link.relay?.gone(this.link, code);
      this.end();
    }

    /** The link drops, as a network does: the relay keeps the seat for a while. */
    kill() {
      this.link.relay?.gone(this.link, 1006);
      this.end();
    }

    private end() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      sockets.delete(this);
      setTimeout(() => this.onclose?.({}), 0);
    }
  }

  const WebSocket: WebSocketConstructor = Socket;
  /** What play() and connect() need to reach this room. */
  const options = (more: Partial<ConnectOptions> = {}): ConnectOptions =>
    ({ url: 'ws://relay.test/mp', game: 'dots', room: ROOM, key: KEY, storage: null, WebSocket, ...more });
  return { relay, WebSocket, sockets, options };
}

export type Dot = { x: number; y: number; hp: number };

/**
 * A game of dots for the snapshot and predict modes: each player is entity p<seat>, an input { dx, dy } moves it
 * by dx and dy units a second. Its world is plain data; calls counts the hooks play() called.
 */
export function dots(o: { stepping?: boolean } = {}) {
  type Input = { dx: number; dy: number } | null;
  const world = new Map<number, Dot & { input: Input }>([[1, { x: 0, y: 0, hp: 3, input: null }]]);
  const calls: Record<string, number> = {};
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  const game: { me: number; simulating: boolean; local: Input; extra: Record<string, unknown> } = { me: 1, simulating: true, local: { dx: 0, dy: 0 }, extra: {} };
  const hooks: Hooks = {
    me(id) { count('me'); game.me = id; },
    join(id) { count('join'); if (!world.has(id)) world.set(id, { x: 0, y: 0, hp: 3, input: null }); },
    leave(id) { count('leave'); world.delete(id); },
    simulate(on) { count('simulate'); game.simulating = on; },
    snapshot() {
      count('snapshot');
      const out: Record<string, unknown> = { ...game.extra };
      for (const [id, p] of world) out['p' + id] = { x: p.x, y: p.y, hp: p.hp };
      return out;
    },
    restore(state) {
      count('restore');
      const s = state as Record<string, Dot>, inputs = new Map([...world].map(([id, p]) => [id, p.input]));
      world.clear();
      for (const [k, d] of Object.entries(s)) if (k.startsWith('p')) world.set(Number(k.slice(1)), { ...d, input: inputs.get(Number(k.slice(1))) ?? null });
    },
    input() { count('input'); return game.local; },
    control(id, input) { count('control'); const p = world.get(id); if (p) p.input = input as Input; },
    predict(input, dt) {
      count('predict');
      const p = world.get(game.me), i = input as Input;
      if (p && i) { p.x += i.dx * dt; p.y += i.dy * dt; }
    },
  };
  if (o.stepping !== false) {
    hooks.step = (dt) => {
      count('step');
      for (const p of world.values()) if (p.input) { p.x += p.input.dx * dt; p.y += p.input.dy * dt; }
    };
  }
  return Object.assign(game, { world, calls, hooks });
}

/** Positions to compare, rounded so floating steps compare equal. */
export function positions(world: Map<number, Dot>) {
  return Object.fromEntries([...world].map(([id, p]) => [id, [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]]));
}
