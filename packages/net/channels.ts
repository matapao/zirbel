/**
 * Named channels: a game names its messages, and every seat maps the names to app message types in the order they
 * are declared, so nobody picks type numbers by hand.
 *
 *   const ch = channels(net, ['shot', 'chat']);        // shot is type 0, chat type 1
 *   ch.on('shot', (value, from) => boom(value));
 *   ch.send('shot', { x, y });                         // reliable, to everyone else
 */
import type { Reader } from './codec.ts';
import { report } from './env.ts';
import type { GameNet } from './game.ts';
import { pack, type Codec } from './pack.ts';
import { ALL, MAX_TYPE } from './protocol.ts';

export type ChannelListener = (value: unknown, from: number, reliable: boolean) => void;

export interface Channels<N extends string = string> {
  /** Each channel's app message type. */
  readonly types: Readonly<Record<N, number>>;
  /** Reliable and ordered. to: ALL (the default), HOST or a seat. */
  send(name: N, value?: unknown, to?: number): void;
  /** Unreliable, latest wins. */
  stream(name: N, value?: unknown, to?: number): void;
  on(name: N, fn: ChannelListener): this;
  off(name: N, fn: ChannelListener): this;
  /** Stops listening on the connection. */
  close(): void;
}

export interface ChannelOptions {
  /** The type of the first channel; the others follow it. Default 0. */
  readonly first?: number;
  /** How values are written. Default pack (binary); json for JSON text. */
  readonly codec?: Codec;
}

export function channels<N extends string>(net: GameNet, names: readonly N[], options: ChannelOptions = {}): Channels<N> {
  const first = options.first ?? 0, codec = options.codec ?? pack;
  if (new Set(names).size !== names.length) throw new RangeError('zirbel-net: channel names must differ');
  if (!Number.isInteger(first) || first < 0 || first + names.length - 1 > MAX_TYPE) {
    throw new RangeError('zirbel-net: channels take types ' + first + ' to ' + (first + names.length - 1) + ', past ' + MAX_TYPE);
  }
  const types = Object.create(null) as Record<N, number>;
  // Replaced on every change, so a listener may remove itself while it runs.
  const listeners: (readonly ChannelListener[])[] = names.map(() => []);
  names.forEach((name, i) => { types[name] = first + i; });
  const index = (name: N): number => {
    const t = types[name];
    if (t === undefined) throw new RangeError('zirbel-net: no channel ' + String(name));
    return t;
  };
  const out = (name: N, value: unknown, to: number, reliable: boolean): void => {
    const w = net.begin();
    codec.write(w, value);
    if (reliable) net.send(to, index(name), w);
    else net.stream(to, index(name), w);
  };
  const onMessage = (from: number, type: number, r: Reader, reliable: boolean): void => {
    const list = listeners[type - first];
    if (!list?.length) return;
    const value = codec.read(r);
    for (const fn of list) {
      try {
        fn(value, from, reliable);
      } catch (error) {
        report(error);
      }
    }
  };
  net.on('message', onMessage);
  const ch: Channels<N> = {
    types,
    send: (name, value, to = ALL) => out(name, value, to, true),
    stream: (name, value, to = ALL) => out(name, value, to, false),
    on(name, fn) {
      const i = index(name) - first;
      listeners[i] = [...listeners[i]!, fn];
      return ch;
    },
    off(name, fn) {
      const i = index(name) - first;
      listeners[i] = listeners[i]!.filter((f) => f !== fn);
      return ch;
    },
    close: () => { net.off('message', onMessage); },
  };
  return ch;
}
