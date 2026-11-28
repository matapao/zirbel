// The person's own Claude Code and Codex, each run through its agent's SDK by the harness library, signed in as the
// person is. A turn works in its thread's folder (threads.ts) and continues the thread's session; without a thread it
// gets a folder of its own that goes after it.
import {
  AgentRuntime,
  claudeAgent,
  codexAgent,
  findProgram,
  type AgentAsk,
  type AgentLogin,
  type Host,
  type RunHandle,
  type RunProgress,
  type RunSpec,
  type Runtime,
} from 'celler/harness';
import { constants, copyFileSync, existsSync, lstatSync, chmodSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { newId, ZirbelError } from '../core/projects.ts';
import { modelChoices, type ModelSettings } from '../sdk/model-settings.ts';
import { accountDirectory, privateDirectory } from './account.ts';
import { ClaudeSdk } from './claude-sdk.ts';
import { harnessActivity } from './harness-activity.ts';
import { TurnEndedError, type Processor, type ProcessorRun, type Processors, type SignInStatus } from './processors.ts';

/** A turn has no time limit: it runs until it ends or Stop ends it. The library needs a value, and its clock takes this
 *  one, the largest a number holds (it sets its timer again every 2^31 - 1 ms, and stands still while the person is
 *  asked). */
const NO_TIME_LIMIT = Number.POSITIVE_INFINITY;

/** The model tiers every harness takes, and the reasoning efforts each agent offers, by its runtime's kind. */
const TIERS = [
  { value: 'fast', name: 'Fast' },
  { value: 'balanced', name: 'Balanced' },
  { value: 'strong', name: 'Strong' },
];
const EFFORT_NAMES: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};
const EFFORTS: Record<string, string[]> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
};

/** What the model picker offers for a harness: no choice made means the harness's own default. */
function modelSettings(kind: string): ModelSettings {
  const efforts = EFFORTS[kind] ?? [];
  return {
    model: { name: 'Model', currentValue: '', options: TIERS },
    ...(efforts.length
      ? {
          effort: {
            name: 'Reasoning effort',
            currentValue: '',
            options: efforts.map((value) => ({ value, name: EFFORT_NAMES[value] ?? value })),
          },
        }
      : {}),
  };
}

