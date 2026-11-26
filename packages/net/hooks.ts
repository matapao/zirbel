/** What play() takes and returns, and what its modes share: their context and their message types. */
import type { Reader } from './codec.ts';
import type { ConnectOptions, Connection } from './connection.ts';
import type { NetOptions } from './netsim.ts';
import type { Codec } from './pack.ts';

export type ModeName = 'snapshot' | 'predict' | 'actions' | 'events' | 'lockstep';

/**
 * A game's hooks: plain functions over plain data. Each mode uses some of them (see README.md); a hook a mode
 * doesn't use is never called. Player ids are seats, 1 to 253; alone, this screen's player is 1.
 */
export interface Hooks {
  /** Which player this screen controls and follows. */
  me?(id: number): void;
  /**
   * Adds or removes a player. snapshot and predict: join on the host, leave everywhere. actions, events and
   * lockstep: on every seat at the same point of the game. Once seated, every mode also moves this screen's own
   * player from 1 to its seat (leave(1), join(seat)). join must ignore a player already there.
   */
  join?(id: number): void;
  leave?(id: number): void;
  /** snapshot, predict and events: true where this screen runs the game (alone, or the room's host), false where it only shows what arrives. */
  simulate?(on: boolean): void;
  /**
   * The state. snapshot and predict: entities by a key that stays the same ({ p1: {…}, rock7: {…} }), each sent
   * only when it changed. actions, events and lockstep: everything a newcomer needs, sent once (events: also a Uint8Array).
   */
  snapshot?(): unknown;
  /** Replaces the state with one snapshot() gave. */
  restore?(state: unknown): void;
  /** snapshot and predict: one entity between two states, t from 0 to 1, for smooth drawing. */
  blend?(a: unknown, b: unknown, t: number, key: string): unknown;
  /** snapshot and predict: whether seat gets this entity at all. Default: every seat gets everything. */
  interest?(seat: number, key: string, entity: unknown): boolean;
  /** snapshot, predict and lockstep: the local player's input right now. */
  input?(): unknown;
  /** Steers player id with an input from the next step on; null means no input. */
  control?(id: number, input: unknown): void;
  /** predict and lockstep (snapshot too, when given): advances the game by one tick of dt seconds. */
  step?(dt: number): void;
  /** predict: moves this screen's own player one tick with its own input, on top of the host's latest state. */
  predict?(input: unknown, dt: number): void;
  /** predict: the key of player id's entity in snapshot(). Default 'p' + id. */
  player?(id: number): string;
  /** actions and events, on the host: whether player id may do this now. Default: yes. */
  validate?(id: number, action: unknown): boolean;
  /** actions and events: does it, on every seat, in the host's order. */
  apply?(id: number, action: unknown): void;
  /** lockstep: a number that sums up the state, compared between seats to find drift. */
  checksum?(): number;
}

export interface PlayOptions {
  /** Default 'snapshot'. */
  readonly mode?: ModeName;
  /** snapshot and predict: states the host sends per second. Default 20. */
  readonly rate?: number;
  /** Ticks per second: inputs sent (snapshot), the game stepped (predict, lockstep, snapshot with step). Default 30; predict 60, lockstep 20. */
  readonly tick?: number;
  /** snapshot and predict: ms the others are drawn in the past. Default 1.5 state intervals plus twice the jitter. */
  readonly smooth?: number;
  /** snapshot and predict: ms between full states, the safety net beside the changes. Default 10000. */
  readonly full?: number;
  /** lockstep: ticks between an input and the tick it plays in. Default 2. */
  readonly delay?: number;
  /** lockstep: ticks between checksums. Default one second's worth. */
  readonly check?: number;
  /** JSON text instead of binary. */
  readonly json?: boolean;
  /** Your own codecs for states (and their entities), inputs, and actions. */
  readonly codecs?: { readonly state?: Codec; readonly input?: Codec; readonly action?: Codec };
  /** The game's own message names, for session.send(), stream() and the message event. */
  readonly channels?: readonly string[];
  /** ms to wait for a seat before playing alone. Default 10000. */
  readonly timeout?: number;
  /** The network simulator and stats overlay, as in ?net=: 'lag:120,jitter:30,loss:5,kbps:256,stats'. The address adds to it. */
  readonly net?: string | NetOptions;
  /** What connect() gets over launchParams(). With room set, play() connects even without ?room= in the address. */
  readonly connect?: ConnectOptions;
}

export interface SessionEvents {
  /** Seated in a room. */
  online: (id: number, hostId: number) => void;
  /** Playing alone from now on: the room ended, refused this screen, or no seat came in time. */
  offline: (code: number, message: string) => void;
  /** The host changed; host is true where this screen is it now. */
  host: (host: boolean) => void;
  away: (id: number) => void;
  back: (id: number) => void;
  /** lockstep: seat's state stopped matching the host's at tick. Both the host and that seat hear it. */
  drift: (seat: number, tick: number) => void;
  /** A message on one of the game's channels. */
  message: (channel: string, value: unknown, from: number) => void;
}

export interface Session {
  readonly mode: ModeName;
  /** The connection while in a room; null alone. */
  readonly net: Connection | null;
  /** This screen's player. */
  readonly id: number;
  /** true once seated in a room, false when playing alone. */
  readonly ready: Promise<boolean>;
  /** Whether this screen runs the game: alone, or the room's host. */
  isHost(): boolean;
  /** actions and events: does an action. Alone or on the host it is checked and done at once; elsewhere the host decides. */
  act(action: unknown): void;
  /** On one of the game's channels: reliable and ordered. to: ALL (the default), HOST or a seat. */
  send(channel: string, value?: unknown, to?: number): void;
  /** Unreliable, latest wins. */
  stream(channel: string, value?: unknown, to?: number): void;
  on<K extends keyof SessionEvents>(name: K, fn: SessionEvents[K]): this;
  off<K extends keyof SessionEvents>(name: K, fn: SessionEvents[K]): this;
  /** Leaves the room for good and plays on alone. */
  leave(): void;
  /** Leaves, and stops driving the game. */
  stop(): void;
}

/** What a mode sees of its session. */
export interface Ctx {
  readonly game: Hooks;
  readonly o: PlayOptions;
  readonly net: Connection | null;
  readonly me: number;
  readonly host: boolean;
  readonly codec: { readonly state: Codec; readonly input: Codec; readonly action: Codec };
  /** The other seats in the room, in order. */
  others(): number[];
  drift(seat: number, tick: number): void;
}

/** A mode: it starts alone in its constructor. */
export interface Mode {
  /** Seated; prev is the player this screen was until now. */
  online(prev: number): void;
  /** The host changed, or this screen's link came back. */
  role(): void;
  peer(id: number): void;
  leave(id: number): void;
  /** One of play()'s own messages. */
  message(from: number, type: number, r: Reader): void;
  frame(now: number, dt: number): void;
  /** The room is gone: play on alone. gone: the other seats that were in it. */
  offline(gone: number[]): void;
  act?(action: unknown): void;
}

/** play()'s own message types; the game's channels start at 16. */
export const T = { STATE: 0, INPUT: 1, ACT: 2, LOG: 3, REJECT: 4, WANT: 5, CHUNK: 6, MEMBER: 7, CHECK: 8, DRIFT: 9 } as const;
export const CHANNELS = 16;
