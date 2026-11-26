// The security checks, the same script in each of the owner's repositories: `pnpm check:security` here, and the
// Security workflow in CI, which passes --strict. Two kinds:
// - By default, the checks that give the same answer for the same code: pinned tools and rules, read offline. These
//   gate every push and pull request.
// - With --live, also those that read the world as it is now: advisory databases, the registry, the actions' own
//   repositories, Semgrep's registry rules. Their answer changes without a change here, so they run daily and before
//   a release, and tell; they never decide a pull request.
// A check runs where its tool is installed and says so where it isn't; with --strict a missing tool fails.
// --skip=<tool,…> leaves tools out. Locally nothing about the project leaves this computer: pnpm audit, which posts every
// package name to the registry, runs in CI only, and OSV-Scanner reads a downloaded database. What each looks at:
// - the lockfile: one YAML document, every package from the registry with nothing but its hash;
// - hidden characters: format and invisible characters in tracked text files ("Trojan Source", hidden prompts);
// - licences: every package that ships with this one carries a licence on the list below;
// - Betterleaks: secrets in every commit (.gitleaks.toml, if there is one);
// - Semgrep: this repository's own rules; with --live, Semgrep's registry rules too (a `nosemgrep` line says why);
// - zizmor (offline; with --live, its audits of the actions' repositories) and actionlint: the workflows themselves;
// - with --live: pnpm audit and its signatures (CI), OSV-Scanner, and govulncheck for Go;
// - Go, Dockerfiles and shell scripts, where this repository has them.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ── This repository's part ────────────────────────────────────────────────────────────────────────────────────────
// The root module's Go checks, govulncheck among them (with --live), are scripts/check-go.mjs's (`pnpm check:go`).
const GO_MODULES = []; // folders with a go.mod
const SEMGREP_LOCAL = []; // the repository's own rules, at the code's revision: they gate ('.semgrep')
const SEMGREP_REGISTRY = ['p/default', 'p/typescript', 'p/nodejs', 'p/golang']; // Semgrep's, as they are today: --live only
const SEMGREP_OFF = []; // rule ids turned off everywhere: prefer a `nosemgrep` line with its reason
const DOCKERFILES = ['Dockerfile', 'Dockerfile.host'];
const PNPM_PROJECTS = ['.', 'desktop']; // folders with a pnpm-lock.yaml of their own
const SHELL_SCRIPTS = [];
// Licences a package that ships with this one may carry (SPDX). Development tools are not checked.
const LICENCES = ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'MPL-2.0', 'Unlicense', 'Python-2.0', 'CC-BY-4.0'];
// A package the owner chose under other terms, by name, with why: { 'name': 'reason' }.
const CLAUDE_CODE = "Anthropic's Agent SDK and its Claude Code binaries, under Anthropic's terms (SEE LICENSE IN README.md): " +
  'the Claude harness runs the person\'s own Claude Code through the SDK, installed with the editor and kept out of dist/, ' +
  'never in an image or release, and fetched on first use by an editor without it; its binaries are not installed (pnpm-workspace.yaml)';
const LICENCE_EXCEPTIONS = Object.fromEntries(['', '-darwin-arm64', '-darwin-x64', '-linux-arm64', '-linux-arm64-musl', '-linux-x64',
  '-linux-x64-musl', '-win32-arm64', '-win32-x64'].map((platform) => ['@anthropic-ai/claude-agent-sdk' + platform, CLAUDE_CODE]));
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Versions of the Go tools, run with the Go that is installed, so they always read its standard library.
const GOVULNCHECK = 'golang.org/x/vuln/cmd/govulncheck@v1.10.0';
const GOLANGCI_LINT = 'github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0';

const root = path.resolve(import.meta.dirname, '..');
const strict = process.argv.includes('--strict');
const skip = new Set(process.argv.find((a) => a.startsWith('--skip='))?.slice(7).split(',') ?? []);
const ci = !!process.env.CI;
const live = process.argv.includes('--live');

