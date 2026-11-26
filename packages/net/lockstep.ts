/**
 * lockstep: every seat steps the same game with everyone's input for each tick. A seat sends its input for tick
 * t + delay when it steps t, so it is there by the time anyone needs it, and a tick waits until every player's
 * input for it is in. A player's first delay ticks have no input (null). The host decides when players join and
 * leave, at a tick no seat has reached, and gives a newcomer the state at its first tick with the inputs it holds
 * from then on. Every check ticks, each seat sends the host its checksum; one that differs is drift.
 *
 *   INPUT   seat to all    varint tick, input
 *   MEMBER  host to all    u8 kind (1 join, 2 leave), u8 seat, varint tick it takes effect
 *   WANT    seat to host   send me the state
 *   CHUNK   host to seat   pack { t: tick, m: [seat, first tick], c: [tick, seat, kind] to come, i: [tick, seat, input], w: state }
 *   CHECK   seat to host   varint tick, f64 checksum
 *   DRIFT   host to seat   varint tick
 */
import { Reader, Writer } from './codec.ts';
import { T, type Ctx, type Mode } from './hooks.ts';
import { pack } from './pack.ts';
import { ALL, HOST } from './protocol.ts';
import { Ticks } from './ticks.ts';
import { Assembler, sendChunks } from './transfer.ts';

type Change = [tick: number, seat: number, kind: number];

interface Envelope {
  t: number;
  m: [number, number][];
  c: Change[];
  i: [number, number, Uint8Array][];
  w: Uint8Array;
}

const isEnvelope = (e: Partial<Envelope> | null): e is Envelope =>
  !!e && typeof e.t === 'number' && Array.isArray(e.m) && Array.isArray(e.c) && Array.isArray(e.i) && e.w instanceof Uint8Array;

export class Lockstep implements Mode {
  #tick = 0;
  #delay = 0;
  readonly #t: Ticks;
  readonly #check: number;
  /** The players, each with the first tick it plays. */
  #members = new Map<number, number>([[1, 0]]);
  /** Inputs by tick, then by seat. */
  readonly #inputs = new Map<number, Map<number, unknown>>();
  /** Joins and leaves not yet in effect, in the order the host decided them. */
  #changes: Change[] = [];
  #loaded = true;
  #leading = true;
  #hostId = 0;
  // Leading: the newcomers waiting for their state and the tick it goes at, and checksums.
  readonly #wants = new Map<number, number>();
  readonly #sums = new Map<number, number>();
  readonly #theirs = new Map<number, [number, number][]>();
  #transfers = 0;
  readonly #asm = new Assembler();
  readonly #w = new Writer(64);
  readonly #rd = new Reader();
  readonly #c: Ctx;

  constructor(c: Ctx) {
    this.#c = c;
    const tick = c.o.tick ?? 20;
    this.#t = new Ticks(tick);
    this.#check = c.o.check ?? Math.round(tick);
  }

  online(prev: number): void {
    const { game, me, host } = this.#c;
    this.#delay = Math.max(0, Math.round(this.#c.o.delay ?? 2));
    // The player this screen had alone takes its seat's number; a follower's is replaced by the host's state.
    if (prev !== me) {
      game.leave?.(prev);
      game.join?.(me);
    }
    // Its own inputs for the next delay ticks were never sampled: they are none.
    this.#members = new Map([[me, this.#tick]]);
    if (!host) {
      this.#loaded = false;
      this.#inputs.clear();
    }
    this.#hostId = -1;
    this.role();
  }

