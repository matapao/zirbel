import { randomBytes, timingSafeEqual } from 'node:crypto';
import { legacyScene, PROTOCOL_VERSION, type ClientMessage, type Release, type SeatInfo, type ServerMessage } from '../sdk/contracts.ts';
import { mosslight, tessellate, type Simulation } from '../games/simulations.ts';
import { boundedJson } from '../sdk/game.ts';
import type { z } from 'zod';
import { newId, ZirbelError } from './projects.ts';
import { Relay } from './relay.ts';

export const secret = () => randomBytes(24).toString('base64url');
// Room secrets travel over the LAN; compare them in constant time.
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const GRACE = 90_000;
const INVITE = 4 * 60 * 60 * 1000;
const IDLE = 20 * 60 * 1000;

export type Peer = {
  send(message: ServerMessage): void;
  close(code?: number): void;
};
type Seat = {
  info: SeatInfo;
  resume: string;
  peer?: Peer;
  ack: number;
  expires: number;
};

const error = (code: Extract<ServerMessage, { type: 'error' }>['code'], message: string): ServerMessage =>
  ({ type: 'error', code, message });

function sharedState(): Simulation {
  const states = new Map<string, z.core.util.JSONType>();
  let changed = false;
  return {
    add() {}, suspend() {},
    remove(seat) { states.delete(seat); },
    apply(seat, value) {
      if (!boundedJson(value) || JSON.stringify(value).length > 4096) return 'Send a compact JSON state.';
      states.set(seat, value as z.core.util.JSONType);
      changed = true;
    },
    tick() { const update = changed; changed = false; return update; },
    snapshot() { return Object.fromEntries(states); },
  };
}

export class Room {
  readonly id = randomBytes(6).toString('hex');
  readonly invite = secret();
  readonly documentKey = secret();
  readonly inviteExpires = Date.now() + INVITE;
  readonly simulation: Simulation | null;
  /** A net-v2 room's relay, at /mp: the game's own netcode carries its play. */
  readonly relay: Relay | null;
  readonly seats = new Map<string, Seat>();
  private pending = new Map<string, { name: string; role: SeatInfo['role']; expires: number }>();
  private tickNumber = 0;
  private activity = Date.now();
  private closed = false;

  constructor(
    readonly release: Release, readonly solo: boolean, readonly access: 'local' | 'lan',
    readonly development = false,
  ) {
    const kind = release.manifest.simulation;
    this.simulation = kind === 'mosslight-v1' ? mosslight(legacyScene(release)) :
      kind === 'tessellate-v1' ? tessellate(solo) : kind === 'shared-state-v1' ? sharedState() : null;
    this.relay = kind === 'net-v2' ? new Relay(this.capacity('player'), () => { this.activity = Date.now(); }) : null;
  }

  summary() {
    const seats = [...this.seats.values()].map((seat) => seat.info);
    return {
      id: this.id, manifest: this.release.manifest, solo: this.solo, development: this.development, access: this.access, seats,
      status: this.closed ? 'closed' : seats.some((seat) => seat.connected) ? 'active' : 'waiting',
    };
  }

  mayView(credential: string) {
    this.prune();
    return !this.closed && ((same(credential, this.invite) && Date.now() < this.inviteExpires) ||
      this.pending.has(credential) || [...this.seats.values()].some((seat) => same(seat.resume, credential)));
  }

  reserve(invite: string, name: string, role: SeatInfo['role']) {
    if (this.closed) throw new ZirbelError(404, 'This room has closed.');
    if (!same(invite, this.invite) || Date.now() >= this.inviteExpires) throw new ZirbelError(403, 'This invitation is invalid or expired.');
    if (this.solo && role !== 'player') throw new ZirbelError(403, 'This is a local playtest.');
    const ticket = secret();
    this.prune();
    if (this.used(role) + [...this.pending.values()].filter((item) => item.role === role).length >= this.capacity(role))
      throw new ZirbelError(409, role === 'player' ? 'All player seats are reserved.' : 'The spectator seats are full.');
    this.pending.set(ticket, { name, role, expires: Date.now() + 30_000 });
    this.activity = Date.now();
    return ticket;
  }

  private capacity(role: SeatInfo['role']) { return role === 'spectator' ? 4 : this.solo ? 1 : this.release.manifest.players.max; }

  private used(role: SeatInfo['role']) {
    return [...this.seats.values()].filter((seat) => seat.info.role === role).length;
  }

  connect(hello: Extract<ClientMessage, { type: 'hello' }>, peer: Peer) {
    if (this.closed || hello.releaseId !== this.release.manifest.releaseId) {
      peer.send(error('protocol', 'This connection uses a different release.'));
      return;
    }
    this.prune();
    const ticket = this.pending.get(hello.credential);
    let seat = [...this.seats.values()].find((item) => same(item.resume, hello.credential));
    if (!seat && ticket && this.used(ticket.role) < this.capacity(ticket.role)) {
      this.pending.delete(hello.credential);
      const id = newId();
      seat = { info: { id, name: ticket.name, role: ticket.role, connected: true }, resume: secret(), ack: 0, expires: Infinity };
      this.seats.set(id, seat);
      if (ticket.role === 'player') this.simulation?.add(id);
    }
    if (!seat) {
      peer.send(error('expired', 'This seat has expired. Join again from your invitation.'));
      return;
    }
    const previous = seat.peer;
    seat.peer = peer;
    previous?.close(4001);
    seat.info.connected = true;
    seat.expires = Infinity;
    this.activity = Date.now();
    peer.send({ type: 'welcome', version: PROTOCOL_VERSION, releaseId: this.release.manifest.releaseId,
      seat: seat.info, resume: seat.resume, ack: seat.ack });
    this.broadcast();
    return seat.info.id;
  }

