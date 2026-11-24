import { AgentRuntime, claudeAgent, codexAgent, findProgram, type AgentLogin, type Host, type RunProgress, type RunSpec, type Runtime, type SessionConfigOption } from 'celler/harness';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, chmodSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { newId, ZirbelError } from '../core/projects.ts';
import { modelChoices, type ModelSettings } from '../sdk/model-settings.ts';
import { harnessActivity } from './harness-activity.ts';
import type { Processor, ProcessorRun, Processors, SignInStatus } from './processors.ts';

const TURN_TIMEOUT = 60 * 60 * 1000;
const SETTINGS_TIMEOUT = 15_000;
const SETTINGS_CACHE_MS = 5 * 60 * 1000;

function modelSettings(options: SessionConfigOption[]): ModelSettings {
  const settings: ModelSettings = {};
  for (const option of options) {
    if (option.type !== 'select') continue;
    const key = option.category === 'model' ? 'model' : option.category === 'thought_level' ? 'effort' : undefined;
    if (!key) continue;
    const { name, description, currentValue } = option;
    settings[key] = { name, description, currentValue, options: option.options.map((choice) => 'group' in choice
      ? { group: choice.group, name: choice.name, options: choice.options.map(({ value, name, description }) => ({ value, name, description })) }
      : { value: choice.value, name: choice.name, description: choice.description }) };
  }
  return settings;
}

const packages = {
  codex: '@agentclientprotocol/codex-acp',
  claude: '@agentclientprotocol/claude-agent-acp',
};

const fromZirbel = createRequire(import.meta.url);

function manifest(name: string, from = fromZirbel) {
  try { return from.resolve(name + '/package.json'); } catch { return undefined; }
}

function adapter(manifestPath?: string) {
  if (!manifestPath) return;
  const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: string | Record<string, string> };
  const entry = typeof bin === 'string' ? bin : Object.values(bin ?? {})[0];
  return entry && join(dirname(manifestPath), entry);
}

function bundledProgram(harness: keyof typeof packages, packagePath?: string) {
  if (!packagePath) return null;
  const name = harness === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-agent-sdk';
  const from = createRequire(packagePath);
  let sdk;
  try { sdk = manifest(name, from) ?? from.resolve(name); } catch { return null; }
  const native = manifest(name + '-' + process.platform + '-' + process.arch, createRequire(sdk));
  if (!native) return null;
  const executable = harness + (process.platform === 'win32' ? '.exe' : '');
  if (harness === 'claude') {
    const file = join(dirname(native), executable);
    return existsSync(file) ? file : null;
  }
  const vendor = join(dirname(native), 'vendor');
  for (const triple of existsSync(vendor) ? readdirSync(vendor) : []) {
    const file = join(vendor, triple, 'bin', executable);
    if (existsSync(file)) return file;
  }
  return null;
}

function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077))))
    throw new Error('Zirbel account storage must be a private directory owned by this user.');
}

function accountDirectory() {
  const home = homedir();
  const config = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') :
    process.platform === 'win32' ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local') :
    process.env.XDG_CONFIG_HOME || join(home, '.config');
  const directory = process.env.ZIRBEL_ACCOUNT_DIR || join(config, 'Zirbel');
  if (!isAbsolute(directory)) throw new Error('Zirbel account storage requires an absolute path.');
  return directory;
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

type LocalProcessor = Pick<Processor, 'id' | 'name'> & { runtime: Runtime & Pick<AgentRuntime, 'login'> };
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
  const host: Host = { client: { name: 'zirbel', title: 'Zirbel', version: '0.1.0' }, data, mark: (env) => env };
  const codex = manifest(packages.codex);
  const claude = manifest(packages.claude);
  return new LocalHarnesses(turns, [
    { id: 'codex', name: 'Codex', runtime: new AgentRuntime(codexAgent({
      adapter: adapter(codex), codex: () => bundledProgram('codex', codex) ?? findProgram('codex'),
      home: codexHome, profile: 'zirbel',
      words: { install: 'The Codex harness is unavailable.', login: 'Sign in to Codex to continue.',
        signedOut: 'Sign-in required.', untrusted: 'Codex could not use this workspace.' },
    }), host) },
    { id: 'claude', name: 'Claude Code', runtime: new AgentRuntime(claudeAgent({
      adapter: adapter(claude), claude: () => findProgram('claude') ?? bundledProgram('claude', claude),
      words: { noAdapter: 'The Claude Code adapter is unavailable.', noClaude: 'Claude Code is unavailable.', login: 'Sign in to Claude Code to continue.' },
    }), host) },
  ]);
}

