import { randomBytes, timingSafeEqual } from 'node:crypto';
import { legacyScene, PROTOCOL_VERSION, type ClientMessage, type Release, type SeatInfo, type ServerMessage } from '../sdk/contracts.ts';
import { mosslight, tessellate, type Simulation } from '../games/simulations.ts';
import { boundedJson } from '../sdk/game.ts';
import type { z } from 'zod';
import { newCode } from './lobby.ts';
import { newId, ZirbelError } from './projects.ts';

export const secret = () => randomBytes(24).toString('base64url');
// Room secrets travel over the LAN; compare them in constant time.
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const GRACE = 90_000;
const INVITE = 4 * 60 * 60 * 1000;
const IDLE = 20 * 60 * 1000;
/** How long a seat the lobby holds for someone waits for them: they may read out the code before they go in. */
const LOBBY_TICKET = 5 * 60 * 1000;

/** What a net game's room needs of the spaces kernel (packages/server/spaces.ts gives it): a space of its own, a
 *  one-time ticket into it, and its end. A space's code is its session's. */
export interface SpaceKernel {
  readonly available: boolean;
  open(options: { participants: number; code: boolean }): Promise<{ space: string; invite: string; code?: string }>;
  ticket(space: string, name: string, role: 'participant' | 'observer'): Promise<string>;
  close(space: string): void;
}
/** A game with its own netcode, which plays over a space of the spaces kernel. */
export const isNet = (release: Release) => release.manifest.simulation === 'net-v2';

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
  readonly started = Date.now();
  /** The lobby's name for this room: for its list alone, never enough to join. */
  readonly session = randomBytes(6).toString('hex');
  readonly simulation: Simulation | null;
  /** A net game's space, which its players are members of and its own netcode plays over: its id, and the invitation
   *  in its link. A net room has none alone, or when no spaces kernel runs. */
  space: { readonly id: string; readonly invite: string } | null = null;
  /** The space's participants and whether any is connected, as the kernel last listed them. */
  members = { participants: 0, connected: false };
  readonly seats = new Map<string, Seat>();
  private pending = new Map<string, { name: string; role: SeatInfo['role']; expires: number }>();
  private tickNumber = 0;
  private activity = Date.now();
  private closed = false;

  /** code: the short code a session is joined by, from the lobby; startedBy: the address that started it there. */
  constructor(
    readonly release: Release, readonly solo: boolean, readonly access: 'local' | 'lan',
    readonly development = false, public code: string | null = null, readonly startedBy?: string,
  ) {
    const kind = release.manifest.simulation;
    this.simulation = kind === 'mosslight-v1' ? mosslight(legacyScene(release)) :
      kind === 'tessellate-v1' ? tessellate(solo) : kind === 'shared-state-v1' ? sharedState() : null;
  }

  summary() {
    const seats = [...this.seats.values()].map((seat) => seat.info);
    return {
      id: this.id, manifest: this.release.manifest, solo: this.solo, development: this.development, access: this.access, seats,
      status: this.closed ? 'closed' : seats.some((seat) => seat.connected) || this.members.connected ? 'active' : 'waiting',
      ...(this.code ? { code: this.code } : {}),
    };
  }

  /** The player seats taken now, by players connected or still within their grace. */
  get players() { return this.space ? this.members.participants : this.used('player'); }

  /** An invitation, a held seat or a seat's own, or for a room with a space that space's id, which is in every link. */
  mayView(credential: string) {
    this.prune();
    return !this.closed && ((same(credential, this.invite) && Date.now() < this.inviteExpires) ||
      (this.space !== null && same(credential, this.space.id)) ||
      this.pending.has(credential) || [...this.seats.values()].some((seat) => same(seat.resume, credential)));
  }

  reserve(invite: string, name: string, role: SeatInfo['role']) {
    if (this.closed) throw new ZirbelError(404, 'This room has closed.');
    if (!same(invite, this.invite) || Date.now() >= this.inviteExpires) throw new ZirbelError(403, 'This invitation is invalid or expired.');
    if (this.solo && role !== 'player') throw new ZirbelError(403, 'This is a local playtest.');
    return this.hold(name, role, 30_000);
  }

  /** A seat held for someone the lobby lets in, without the invitation (which may have expired): the role asked for,
   *  or a player's while one is free and else a spectator's. Its ticket is a one-time credential. */
  seat(name: string, role?: SeatInfo['role']) {
    if (this.closed) throw new ZirbelError(404, 'This room has closed.');
    this.prune();
    return this.hold(name, role ?? (this.solo || this.free('player') ? 'player' : 'spectator'), LOBBY_TICKET);
  }

  private hold(name: string, role: SeatInfo['role'], lasts: number) {
    const ticket = secret();
    this.prune();
    if (!this.free(role)) throw new ZirbelError(409, role === 'player' ? 'All player seats are reserved.' : 'The spectator seats are full.');
    this.pending.set(ticket, { name, role, expires: Date.now() + lasts });
    this.activity = Date.now();
    return ticket;
  }

  private free(role: SeatInfo['role']) {
    return this.used(role) + [...this.pending.values()].filter((item) => item.role === role).length < this.capacity(role);
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
    // A room with a space lives as long as its space: the kernel ends one nobody plays in (Players' sweep).
    if (this.space) return !this.closed;
    // A shared room stays open as long as its invitation is valid, so a link
    // printed by a headless host still works after a quiet spell. One from the lobby is joined by its code instead.
    const now = Date.now();
    if (!this.connected && now - this.activity > IDLE && (this.solo || this.startedBy !== undefined || now >= this.inviteExpires))
      return false;
    if (this.simulation?.tick(0.05)) this.broadcast();
    return !this.closed;
  }

  close() {
    this.closed = true;
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
  /** The spaces kernel, which a net game's room plays over while it runs (hosting.ts sets it). */
  kernel?: SpaceKernel;
  private timer = setInterval(() => {
    for (const room of this.rooms.values()) if (!room.step()) this.close(room.id);
  }, 50).unref();

  /** startedBy: the address that started the room from the lobby. A multiplayer room the owner shares on the LAN, or
   *  anyone starts from the lobby, gets a code. */
  create(release: Release, solo: boolean, access: 'local' | 'lan' = 'local', development = false, startedBy?: string) {
    const lobby = startedBy !== undefined;
    if ((!solo || lobby) && !release.manifest.permissions.play)
      throw new ZirbelError(422, 'The creator has disabled play for this release.');
    if (this.rooms.size >= 24) {
      // Solo playtests are not listed in Share, so make way by closing the oldest one nobody is playing.
      const idle = [...this.rooms.values()].find((room) => room.solo && !room.connected);
      if (!idle) throw new ZirbelError(429, 'Close an existing room before starting another.');
      this.close(idle.id);
    }
    if (solo && access === 'lan' && !lobby) throw new ZirbelError(400, 'Solo playtests use the local player service.');
    // A net game's code is its space's (withSpace).
    const code = !solo && release.manifest.simulation !== null && !isNet(release) && (lobby || access === 'lan')
      ? newCode((taken) => [...this.rooms.values()].some((room) => room.code === taken)) : null;
    // The player serves runtime files from the host's own verified build, so a room
    // does not keep the release's embedded copy (about 3 MB per room).
    const room = new Room({ ...release, files: {} }, solo, access, development, code, startedBy);
    this.rooms.set(room.id, room);
    return room;
  }

  /** Opens a space for a net game's shared room, while the kernel runs, with a code where the room would have one: the
   *  room plays over it, and its code is the session's. A room the kernel can't give one is closed. A space whose code
   *  another room has (the kernel draws its own) is given back for another. */
  async withSpace(room: Room) {
    const kernel = this.kernel;
    if (room.solo || !isNet(room.release) || room.space || !kernel?.available) return room;
    const code = room.startedBy !== undefined || room.access === 'lan';
    try {
      for (let tries = 0; ; tries++) {
        const opened = await kernel.open({ participants: room.release.manifest.players.max, code });
        if (opened.code && tries < 3 && this.open().some((other) => other.code === opened.code)) { kernel.close(opened.space); continue; }
        if (!this.rooms.has(room.id)) { kernel.close(opened.space); throw new ZirbelError(404, 'This room has closed.'); }
        room.space = { id: opened.space, invite: opened.invite };
        room.code = opened.code ?? null;
        return room;
      }
    } catch (error) {
      this.close(room.id);
      if (error instanceof ZirbelError) throw error;
      throw new ZirbelError(503, 'Multiplayer isn\'t available on this host now. Try again soon.');
    }
  }

  /** A one-time ticket into a room's space for someone: a player's place while one is free, else an observer's. */
  async spaceTicket(room: Room, name: string, role?: 'participant' | 'observer') {
    const kernel = this.kernel;
    if (!room.space || !kernel) throw new ZirbelError(503, 'Multiplayer isn\'t available on this host now.');
    for (const asked of role ? [role] : ['participant', 'observer'] as const) {
      try { return await kernel.ticket(room.space.id, name, asked); } catch (error) {
        const why = (error as { code?: unknown }).code;
        if (why === 'unavailable') throw new ZirbelError(503, 'Multiplayer isn\'t available on this host now.');
        if (why !== 'full') throw new ZirbelError(410, 'This session has ended.');
      }
    }
    throw new ZirbelError(409, role === 'participant' ? 'All player seats are reserved.' : 'This session is full.');
  }

  get(id: string) {
    const room = this.rooms.get(id);
    if (!room) throw new ZirbelError(404, 'This room does not exist or has closed.');
    return room;
  }

  /** The open room with this id, if there is one. */
  find(id: string) { return this.rooms.get(id); }

  list() { return [...this.rooms.values()].filter((room) => !room.solo).map((room) => room.summary()); }

  /** Every open room, oldest first. */
  open() { return [...this.rooms.values()]; }

  close(id: string) {
    const room = this.rooms.get(id);
    room?.close();
    if (room?.space) this.kernel?.close(room.space.id);
    this.rooms.delete(id);
  }

  /** The spaces kernel listed its spaces (Players' sweep): a room's members as it counts them, and the end of every room
   *  whose space it no longer has. gone: the kernel went, with every space. */
  spaces(listed: ReadonlyMap<string, { participants: number; connected: boolean }> | 'gone') {
    for (const room of this.open()) {
      if (!room.space) continue;
      const members = listed === 'gone' ? undefined : listed.get(room.space.id);
      if (members) room.members = members;
      else this.close(room.id);
    }
  }

  closeProject(projectId: string) {
    for (const room of this.rooms.values()) {
      if (room.release.manifest.gameId === projectId) this.close(room.id);
    }
  }

  dispose() { clearInterval(this.timer); for (const id of this.rooms.keys()) this.close(id); }
}
