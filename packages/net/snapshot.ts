/**
 * snapshot and predict: the host steps the game and sends each seat what changed, entity by entity, since the
 * last state that seat confirmed (and everything when it has confirmed none, or every so often). The others send
 * their input and draw the host's states a little in the past. predict also moves this screen's own player at
 * once, and replays the inputs the host hasn't applied yet on top of each state it sends. The host applies each
 * seat's inputs one a tick, two while more than DEPTH wait; with none waiting, the player keeps its last input.
 *
 *   STATE  host to seat   u8 flags (1 changes since a base, 2 inputs applied), u16 seq, [u16 base], f64 time,
 *                         [u16 last input applied], varint n, n x (str key, bytes entity), varint m, m x str key gone
 *   INPUT  seat to host   u8 flags (1 ack), [u16 newest state in], u16 first input's seq, u8 n, n inputs
 */
import { Reader, Writer } from './codec.ts';
import { T, type Ctx, type Mode } from './hooks.ts';
import { Interp, type Sample } from './interp.ts';
import { HOST, seqNewer } from './protocol.ts';
import { Ticks } from './ticks.ts';

/** States kept on both sides, and how far back a confirmed state may be to send changes against it. */
const RING = 64, WINDOW = 32;
/** predict: the newest inputs each message repeats, in case one is lost. */
const REPEAT = 6;
/**
 * predict: ms of its inputs a seat keeps until the host has applied them. More than the relay waits before an
 * away host's role moves on (2.5 s), so this screen's own player drives on until then.
 */
const KEEP_MS = 4000;
/** On the host, a seat's inputs waiting: above DEPTH two go a tick, and past BURST all but the newest DEPTH are skipped. */
const DEPTH = 2, BURST = 8;

interface Ent {
  readonly b: Uint8Array;
  readonly v: unknown;
}
type World = Map<string, Ent>;

/** The host's view of one seat. */
class Seat {
  ack = -1;
  full = -Infinity;
  last = -1;
  applied = -1;
  readonly sent: (World | undefined)[] = [];
  readonly seqs = new Int32Array(RING).fill(-1);
  readonly queue: [number, unknown][] = [];
}

const values = (w: World): Map<string, unknown> => new Map([...w].map(([k, e]) => [k, e.v]));

function same(a: Uint8Array, w: Writer): boolean {
  if (a.length !== w.pos) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== w.buf[i]) return false;
  return true;
}

export class Snapshots implements Mode {
  readonly #stepping: boolean;
  readonly #t: Ticks;
  readonly #every: number;
  readonly #per: number;
  readonly #keep: number;
  #since = 0;
  #ticks = 0;
  /** The host this screen follows (its own seat when it leads), and whether it leads. */
  #hostId = 0;
  #leading = true;
  // Leading: the states sent, and each seat's.
  #seq = 0;
  #last: World = new Map();
  readonly #seats = new Map<number, Seat>();
  // Following: the states in, and this screen's inputs.
  readonly #ring: (World | undefined)[] = [];
  readonly #rseq = new Int32Array(RING).fill(-1);
  #newest = -1;
  #world: World | null = null;
  #fresh = false;
  readonly #past = new Interp<World>(RING);
  #inSeq = 0;
  #pending: { q: number; v: unknown; b: Uint8Array }[] = [];
  /** predict: this screen's own player after its last two ticks (a, b), on the newest state seq, up to input q. */
  #mine: { seq: number; q: number; a: unknown; b: unknown } | null = null;
  /** Seats that left the room, whose players a state from before may still hold. */
  readonly #left = new Set<number>();
  readonly #w = new Writer(1024);
  readonly #rd = new Reader();
  readonly #c: Ctx;
  readonly #predicting: boolean;

  constructor(c: Ctx, predicting: boolean) {
    this.#c = c;
    this.#predicting = predicting;
    this.#stepping = predicting || !!c.game.step;
    this.#t = new Ticks(c.o.tick ?? (predicting ? 60 : 30));
    this.#every = 1000 / (c.o.rate ?? 20);
    this.#per = Math.max(1, Math.round(this.#every / this.#t.ms));
    this.#keep = Math.ceil(KEEP_MS / this.#t.ms);
    c.game.simulate?.(true);
  }