function reuseCodexSignIn(codexHome: string) {
  // The old default installation and the CLI can both have an existing sign-in.
  // Only the well-known legacy location is eligible for migration.
  const auth = join(codexHome, 'auth.json');
  const previous = join(homedir(), '.zirbel', 'harnesses', 'codex');
  for (const source of [previous, process.env.CODEX_HOME || join(homedir(), '.codex')]) {
    if (existsSync(auth) || !isAbsolute(source)) continue;
    try {
      const file = join(source, 'auth.json');
      const stat = lstatSync(file);
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) continue;
      copyFileSync(file, auth, constants.COPYFILE_EXCL);
      chmodSync(auth, 0o600);
    } catch (error) {
      if (!['ENOENT', 'EEXIST', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
}

type LocalProcessor = Pick<Processor, 'id' | 'name'> & {
  runtime: Runtime & Pick<AgentRuntime, 'login'>;
  unavailable?: string | undefined;
  /** What a turn needs first: says what it did, when it did something. */
  prepare?: (signal?: AbortSignal) => Promise<{ title: string; detail: string } | undefined>;
};
type ActiveSignIn = { login: AgentLogin; state: SignInStatus };

export function localHarnesses(projectDirectory: string, root = accountDirectory()) {
  privateDirectory(root);
  const projects = realpathSync(projectDirectory);
  const accounts = realpathSync(root);
  if (projects === accounts || accounts.startsWith(join(projects, sep)) || projects.startsWith(join(accounts, sep)))
    throw new Error('Use separate directories for games and harness accounts.');
  const data = join(root, 'harnesses');
  const turns = join(root, 'turns');
  const codexHome = join(data, 'codex');
  for (const directory of [data, codexHome, turns]) privateDirectory(directory);
  reuseCodexSignIn(codexHome);
  const host: Host = { client: { name: 'zirbel', version: '0.1.0' }, mark: (env) => env };
  const claudeSdk = new ClaudeSdk(join(root, 'claude-agent-sdk'));
  return new LocalHarnesses(turns, [
    {
      id: 'codex',
      name: 'Codex',
      runtime: new AgentRuntime(
        codexAgent({
          codex: () => findProgram('codex'),
          home: codexHome,
          words: {
            install: 'Install Codex to use it here.',
            login: 'Sign in to Codex to continue.',
            signedOut: 'Sign-in required.',
          },
        }),
        host,
      ),
    },
    {
      id: 'claude',
      name: 'Claude Code',
      unavailable: claudeSdk.available ? undefined : 'Unavailable in this editor',
      prepare: (signal) => claudeSdk.ready(signal),
      runtime: new AgentRuntime(
        claudeAgent({
          claude: () => findProgram('claude'),
          words: { noClaude: 'Claude Code is unavailable.', login: 'Sign in to Claude Code to continue.' },
        }),
        host,
      ),
    },
  ]);
}

export class LocalHarnesses implements Processors {
  private readonly signIns = new Map<string, ActiveSignIn>();
  private checking: Promise<Processor[]> | undefined;
  private checked: { at: number; processors: Processor[] } | undefined;
  /** The runs still going, which close() stops and waits for. */
  private readonly running = new Set<RunHandle>();
  private readonly cwd: string;
  private readonly processors: LocalProcessor[];

  constructor(cwd: string, processors: LocalProcessor[]) {
    this.cwd = cwd;
    this.processors = processors;
  }

  async list() {
    if (this.checking) return this.checking;
    if (this.checked && Date.now() - this.checked.at < 3000) return this.checked.processors;
    this.checking = Promise.all(
      this.processors.map(async ({ id, name, runtime, unavailable }): Promise<Processor> => {
        if (unavailable) return { id, name, ready: false, detail: unavailable };
        try {
          const health = await runtime.health(false);
          if (health.ok) return { id, name, ready: true, modelSettings: true };
          if (health.fix === 'login') return { id, name, ready: false, signIn: true };
          // Found, but not one that runs here (older than its SDK is made with): the library says what to do.
          if (health.program && !health.fix) return { id, name, ready: false, detail: health.detail.slice(0, 300) };
        } catch {
          /* One unavailable harness should leave the others usable. */
        }
        return { id, name, ready: false, detail: 'Unavailable on this device' };
      }),
    );
    try {
      const processors = await this.checking;
      this.checked = { at: Date.now(), processors };
      return processors;
    } finally {
      this.checking = undefined;
    }
  }

  async settings(id: string, model?: string, signal?: AbortSignal): Promise<ModelSettings> {
    signal?.throwIfAborted();
    const settings = modelSettings(this.get(id).runtime.kind);
    if (model && !modelChoices(settings.model).some(({ value }) => value === model))
      throw new ZirbelError(422, 'Choose a model offered by the harness.');
    return settings;
  }

  async start(id: string, prompt: string, { signal, update, ask, selection, place, session }: ProcessorRun = {}) {
    const processor = this.get(id);
    const { model, effort } = selection ?? {};
    const settings = await this.settings(id, model, signal);
    if (effort && !modelChoices(settings.effort).some(({ value }) => value === effort))
      throw new ZirbelError(422, 'Choose a reasoning level offered for this model.');
    const status = (await this.list()).find((choice) => choice.id === id);
    signal?.throwIfAborted();
    if (!status?.ready)
      throw new ZirbelError(
        409,
        status?.signIn ? 'Sign in to ' + processor.name + ' to continue.' : processor.name + ' is unavailable.',
      );
    const prepared = await processor.prepare?.(signal);
    if (prepared) update?.({ type: 'activity', entry: { id: 'prepared', kind: 'notice', ...prepared } });
    const cwd = place?.cwd ?? (await mkdtemp(join(this.cwd, 'turn-')));
    try {
      signal?.throwIfAborted();
      return await this.run(
        processor,
        {
          cwd,
          prompt,
          systemPrompt: '',
          model: model ?? '',
          ...(effort === undefined ? {} : { effort }),
          sessionId: place?.sessionId ?? newId(),
          resume: Boolean(place?.resume && place.sessionId),
          mcpServers: place?.mcpServers ?? [],
          ...(place?.readable ? { readable: place.readable } : {}),
          purpose: 'work',
          timeoutMs: NO_TIME_LIMIT,
        },
        { signal, update, ask, session },
      );
    } finally {
      if (!place)
        await rm(cwd, { recursive: true, force: true, maxRetries: 2 }).catch(() =>
          console.warn('Could not remove a harness scratch folder.'),
        );
    }
  }

  private async run({ name, runtime }: LocalProcessor, spec: RunSpec, { signal, update, ask, session }: ProcessorRun) {
    const report = update ? harnessActivity(name, spec.cwd, update) : undefined;
    let sessionId = spec.resume ? spec.sessionId : undefined;
    // A call to one of the turn's MCP servers, by its call: a request about it names that server and tool.
    const servers = new Map<string, { server: string; tool: string }>();
    const progress = (event: RunProgress) => {
      if (event.type === 'session') {
        sessionId = event.sessionId;
        session?.(event.sessionId);
      }
      if (event.type === 'tool' && event.call && event.mcp) servers.set(event.call, event.mcp);
      report?.(event);
    };
    const handle = runtime.run(
      {
        ...spec,
        ...(ask
          ? {
              ask: (question: AgentAsk, withdrawn: AbortSignal) =>
                ask(question, withdrawn, { folder: spec.cwd, harness: name, mcp: servers.get(question.call) }),
            }
          : {}),
      },
      progress,
    );
    this.running.add(handle);
    const stop = () => handle.cancel();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const result = await handle.done.finally(() => {
      signal?.removeEventListener('abort', stop);
      report?.flush();
    });
    void Promise.resolve(handle.cleaned).finally(() => this.running.delete(handle));
    signal?.throwIfAborted();
    result.permissionDenials.slice(0, 40).forEach((detail, index) =>
      update?.({
        type: 'activity',
        entry: { id: 'denied:' + index, kind: 'notice', title: 'Permission denied', detail },
      }),
    );
    const task = sessionId ?? spec.sessionId;
    if (result.cancelled) return { task, name, stopReason: 'cancelled', sessionId };
    if (!result.ok) {
      this.checked = undefined;
      if (result.ended) throw new TurnEndedError(name, result.ended);
      throw new ZirbelError(502, result.error || name + ' could not complete the turn.');
    }
    const { input, output, cacheRead, cacheWrite5m, cacheWrite1h } = result.usage;
    const totalTokens = input + output + cacheRead + cacheWrite5m + cacheWrite1h;
    return {
      task,
      name,
      stopReason: 'end_turn',
      text: result.text,
      usage: totalTokens ? { totalTokens } : undefined,
      sessionId,
    };
  }

  async removeSession(id: string, session: { cwd: string; sessionId: string }) {
    await this.get(id).runtime.removeSession?.(session);
  }

  async close() {
    const runs = [...this.running];
    for (const run of runs) run.cancel();
    await Promise.allSettled(runs.map((run) => run.cleaned ?? run.done));
  }

  /** elsewhere: the person's browser is on another device, as on a box's paired device, so a harness that would wait on
   *  this computer's own browser signs in with a page and a one-time code instead. */
  async beginSignIn(id: string, { elsewhere = false }: { elsewhere?: boolean } = {}) {
    const { name, runtime } = this.get(id);
    const current = this.signIns.get(id);
    if (current?.state.status === 'pending') return current.state;
    const processor = (await this.list()).find((choice) => choice.id === id);
    if (processor?.ready) return { status: 'complete' } as const;
    if (!processor?.signIn) throw new ZirbelError(409, name + ' is unavailable.');
    const pending = this.signIns.get(id);
    if (pending?.state.status === 'pending') return pending.state;
    const login = runtime.login({ elsewhere });
    if ('error' in login) throw new ZirbelError(502, 'Could not start sign-in for ' + name + '.');
    const session: ActiveSignIn = { login, state: { status: 'pending' } };
    this.signIns.set(id, session);
    void login.url
      .then((address) => {
        const url = address && URL.parse(address);
        if (session.state.status === 'pending' && url && url.protocol === 'https:' && !url.username && !url.password)
          session.state = { ...session.state, url: url.href };
      })
      .catch(() => {
        /* The harness may use a code-only sign-in. */
      });
    // The one-time code to enter on that page, for a sign-in from another device that shows one.
    void login.userCode
      ?.then((code) => {
        if (session.state.status === 'pending' && code && /^[A-Z0-9-]{4,32}$/i.test(code))
          session.state = { ...session.state, userCode: code };
      })
      .catch(() => {
        /* It ended without one; done says how. */
      });
    void login.done.then(
      ({ ok, error }) => {
        // Why it didn't complete, as the sign-in says it: the harness's words, or the library's when it ended it.
        const reason =
          !ok && error
            ? error
                .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
                .trim()
                .slice(0, 300)
            : '';
        session.state = ok ? { status: 'complete' } : { status: 'failed', ...(reason ? { error: reason } : {}) };
        this.checked = undefined;
      },
      () => {
        session.state = { status: 'failed' };
        this.checked = undefined;
      },
    );
    return session.state;
  }

  signInStatus(id: string) {
    const session = this.signIns.get(id);
    if (!session) throw new ZirbelError(404, 'No sign-in was started.');
    return session.state;
  }

  submitSignInCode(id: string, code: string) {
    const session = this.signIns.get(id);
    if (!session || session.state.status !== 'pending') throw new ZirbelError(409, 'Start a new sign-in first.');
    session.login.sendCode(code);
    return session.state;
  }

  private get(id: string) {
    const choice = this.processors.find((processor) => processor.id === id);
    if (!choice) throw new ZirbelError(404, 'That harness is unavailable.');
    return choice;
  }
}
