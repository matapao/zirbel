import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { PORTABLE_FILE_LIMIT, type Release } from '../sdk/contracts.ts';
import { Lobby } from '../core/lobby.ts';
import { Pads } from '../core/pads.ts';
import { ZirbelError } from '../core/projects.ts';
import type { Releases } from '../core/releases.ts';
import type { Room, Rooms } from '../core/rooms.ts';
import { lanAddresses, roomLink } from './http.ts';
import type { LobbyContext } from './lobby-routes.ts';
import { padsService } from './pads-socket.ts';
import { playerListener, type PlayerReach } from './player-listener.ts';
import { lobbyFiles, threeAddons, type Addons } from './runtime-files.ts';
import { Spaces, spacesBinary } from './spaces.ts';

// Shared by the editor and the headless host. Keep editor-only code (harnesses,
// MCP) out of this file so `--host-only` loads only what players need.
type Listener = Awaited<ReturnType<typeof playerListener>>;

export function readPort(input: string) {
  if (!/^\d{1,5}$/.test(input) || Number(input) > 65535) throw new Error('Expected a port from 0 to 65535.');
  return Number(input);
}

export function readLanHost(input?: string) {
  if (input && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(input))
    throw new Error('The player host must be an IPv4 address or hostname.');
  return input?.toLowerCase();
}

export function importReleases(releases: Releases, files: string[]) {
  for (const file of files) releases.import(JSON.parse(readRelease(file)));
}

/** A release file's text, checked and read through one handle, never past the portable file limit. It opens without
 *  waiting, so a named pipe is refused rather than waited on. */
function readRelease(file: string) {
  const refused = () => new Error('Import a release file under 48 MB.');
  const handle = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size > PORTABLE_FILE_LIMIT) throw refused();
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < buffer.length; length += read)
      read = readSync(handle, buffer, length, buffer.length - length, null);
    // One that grew while it was read is not the file that was checked.
    if (length > stat.size) throw refused();
    return buffer.toString('utf8', 0, length);
  } finally { closeSync(handle); }
}

// A box without IPv6 listens on IPv4 alone.
function everyInterface(open: (bind: string) => Promise<Listener>) {
  return open('::').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EAFNOSUPPORT') throw error;
    return open('0.0.0.0');
  });
}