  online(prev: number): void {
    // The player this screen had alone takes its seat's number; a follower's is replaced by the host's state.
    const { game, me } = this.#c;
    if (prev !== me) {
      game.leave?.(prev);
      game.join?.(me);
    }
    this.#hostId = -1;
    this.role();
  }

  role(): void {
    const { game, net, host } = this.#c, h = net ? net.hostId : 0;
    if (h === this.#hostId && host === this.#leading) return;
    this.#hostId = h;
    if (host && !this.#leading) {
      // Carry on from the latest state in, with this screen's own player where it predicted it, and without the
      // players who left since.
      this.#carryOn([]);
      this.#pending = [];
      this.#seats.clear();
      this.#last = new Map();
      for (const id of this.#c.others()) game.join?.(id);
    }
    if (!host) {
      // Another host numbers its states afresh: what came before is no base for them.
      this.#ring.length = 0;
      this.#rseq.fill(-1);
      this.#newest = -1;
      this.#world = null;
      this.#past.clear();
    }
    this.#mine = null;
    this.#leading = host;
    game.simulate?.(host);
  }

  peer(id: number): void {
    this.#left.delete(id);
    if (this.#leading) this.#c.game.join?.(id);
  }

  leave(id: number): void {
    this.#left.add(id);
    this.#seats.delete(id);
    this.#c.game.leave?.(id);
  }

  message(from: number, type: number, r: Reader): void {
    const net = this.#c.net;
    if (type === T.STATE && !this.#leading && net && from === net.hostId) this.#receive(r);
    else if (type === T.INPUT && this.#leading) this.#input(from, r);
  }

  frame(_now: number, dt: number): void {
    const t = this.#t;
    if (this.#stepping || !this.#leading) {
      t.add(dt);
      while (t.due) {
        t.take();
        this.#tick();
      }
    }
    if (!this.#leading) this.#draw(t.alpha);
    else if (this.#stepping) this.#c.game.draw?.(t.alpha);
    else if ((this.#since += dt) >= this.#every) {
      this.#since = Math.min(this.#since - this.#every, this.#every);
      this.#send();
    }
  }

  offline(gone: number[]): void {
    const game = this.#c.game;
    if (!this.#leading) this.#carryOn(gone);
    else for (const id of gone) game.leave?.(id);
    this.#pending = [];
    this.#mine = null;
    this.#seats.clear();
    this.#hostId = 0;
    this.#leading = true;
    game.simulate?.(true);
  }

  #tick(): void {
    const { game, net, me } = this.#c;
    if (this.#leading) {
      for (const [id, s] of this.#seats) {
        // Inputs that pile up (at the start, or in a burst after a stall) go two a tick, or are skipped, so the
        // seat's lag doesn't stay. With none waiting, its player keeps the last input it had.
        const q = s.queue;
        if (q.length > BURST) q.splice(0, q.length - DEPTH);
        for (let n = q.length > DEPTH ? 2 : 1; n > 0 && q.length; n--) {
          const [seq, v] = q.shift()!;
          s.applied = seq;
          game.control?.(id, v);
        }
      }
      if (game.input) game.control?.(me, game.input());
      game.step?.(this.#t.ms / 1000);
      if (net && ++this.#ticks >= this.#per) {
        this.#ticks = 0;
        this.#send();
      }
      return;
    }
    if (!net) return;
    const q = (this.#inSeq = (this.#inSeq + 1) & 0xffff), codec = this.#c.codec.input;
    const m = net.begin().u8(this.#newest >= 0 ? 1 : 0);
    if (this.#newest >= 0) m.u16(this.#newest);
    if (this.#predicting) {
      codec.write(this.#w.reset(), game.input ? game.input() : null);
      this.#pending.push({ q, v: codec.read(this.#rd.set(this.#w.view())), b: this.#w.view().slice() });
      if (this.#pending.length > this.#keep) this.#pending.shift();
      const from = Math.max(0, this.#pending.length - REPEAT);
      m.u16(this.#pending[from]!.q).u8(this.#pending.length - from);
      for (let i = from; i < this.#pending.length; i++) m.raw(this.#pending[i]!.b);
    } else {
      m.u16(q).u8(game.input ? 1 : 0);
      if (game.input) codec.write(m, game.input());
    }
    net.stream(HOST, T.INPUT, m);
  }

  #send(): void {
    const { game, net } = this.#c;
    // Alone in the room there is nobody to send to.
    if (!net || !game.snapshot || !this.#c.others().length) return;
    const raw = (game.snapshot() ?? {}) as Record<string, unknown>, cur: World = new Map(), w = this.#w, codec = this.#c.codec.state;
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (v === undefined) continue;
      codec.write(w.reset(), v);
      const was = this.#last.get(k);
      cur.set(k, was && same(was.b, w) ? was : { b: w.view().slice(), v });
    }
    this.#last = cur;
    const seq = (this.#seq = (this.#seq + 1) & 0xffff), now = net.now(), at = seq % RING, full = this.#c.o.full ?? 10000;
    for (const id of this.#c.others()) {
      let s = this.#seats.get(id);
      if (!s) this.#seats.set(id, (s = new Seat()));
      let view = cur;
      if (game.interest) {
        view = new Map();
        for (const [k, e] of cur) if (game.interest(id, k, e.v)) view.set(k, e);
      }
      const a = s.ack, ok = a >= 0 && s.seqs[a % RING] === a && ((seq - a) & 0xffff) < WINDOW && now - s.full < full;
      const base = ok ? s.sent[a % RING] : undefined;
      if (!base) s.full = now;
      s.sent[at] = view;
      s.seqs[at] = seq;
      const applied = this.#predicting && s.applied >= 0;
      const m = net.begin().u8((base ? 1 : 0) | (applied ? 2 : 0)).u16(seq);
      if (base) m.u16(a);
      m.f64(now);
      if (applied) m.u16(s.applied);
      let n = 0;
      for (const [k, e] of view) if (base?.get(k) !== e) n++;
      m.varint(n);
      for (const [k, e] of view) if (base?.get(k) !== e) m.str(k).bytes(e.b);
      const gone = base ? [...base.keys()].filter((k) => !view.has(k)) : [];
      m.varint(gone.length);
      for (const k of gone) m.str(k);
      net.stream(id, T.STATE, m);
    }
  }

  #receive(r: Reader): void {
    const f = r.u8(), seq = r.u16(), b = f & 1 ? r.u16() : -1, t = r.f64(), applied = f & 2 ? r.u16() : -1;
    if (this.#newest >= 0 && !seqNewer(seq, this.#newest)) return;
    const base = b >= 0 ? this.#ring[b % RING] : undefined;
    if (b >= 0 && (!base || this.#rseq[b % RING] !== b)) return;
    const world: World = new Map(base), codec = this.#c.codec.state;
    for (let n = r.varint(); n > 0 && !r.overrun; n--) {
      const k = r.str(), bytes = r.bytes().slice();
      world.set(k, { b: bytes, v: codec.read(this.#rd.set(bytes)) });
    }
    for (let n = r.varint(); n > 0 && !r.overrun; n--) world.delete(r.str());
    if (r.overrun) return;
    this.#ring[seq % RING] = world;
    this.#rseq[seq % RING] = seq;
    this.#newest = seq;
    this.#world = world;
    this.#fresh = true;
    this.#past.push(t, world);
    while (applied >= 0 && this.#pending.length && !seqNewer(this.#pending[0]!.q, applied)) this.#pending.shift();
  }

  #input(from: number, r: Reader): void {
    let s = this.#seats.get(from);
    if (!s) this.#seats.set(from, (s = new Seat()));
    if (r.u8() & 1) {
      const a = r.u16();
      if (s.ack < 0 || seqNewer(a, s.ack)) s.ack = a;
    }
    let q = r.u16();
    const codec = this.#c.codec.input;
    for (let n = r.u8(); n > 0; n--, q = (q + 1) & 0xffff) {
      const v = codec.read(r);
      if (r.overrun) return;
      if (s.last >= 0 && !seqNewer(q, s.last)) continue;
      s.last = q;
      if (this.#stepping) s.queue.push([q, v]);
      else this.#c.game.control?.(from, v);
    }
  }

  /**
   * Restores the newest state in, with this screen's own player where it predicted it, then takes out the players
   * who aren't in the room any more.
   */
  #carryOn(gone: number[]): void {
    if (!this.#world) return;
    const game = this.#c.game, view = values(this.#world), m = this.#mine?.seq === this.#newest ? this.#mine : null;
    if (this.#predicting && m) view.set(this.#key(), m.b);
    game.restore?.(Object.fromEntries(view));
    if (this.#predicting && !m) for (const p of this.#pending) game.predict?.(p.v, this.#t.ms / 1000);
    for (const id of new Set([...this.#left, ...gone])) game.leave?.(id);
  }

  /** Each frame while following: the others in the past (blended when the game can), this screen's own player now. */
  #draw(alpha: number): void {
    const { game, net } = this.#c;
    if (!net || !this.#world || !game.restore) return;
    if (!game.blend && !this.#predicting) {
      if (this.#fresh) game.restore(Object.fromEntries(values(this.#world)));
      this.#fresh = false;
      return;
    }
    const at = game.blend ? this.#past.sample(net.now() - (this.#c.o.smooth ?? 1.5 * this.#every + 2 * net.jitter)) : null;
    const view = at ? this.#blend(at) : values(this.#world);
    if (this.#predicting) this.#own(view, alpha);
    else game.restore(Object.fromEntries(view));
  }

  #blend(at: Sample<World>): Map<string, unknown> {
    const out = new Map<string, unknown>(), game = this.#c.game;
    for (const [k, e] of at.b) {
      const a = at.a.get(k);
      out.set(k, a && a !== e && at.t < 1 && game.blend ? game.blend(a.v, e.v, at.t, k) : e.v);
    }
    return out;
  }

  #key(): string {
    const { game, me } = this.#c;
    return game.player ? game.player(me) : 'p' + me;
  }

  /**
   * predict: restores view with this screen's own player as the newest state has it and the inputs the host hasn't
   * applied yet played on top, drawn between its last two ticks (blend, at alpha). Each input is played once on a
   * state: until the next state comes, a new tick plays on from where the last one left the player.
   */
  #own(view: Map<string, unknown>, alpha: number): void {
    const game = this.#c.game, k = this.#key(), host = this.#world?.get(k), p = this.#pending, dt = this.#t.ms / 1000;
    const show = (own: unknown): void => {
      if (own !== undefined) view.set(k, own);
      game.restore?.(Object.fromEntries(view));
    };
    if (!host || !game.snapshot) {
      show(host?.v);
      for (const x of p) game.predict?.(x.v, dt);
      return;
    }
    const m = this.#mine?.seq === this.#newest ? this.#mine : null;
    const from = m ? p.findIndex((x) => m.q < 0 || seqNewer(x.q, m.q)) : 0;
    let a = m ? m.a : host.v, b = m ? m.b : host.v;
    if (from >= 0 && from < p.length) {
      show(b);
      for (let i = from; i < p.length; i++) {
        if (i === p.length - 1) a = i > from ? this.#copy(k) : b;
        game.predict?.(p[i]!.v, dt);
      }
      b = this.#copy(k);
      // A snapshot without this screen's player: it stays as played.
      if (a === undefined || b === undefined) {
        this.#mine = null;
        return;
      }
    }
    this.#mine = { seq: this.#newest, q: p.at(-1)?.q ?? -1, a, b };
    show(game.blend && a !== b ? game.blend(a, b, alpha, k) : b);
  }

  /** The game's entity k as it is now, through the state's codec, as a state would bring it. */
  #copy(k: string): unknown {
    const v = (this.#c.game.snapshot?.() as Record<string, unknown> | null | undefined)?.[k], codec = this.#c.codec.state;
    if (v === undefined) return undefined;
    codec.write(this.#w.reset(), v);
    return codec.read(this.#rd.set(this.#w.view()));
  }
}