  message(id: string, peer: Peer, input: ClientMessage) {
    const seat = this.seats.get(id);
    if (!seat || seat.peer !== peer || this.closed) return;
    if (input.type === 'resync') { this.snapshot(seat); return; }
    if (input.type === 'leave') {
      this.remove(seat);
      peer.close(1000);
      this.broadcast();
      return;
    }
    if (input.type !== 'action') {
      peer.send(error('protocol', 'The connection is already established.'));
      return;
    }
    if (seat.info.role !== 'player' || !this.simulation) {
      peer.send(error('forbidden', 'This seat cannot send game actions.'));
      return;
    }
    if (input.sequence <= seat.ack) { peer.send(error('stale-action', 'This action was already received.')); return; }
    seat.ack = input.sequence;
    this.activity = Date.now();
    const rejection = this.simulation.apply(id, input.action);
    if (rejection) { peer.send(error('invalid-action', rejection)); this.snapshot(seat); return; }
    if (this.release.manifest.simulation === 'tessellate-v1') this.broadcast();
  }

  disconnected(id: string, peer: Peer) {
    const seat = this.seats.get(id);
    if (!seat || seat.peer !== peer) return;
    seat.peer = undefined;
    seat.info.connected = false;
    seat.expires = Date.now() + GRACE;
    this.simulation?.suspend(id);
    this.broadcast();
  }

  private snapshot(seat: Seat) {
    seat.peer?.send({ type: 'snapshot', tick: this.tickNumber, ack: seat.ack,
      seats: [...this.seats.values()].map((seat) => seat.info), state: this.simulation?.snapshot() ?? null });
  }

  private broadcast() {
    this.tickNumber++;
    for (const seat of this.seats.values()) this.snapshot(seat);
  }

  private remove(seat: Seat) {
    this.seats.delete(seat.info.id);
    if (seat.info.role === 'player') this.simulation?.remove(seat.info.id);
  }

  private prune() {
    const now = Date.now();
    let removed = false;
    for (const [ticket, item] of this.pending) if (item.expires < now) this.pending.delete(ticket);
    for (const seat of this.seats.values()) {
      if (seat.expires >= now) continue;
      this.remove(seat);
      removed = true;
    }
    if (removed) this.broadcast();
  }

  get connected() { return [...this.seats.values()].some((seat) => seat.info.connected); }

  step() {
    this.prune();
    // A shared room stays open as long as its invitation is valid, so a link
    // printed by a headless host still works after a quiet spell.
    const now = Date.now();
    if (!this.connected && now - this.activity > IDLE && (this.solo || now >= this.inviteExpires)) return false;
    if (this.simulation?.tick(0.05)) this.broadcast();
    return !this.closed;
  }

  close() {
    this.closed = true;
    this.relay?.close();
    for (const seat of this.seats.values()) {
      seat.peer?.send({ type: 'closed', message: 'The owner ended this room.' });
      seat.peer?.close(1000);
    }
    this.seats.clear();
    this.pending.clear();
  }
}

export class Rooms {
  private rooms = new Map<string, Room>();
  private timer = setInterval(() => {
    for (const room of this.rooms.values()) if (!room.step()) this.close(room.id);
  }, 50).unref();

  create(release: Release, solo: boolean, access: 'local' | 'lan' = 'local', development = false) {
    if (!solo && !release.manifest.permissions.play)
      throw new ZirbelError(422, 'The creator has disabled play for this release.');
    if (this.rooms.size >= 24) {
      // Solo playtests are not listed in Share, so make way by closing the oldest one nobody is playing.
      const idle = [...this.rooms.values()].find((room) => room.solo && !room.connected);
      if (!idle) throw new ZirbelError(429, 'Close an existing room before starting another.');
      this.close(idle.id);
    }
    if (solo && access === 'lan') throw new ZirbelError(400, 'Solo playtests use the local player service.');
    // The player serves runtime files from the host's own verified build, so a room
    // does not keep the release's embedded copy (about 3 MB per room).
    const room = new Room({ ...release, files: {} }, solo, access, development);
    this.rooms.set(room.id, room);
    return room;
  }

  get(id: string) {
    const room = this.rooms.get(id);
    if (!room) throw new ZirbelError(404, 'This room does not exist or has closed.');
    return room;
  }

  /** The open room with this id, if there is one. */
  find(id: string) { return this.rooms.get(id); }

  list() { return [...this.rooms.values()].filter((room) => !room.solo).map((room) => room.summary()); }

  close(id: string) {
    this.rooms.get(id)?.close();
    this.rooms.delete(id);
  }

  closeProject(projectId: string) {
    for (const room of this.rooms.values()) {
      if (room.release.manifest.gameId === projectId) this.close(room.id);
    }
  }

  dispose() { clearInterval(this.timer); for (const id of this.rooms.keys()) this.close(id); }
}
