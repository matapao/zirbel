// The rooms the player service holds, mirroring host/rooms.go and host/rooms_spaces.go: making one with its code,
// a net game's room in a space of the spaces kernel, finding, listing and ending them.
import type { Release } from '../sdk/contracts.ts';
import { newCode } from './lobby.ts';
import { ZirbelError } from './projects.ts';
import { Room } from './room.ts';

/** Codes a net game's room tries for its space, each refused as another space's, before it gives up. */
const CODE_TRIES = 8;
/** A proof as the kernel makes one: one of its secrets. */
const PROOF = /^[A-Za-z0-9_-]{16,100}$/;

/** What a net game's room needs of the spaces kernel (packages/server/spaces.ts gives it): a space of its own, with
 *  the code Zirbel chose for its session (refused as taken when another space has it), a one-time ticket into it, the
 *  member a page's proof names, and its end. */
export interface SpaceKernel {
  readonly available: boolean;
  open(options: { participants: number; code?: string }): Promise<{ space: string; invite: string }>;
  ticket(space: string, name: string, role: 'participant' | 'observer'): Promise<string>;
  member(
    space: string,
    proof: string,
  ): Promise<{ id: string; n: number; name: string; role: 'participant' | 'observer' }>;
  close(space: string): void;
}
/** A game with its own netcode, which plays over a space of the spaces kernel. */
export const isNet = (release: Release) => release.manifest.simulation === 'net-v2';

export class Rooms {
  private rooms = new Map<string, Room>();
  /** Codes chosen for spaces the kernel is opening: no other room gets one meanwhile. */
  private readonly opening = new Set<string>();
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
    // A net game's code goes to its space as that opens (withSpace).
    const code =
      !solo && release.manifest.simulation !== null && !isNet(release) && (lobby || access === 'lan')
        ? this.freeCode()
        : null;
    // The player serves runtime files from the host's own verified build, so a room
    // does not keep the release's embedded copy (about 3 MB per room).
    const room = new Room({ ...release, files: {} }, solo, access, development, code, startedBy);
    this.rooms.set(room.id, room);
    return room;
  }

  /** A code no open room has, nor a space being opened: every room's code is Zirbel's, from the lobby's letters. */
  private freeCode() {
    return newCode((taken) => this.opening.has(taken) || [...this.rooms.values()].some((room) => room.code === taken));
  }

  /** Opens a space for a net game's shared room, while the kernel runs, with a code where the room would have one: the
   *  room plays over it, and the code Zirbel chose is its session's and its space's. A code the kernel refuses as another
   *  space's gives way to another. A room the kernel can't give a space is closed. */
  async withSpace(room: Room) {
    const kernel = this.kernel;
    if (room.solo || !isNet(room.release) || room.space || !kernel?.available) return room;
    const coded = room.startedBy !== undefined || room.access === 'lan';
    try {
      for (let tries = 1; ; tries++) {
        const code = coded ? this.freeCode() : undefined;
        if (code) this.opening.add(code);
        let opened: { space: string; invite: string };
        try {
          opened = await kernel.open({ participants: room.release.manifest.players.max, ...(code ? { code } : {}) });
        } catch (error) {
          if ((error as { code?: unknown }).code === 'taken' && tries < CODE_TRIES) continue;
          throw error;
        } finally {
          if (code) this.opening.delete(code);
        }
        if (!this.rooms.has(room.id)) {
          kernel.close(opened.space);
          throw new ZirbelError(404, 'This room has closed.');
        }
        room.space = { id: opened.space, invite: opened.invite };
        room.spaceOpened = performance.now();
        room.code = code ?? null;
        return room;
      }
    } catch (error) {
      this.close(room.id);
      if (error instanceof ZirbelError) throw error;
      throw new ZirbelError(503, "Multiplayer isn't available on this host now. Try again soon.");
    }
  }

  /** A one-time ticket into a room's space for someone: a player's place while one is free, else an observer's. */
  async spaceTicket(room: Room, name: string, role?: 'participant' | 'observer') {
    const kernel = this.kernel;
    if (!room.space || !kernel) throw new ZirbelError(503, "Multiplayer isn't available on this host now.");
    for (const asked of role ? [role] : (['participant', 'observer'] as const)) {
      try {
        return await kernel.ticket(room.space.id, name, asked);
      } catch (error) {
        const why = (error as { code?: unknown }).code;
        if (why === 'unavailable') throw new ZirbelError(503, "Multiplayer isn't available on this host now.");
        if (why !== 'full') throw new ZirbelError(410, 'This session has ended.');
      }
    }
    throw new ZirbelError(409, role === 'participant' ? 'All player seats are reserved.' : 'This session is full.');
  }

  /** Whether a proof a page made on its own connection to a room's space names a member of that space, as the kernel
   *  says; the proof is used up. A space's id, in every link, is no credential. */
  async proven(room: Room, proof: string) {
    if (!room.space || !this.kernel || !PROOF.test(proof)) return false;
    try {
      await this.kernel.member(room.space.id, proof);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === 'unavailable')
        throw new ZirbelError(503, "Multiplayer isn't available on this host now.");
      return false;
    }
  }

  get(id: string) {
    const room = this.rooms.get(id);
    if (!room) throw new ZirbelError(404, 'This room does not exist or has closed.');
    return room;
  }

  /** The open room with this id, if there is one. */
  find(id: string) {
    return this.rooms.get(id);
  }

  list() {
    return [...this.rooms.values()].filter((room) => !room.solo).map((room) => room.summary());
  }

  /** Every open room, oldest first. */
  open() {
    return [...this.rooms.values()];
  }

  close(id: string) {
    const room = this.rooms.get(id);
    room?.close();
    if (room?.space) this.kernel?.close(room.space.id);
    this.rooms.delete(id);
  }

  /** The spaces kernel listed its spaces (Players' sweep): a room's members as it counts them, and the end of every room
   *  whose space it no longer has. gone: the kernel went, with every space. since: when the list was asked for, so a
   *  space opened while it was on its way, which it can't have, stays. */
  spaces(listed: ReadonlyMap<string, { participants: number; connected: boolean }> | 'gone', since = Infinity) {
    for (const room of this.open()) {
      if (!room.space || (listed !== 'gone' && room.spaceOpened >= since)) continue;
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

  dispose() {
    clearInterval(this.timer);
    for (const id of this.rooms.keys()) this.close(id);
  }
}