export class LocalHarnesses implements Processors {
  private readonly signIns = new Map<string, ActiveSignIn>();
  private checking?: Promise<Processor[]>;
  private checked?: { at: number; processors: Processor[] };
  private readonly knownSettings = new Map<string, { at: number; value: ModelSettings }>();

  constructor(private readonly cwd: string, private readonly processors: LocalProcessor[]) {}

  async list() {
    if (this.checking) return this.checking;
    if (this.checked && Date.now() - this.checked.at < 3000) return this.checked.processors;
    this.checking = Promise.all(this.processors.map(async ({ id, name, runtime }): Promise<Processor> => {
      try {
        const health = await runtime.health(false);
        if (health.ok) return { id, name, ready: true, activity: 'zirbel', modelSettings: true };
        if (health.fix === 'login' || health.fix === 'login-codex') return { id, name, ready: false, signIn: true };
      } catch { /* One unavailable harness should leave the others usable. */ }
      return { id, name, ready: false, detail: 'Unavailable on this device' };
    }));
    try {
      const processors = await this.checking;
      this.checked = { at: Date.now(), processors };
      return processors;
    } finally { this.checking = undefined; }
  }

  private async inScratch<T>(id: string, signal: AbortSignal | undefined,
    operation: (processor: LocalProcessor, spec: RunSpec) => Promise<T>) {
    const processor = this.get(id);
    const status = (await this.list()).find((choice) => choice.id === id);
    signal?.throwIfAborted();
    if (!status?.ready) throw new ZirbelError(409, status?.signIn ? 'Sign in to ' + processor.name + ' to continue.' : processor.name + ' is unavailable.');
    const cwd = await mkdtemp(join(this.cwd, 'turn-'));
    try {
      signal?.throwIfAborted();
      return await operation(processor, { cwd, prompt: '', systemPrompt: '', model: '', sessionId: newId(),
        resume: false, mcpServers: [], purpose: 'work', trusted: true, timeoutMs: TURN_TIMEOUT });
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 2 }).catch(() => console.warn('Could not remove a harness scratch folder.'));
    }
  }

  async settings(id: string, model?: string, signal?: AbortSignal): Promise<ModelSettings> {
    signal?.throwIfAborted();
    if (model) {
      const current = await this.settings(id, undefined, signal);
      if (!modelChoices(current.model).some(({ value }) => value === model))
        throw new ZirbelError(422, 'Choose a model offered by the harness.');
      if (current.model?.currentValue === model) return current;
    }
    const key = JSON.stringify([id, model]);
    const cached = this.knownSettings.get(key);
    if (cached && Date.now() - cached.at < SETTINGS_CACHE_MS) return cached.value;

    const settings = await this.inScratch(id, signal, async ({ name, runtime }, spec) => {
      let settings: ModelSettings | undefined;
      let cancel: (() => void) | undefined;
      const handle = runtime.run({ ...spec, model: model ?? '', timeoutMs: SETTINGS_TIMEOUT }, (event) => {
        // The harness runtime publishes the configured session before sending session/prompt.
        // Cancel in that callback so the options probe never submits a prompt.
        if (event.type !== 'options' || !event.modes || settings) return;
        settings = modelSettings(event.options);
        cancel?.();
      });
      cancel = () => handle.cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      if (settings || signal?.aborted) cancel();
      const result = await handle.done.finally(() => signal?.removeEventListener('abort', cancel));
      signal?.throwIfAborted();
      if (!settings) throw new ZirbelError(502, result.error || name + ' could not report its model settings.');
      if (model && settings.model?.currentValue !== model)
        throw new ZirbelError(422, name + ' could not select that model.');
      return settings;
    });
    this.knownSettings.set(key, { at: Date.now(), value: settings });
    return settings;
  }

  async start(id: string, prompt: string, { signal, update, ask, selection }: ProcessorRun = {}) {
    const { model, effort } = selection ?? {};
    if (model || effort) {
      const settings = await this.settings(id, model, signal);
      if (effort && !modelChoices(settings.effort).some(({ value }) => value === effort))
        throw new ZirbelError(422, 'Choose a reasoning level offered for this model.');
    }
    return this.inScratch(id, signal, async ({ name, runtime }, spec) => {
      const report = update ? harnessActivity(name, spec.cwd, update) : undefined;
      let effective: ModelSettings | undefined;
      const progress = (event: RunProgress) => {
        if ((model || effort) && event.type === 'options' && event.modes) effective = modelSettings(event.options);
        report?.(event);
      };
      const place = { folder: spec.cwd, harness: name };
      const handle = runtime.run({ ...spec, prompt, model: model ?? '', effort,
        ask: ask && ((question, withdrawn) => ask(question, withdrawn, place)) }, progress);
      const stop = () => handle.cancel();
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      const result = await handle.done.finally(() => { signal?.removeEventListener('abort', stop); report?.flush(); });
      signal?.throwIfAborted();
      result.permissionDenials.slice(0, 40).forEach((detail, index) => update?.({ type: 'activity',
        entry: { id: 'denied:' + index, kind: 'notice', title: 'Permission denied', detail },
      }));
      const task = spec.sessionId;
      if (result.cancelled) return { task, name, stopReason: 'cancelled' };
      if (!result.ok) {
        this.checked = undefined;
        this.knownSettings.clear();
        throw new ZirbelError(502, result.error || name + ' could not complete the turn.');
      }
      if ((model && effective?.model?.currentValue !== model) || (effort && effective?.effort?.currentValue !== effort)) {
        this.knownSettings.clear();
        throw new ZirbelError(409, name + ' did not apply the selected model settings. Open Model settings to refresh the choices.');
      }
      const { input, output, cacheRead, cacheWrite5m, cacheWrite1h } = result.usage;
      const totalTokens = input + output + cacheRead + cacheWrite5m + cacheWrite1h;
      return { task, name, stopReason: 'end_turn', text: result.text, usage: totalTokens ? { totalTokens } : undefined };
    });
  }

  async beginSignIn(id: string) {
    const { name, runtime } = this.get(id);
    const current = this.signIns.get(id);
    if (current?.state.status === 'pending') return current.state;
    const processor = (await this.list()).find((choice) => choice.id === id);
    if (processor?.ready) return { status: 'complete' } as const;
    if (!processor?.signIn) throw new ZirbelError(409, name + ' is unavailable.');
    const pending = this.signIns.get(id);
    if (pending?.state.status === 'pending') return pending.state;
    const login = runtime.login();
    if ('error' in login) throw new ZirbelError(502, 'Could not start sign-in for ' + name + '.');
    const session: ActiveSignIn = { login, state: { status: 'pending' } };
    this.signIns.set(id, session);
    void login.url.then((address) => {
      const url = address && URL.parse(address);
      if (session.state.status === 'pending' && url && url.protocol === 'https:' && !url.username && !url.password)
        session.state = { status: 'pending', url: url.href };
    }).catch(() => { /* The adapter may use a code-only sign-in. */ });
    void login.done.then(({ ok }) => {
      session.state = { status: ok ? 'complete' : 'failed' };
      this.checked = undefined;
      this.knownSettings.clear();
    }, () => { session.state = { status: 'failed' }; this.checked = undefined; });
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
