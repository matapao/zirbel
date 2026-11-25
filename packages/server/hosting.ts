import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { PORTABLE_FILE_LIMIT, type Release } from '../sdk/contracts.ts';
import { ZirbelError } from '../core/projects.ts';
import type { Releases } from '../core/releases.ts';
import type { Room, Rooms } from '../core/rooms.ts';
import { lanAddresses, roomLink } from './http.ts';
import { playerListener } from './player-listener.ts';
import { threeAddons, type Addons } from './runtime-files.ts';

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

// A failed shutdown must not become an unhandled rejection.
export async function stopOnSignal(stop: () => Promise<void>) {
  try { await stop(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// Owns the loopback and LAN player listeners and the rooms they serve.
export class Players {
  local?: Listener;
  private lan?: Listener;
  private startingLan?: Promise<Listener>;

  // Read from the build beside the release runtime, and shared by both listeners.
  private readonly addons: Addons;

  // qr renders a LAN link for the editor; the headless host prints links only.
  constructor(readonly rooms: Rooms, private releases: Releases,
    private options: { playerPort: number; lanHost?: string; qr?: (link: string) => Promise<string> }) {
    this.addons = threeAddons(releases.webRoot);
  }

  get lanHost() { return this.options.lanHost; }

  async openLocal(port: number, editorOrigins: string[] = []) {
    this.local = await playerListener(this.rooms, this.releases.runtime, this.addons, { bind: '127.0.0.1', lan: false, port, editorOrigins });
    return this.local;
  }

  startLan() {
    if (this.lan) return Promise.resolve(this.lan);
    const { playerPort, lanHost } = this.options;
    this.startingLan ??= playerListener(this.rooms, this.releases.runtime, this.addons, { bind: '0.0.0.0', lan: true, port: playerPort,
      extraHosts: lanHost ? [lanHost] : [] }).then((active) => (this.lan = active))
      .finally(() => { this.startingLan = undefined; });
    return this.startingLan;
  }

  async describe(room: Room) {
    const shared = room.access === 'lan';
    const active = shared ? this.lan : this.local;
    if (!active) throw new ZirbelError(409, 'The player service is unavailable.');
    const address = shared ? this.options.lanHost ?? lanAddresses()[0] : undefined;
    const link = roomLink('http://' + (address ?? '127.0.0.1') + ':' + active.port, room);
    return { ...room.summary(), lan: Boolean(address), link,
      localLink: roomLink('http://127.0.0.1:' + active.port, room),
      qr: shared && address && this.options.qr ? await this.options.qr(link) : null,
    };
  }

  solo(release: Release) {
    if (!this.local) throw new ZirbelError(503, 'The player service is unavailable.');
    const room = this.rooms.create(release, true);
    return { link: roomLink('http://127.0.0.1:' + this.local.port, room), id: room.id };
  }

  async start(releaseId: string, share: boolean) {
    const release = this.releases.read(releaseId);
    if (!release.manifest.permissions.play)
      throw new ZirbelError(403, 'The creator has disabled play for this release.');
    if (share) await this.startLan();
    return this.describe(this.rooms.create(release, false, share ? 'lan' : 'local'));
  }

  async close() {
    await Promise.allSettled([this.startingLan]);
    this.rooms.dispose();
    this.local?.close();
    this.lan?.close();
  }
}
