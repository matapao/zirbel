// The spaces kernel, which carries the multiplayer of games with their own netcode. Zirbel runs it as a child (its
// binary's `spaces` mode, with Zirbel's skalet.json), or, under a host that already runs one (SKALET_SPACES in the
// environment), uses that host's and runs none. Zirbel's own code reaches it over its local socket (spaces-socket.ts);
// pages reach it through /.skalet/* on Zirbel's listeners, which spaces-proxy.ts forwards to the child's address. The
// socket's address and token stay in this process: they are no harness's or game's.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SpaceKernel } from '../core/rooms.ts';
import { spacesList, spacesMember, spacesOpened, spacesStart, spacesTicket } from '../sdk/contracts.ts';
import { SpacesError, SpacesSocket } from './spaces-socket.ts';

/** How long a child has to print its start line, and the waits before starting it again: doubled up to the last. */
const START_TIME = 10_000;
const BACKOFF = [1000, 2000, 4000, 8000, 16_000, 30_000];
/** A child that ran this long starts the backoff over when it ends. */
const STEADY = 60_000;
/** The listener of Zirbel's skalet.json that its rooms' spaces are for, the observers each takes beside its players,
 *  as a room's spectators, and how long a member who drops keeps its place (a lockstep game waits that long for it). */
const PLAYER = 'player';
const OBSERVERS = 4;
const GRACE_SECONDS = 15;
const secretPattern = /^[A-Za-z0-9_-]{16,128}$/;

const binaryName = 'skalet' + (process.platform === 'win32' ? '.exe' : '');

/** The binary: the one named (--spaces-binary, ZIRBEL_SPACES_BINARY), else one beside the host's program (the
 *  desktop app's, the box image's), else the one `pnpm run deps` built in the repository. */
export function spacesBinary(named: string | undefined, dist: string) {
  if (named) return named;
  return [join(dist, binaryName), join(dist, '..', 'deps', 'skalet', 'bin', binaryName)].find((path) =>
    existsSync(path),
  );
}

export type SpacesOptions = {
  /** The kernel's binary, if there is one. */
  binary?: string | undefined;
  /** Zirbel's skalet.json, whose listeners and spaces block the child serves. */
  manifest: string;
  env?: NodeJS.ProcessEnv;
};

export class Spaces implements SpaceKernel {
  /** Where /.skalet/* goes, and the token it goes with: the child's; none under a host, whose front answers those
   *  paths itself, or while no child runs. */
  target: { http: string; token: string } | null = null;
  private socket: SpacesSocket | undefined;
  private child: ChildProcess | undefined;
  private timer?: NodeJS.Timeout;
  private attempt = 0;
  private stopped = false;
  private readonly resets = new Set<() => void>();

  private readonly options: SpacesOptions;

  constructor(options: SpacesOptions) {
    this.options = options;
  }

  /** Whether spaces can be opened now. */
  get available() {
    return Boolean(this.socket);
  }

  /** Starts the kernel, or connects to the host's: resolves once the first try has succeeded or failed. */
  async start() {
    const env = this.options.env ?? process.env;
    if (env.SKALET_SPACES) {
      await this.connect(env.SKALET_SPACES, env.SKALET_SPACES_TOKEN ?? '', null);
      return;
    }
    const { binary } = this.options;
    if (!binary) return;
    if (!existsSync(binary)) {
      console.error('Zirbel finds no spaces kernel at ' + binary + ': games with their own netcode play alone.');
      return;
    }
    await this.spawn(binary);
  }

  /** Calls the kernel; a SpacesError when none runs or it refuses. */
  call(method: string, params: Record<string, unknown>) {
    return this.socket
      ? this.socket.call(method, params)
      : Promise.reject(new SpacesError('unavailable', "Multiplayer isn't available on this host now."));
  }