const installed = (tool) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [tool], { stdio: 'ignore' }).status === 0;
const run = (cmd, args, cwd = root) => spawnSync(cmd, args, { cwd, stdio: 'inherit' }).status === 0;
// pnpm is a .cmd on Windows, which starts only through a shell: its own script runs on this Node instead.
const pnpm = (args) => (process.env.npm_execpath ? run(process.execPath, [process.env.npm_execpath, ...args]) : run('pnpm', args));
const pnpmOut = (args) => spawnSync(process.env.npm_execpath ? process.execPath : 'pnpm', process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Characters that change what a line shows, or show nothing: every format character (bidirectional controls, zero
// widths, the tag characters a hidden message is written in) and every default-ignorable one (variation selectors,
// fillers), and the line and paragraph separators. An emoji's own presentation selector and joiner are allowed.
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u20e3\ufe0f]/u;
function emojiPart(chars, i) {
  if (chars[i] === '\ufe0f' || chars[i] === '\ufe0e') return i > 0 && EMOJI.test(chars[i - 1]);
  if (chars[i] === '\u200d') return i > 0 && i < chars.length - 1 && EMOJI.test(chars[i - 1]) && EMOJI.test(chars[i + 1]);
  return false;
}

/** Each lockfile one YAML document, each package from the registry with nothing but its hash, no other registry named,
 *  and no hidden characters in tracked text files. A lockfile written as two documents has the project's packages only
 *  in the second, and a scanner that reads the first finds none of them and says all is well. */
function sources() {
  const problems = [];
  for (const project of PNPM_PROJECTS) {
    const at = (file) => path.join(project, file);
    const lock = readFileSync(path.join(root, at('pnpm-lock.yaml')), 'utf8');
    if (lock.startsWith('---')) problems.push(`${at('pnpm-lock.yaml')} is two documents: a scanner that reads the first misses the project's packages`);
    const start = lock.indexOf('\npackages:\n');
    const end = lock.indexOf('\nsnapshots:\n');
    if (start < 0 || end < start) problems.push(`${at('pnpm-lock.yaml')} has no packages to check`);
    let entry = '';
    for (const line of lock.slice(start, end).split('\n')) {
      if (/^ {2}\S/.test(line)) entry = line.trim().replace(/:$/, '');
      else if (line.startsWith('    resolution: ') && !/^ {4}resolution: \{integrity: sha512-[A-Za-z0-9+/]+={0,2}\}$/.test(line)) problems.push(`${at('pnpm-lock.yaml')}: ${entry} comes from ${line.slice(16)}`);
    }
    for (const [file, setting] of [['.npmrc', /^\s*(@[^:]+:)?registry\s*=/m], ['pnpm-workspace.yaml', /^(registries|namedRegistries):/m]]) {
      if (existsSync(path.join(root, at(file))) && setting.test(readFileSync(path.join(root, at(file)), 'utf8'))) problems.push(`${at(file)} names another registry`);
    }
  }
  const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).stdout.split('\0');
  const text = /\.(ts|tsx|mts|cts|mjs|cjs|js|go|json|md|ya?ml|sh|css|html|toml|txt)$|Dockerfile[^/]*$/;
  for (const f of new Set(files)) {
    if (!text.test(f) || !existsSync(path.join(root, f))) continue;
    readFileSync(path.join(root, f), 'utf8').split('\n').forEach((line, i) => {
      if (!HIDDEN.test(line)) return;
      const chars = Array.from(line);
      const at = chars.findIndex((ch, j) => HIDDEN.test(ch) && !emojiPart(chars, j));
      if (at >= 0) problems.push(`${f}:${i + 1} has U+${chars[at].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    });
  }
  for (const p of problems) console.error(p);
  return problems.length === 0;
}

/** Every package that ships with this one under a licence on the list. pnpm can list them but has no way to fail. */
function licences() {
  const out = pnpmOut(['licenses', 'list', '--prod', '--json']);
  if (out.status !== 0) { console.error(out.stderr); return false; }
  const allowed = new Set(LICENCES);
  // An expression ("MIT OR Apache-2.0") is fine if one side is; "(A AND B)" needs both.
  const ok = (spdx) => spdx.replace(/[()]/g, '').split(/\s+OR\s+/).some((either) => either.split(/\s+AND\s+/).every((one) => allowed.has(one.trim())));
  const refused = Object.entries(JSON.parse(out.stdout || '{}')).flatMap(([spdx, pkgs]) =>
    ok(spdx) ? [] : pkgs.filter((p) => !Object.hasOwn(LICENCE_EXCEPTIONS, p.name)).map((p) => `${spdx}: ${p.name}@${p.versions?.join(',') ?? p.version}`));
  for (const line of refused) console.error(line);
  return refused.length === 0;
}

/** The advisories osv-scanner.toml accepts, each there with its reason and until when: pnpm audit is told the same,
 *  so one list says what is accepted and why. One whose date has passed counts again. */
function accepted() {
  const file = path.join(root, 'osv-scanner.toml');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/^\[\[IgnoredVulns\]\]/m).slice(1).flatMap((block) => {
    const id = /^\s*id\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const until = /^\s*ignoreUntil\s*=\s*(\S+)/m.exec(block)?.[1];
    return id && (!until || Date.parse(until) > Date.now()) ? [id] : [];
  });
}

function osv() {
  const config = existsSync(path.join(root, 'osv-scanner.toml')) ? ['--config=osv-scanner.toml'] : [];
  return run('osv-scanner', ['scan', 'source', ...config, ...(ci ? [] : ['--offline-vulnerabilities', '--download-offline-databases']), '-r', '.']);
}

function secrets() {
  const config = existsSync(path.join(root, '.gitleaks.toml')) ? ['--config', '.gitleaks.toml'] : [];
  if (installed('betterleaks')) return run('betterleaks', ['git', ...config, '.']);
  return run('gitleaks', ['git', '--redact', '--no-banner', '--log-level', 'warn', ...config, '.']); // here only: CI has Betterleaks
}

function semgrep(rules) {
  const args = ['scan', '--error', '--metrics=off', '--disable-version-check', ...rules.flatMap((r) => ['--config', r]), ...SEMGREP_OFF.flatMap((r) => ['--exclude-rule', r]), '.'];
  const image = process.env.SEMGREP_IMAGE; // CI runs Semgrep's image, pinned to its digest
  return image ? run('docker', ['run', '--rm', '-v', `${root}:/src`, '-w', '/src', image, 'semgrep', ...args]) : run('semgrep', args);
}

// Each check, and whether it reads the world as it is now (live) or only what is here.
const checks = [
  { name: 'lockfile sources and hidden characters', tool: 'git', run: sources },
  { name: 'licences of what ships', tool: 'pnpm', run: licences },
  { name: 'secrets in every commit', tool: ci || installed('betterleaks') ? 'betterleaks' : 'gitleaks', run: secrets },
  ...(SEMGREP_LOCAL.length ? [{ name: "Semgrep, this repository's rules", tool: process.env.SEMGREP_IMAGE ? 'docker' : 'semgrep', run: () => semgrep(SEMGREP_LOCAL) }] : []),
  { name: 'zizmor', tool: 'zizmor', run: () => run('zizmor', ['--offline', '--min-severity', 'low', '.']) },
  { name: 'actionlint', tool: 'actionlint', run: () => run('actionlint', []) },
  ...GO_MODULES.flatMap((dir) => [
    { name: `go mod verify and tidy (${dir})`, tool: 'go', run: () => run('go', ['mod', 'verify'], path.join(root, dir)) && run('go', ['mod', 'tidy', '-diff'], path.join(root, dir)) },
    { name: `golangci-lint (${dir})`, tool: 'go', run: () => run('go', ['run', GOLANGCI_LINT, 'run'], path.join(root, dir)) },
    { live: true, name: `govulncheck (${dir})`, tool: 'go', run: () => run('go', ['run', GOVULNCHECK, './...'], path.join(root, dir)) },
  ]),
  ...(DOCKERFILES.length ? [{ name: 'hadolint', tool: 'hadolint', run: () => run('hadolint', DOCKERFILES) }] : []),
  ...(SHELL_SCRIPTS.length ? [
    { name: 'ShellCheck', tool: 'shellcheck', run: () => run('shellcheck', SHELL_SCRIPTS) },
    { name: 'shfmt', tool: 'shfmt', run: () => run('shfmt', ['-d', ...SHELL_SCRIPTS]) },
  ] : []),
  ...(ci ? [
    { live: true, name: 'pnpm audit (high and critical)', tool: 'pnpm', run: () => pnpm(['audit', '--audit-level', 'high', ...accepted().flatMap((id) => ['--ignore', id])]) },
    { live: true, name: 'pnpm registry signatures', tool: 'pnpm', run: () => pnpm(['audit', 'signatures']) },
  ] : []),
  { live: true, name: 'OSV-Scanner', tool: 'osv-scanner', run: osv },
  ...(SEMGREP_REGISTRY.length ? [{ live: true, name: "Semgrep, the registry's rules", tool: process.env.SEMGREP_IMAGE ? 'docker' : 'semgrep', run: () => semgrep(SEMGREP_REGISTRY) }] : []),
  // the actions' own repositories as they are now: known-vulnerable pins, impostor commits
  { live: true, name: 'zizmor, online', tool: 'zizmor', run: () => (process.env.GH_TOKEN ? run('zizmor', ['--min-severity', 'low', '.']) : (console.log('No GH_TOKEN: offline only.'), true)) },
].filter((c) => live || !c.live);

const failed = [];
const missing = [];
for (const c of checks) {
  console.log(`\n== ${c.name}`);
  if (skip.has(c.tool)) { console.log('Left out (--skip).'); missing.push(c.name); continue; }
  if (!installed(c.tool)) { console.log(`${c.tool} isn't installed here: CI runs this one.`); missing.push(c.name); continue; }
  if (!c.run()) failed.push(c.name);
}
if (!live) console.log('\nWith --live: the advisory databases, the registry and the actions as they are now (daily in CI).');
else if (!ci) console.log('\npnpm audit and its signatures run in CI only: they send every package name to the registry.');
console.log(`\n${checks.length - failed.length - missing.length} passed${failed.length ? `, failed: ${failed.join(', ')}` : ''}${missing.length ? `, not run: ${missing.join(', ')}` : ''}`);
process.exit(failed.length || (strict && missing.length) ? 1 : 0);