  role(): void {
    const { net, host, me } = this.#c, h = net ? net.hostId : 0;
    if (h === this.#hostId && host === this.#leading) return;
    this.#hostId = h;
    this.#leading = host;
    this.#wants.clear();
    this.#sums.clear();
    this.#theirs.clear();
    if (host) {
      if (!this.#loaded) {
        // Never got the state: carries on with its own, alone.
        this.#loaded = true;
        this.#members = new Map([[me, this.#tick]]);
        this.#changes = [];
      }
      const room = new Set([me, ...this.#c.others()]);
      const seats = new Set([...this.#members.keys(), ...this.#changes.map((ch) => ch[1])]);
      for (const seat of seats) if (!room.has(seat)) this.#out(seat);
    } else if (net && !this.#loaded) net.send(HOST, T.WANT);
  }

  peer(): void {}

  leave(id: number): void {
    if (!this.#leading) return;
    this.#wants.delete(id);
    if (this.#members.has(id) || this.#joining(id) >= 0) this.#out(id);
  }

  message(from: number, type: number, r: Reader): void {
    const { net, codec } = this.#c;
    if (!net) return;
    if (type === T.INPUT) {
      const t = r.varint(), v = codec.input.read(r);
      // A newcomer keeps what comes before its state, whose tick it doesn't know yet.
      if (!r.overrun && (this.#loaded ? t >= this.#tick && t < this.#tick + 1000 : this.#inputs.size < 4096)) this.#put(t, from, v);
    } else if (this.#leading) {
      if (type === T.WANT) this.#want(from);
      else if (type === T.CHECK) this.#compare(from, r.varint(), r.f64());
    } else if (from === net.hostId) {
      if (type === T.MEMBER && this.#loaded) {
        const kind = r.u8(), seat = r.u8(), t = r.varint();
        if (!r.overrun) this.#changes.push([t, seat, kind]);
      } else if (type === T.CHUNK && !this.#loaded) this.#load(r);
      else if (type === T.DRIFT) this.#c.drift(this.#c.me, r.varint());
    }
  }

  frame(_now: number, dt: number): void {
    if (!this.#loaded) return;
    const t = this.#t;
    t.add(dt);
    for (let n = 0; t.due && n < 8; n++) {
      this.#effect(this.#tick);
      if (!this.#ready(this.#tick)) break;
      t.take();
      this.#step();
    }
    this.#c.game.draw?.(t.alpha);
  }

  offline(): void {
    const { game, me } = this.#c;
    for (const seat of this.#members.keys()) if (seat !== me) game.leave?.(seat);
    this.#members = new Map([[me, this.#tick]]);
    this.#changes = [];
    this.#wants.clear();
    this.#loaded = true;
    this.#leading = true;
    this.#hostId = 0;
    this.#delay = 0;
    for (const m of this.#inputs.values()) for (const seat of m.keys()) if (seat !== me) m.delete(seat);
  }

  #put(t: number, seat: number, v: unknown): void {
    let m = this.#inputs.get(t);
    if (!m) this.#inputs.set(t, (m = new Map()));
    m.set(seat, v);
  }

  /** Puts the joins and leaves due by tick t into effect, in the host's order. */
  #effect(t: number): void {
    if (!this.#changes.some((ch) => ch[0] <= t)) return;
    const game = this.#c.game, due = this.#changes.filter((ch) => ch[0] <= t);
    this.#changes = this.#changes.filter((ch) => ch[0] > t);
    for (const [at, seat, kind] of due) {
      if (kind === 1) {
        this.#members.set(seat, at);
        game.join?.(seat);
      } else {
        this.#members.delete(seat);
        game.leave?.(seat);
      }
    }
  }

  #ready(t: number): boolean {
    const got = this.#inputs.get(t);
    for (const [seat, since] of this.#members) if (t >= since + this.#delay && !got?.has(seat)) return false;
    return true;
  }

  #step(): void {
    const { game, net, me, codec } = this.#c, t = this.#tick;
    if (this.#members.has(me)) {
      // As the others will read it, so every seat steps with the same value.
      codec.input.write(this.#w.reset(), game.input ? game.input() : null);
      this.#put(t + this.#delay, me, codec.input.read(this.#rd.set(this.#w.view())));
      if (net) net.send(ALL, T.INPUT, net.begin().varint(t + this.#delay).raw(this.#w.view()));
    }
    const got = this.#inputs.get(t);
    for (const seat of [...this.#members.keys()].sort((a, b) => a - b)) game.control?.(seat, got?.get(seat) ?? null);
    game.step?.(this.#t.ms / 1000);
    this.#inputs.delete(t);
    this.#tick = t + 1;
    if (net && this.#check > 0 && t % this.#check === 0 && game.checksum) {
      const sum = game.checksum();
      if (!this.#leading) net.send(HOST, T.CHECK, net.begin().varint(t).f64(sum));
      else {
        this.#sums.set(t, sum);
        this.#sums.delete(t - this.#check * 16);
        for (const [seat, theirs] of this.#theirs.get(t) ?? []) this.#compare(seat, t, theirs);
        this.#theirs.delete(t);
      }
    }
    for (const [seat, at] of this.#wants) {
      if (at > this.#tick) continue;
      this.#wants.delete(seat);
      this.#give(seat);
    }
  }

  /** On the host: one seat's checksum for tick t, against its own. */
  #compare(seat: number, t: number, sum: number): void {
    const mine = this.#sums.get(t);
    if (mine === undefined) {
      if (t >= this.#tick && t < this.#tick + 1000) this.#theirs.set(t, [...(this.#theirs.get(t) ?? []), [seat, sum]]);
      return;
    }
    if (Object.is(mine, sum)) return;
    this.#c.drift(seat, t);
    const net = this.#c.net;
    if (net) net.send(seat, T.DRIFT, net.begin().varint(t));
  }

  /** The last join or leave of seat still to come. */
  #next(seat: number): Change | undefined {
    let last: Change | undefined;
    for (const ch of this.#changes) if (ch[1] === seat) last = ch;
    return last;
  }

  /** The tick a join of seat waits for, or -1. */
  #joining(seat: number): number {
    const ch = this.#next(seat);
    return ch?.[2] === 1 ? ch[0] : -1;
  }

  /** On the host: seat leaves after the last tick it has input for, which no seat can have passed. */
  #out(seat: number): void {
    if (this.#next(seat)?.[2] === 2) return;
    const since = this.#joining(seat) >= 0 ? this.#joining(seat) : (this.#members.get(seat) ?? -1);
    if (since < 0) return;
    let last = since + this.#delay - 1;
    for (const [t, m] of this.#inputs) if (t > last && m.has(seat)) last = t;
    this.#change(2, seat, Math.max(last + 1, this.#tick));
  }

  #change(kind: number, seat: number, at: number): void {
    this.#changes.push([at, seat, kind]);
    const net = this.#c.net;
    if (net) net.send(ALL, T.MEMBER, net.begin().u8(kind).u8(seat).varint(at));
  }

  /** On the host: a newcomer asks for the state. It is out first if it was in, then joins at a tick no seat has reached. */
  #want(seat: number): void {
    if (this.#members.has(seat) || this.#joining(seat) >= 0) this.#out(seat);
    const at = Math.max(this.#tick + this.#delay + 1, this.#next(seat)?.[0] ?? 0);
    this.#change(1, seat, at);
    this.#wants.set(seat, at);
  }

  /** On the host, at the newcomer's first tick: the state, who plays, what is to come, and the inputs from then on. */
  #give(seat: number): void {
    const { game, net, codec } = this.#c;
    if (!net) return;
    const body = new Writer(1024), i: [number, number, Uint8Array][] = [];
    codec.state.write(body, game.snapshot?.());
    for (const [t, m] of this.#inputs) {
      for (const [s, v] of m) {
        codec.input.write(this.#w.reset(), v);
        i.push([t, s, this.#w.view().slice()]);
      }
    }
    const w = new Writer(body.pos + 256);
    pack.write(w, { t: this.#tick, m: [...this.#members], c: this.#changes, i, w: body.view() });
    sendChunks(net, T.CHUNK, seat, ++this.#transfers, w.view());
  }

  #load(r: Reader): void {
    const whole = this.#asm.add(r);
    if (!whole) return;
    const e = pack.read(new Reader(whole)) as Partial<Envelope> | null;
    if (!isEnvelope(e)) return;
    const codec = this.#c.codec;
    this.#c.game.restore?.(codec.state.read(new Reader(e.w)));
    this.#tick = e.t;
    this.#members = new Map(e.m);
    this.#changes = e.c;
    for (const t of this.#inputs.keys()) if (t < e.t) this.#inputs.delete(t);
    for (const [t, s, b] of e.i) if (!this.#inputs.get(t)?.has(s)) this.#put(t, s, codec.input.read(new Reader(b)));
    this.#loaded = true;
    this.#t.reset();
  }
}
