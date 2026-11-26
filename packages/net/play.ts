/**
 * play(): makes a game multiplayer through its hooks. The game starts alone at once; when the page was opened in a
 * room, play() connects, and once seated runs a mode against the hooks: the host runs the game, the others follow
 * it, a new host carries on from the last state it has. When no seat comes in time, the room refuses this screen
 * or ends, the game plays on alone.
 *
 *   const { play } = await import('/zirbel-net.js');
 *   play(globalThis.gameHooks, { mode: 'predict' });
 */
import { channels, type Channels } from './channels.ts';
import { connect } from './client.ts';
import type { Connection } from './connection.ts';
import { Emitter } from './emitter.ts';
import { clock, env, report } from './env.ts';
import { CHANNELS, type Ctx, type Hooks, type Mode, type ModeName, type PlayOptions, type Session, type SessionEvents } from './hooks.ts';
import { launchParams } from './launch.ts';
import { Lockstep } from './lockstep.ts';
import { Log } from './log.ts';
import { netParams, netsim, troubled, type SimSocket } from './netsim.ts';
import { overlay } from './overlay.ts';
import { json, pack } from './pack.ts';
import { SERVER } from './protocol.ts';
import { Snapshots } from './snapshot.ts';

const MODES: readonly ModeName[] = ['snapshot', 'predict', 'actions', 'events', 'lockstep'];

export function play(game: Hooks, options: PlayOptions = {}): Session {
  return new Play(game, options);
}

/** Calls fn every animation frame, and every 100 ms in a hidden page, which gets none. */
function loop(fn: (now: number) => void): () => void {
  const raf = (env as { requestAnimationFrame?: (f: () => void) => unknown }).requestAnimationFrame;
  let on = true, gen = 0, timer: unknown = null;
  const run = (g: number) => (): void => {
    if (!on || g !== gen) return;
    gen++;
    env.clearTimeout(timer);
    try {
      fn(clock());
    } catch (error) {
      report(error);
    }
    next();
  };
  const next = (): void => {
    raf?.(run(gen));
    timer = env.setTimeout(run(gen), raf ? 100 : 16);
  };
  next();
  return () => {
    on = false;
    env.clearTimeout(timer);
  };
}

class Play extends Emitter<SessionEvents> implements Session, Ctx {
  readonly mode: ModeName;
  readonly codec: Ctx['codec'];
  readonly ready: Promise<boolean>;
  net: Connection | null = null;
  id = 1;
  host = true;
  #settle: (online: boolean) => void = () => {};
  readonly #m: Mode;
  #ch: Channels | null = null;
  #seated = false;
  #timer: unknown = null;
  #hide: (() => void) | null = null;
  readonly #end: () => void;
  #last = clock();

  constructor(readonly game: Hooks, readonly o: PlayOptions) {
    super();
    this.mode = o.mode ?? 'snapshot';
    if (!MODES.includes(this.mode)) throw new RangeError('zirbel-net: play() modes are ' + MODES.join(', '));
    const base = o.json ? json : pack;
    this.codec = { state: o.codecs?.state ?? base, input: o.codecs?.input ?? base, action: o.codecs?.action ?? base };
    this.ready = new Promise((resolve) => { this.#settle = resolve; });
    game.me?.(1);
    this.#m = this.mode === 'lockstep' ? new Lockstep(this) : this.mode === 'actions' || this.mode === 'events'
      ? new Log(this, this.mode === 'events') : new Snapshots(this, this.mode === 'predict');
    this.#end = loop((now) => {
      const dt = Math.min(now - this.#last, 1000);
      this.#last = now;
      this.#m.frame(now, dt);
    });
    this.#join();
  }

  get me(): number {
    return this.id;
  }

  isHost(): boolean {
    return this.host;
  }

  others(): number[] {
    const net = this.net;
    if (!net) return [];
    return [...net.peers.keys()].filter((id) => id !== SERVER && id !== net.id).sort((a, b) => a - b);
  }

  drift(seat: number, tick: number): void {
    this.emit('drift', seat, tick);
  }

  act(action: unknown): void {
    if (!this.#m.act) throw new RangeError('zirbel-net: act() is for the actions and events modes');
    this.#m.act(action);
  }

  send(channel: string, value?: unknown, to?: number): void {
    this.#ch?.send(channel, value, to);
  }

  stream(channel: string, value?: unknown, to?: number): void {
    this.#ch?.stream(channel, value, to);
  }

  leave(): void {
    this.net?.close();
  }

  stop(): void {
    this.leave();
    this.#end();
    this.#hide?.();
  }

  #join(): void {
    const o = this.o, search = env.location?.search ?? '';
    if (o.connect?.room === undefined && !/[?&]room=/.test(search)) {
      this.#settle(false);
      return;
    }
    const asked = { ...(typeof o.net === 'string' ? netParams('?net=' + o.net) : o.net), ...netParams(search) };
    let sim: SimSocket | undefined, net: Connection;
    try {
      const params = { ...launchParams(), ...o.connect };
      if (troubled(asked)) sim = netsim(asked, params.WebSocket);
      net = this.net = connect(sim ? { ...params, WebSocket: sim } : params);
    } catch (error) {
      report(error);
      this.#settle(false);
      return;
    }
    const names = o.channels ?? [];
    if (names.length) {
      const ch = (this.#ch = channels(net, names, { first: CHANNELS, codec: this.codec.action }));
      for (const name of names) ch.on(name, (value, from) => this.emit('message', name, value, from));
    }
    if (asked.stats) {
      this.#hide = overlay(net, () => this.mode + ' ' + (this.host ? 'host' : 'seat') + ' ' + this.id + (sim ? '  lost ' + sim.lost : ''));
    }
    this.#timer = env.setTimeout(() => { if (!this.#seated) net.close(); }, o.timeout ?? 10000);
    const role = (): void => {
      this.host = net.isHost();
      this.#m.role();
    };
    net.on('open', () => {
      env.clearTimeout(this.#timer);
      const prev = this.id;
      this.id = net.id;
      this.host = net.isHost();
      this.#seated = true;
      this.game.me?.(net.id);
      this.#m.online(prev);
      this.#settle(true);
      this.emit('online', net.id, net.hostId);
    });
    net.on('host', () => {
      role();
      this.emit('host', this.host);
    });
    net.on('resume', role);
    net.on('peer', (id) => { if (id !== SERVER) this.#m.peer(id); });
    net.on('leave', (id) => { if (id !== SERVER) this.#m.leave(id); });
    net.on('away', (id) => this.emit('away', id));
    net.on('back', (id) => this.emit('back', id));
    net.on('message', (from, type, r) => { if (type < CHANNELS) this.#m.message(from, type, r); });
    net.on('close', (code, message) => {
      env.clearTimeout(this.#timer);
      const gone = this.others();
      this.net = null;
      this.#ch = null;
      this.host = true;
      if (this.#seated) this.#m.offline(gone);
      this.#seated = false;
      this.#hide?.();
      this.#hide = null;
      this.#settle(false);
      this.emit('offline', code, message);
    });
  }
}
