// The box's pairing (box mode, --box): the one-time codes that pair a device, and the paired devices' sessions. A code
// lives in memory for ten minutes and pairs one device. A session is a cookie of 32 random bytes; the account folder
// keeps only its SHA-256 (box/paired.json), with a label for the device and when it was paired and last seen. A box
// no device has ever paired with may be claimed once, by the first device on its network (a box set up over Ethernet
// has no Bluetooth or hotspot to hand a code over).
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite, newId, ZirbelError } from '../core/projects.ts';
import { id } from '../sdk/contracts.ts';
import { privateDirectory } from './account.ts';

/** Crockford's base32: no I, L, O or U, which read as other characters. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_MS = 10 * 60_000;
/** Wrong codes an address may try in a minute. */
export const WRONG_CODES = 10;
const DEVICES = 64;
/** How often a session's last use is written down. */
const SEEN_MS = 60_000;
export const SESSION_COOKIE = 'zirbel_session';

const iso = z.iso.datetime();
const device = z.strictObject({
  id, label: z.string().max(80), tokenHash: z.string().regex(/^[0-9a-f]{64}$/), createdAt: iso, lastSeen: iso,
});
/** claimed: a device has been paired before. Until one is, the first device on the network may claim the box. */
const store = z.strictObject({ version: z.literal(1), claimed: z.boolean(), devices: z.array(device).max(DEVICES) });
type Device = z.infer<typeof device>;

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** A code as a person types it: any case, with or without its dash or spaces, O read as 0 and I or L as 1. */
export function normalizeCode(input: string) {
  const plain = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(plain) ? plain.slice(0, 4) + '-' + plain.slice(4) : undefined;
}

/** A short name for the device a browser runs on, from its User-Agent. */
export function deviceLabel(agent = '') {
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome'
    : /Safari\//.test(agent) ? 'Safari' : 'A browser';
  const system = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android'
    : /CrOS/.test(agent) ? 'ChromeOS' : /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows'
    : /Linux/.test(agent) ? 'Linux' : '';
  return system ? browser + ' on ' + system : browser;
}

/** The session a Cookie header carries, if it carries one in the form this box makes. */
export function sessionToken(cookie = '') {
  for (const part of cookie.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === SESSION_COOKIE && value && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return undefined;
}

export class Pairing {
  /** Each pending code's hash, and when it expires. */
  private readonly codes = new Map<string, { hash: Buffer; expires: number }>();
  private readonly wrong = new Map<string, { since: number; count: number }>();
  private readonly file: string;

  constructor(folder: string, private readonly now = Date.now) {
    privateDirectory(folder);
    this.file = join(folder, 'paired.json');
  }

  /** A new one-time code, valid for ten minutes. */
  createCode() {
    this.prune();
    const plain = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const code = plain.slice(0, 4) + '-' + plain.slice(4);
    const expires = this.now() + CODE_MS;
    this.codes.set(newId(), { hash: sha256(code), expires });
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  /** Pairs the device that sent a pending code, once: its new session's token, for the cookie. */
  redeem(input: string, address: string, agent?: string) {
    const at = this.now();
    const tries = this.wrong.get(address);
    if (tries && at - tries.since < 60_000 && tries.count >= WRONG_CODES)
      throw new ZirbelError(429, 'Too many wrong codes. Wait a minute and try again.');
    this.prune();
    const code = normalizeCode(input);
    const hash = sha256(code ?? '');
    // Every pending code is compared, in constant time, whichever matches.
    let found: string | undefined;
    for (const [key, pending] of this.codes) if (timingSafeEqual(pending.hash, hash) && code) found = key;
    if (!found) {
      const fresh = !tries || at - tries.since >= 60_000;
      this.wrong.set(address, fresh ? { since: at, count: 1 } : { since: tries.since, count: tries.count + 1 });
      throw new ZirbelError(403, 'That code is wrong or has expired. Get a new one from a paired device.');
    }
    const token = this.pair(agent);
    this.codes.delete(found);
    return token;
  }

  /** Whether the box can still be claimed: no device was ever paired with it. Once one has been, it stays closed, also
   *  after every device is removed; then only a code pairs, from a paired device or the box itself. */
  get claimable() { return !this.read().claimed; }

  /** Pairs the first device, while the box can be claimed: its session's token. */
  claim(agent?: string) {
    if (!this.claimable) throw new ZirbelError(409, 'This box is already claimed. Get a code from a paired device.');
    return this.pair(agent);
  }

  private pair(agent?: string) {
    const { devices } = this.read();
    if (devices.length >= DEVICES) throw new ZirbelError(409, 'This box has as many paired devices as it keeps. Remove one first.');
    const token = randomBytes(32).toString('base64url');
    const stamp = new Date(this.now()).toISOString();
    devices.push({ id: newId(), label: deviceLabel(agent), tokenHash: sha256(token).toString('hex'), createdAt: stamp, lastSeen: stamp });
    this.write(devices, true);
    return token;
  }

  /** The paired device a Cookie header's session belongs to, if any; its last use is noted. */
  session(cookie: string | undefined): Device | undefined {
    const token = sessionToken(cookie);
    if (!token) return undefined;
    const hash = sha256(token);
    const { devices } = this.read();
    let found: Device | undefined;
    for (const known of devices) if (timingSafeEqual(Buffer.from(known.tokenHash, 'hex'), hash)) found = known;
    if (found && this.now() - Date.parse(found.lastSeen) > SEEN_MS) {
      found.lastSeen = new Date(this.now()).toISOString();
      this.write(devices, true);
    }
    return found;
  }

  devices(current?: string) {
    return this.read().devices.map(({ tokenHash: _hash, ...known }) => ({ ...known, current: known.id === current }));
  }

  revoke(deviceId: string) {
    const { devices, claimed } = this.read();
    const kept = devices.filter((known) => known.id !== deviceId);
    if (kept.length === devices.length) throw new ZirbelError(404, 'That device is not paired.');
    this.write(kept, claimed);
  }

  get count() { return this.read().devices.length; }

  private prune() {
    const at = this.now();
    for (const [key, pending] of this.codes) if (pending.expires <= at) this.codes.delete(key);
    for (const [address, tries] of this.wrong) if (at - tries.since >= 60_000) this.wrong.delete(address);
  }

  private read() {
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 as const, claimed: false, devices: [] as Device[] };
      throw error;
    }
    try { return store.parse(JSON.parse(text)); } catch { throw new ZirbelError(500, 'The paired devices could not be read.'); }
  }

  private write(devices: Device[], claimed: boolean) {
    atomicWrite(this.file, JSON.stringify(store.parse({ version: 1, claimed, devices })));
  }
}
