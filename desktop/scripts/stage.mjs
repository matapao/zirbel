// The editor as the packed app carries it (Contents/Resources/editor): the repository's built dist/, and beside it the
// packages the server still loads from node_modules at runtime. Everything else dist/server.mjs imports is bundled into
// it; the agent SDKs stay out of dist/ (scripts/build.mjs), and the harnesses run the person's own Claude Code and
// Codex through them. Those packages are installed from the repository's lockfile, with its supply-chain settings, for
// the target platform only, without install scripts, and then cut down to what RUNTIME needs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The packages the server resolves at runtime that go in the app: the Codex SDK, and TypeScript and esbuild with
 *  their platform binaries, which a harness turn's node_modules links to (turn-tools.ts). Anthropic's Agent SDK does
 *  not: it is under Anthropic's terms and goes in no image or release (scripts/check-security.mjs). The packed app
 *  fetches it the first time a Claude Code turn starts (packages/server/claude-sdk.ts). */
const RUNTIME = ['@openai/codex-sdk', 'typescript', 'esbuild'];

/** The folder of a package as Node finds it from `from`: in node_modules beside `from`, then in each folder above, up
 *  to the install's own node_modules. */
function resolvePackage(name, from, top) {
  for (let dir = from; dir.startsWith(top); dir = path.dirname(dir)) {
    if (path.basename(dir) === 'node_modules') continue;
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/** Every package folder RUNTIME reaches through dependencies, optional dependencies and peer dependencies present. */
function reachable(top) {
  const kept = new Set();
  const visit = (name, from, required) => {
    const found = resolvePackage(name, from, top);
    if (!found) {
      if (required) throw new Error(`${name} is not installed for ${path.relative(top, from) || 'the editor'}`);
      return;
    }
    if (kept.has(found)) return;
    kept.add(found);
    const manifest = JSON.parse(fs.readFileSync(path.join(found, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, found, true);
    for (const field of ['optionalDependencies', 'peerDependencies'])
      for (const dependency of Object.keys(manifest[field] ?? {})) visit(dependency, found, false);
  };
  for (const name of RUNTIME) visit(name, top, true);
  return kept;
}

/** Removes every package folder (and link) under a node_modules that is not kept, and every .bin folder. */
function prune(modules, kept) {
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    const at = path.join(modules, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      prune(at, kept);
      if (fs.readdirSync(at).length === 0) fs.rmdirSync(at);
    } else if (entry.isSymbolicLink() || entry.name.startsWith('.') || !kept.has(at)) {
      fs.rmSync(at, { recursive: true, force: true });
    } else if (fs.existsSync(path.join(at, 'node_modules'))) {
      prune(path.join(at, 'node_modules'), kept);
    }
  }
}

export function stageEditor(editor, repo, { os, cpu }) {
  const install = path.join(path.dirname(editor), 'install');
  fs.mkdirSync(install, { recursive: true });
  for (const file of ['package.json', 'pnpm-lock.yaml'])
    fs.copyFileSync(path.join(repo, file), path.join(install, file));
  // The patches pnpm-workspace.yaml names (patchedDependencies), which the install applies.
  fs.cpSync(path.join(repo, 'patches'), path.join(install, 'patches'), { recursive: true });
  const settings = fs.readFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'utf8');
  fs.writeFileSync(
    path.join(install, 'pnpm-workspace.yaml'),
    `${settings}\nnodeLinker: hoisted\nsupportedArchitectures:\n  os: [${os}]\n  cpu: [${cpu}]\n`,
  );
  // The link: dependencies are bundled into dist/; their links here point nowhere and are pruned below.
  execFileSync('pnpm', ['install', '--prod', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'], {
    cwd: install,
    stdio: 'inherit',
  });
  const modules = path.join(install, 'node_modules');
  prune(modules, reachable(install));

  fs.cpSync(path.join(repo, 'dist'), editor, {
    recursive: true,
    filter: (source) => path.basename(source) !== '.DS_Store',
  });
  fs.renameSync(modules, path.join(editor, 'node_modules'));
  fs.rmSync(install, { recursive: true, force: true });
}
