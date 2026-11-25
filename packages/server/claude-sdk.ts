// Anthropic's Agent SDK, which runs the person's own Claude Code. It is under Anthropic's terms and goes in no image or
// release (scripts/build.mjs keeps it out of dist/), so an editor installed without it, as the packed desktop app is,
// fetches it the first time a Claude Code turn starts, and only then: one installed with the editor is used as it is,
// and one fetched before is loaded from the account folder. What comes is the version the editor was built with, from
// the npm registry, kept only when its tarball matches the lockfile's hash. Only the SDK's own package comes: the SDK
// runs the person's Claude Code, so the platform binaries it would otherwise install never do.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ZirbelError } from '../core/projects.ts';
import { privateDirectory } from './account.ts';

/** The version and hash the lockfile holds, set by the build (scripts/build.mjs); absent when run from the sources. */
declare const ZIRBEL_CLAUDE_SDK: Pin | undefined;
type Pin = { version: string; integrity: string };

const NAME = '@anthropic-ai/claude-agent-sdk';
/** Where the built editor's stand-in for the SDK (scripts/build.mjs) finds the one loaded here. */
const SLOT = Symbol.for('zirbel.claude-agent-sdk');
const REGISTRY = 'https://registry.npmjs.org';
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const LIMITS = { tarball: 32 * 1024 * 1024, unpacked: 64 * 1024 * 1024, files: 1000, fetchMs: 120_000 };
/** A fetch an editor stopped in the middle of leaves its folder; one this old is no other editor's. */
const ABANDONED_MS = 60 * 60 * 1000;

