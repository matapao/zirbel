/**
 * A whole state for a newcomer, in reliable chunks within the hub's message limit: each chunk is its transfer's
 * number, its index and the count, then its bytes. Reliable messages from one seat arrive in order, so the
 * receiver only appends.
 */
import { Writer, type Reader } from './codec.ts';
import type { Connection } from './connection.ts';

const CHUNK = 60_000;

export function sendChunks(net: Connection, type: number, to: number, id: number, bytes: Uint8Array): void {
  const size = Math.max(1024, Math.min(CHUNK, net.maxMsg - 64));
  const n = Math.max(1, Math.ceil(bytes.length / size));
  for (let i = 0; i < n; i++) net.send(to, type, net.begin().varint(id).varint(i).varint(n).raw(bytes.subarray(i * size, (i + 1) * size)));
}

export class Assembler {
  #id = -1;
  #next = 0;
  readonly #w = new Writer(1024);

  /** Adds a chunk; returns the whole once its last chunk is in. A newer transfer replaces one in progress. */
  add(r: Reader): Uint8Array | null {
    const id = r.varint(), i = r.varint(), n = r.varint();
    if (i === 0) {
      this.#id = id;
      this.#next = 0;
      this.#w.reset();
    }
    if (id !== this.#id || i !== this.#next || i >= n) return null;
    this.#w.raw(r.rest());
    this.#next++;
    if (this.#next < n) return null;
    this.#id = -1;
    const whole = this.#w.view().slice();
    this.#w.buf = new Uint8Array(1024);
    this.#w.reset();
    return whole;
  }
}
