// The box's switches (box mode, --box), in the account folder (box/settings.json): whether harnesses run on the box,
// whether agents elsewhere on the network may use its MCP server, whether its first-run choice was made, whether
// someone asked for the Wi-Fi setup again, whether the box makes its own Wi-Fi (box-network.ts), the last two of
// which the box's setup service reads from /api/box/status, and whether a TV plugged into the box shows its lobby (tv),
// which the box's console service reads there (docs/box-tv.md). What is off does not run: the harnesses are built only
// while they are on (BoxHarnesses), and /mcp answers the network only while external MCP access is on.
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite, ZirbelError } from '../core/projects.ts';
import type { ModelSettings } from '../sdk/model-settings.ts';
import { privateDirectory } from './account.ts';
import type { ProcessorRun, Processors } from './processors.ts';

const settings = z.strictObject({
  version: z.literal(1), harnesses: z.boolean(), externalMcp: z.boolean(), onboarded: z.boolean(), setupRequested: z.boolean(),
  // Settings written before the box could make its own Wi-Fi have none: it is off.
  ownNetwork: z.boolean().default(false),
  // Nor, before its TV console, a tv switch: it is as on a new box.
  tv: z.boolean().optional(),
});
export type BoxSwitches = Required<z.infer<typeof settings>>;
/** What a paired device or the box itself may change. */
export const settingsChange = z.strictObject({
  harnesses: z.boolean().optional(), externalMcp: z.boolean().optional(), onboarded: z.boolean().optional(),
  ownNetwork: z.boolean().optional(), tv: z.boolean().optional(),
});

/** What the box is, as it starts: harnesses runs only where Claude Code and Codex are made for the system, 64-bit ARM
 *  or x86 (a 32-bit Pi has neither). */
export type Capabilities = { arch: string; memoryMB: number; model?: string; harnesses: boolean };
/** Under this much memory (a 2 GB board reports a little less), harnesses start off: a turn may run the box out of it.
 *  So does the TV, whose browser needs room beside the editor; and it starts on only on a 64-bit box (docs/box-tv.md). */
const ROOMY_MB = 1536;
export const tvByDefault = (capabilities: Capabilities) => capabilities.arch === 'arm64' && capabilities.memoryMB >= ROOMY_MB;

export function boxCapabilities(): Capabilities {
  let model: string | undefined;
  try { model = readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim().slice(0, 120) || undefined; }
  catch { /* Not a single-board computer, or not Linux. */ }
  const harnesses = ['linux', 'darwin', 'win32'].includes(process.platform) && ['arm64', 'x64'].includes(process.arch);
  return { arch: process.arch, memoryMB: Math.round(totalmem() / 1048576), ...(model ? { model } : {}), harnesses };
}

/** Why harnesses can't be turned on here, in plain words, or nothing when they can. */
export function harnessesUnavailable(capabilities: Capabilities) {
  return capabilities.harnesses ? undefined : 'Claude Code and Codex aren’t made for this box’s ' +
    capabilities.arch + ' system. Use your own agent over MCP instead.';
}

export class BoxSettings {
  private readonly file: string;
  private readonly defaults: BoxSwitches;
  private cached?: BoxSwitches;

  constructor(folder: string, capabilities: Capabilities) {
    privateDirectory(folder);
    this.file = join(folder, 'settings.json');
    this.defaults = { version: 1, harnesses: capabilities.harnesses && capabilities.memoryMB >= ROOMY_MB,
      externalMcp: false, onboarded: false, setupRequested: false, ownNetwork: false, tv: tvByDefault(capabilities) };
  }

  read(): BoxSwitches {
    if (this.cached) return this.cached;
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.cached = this.defaults);
      throw error;
    }
    let read;
    try { read = settings.parse(JSON.parse(text)); } catch { throw new ZirbelError(500, 'The box settings could not be read.'); }
    return (this.cached = { ...read, tv: read.tv ?? this.defaults.tv });
  }

  update(change: Partial<Omit<BoxSwitches, 'version'>>) {
    const next = settings.parse({ ...this.read(), ...change });
    atomicWrite(this.file, JSON.stringify(next));
    return (this.cached = { ...next, tv: next.tv ?? this.defaults.tv });
  }
}

const OFF = 'Harnesses are off on this box. Turn them on in Box settings.';

/** The box's harnesses, built only while the switch is on: off, nothing of theirs is built, checked or started. */
export class BoxHarnesses implements Processors {
  private inner?: Processors;

  constructor(private readonly build: () => Processors, private readonly on: () => boolean) {}

  private get() {
    if (!this.on()) throw new ZirbelError(409, OFF);
    return (this.inner ??= this.build());
  }

  /** Stops and lets go of the harnesses, as the switch goes off. */
  async off() {
    const inner = this.inner;
    this.inner = undefined;
    await inner?.close?.();
  }

  async list() { return this.on() ? this.get().list() : []; }
  async start(id: string, prompt: string, run?: ProcessorRun) { return this.get().start(id, prompt, run); }

  async settings(id: string, model?: string, signal?: AbortSignal): Promise<ModelSettings> {
    const inner = this.get();
    if (!inner.settings) throw new ZirbelError(404, 'This harness has no model settings.');
    return inner.settings(id, model, signal);
  }

  async beginSignIn(id: string, options?: { elsewhere?: boolean }) {
    const inner = this.get();
    if (!inner.beginSignIn) throw new ZirbelError(404, 'This harness has no sign-in.');
    return inner.beginSignIn(id, options);
  }

  signInStatus(id: string) {
    const inner = this.get();
    if (!inner.signInStatus) throw new ZirbelError(404, 'This harness has no sign-in.');
    return inner.signInStatus(id);
  }

  submitSignInCode(id: string, code: string) {
    const inner = this.get();
    if (!inner.submitSignInCode) throw new ZirbelError(404, 'This harness has no sign-in.');
    return inner.submitSignInCode(id, code);
  }

  /** A deleted thread's session, removed by its harness while harnesses are on; off, it stays with the harness. */
  async removeSession(id: string, session: { cwd: string; sessionId: string }) {
    if (this.on()) await this.get().removeSession?.(id, session);
  }

  async close() { await this.inner?.close?.(); }
}
