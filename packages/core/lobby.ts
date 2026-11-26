// The lobby: the games the owner offers to anyone who reaches the host's player side, and the sessions being played.
// Anyone there may start a session of an offered game; a multiplayer session has a short code, and joining it takes
// the code, which the lobby never lists. The offers persist in the data folder's lobby.json (both hosts write the same
// file); the codes live with their rooms, and the limits and wrong-code counts in memory.
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lobbyFile, type Manifest } from '../sdk/contracts.ts';
import { atomicWrite, ZirbelError } from './projects.ts';
import type { Releases } from './releases.ts';
import type { Room, Rooms } from './rooms.ts';

/** A code's letters: no 0, O, 1 or I, which read as one another. */
export const CODE_LETTERS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Sessions started from the lobby that may be open at once on the host. */
export const LOBBY_SESSIONS = 16;
/** Of those, how many one address may have started (the host's own loopback aside). */
export const SESSIONS_PER_ADDRESS = 3;
/** Wrong codes an address may try in a minute before the lobby stops answering it for the rest of that minute. */
export const WRONG_CODES = 10;
const MINUTE = 60_000;
/** Addresses whose wrong codes are counted at once; the oldest make way. */
const COUNTED = 4096;

/** A code as a person types it: any case, with spaces, line breaks or dashes anywhere. Only a to z are upper-cased, so
 *  no other letter turns into one of the code's. */
export function readCode(input: string) {
  const code = input.replace(/[\t\n\f\r -]/g, '').replace(/[a-z]/g, (letter) => letter.toUpperCase());
  return /^[2-9A-HJ-NP-Z]{4}$/.test(code) ? code : undefined;
}

/** A new code that taken says no open room has. */
export function newCode(taken: (code: string) => boolean) {
  for (;;) {
    const code = Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
    if (!taken(code)) return code;
  }
}

/** An address as the limits count it: an IPv4 address mapped into IPv6 as itself. */
const plainAddress = (address: string) => address.replace(/^::ffff:(?=\d+\.)/, '');
const loopback = (address: string) => address === '::1' || address.startsWith('127.');
/** Titles as a reader orders them: case aside, then by case. */
const byTitle = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

export class Lobby {
  private offers: string[];
  private readonly manifests = new Map<string, Manifest>();
  private readonly wrong = new Map<string, { since: number; count: number }>();

  /** Reads the offers as the host starts: a lobby.json that is not one stops it. */
  constructor(private readonly rooms: Rooms, private readonly releases: Releases, private readonly file = join(releases.root, 'lobby.json'),
    private readonly now = Date.now) {
    let text = '';
    try { text = readFileSync(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try { this.offers = text ? lobbyFile.parse(JSON.parse(text)).offered : []; }
    catch { throw new Error('lobby.json in the data directory is not a lobby; move it aside to start with an empty one.'); }
  }

  /** The offered releases, in the order they were offered. */
  offered() { return [...this.offers]; }

  /** Puts a release in the lobby last, in place of any other release of its game, or takes it out: the new list. */
  offer(releaseId: string, offered: boolean) {
    let next = this.offers.filter((item) => item !== releaseId);
    if (offered) {
      const manifest = this.manifest(releaseId);
      if (!manifest.permissions.play) throw new ZirbelError(403, 'The creator has disabled play for this release.');
      const sameGame = (item: string) => {
        try { return this.manifest(item).gameId === manifest.gameId; } catch { return false; }
      };
      next = [...next.filter((item) => !sameGame(item)), releaseId];
    }
    atomicWrite(this.file, JSON.stringify(lobbyFile.parse({ version: 1, offered: next })));
    this.offers = next;
    return { offered: [...next] };
  }

  /** What the lobby shows on a listener: the offered games by title, and that listener's sessions with a code, newest
   *  first. Neither codes nor seats' names are in it. */
  state(access: Room['access']) {
    const games = this.offered().flatMap((release) => {
      let manifest: Manifest;
      try { manifest = this.manifest(release); } catch { return []; }
      if (!manifest.permissions.play) return [];
      return [{ release, title: manifest.title, players: { min: manifest.players.min, max: manifest.players.max },
        multiplayer: manifest.simulation !== null }];
    }).sort((a, b) => byTitle(a.title, b.title));
    const sessions = this.rooms.open().filter((room) => room.code && room.access === access).reverse().map((room) => ({
      id: room.session, title: room.release.manifest.title, players: room.players, max: room.release.manifest.players.max,
      started: new Date(room.started).toISOString(),
    }));
    return { games, sessions };
  }

  /** Starts a session of an offered release for the person at address: its room, with a seat held for them. */
  start(access: Room['access'], address: string, releaseId: string, name: string) {
    if (!this.offers.includes(releaseId)) throw new ZirbelError(404, 'That game is not in the lobby.');
    const from = plainAddress(address);
    const open = this.rooms.open().filter((room) => room.startedBy !== undefined);
    if (open.length >= LOBBY_SESSIONS)
      throw new ZirbelError(429, 'The lobby is full. Join a session, or try again when one ends.');
    // The host's own loopback is its owner's.
    if (!loopback(from) && open.filter((room) => room.startedBy === from).length >= SESSIONS_PER_ADDRESS)
      throw new ZirbelError(429, 'You have three sessions open. Join one, or wait until one ends.');
    const release = this.releases.read(releaseId);
    const room = this.rooms.create(release, release.manifest.simulation === null, access, false, from);
    return { room, ticket: room.seat(name, 'player') };
  }

  /** Seats the person at address in the open session with this code, on this listener: a player's seat while there is
   *  one, else a spectator's. */
  join(access: Room['access'], address: string, input: string, name: string) {
    const from = plainAddress(address);
    const at = this.now();
    const tries = this.wrong.get(from);
    if (tries && at - tries.since < MINUTE && tries.count >= WRONG_CODES)
      throw new ZirbelError(429, 'Too many wrong codes. Wait a minute and try again.');
    const code = readCode(input);
    const room = code ? this.rooms.open().find((item) => item.code === code && item.access === access) : undefined;
    if (!room) {
      this.miss(from, at);
      throw new ZirbelError(404, 'No session has that code.');
    }
    return { room, ticket: room.seat(name) };
  }

  private miss(address: string, at: number) {
    for (const [counted, tries] of this.wrong) if (at - tries.since >= MINUTE) this.wrong.delete(counted);
    const tries = this.wrong.get(address);
    this.wrong.delete(address);
    this.wrong.set(address, tries ? { since: tries.since, count: tries.count + 1 } : { since: at, count: 1 });
    if (this.wrong.size > COUNTED) this.wrong.delete(this.wrong.keys().next().value!);
  }

  // A release never changes under its id, so its manifest is read once.
  private manifest(releaseId: string) {
    let manifest = this.manifests.get(releaseId);
    if (!manifest) this.manifests.set(releaseId, manifest = this.releases.read(releaseId).manifest);
    return manifest;
  }
}