  /** A space for a net game's room, for the player listener, with the binary lane and the code Zirbel chose for it, if
   *  any (a SpacesError taken when another space has it): its id, and the invitation its link holds. */
  async open({ participants, code }: { participants: number; code?: string }) {
    const opened = spacesOpened.parse(
      await this.call('space.open', {
        rules: null,
        listener: PLAYER,
        members: { participants, observers: OBSERVERS },
        ...(code ? { code } : {}),
        binary: true,
        graceSeconds: GRACE_SECONDS,
      }),
    );
    const invite = new URLSearchParams(opened.link.split('#')[1] ?? '').get('skalet.invite') ?? '';
    if (!secretPattern.test(invite)) {
      this.close(opened.space);
      throw new SpacesError('protocol', 'The spaces kernel gave a link without its invitation.');
    }
    return { space: opened.space, invite };
  }

  /** A one-time ticket into a space, for a name and a role. */
  async ticket(space: string, name: string, role: 'participant' | 'observer') {
    return spacesTicket.parse(await this.call('space.ticket', { space, name, role })).ticket;
  }

  /** The member of a space a page's proof names, which uses the proof up; a SpacesError expired when it names none. */
  async member(space: string, proof: string) {
    return spacesMember.parse(await this.call('space.member', { space, proof })).member;
  }

  /** Ends a space; its members hear it closed. */
  close(space: string) {
    this.call('space.close', { space }).catch(() => {});
  }

  /** Every space of Zirbel's the kernel holds, by id: its participants (connected, or away within their grace), and
   *  whether any member is connected. */
  async list() {
    const listed = spacesList.parse(await this.call('space.list', {}));
    return new Map(
      listed.map((item) => [
        item.space,
        {
          participants: item.members.filter((member) => member.role === 'participant').length,
          connected: item.members.some((member) => member.connected),
        },
      ]),
    );
  }

  /** Hears that the kernel went, and every space it held with it. */
  onReset(listener: () => void) {
    this.resets.add(listener);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => {
        clearTimeout(force);
        done();
      });
      // It ends when its stdin closes, and on SIGTERM.
      child.stdin?.end();
      child.kill('SIGTERM');
    });
  }

  private async spawn(binary: string) {
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), SKALET_EXIT_WITH_STDIN: '1' };
    delete env.SKALET_SPACES;
    delete env.SKALET_SPACES_TOKEN;
    const child = spawn(binary, ['spaces', '--manifest', this.options.manifest], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child = child;
    child.on('error', () => {});
    const born = Date.now();
    // Its stdin is held open for as long as Zirbel runs: the child ends with it, even when Zirbel is killed.
    child.stdin?.on('error', () => {});
    child.once('exit', () => {
      if (this.child === child) this.child = undefined;
      this.target = null;
      if (Date.now() - born > STEADY) this.attempt = 0;
      this.retry(() => this.spawn(binary));
    });
    try {
      const line = await firstLine(child);
      const started = spacesStart.parse(JSON.parse(line));
      await this.connect(started.socket, started.token, started.spaces);
    } catch (error) {
      console.error('The spaces kernel did not start: ' + (error instanceof Error ? error.message : String(error)));
      child.kill('SIGKILL');
    }
  }

  private async connect(address: string, token: string, http: string | null) {
    try {
      const socket = await SpacesSocket.open(address, token);
      this.socket = socket;
      this.target = http ? { http, token } : null;
      socket.onEnd(() => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.target = null;
        for (const listener of this.resets) listener();
        // Under a host, its socket comes back; a child's comes back with the child, which goes without it.
        if (!http) this.retry(() => this.connect(address, token, null));
        else if (!this.stopped) this.child?.kill('SIGTERM');
      });
    } catch (error) {
      if (!http) {
        console.error(
          "Zirbel can't reach the spaces kernel at " +
            address +
            ': ' +
            (error instanceof Error ? error.message : String(error)),
        );
        this.retry(() => this.connect(address, token, null));
      } else throw error;
    }
  }

  private retry(again: () => Promise<void>) {
    if (this.stopped) return;
    const wait = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]!;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.stopped) void again();
    }, wait);
    this.timer.unref();
  }
}

/** The child's first line on stdout, its start line; what follows is read and let go. */
function firstLine(child: ChildProcess) {
  return new Promise<string>((resolve, reject) => {
    if (!child.stdout) {
      reject(new Error('it has no stdout'));
      return;
    }
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error('it printed no start line')), START_TIME);
    lines.once('line', (line) => {
      clearTimeout(timer);
      resolve(line);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('it ended with ' + code));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
