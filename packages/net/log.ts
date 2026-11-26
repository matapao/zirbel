/**
 * actions and events: an ordered log the host keeps. A seat sends its action to the host, the host checks it
 * (validate), numbers it and sends it to everyone, and every seat applies it in that order (apply), the host too.
 * Players joining and leaving are entries as well. A newcomer asks for the state and gets it in chunks, with the
 * number of the last entry in it, and applies the entries after that one. events: the host also runs the game
 * (simulate), and what its game changes, it changes through actions too.
 *
 *   ACT     seat to host   varint n (the seat's own count), action
 *   LOG     host to all    varint seq, u8 kind (0 action, 1 join, 2 leave), u8 seat, [varint n, action]
 *   REJECT  host to seat   varint n: the seat's actions up to n are settled
 *   WANT    seat to host   send me the state
 *   CHUNK   host to seat   pack { s: seq, m: members, l: [seat, n] pairs, w: state, b: 1 when the state is bytes }
 */
import { Reader, Writer } from './codec.ts';
import { T, type Ctx, type Mode } from './hooks.ts';
import { pack } from './pack.ts';
import { ALL, HOST } from './protocol.ts';
import { Assembler, sendChunks } from './transfer.ts';

interface Envelope {
  s: number;
  m: number[];
  l: [number, number][];
  w: Uint8Array;
  b: number;
}

const isEnvelope = (e: Partial<Envelope> | null): e is Envelope =>
  !!e && typeof e.s === 'number' && Array.isArray(e.m) && Array.isArray(e.l) && e.w instanceof Uint8Array;

export class Log implements Mode {
  #seq = 0;
  #members = new Set<number>([1]);
  /** Each seat's newest action in the log, by its own count. */
  #done = new Map<number, number>();
  #pending: [number, unknown][] = [];
  #n = 0;
  #loaded = true;
  #early: Uint8Array[] = [];
  readonly #queue: [number, number, unknown][] = [];
  #busy = false;
  #leading = true;
  #hostId = 0;
  #transfers = 0;
  readonly #asm = new Assembler();
  readonly #w = new Writer(256);
  readonly #rd = new Reader();
  readonly #c: Ctx;
  readonly #sim: boolean;

  constructor(c: Ctx, sim: boolean) {
    this.#c = c;
    this.#sim = sim;
    if (sim) c.game.simulate?.(true);
  }

  act(a: unknown): void {
    const n = ++this.#n, net = this.#c.net;
    if (this.#leading || !net) {
      this.#take(this.#c.me, n, a);
      return;
    }
    this.#pending.push([n, a]);
    this.#ask(net, n, a);
  }

  online(prev: number): void {
    const { me, host } = this.#c;
    if (prev !== me) {
      // The player this screen had alone takes its seat's number; a follower's is replaced by the host's state.
      if (host) {
        this.#entry(2, prev, 0, null);
        this.#entry(1, me, 0, null);
      } else {
        this.#apply(2, prev, 0, null);
        this.#apply(1, me, 0, null);
      }
    }
    if (!host) {
      this.#loaded = false;
      this.#early = [];
    }
    this.#hostId = -1;
    this.role();
  }