// A failed shutdown must not become an unhandled rejection.
export async function stopOnSignal(stop: () => Promise<void>) {
  try { await stop(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/** A host name only the device it is on reaches itself by. */
const loopbackName = (host: string) => host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
// An address another device can open as it is: a name, even one this device resolved (a box's .local name), is often
// one a phone or an office network can't.
const sharedAddress = (host: string) => !loopbackName(host) && isIP(host.replace(/^\[(.*)\]$/, '$1')) !== 0;

/** A box's player side: the LAN listener on every interface for the box's own network (reach), and the addresses of
 *  the pairing page and the edit page the lobby links to, on the host name a device reached it by. */
type BoxPlayers = { reach: PlayerReach; pair: (host: string) => string; edit: (host: string) => string };

/** How often the spaces kernel's spaces are listed: their members for the lobby, and the rooms whose space ended. */
const SWEEP = 2000;

// Owns the loopback and LAN player listeners, the rooms they serve and the lobby on each.
export class Players {
  local?: Listener;
  private lan?: Listener;
  private startingLan?: Promise<Listener>;
  readonly lobby: Lobby;
  /** The screens and controllers of both listeners, and the box's own gamepads (core/pads.ts). */
  readonly pads = new Pads();
  private readonly padsSweep = setInterval(() => this.pads.sweep(), 1000).unref();
  private padsLocal?: Promise<{ close(): void } | undefined>;
  /** The spaces kernel, which games with their own netcode play over: the listeners pass /.skalet/* to it. */
  readonly spaces: Spaces;
  private readonly sweep = setInterval(() => void this.listSpaces(), SWEEP).unref();

  // Read from the build beside the release runtime, and shared by both listeners.
  private readonly addons: Addons;
  private readonly lobbyContext: LobbyContext;

  // qr renders a LAN link for the editor; the headless host prints links only. spacesBinary: the kernel's, as named
  // (--spaces-binary, ZIRBEL_SPACES_BINARY).
  constructor(readonly rooms: Rooms, private releases: Releases,
    private options: { playerPort: number; lanHost?: string; qr?: (link: string) => Promise<string>; box?: BoxPlayers;
      spacesBinary?: string }) {
    this.addons = threeAddons(releases.webRoot);
    this.spaces = new Spaces({ binary: spacesBinary(options.spacesBinary, join(releases.webRoot, '..')),
      manifest: join(releases.webRoot, 'skalet.json') });
    rooms.kernel = this.spaces;
    this.spaces.onReset(() => rooms.spaces('gone'));
    this.lobby = new Lobby(rooms, releases);
    this.lobbyContext = { lobby: this.lobby, files: lobbyFiles(releases.webRoot), pair: options.box?.pair, edit: options.box?.edit,
      link: (host) => this.lobbyLink(host) };
  }

  get lanHost() { return this.options.lanHost; }

  /** Starts the spaces kernel, or reaches the host's; without one, games with their own netcode play alone. */
  startSpaces() { return this.spaces.start(); }

  private async listSpaces() {
    if (!this.spaces.available || !this.rooms.open().some((room) => room.space)) return;
    try { this.rooms.spaces(await this.spaces.list()); } catch { /* listed again on the next sweep */ }
  }

  /** The LAN listener's port, once it runs. */
  get lanPort() { return this.lan?.port; }

  /** The player for the editor's own playtests: on loopback, or on a box (reach) on every interface, for the box's
   *  network, embedded by the editor on the host name the device reached it by. */
  async openLocal(port: number, editorOrigins: string[] | ((host: string) => string[]) = [], reach?: PlayerReach) {
    const open = (bind: string) => playerListener(this.rooms, this.releases.runtime, this.addons,
      { bind, lan: false, port, editorOrigins, reach, lobby: this.lobbyContext, pads: this.pads, spaces: () => this.spaces.target });
    this.local = await (reach ? everyInterface(open) : open('127.0.0.1'));
    return this.local;
  }

  /** The LAN listener: on a box, on every interface for the box's own network, from start-up. */
  startLan() {
    if (this.lan) return Promise.resolve(this.lan);
    const { playerPort, lanHost, box } = this.options;
    const open = (bind: string) => playerListener(this.rooms, this.releases.runtime, this.addons, { bind, lan: true,
      port: playerPort, extraHosts: lanHost ? [lanHost] : [], reach: box?.reach, lobby: this.lobbyContext, pads: this.pads,
      spaces: () => this.spaces.target });
    this.startingLan ??= (box ? everyInterface(open) : open('0.0.0.0')).then((active) => (this.lan = active))
      .finally(() => { this.startingLan = undefined; });
    return this.startingLan;
  }

  /** host: the name the editor was reached by, on a box; loopback otherwise. */
  async describe(room: Room, host = '127.0.0.1') {
    const shared = room.access === 'lan';
    const active = shared ? this.lan : this.local;
    if (!active) throw new ZirbelError(409, 'The player service is unavailable.');
    const address = shared ? this.options.lanHost ?? lanAddresses()[0] : undefined;
    const link = roomLink('http://' + (address ?? host) + ':' + active.port, room);
    return { ...room.summary(), lan: Boolean(address), link,
      localLink: roomLink('http://' + host + ':' + active.port, room),
      qr: shared && address && this.options.qr ? await this.options.qr(link) : null,
    };
  }

  /** The lobby's address for other devices on the network, on the LAN listener: by host, the name a box was reached
   *  by, where others can use it, and otherwise by the address a shared room's link has. None while no LAN listener
   *  runs, or while it has no address. */
  lobbyLink(host?: string) {
    if (!this.lan) return null;
    const address = this.sharedHost(host);
    return address ? 'http://' + address + ':' + this.lan.port + '/' : null;
  }

  /** The address other devices on the network reach this host by: host, the name a box was reached by, where others
   *  can use it, and otherwise the player host or the first LAN address. None while it has none. */
  sharedHost(host?: string) {
    return host && sharedAddress(host) ? host : this.options.lanHost ?? lanAddresses()[0];
  }

  solo(release: Release, host = '127.0.0.1') {
    if (!this.local) throw new ZirbelError(503, 'The player service is unavailable.');
    const room = this.rooms.create(release, true);
    return { link: roomLink('http://' + host + ':' + this.local.port, room), id: room.id };
  }

  async start(releaseId: string, share: boolean, host?: string) {
    const release = this.releases.read(releaseId);
    if (!release.manifest.permissions.play)
      throw new ZirbelError(403, 'The creator has disabled play for this release.');
    if (share) await this.startLan();
    return this.describe(await this.rooms.withSpace(this.rooms.create(release, false, share ? 'lan' : 'local')), host);
  }

  /** Listens for the box's controller service at path (--pads-socket). A box comes up without its gamepads rather than
   *  not at all, so a socket it can't open is said and passed over. */
  async listenForPads(path: string) {
    this.padsLocal ??= padsService(this.pads, path).catch((error: unknown) => {
      console.error('Zirbel can\'t listen for the box\'s controllers at ' + path + ': ' + (error instanceof Error ? error.message : String(error)));
      return undefined;
    });
    await this.padsLocal;
  }

  async close() {
    await Promise.allSettled([this.startingLan]);
    clearInterval(this.padsSweep);
    clearInterval(this.sweep);
    (await this.padsLocal)?.close();
    this.rooms.dispose();
    this.local?.close();
    this.lan?.close();
    await this.spaces.stop();
  }
}
