/** What connect() takes and returns. */
import type { StorageLike, WebSocketConstructor } from './env.ts';
import type { GameEvents, GameNet } from './game.ts';

export interface ConnectOptions {
  /** The hub's WebSocket address. Default: /mp on the page's own origin (wss:// on https pages). */
  readonly url?: string;
  /** Rooms are per game. Both are [A-Za-z0-9_.-], 1 to 32 characters. */
  readonly game?: string;
  readonly room?: string;
  /** A host key: whoever connects with the hub's key becomes host. */
  readonly key?: string;
  /** Also deliver your own ALL and HOST messages to yourself: handy when the host also plays. */
  readonly loopback?: boolean;
  /** false: nothing is sent until you call flush(), for example once per tick. */
  readonly autoFlush?: boolean;
  /** false: a dropped link ends the session instead of reconnecting. */
  readonly reconnect?: boolean;
  /** A WebSocket implementation where there is no global one. */
  readonly WebSocket?: WebSocketConstructor;
  /** Where the resume token is kept, so a reload keeps its seat. Default: sessionStorage. null: nowhere. */
  readonly storage?: StorageLike | null;
  /** How data() reads a game's file, given its path on the host (/<game>/@r8/data/town.json). Default: fetch from the host. */
  readonly load?: (path: string) => Promise<unknown>;
}

export type Lane = 'ws' | 'none';

export interface Stats {
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
  /** stream() messages dropped because the link was down or backed up. */
  dropped: number;
}

export interface ClientEvents extends GameEvents {
  /** Your link dropped. zirbel-net reconnects by itself; your seat is kept for a while. */
  disconnect: () => void;
  /** Your link came back on the same seat. A host should send full state now: messages in flight when it dropped may be lost. */
  resume: () => void;
  lane: (lane: Lane) => void;
}

/** What connect() returns. */
export interface Connection extends GameNet {
  readonly url: string;
  readonly game: string;
  readonly room: string;
  readonly lane: Lane;
  /** True once the session has ended for good. */
  readonly closed: boolean;
  /** The largest message the hub accepts. */
  readonly maxMsg: number;
  readonly stats: Readonly<Stats>;
  /** Sends what is queued now. Automatic after each task, unless autoFlush is false. */
  flush(): void;
  /** Leaves the room for good: the others see leave at once. */
  close(): void;
  on<K extends keyof ClientEvents>(name: K, fn: ClientEvents[K]): this;
  off<K extends keyof ClientEvents>(name: K, fn: ClientEvents[K]): this;
}