  role(): void {
    const { net, host, me, game } = this.#c, h = net ? net.hostId : 0;
    if (h === this.#hostId && host === this.#leading) return;
    this.#hostId = h;
    this.#leading = host;
    if (host) {
      // A newcomer that never got the state carries on with its own.
      this.#loaded = true;
      this.#early = [];
      if (!this.#members.has(me)) this.#entry(1, me, 0, null);
      const room = new Set([me, ...this.#c.others()]);
      for (const id of this.#members) if (!room.has(id)) this.#entry(2, id, 0, null);
      const mine = this.#pending;
      this.#pending = [];
      for (const [n, a] of mine) this.#take(me, n, a);
    } else if (net) {
      if (!this.#loaded) net.send(HOST, T.WANT);
      else for (const [n, a] of this.#pending) this.#ask(net, n, a);
    }
    if (this.#sim) game.simulate?.(host);
  }

  peer(): void {}

  leave(id: number): void {
    if (this.#leading && this.#members.has(id)) this.#entry(2, id, 0, null);
  }

  message(from: number, type: number, r: Reader): void {
    const net = this.#c.net;
    if (this.#leading) {
      if (type === T.ACT) {
        const n = r.varint(), a = this.#c.codec.action.read(r);
        if (!r.overrun) this.#take(from, n, a);
      } else if (type === T.WANT) this.#give(from);
      return;
    }
    if (!net || from !== net.hostId) return;
    if (type === T.LOG) {
      if (this.#loaded) this.#log(r);
      else this.#early.push(r.rest().slice());
    } else if (type === T.REJECT) this.#settle(r.varint());
    else if (type === T.CHUNK && !this.#loaded) this.#load(r);
  }

  frame(): void {}

  offline(): void {
    const { game, me } = this.#c;
    this.#leading = true;
    this.#hostId = 0;
    this.#loaded = true;
    this.#early = [];
    for (const id of this.#members) {
      if (id === me) continue;
      this.#members.delete(id);
      game.leave?.(id);
    }
    this.#members.add(me);
    const mine = this.#pending;
    this.#pending = [];
    for (const [n, a] of mine) this.#take(me, n, a);
    if (this.#sim) game.simulate?.(true);
  }

  #ask(net: NonNullable<Ctx['net']>, n: number, a: unknown): void {
    const w = net.begin().varint(n);
    this.#c.codec.action.write(w, a);
    net.send(HOST, T.ACT, w);
  }

  /** On the leading seat: checks an action and logs it. One at a time, so an action that apply() starts waits its turn. */
  #take(from: number, n: number, a: unknown): void {
    this.#queue.push([from, n, a]);
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
        const [seat, k, x] = next, { game, net } = this.#c;
        if (k <= (this.#done.get(seat) ?? 0)) continue;
        if (this.#members.has(seat) && (!game.validate || game.validate(seat, x))) this.#entry(0, seat, k, x);
        else if (net && seat !== this.#c.me) net.send(seat, T.REJECT, net.begin().varint(k));
      }
    } finally {
      this.#busy = false;
    }
  }

  /** On the leading seat: the next entry, sent to everyone and applied here as they will read it. */
  #entry(kind: number, seat: number, n: number, a: unknown): void {
    const w = this.#w.reset().varint(++this.#seq).u8(kind).u8(seat);
    let x = a;
    if (kind === 0) {
      const at = w.varint(n).pos;
      this.#c.codec.action.write(w, a);
      x = this.#c.codec.action.read(this.#rd.set(w.buf, at, w.pos));
    }
    this.#c.net?.send(ALL, T.LOG, w);
    this.#apply(kind, seat, n, x);
  }

  #log(r: Reader): void {
    const seq = r.varint(), kind = r.u8(), seat = r.u8();
    const n = kind === 0 ? r.varint() : 0, a = kind === 0 ? this.#c.codec.action.read(r) : null;
    if (r.overrun || seq <= this.#seq) return;
    this.#seq = seq;
    this.#apply(kind, seat, n, a);
  }

  #apply(kind: number, seat: number, n: number, a: unknown): void {
    const game = this.#c.game;
    if (kind === 0) {
      this.#done.set(seat, n);
      if (seat === this.#c.me) this.#settle(n);
      game.apply?.(seat, a);
    } else if (kind === 1) {
      this.#members.add(seat);
      game.join?.(seat);
    } else {
      this.#members.delete(seat);
      this.#done.delete(seat);
      game.leave?.(seat);
    }
  }

  #settle(n: number): void {
    while (this.#pending.length && this.#pending[0]![0] <= n) this.#pending.shift();
  }

  /** On the leading seat: a newcomer asks for the state. It joins first, so the state has it. */
  #give(seat: number): void {
    const { game, net, codec } = this.#c;
    if (!net) return;
    if (!this.#members.has(seat)) this.#entry(1, seat, 0, null);
    const state = game.snapshot?.(), raw = state instanceof Uint8Array, body = new Writer(1024);
    if (!raw) codec.state.write(body, state);
    const w = new Writer(body.pos + 256);
    pack.write(w, { s: this.#seq, m: [...this.#members], l: [...this.#done], w: raw ? state : body.view(), b: raw ? 1 : 0 });
    sendChunks(net, T.CHUNK, seat, ++this.#transfers, w.view());
  }

  #load(r: Reader): void {
    const whole = this.#asm.add(r);
    if (!whole) return;
    const e = pack.read(new Reader(whole)) as Partial<Envelope> | null;
    if (!isEnvelope(e)) return;
    this.#seq = e.s;
    this.#members = new Set(e.m);
    this.#done = new Map(e.l);
    this.#loaded = true;
    this.#c.game.restore?.(e.b ? e.w : this.#c.codec.state.read(new Reader(e.w)));
    const early = this.#early;
    this.#early = [];
    for (const bytes of early) this.#log(new Reader(bytes));
  }
}
