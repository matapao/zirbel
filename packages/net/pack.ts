/**
 * Codecs for plain values: pack, compact binary and exact (the default everywhere play() and channels() send
 * values), and json, JSON text for games that prefer it. A codec's read must stop where its write ended, so
 * several values can follow each other in one message.
 */
import type { Reader, Writer } from './codec.ts';

export interface Codec<T = unknown> {
  write(w: Writer, value: T): void;
  read(r: Reader): T;
}

// Tags: 0 null, 1 false, 2 true, 3 integer, 4 f64, 5 f32, 6 string, 7 array, 8 object, 9 bytes; 16 to 255 the integers 0 to 239.
const SMALL = 16;

function put(w: Writer, v: unknown): void {
  if (v === null || v === undefined) w.u8(0);
  else if (typeof v === 'boolean') w.u8(v ? 2 : 1);
  else if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 0 && v < 256 - SMALL && !Object.is(v, -0)) w.u8(SMALL + v);
    else if (Number.isInteger(v) && Math.abs(v) < 2 ** 52 && !Object.is(v, -0)) w.u8(3).svarint(v);
    else if (Math.fround(v) === v) w.u8(5).f32(v);
    else w.u8(4).f64(v);
  } else if (typeof v === 'string') w.u8(6).str(v);
  else if (v instanceof Uint8Array) w.u8(9).bytes(v);
  else if (Array.isArray(v)) {
    w.u8(7).varint(v.length);
    for (const x of v as unknown[]) put(w, x);
  } else if (typeof v === 'object') {
    // As JSON does: own enumerable properties, leaving out those that are undefined.
    const o = v as Record<string, unknown>, keys = Object.keys(o).filter((k) => o[k] !== undefined);
    w.u8(8).varint(keys.length);
    for (const k of keys) put(w.str(k), o[k]);
  } else throw new TypeError('zirbel-net: cannot send a ' + typeof v);
}

function get(r: Reader, depth: number): unknown {
  const t = r.u8();
  if (t >= SMALL) return t - SMALL;
  switch (t) {
    case 1: return false;
    case 2: return true;
    case 3: return r.svarint();
    case 4: return r.f64();
    case 5: return r.f32();
    case 6: return r.str();
    case 9: return r.bytes().slice();
    case 7:
    case 8: {
      const n = r.varint();
      // Every item takes a byte at least: a count past the end, or nesting this deep, is not a value.
      if (n > r.left() || depth > 64) return null;
      const items: unknown[] = [];
      for (let i = 0; i < n && !r.overrun; i++) items.push(t === 7 ? get(r, depth + 1) : [r.str(), get(r, depth + 1)]);
      // fromEntries makes own properties, so a key such as __proto__ stays a key.
      return t === 7 ? items : Object.fromEntries(items as [string, unknown][]);
    }
    default: return null;
  }
}

/** Binary and exact: numbers keep every bit, small whole numbers take one byte, keys and strings are UTF-8. */
export const pack: Codec = { write: put, read: (r) => get(r, 0) };

/** JSON text, for games that prefer it: what JSON.stringify keeps, and nothing else. */
export const json: Codec = {
  write: (w, v) => { w.str(JSON.stringify(v) ?? 'null'); },
  read: (r) => {
    try {
      return JSON.parse(r.str()) as unknown;
    } catch {
      return null;
    }
  },
};