/** The work's end, or the turn's when it is stopped first. */
function untilStopped(work: Promise<void>, signal?: AbortSignal) {
  if (!signal) return work;
  return new Promise<void>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

function withEditor() {
  try {
    import.meta.resolve(NAME);
    return true;
  } catch {
    return false;
  }
}

type Fetched = { title: string; detail: string };

export class ClaudeSdk {
  private readonly pin?: Pin;
  private readonly registry: string;
  private readonly installed: () => boolean;
  private fetching?: Promise<void>;

  constructor(
    private readonly folder: string,
    o: { pin?: Pin; registry?: string; withEditor?: () => boolean } = {},
  ) {
    const pin = 'pin' in o ? o.pin : typeof ZIRBEL_CLAUDE_SDK === 'undefined' ? undefined : ZIRBEL_CLAUDE_SDK;
    if (pin && (!VERSION.test(pin.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity)))
      throw new Error('The Claude Agent SDK pin is not a version and a sha512 hash.');
    this.pin = pin;
    this.registry = o.registry ?? REGISTRY;
    this.installed = o.withEditor ?? withEditor;
  }

  /** Whether Claude Code turns can run here: with the editor's own SDK, or one this editor knows how to fetch. */
  get available() {
    return this.installed() || Boolean(this.pin);
  }

  /** Makes the SDK ready for a turn: says what it fetched when it had to, and nothing when the SDK was there. */
  async ready(signal?: AbortSignal): Promise<Fetched | undefined> {
    if (this.installed() || Reflect.has(globalThis, SLOT)) return undefined;
    const pin = this.pin;
    if (!pin) throw new ZirbelError(409, 'Claude Code is unavailable in this editor.');
    const place = join(this.folder, pin.version);
    let fetched: Fetched | undefined;
    if (!existsSync(join(place, 'package.json'))) {
      // One fetch for the turns that start together; a turn stopped meanwhile leaves it to finish for the others.
      this.fetching ??= this.fetch(pin, place).finally(() => {
        this.fetching = undefined;
      });
      await untilStopped(this.fetching, signal);
      fetched = {
        title: "Fetched Claude Code's SDK",
        detail:
          `Anthropic's Claude Agent SDK ${pin.version} came from the ` +
          "npm registry, matched this editor's lockfile, and is kept in Zirbel's account folder for the turns after this one.",
      };
    }
    signal?.throwIfAborted();
    if (!Reflect.has(globalThis, SLOT))
      Reflect.set(globalThis, SLOT, await import(pathToFileURL(join(place, 'sdk.mjs')).href));
    return fetched;
  }

  private async fetch(pin: Pin, place: string) {
    const tarball = await this.download(pin);
    if ('sha512-' + createHash('sha512').update(tarball).digest('base64') !== pin.integrity)
      throw new ZirbelError(
        502,
        "The Claude Agent SDK npm sent doesn't match this editor's lockfile, so it was not kept.",
      );
    const files = packageFiles(tarball);
    const manifest = JSON.parse(files.get('package.json')?.toString('utf8') ?? 'null') as {
      name?: string;
      version?: string;
    } | null;
    if (manifest?.name !== NAME || manifest.version !== pin.version || !files.has('sdk.mjs'))
      throw new ZirbelError(502, 'The package npm sent is not the Claude Agent SDK this editor was built with.');
    privateDirectory(this.folder);
    const staging = join(this.folder, '.fetch-' + randomUUID());
    try {
      for (const [path, content] of files) {
        mkdirSync(dirname(join(staging, path)), { recursive: true, mode: 0o700 });
        writeFileSync(join(staging, path), content, { mode: 0o600, flag: 'wx' });
      }
      try {
        renameSync(staging, place);
      } catch (error) {
        // Another editor of this person's kept the same version first.
        if (!existsSync(join(place, 'package.json'))) throw error;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    this.removeOthers(pin.version);
  }

  private async download({ version }: Pin) {
    const url = `${this.registry}/${NAME}/-/claude-agent-sdk-${version}.tgz`;
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(LIMITS.fetchMs) });
    } catch {
      throw new ZirbelError(
        503,
        "Claude Code's SDK could not be fetched from the npm registry. Check the connection and try again.",
      );
    }
    if (!response.ok || !response.body)
      throw new ZirbelError(502, `The npm registry did not send Claude Code's SDK (HTTP ${response.status}).`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > LIMITS.tarball) throw new ZirbelError(502, 'The Claude Agent SDK npm sent is larger than an SDK is.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** The versions an earlier editor fetched, and fetches no editor finished, go once this one is kept. */
  private removeOthers(version: string) {
    for (const entry of readdirSync(this.folder, { withFileTypes: true })) {
      const at = join(this.folder, entry.name);
      const abandoned = entry.name.startsWith('.fetch-') && Date.now() - lstatSync(at).mtimeMs > ABANDONED_MS;
      if (entry.isDirectory() && (abandoned || (VERSION.test(entry.name) && entry.name !== version)))
        rmSync(at, { recursive: true, force: true });
    }
  }
}

/** The regular files of an npm package's tarball, by their paths in the package. Any other kind of entry, or a path
 *  outside the package, refuses the package. */
function packageFiles(tarball: Buffer) {
  let archive: Buffer;
  try {
    archive = gunzipSync(tarball, { maxOutputLength: LIMITS.unpacked });
  } catch {
    throw new ZirbelError(502, 'The Claude Agent SDK npm sent could not be unpacked.');
  }
  const refuse = (why: string) => new ZirbelError(502, `The Claude Agent SDK npm sent was not kept: ${why}.`);
  const files = new Map<string, Buffer>();
  let paxPath: string | undefined;
  for (let at = 0; at + 512 <= archive.length;) {
    const header = archive.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) =>
      header.toString('utf8', start, start + length).replace(/\0.*$/s, '');
    const octal = (start: number, length: number) => {
      const digits = text(start, length).trim();
      if (!/^[0-7]{1,12}$/.test(digits)) throw refuse('an entry header is damaged');
      return Number.parseInt(digits, 8);
    };
    let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!;
    if (sum !== octal(148, 8)) throw refuse('an entry header is damaged');
    const size = octal(124, 12);
    const content = archive.subarray(at + 512, at + 512 + size);
    if (content.length !== size) throw refuse('it ends inside an entry');
    at += 512 + Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156]!);
    if (type === 'x') {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(content.toString('utf8'))?.[1];
      continue;
    }
    if (type === 'g' || type === '5') {
      paxPath = undefined;
      continue;
    }
    if (type !== '0' && type !== '\0') throw refuse('it holds a link or a special file');
    const prefix = text(345, 155);
    const name = paxPath ?? (prefix ? prefix + '/' + text(0, 100) : text(0, 100));
    paxPath = undefined;
    const path = name.startsWith('package/') ? name.slice('package/'.length) : '';
    if (
      !path ||
      /[\\\0]/.test(path) ||
      path.endsWith('/') ||
      posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      path.split('/').includes('..')
    )
      throw refuse('a file is outside the package');
    if (files.size >= LIMITS.files) throw refuse('it holds more files than an SDK does');
    files.set(path, content);
  }
  return files;
}
