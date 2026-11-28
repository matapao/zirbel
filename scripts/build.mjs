import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

// The agent SDKs the harness library runs its agents through stay out of dist/, installed with the editor and loaded
// from node_modules: Anthropic's is under Anthropic's terms and goes in no image or release. An editor installed
// without it (the packed desktop app) still starts, and fetches it the first time a Claude Code turn starts
// (packages/server/claude-sdk.ts): the version and hash the lockfile holds, which the build writes into dist/.
const CLAUDE_SDK = '@anthropic-ai/claude-agent-sdk';
const agentSdks = {
  name: 'agent-sdks',
  setup(sdks) {
    sdks.onResolve({ filter: /^@openai\/codex-sdk$/ }, ({ path }) => ({ path, external: true }));
    sdks.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, ({ path, namespace }) =>
      namespace === 'optional-sdk' ? { path, external: true } : { path, namespace: 'optional-sdk' },
    );
    sdks.onLoad({ filter: /.*/, namespace: 'optional-sdk' }, () => ({
      loader: 'js',
      contents: `const sdk = await import(${JSON.stringify(CLAUDE_SDK)}).catch(() => undefined);
      export function query(options) {
        const loaded = sdk ?? globalThis[Symbol.for('zirbel.claude-agent-sdk')];
        if (!loaded) throw new Error('Claude Code is unavailable in this editor.');
        return loaded.query(options);
      }`,
    }));
  },
};

/** The Claude Agent SDK's version in package.json, with the hash the lockfile holds for its tarball. */
async function claudeSdkPin() {
  const version = JSON.parse(await readFile('package.json', 'utf8')).dependencies[CLAUDE_SDK];
  const lockfile = await readFile('pnpm-lock.yaml', 'utf8');
  const entry = `\n  '${CLAUDE_SDK}@${version}':\n    resolution: {integrity: `;
  const at = lockfile.indexOf(entry);
  const integrity =
    at < 0 ? undefined : /^sha512-[A-Za-z0-9+/]{86}==(?=})/.exec(lockfile.slice(at + entry.length))?.[0];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !integrity)
    throw new Error(`pnpm-lock.yaml holds no sha512 hash for ${CLAUDE_SDK} ${version}.`);
  return { version, integrity };
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist/web', { recursive: true });
await cp('public', 'dist/web', { recursive: true });
await Promise.all([
  // Zirbel's manifest for the spaces kernel it runs: its listeners and its spaces (packages/server/spaces.ts).
  cp('skalet.json', 'dist/web/skalet.json'),
  mcpGuides('dist/web/mcp-guides'),
  cp('node_modules/three/LICENSE', 'dist/web/three-license.txt'),
  cp('node_modules/zod/LICENSE', 'dist/web/zod-license.txt'),
  threePackage('node_modules/three', 'dist/web/three'),
]);

// The guides the project MCP server gives agents (packages/server/mcp-guides.ts), which both hosts serve as these bytes:
// Zirbel's own from packages/server/guides; the multiplayer skill as it is, followed by guides/multiplayer.md, which
// says how to follow it over MCP; and guides/net-api.md, the net module's API.
async function mcpGuides(to) {
  const own = 'packages/server/guides/';
  await mkdir(to, { recursive: true });
  for (const name of ['overview', 'game-format', 'files', 'revisions', 'net-api'])
    await cp(own + name + '.md', to + '/' + name + '.md');
  const skill = await readFile('skills/zirbel-multiplayer/SKILL.md', 'utf8');
  await writeFile(to + '/multiplayer.md', skill + '\n' + (await readFile(own + 'multiplayer.md', 'utf8')));
}

// three.js as one package, from the pinned node_modules/three: its module build, and its addons with the decoders
// they load at runtime. Games load the addons from <runtime>three/addons/ (examples/jsm here); a harness turn links
// its node_modules/three to this folder, so Node and bundlers resolve `three` and `three/addons/...` to it. The
// upstream package's docs and example assets stay out.
async function threePackage(from, to) {
  const upstream = JSON.parse(await readFile(from + '/package.json', 'utf8'));
  const exports = { '.': upstream.exports['.'], './addons/*': upstream.exports['./addons/*'] };
  if (!exports['.']?.import || exports['./addons/*'] !== './examples/jsm/*')
    throw new Error('node_modules/three no longer declares the exports this package keeps.');
  const { name, version, license, type, main, module } = upstream;
  await mkdir(to + '/build', { recursive: true });
  await writeFile(
    to + '/package.json',
    JSON.stringify({ name, version, license, type, main, module, exports }, null, 2) + '\n',
  );
  await cp(from + '/LICENSE', to + '/LICENSE');
  // The entry points, and the files beside them that they import or require (three.core.js).
  const copied = new Set();
  const copy = async (file) => {
    if (copied.has(file)) return;
    copied.add(file);
    await cp(from + '/build/' + file, to + '/build/' + file);
    const source = await readFile(from + '/build/' + file, 'utf8');
    for (const [, next] of source.matchAll(/(?:\bfrom|\brequire\(|\bimport\()\s*['"]\.\/([\w.-]+\.c?js)['"]/g))
      await copy(next);
  };
  for (const entry of Object.values(exports['.'])) await copy(entry.replace(/^\.\/build\//, ''));
  await cp(from + '/examples/jsm', to + '/examples/jsm', { recursive: true, filter: (path) => !path.endsWith('.md') });
}

await Promise.all([
  build({
    entryPoints: ['packages/web/game-sdk.ts'],
    outfile: 'dist/web/game-sdk.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
  }),
  // The lobby page every player listener serves at /. It is the host's own, and is built apart from the player runtime
  // so the releases' chunks/ stay as they are.
  build({
    entryPoints: ['packages/web/lobby.ts'],
    outfile: 'dist/web/lobby.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
  }),
  // The pad page, a phone as a controller of a screen, which every player listener serves at /pad and /pad/<code>: the
  // host's own, like the lobby's.
  build({
    entryPoints: ['packages/web/pad.ts'],
    outfile: 'dist/web/pad.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
  }),
  // The TV page every player listener serves at /tv, built as the lobby's is, for browsers as old as a TV's.
  build({
    entryPoints: ['packages/web/tv.ts'],
    outfile: 'dist/web/tv.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome80',
    minify: true,
  }),
  build({
    entryPoints: ['node_modules/three/build/three.module.js'],
    outfile: 'dist/web/three.module.js',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    legalComments: 'inline',
  }),
  // server.mjs is a small launcher. `--host-only` loads only the player chunk,
  // not the editor's harness and MCP code. Chunks stay beside it in dist/
  // because the code resolves ./web/ relative to its own file.
  build({
    entryPoints: { server: 'packages/server/cli.ts' },
    bundle: true,
    splitting: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outdir: 'dist',
    outExtension: { '.js': '.mjs' },
    chunkNames: 'server-[name]-[hash]',
    plugins: [agentSdks],
    define: { ZIRBEL_CLAUDE_SDK: JSON.stringify(await claudeSdkPin()) },
    banner: {
      js: "import { createRequire as __zirbelCreateRequire } from 'node:module'; const require = __zirbelCreateRequire(import.meta.url);",
    },
  }),
  // The player runtime ships inside every release and on the LAN listener, so
  // build it apart from the editor: editor-only code never lands in chunks/.
  build({
    entryPoints: { player: 'packages/web/player.ts', 'garden-3d': 'packages/web/garden-3d.ts' },
    bundle: true,
    splitting: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    outdir: 'dist/web',
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    minify: true,
    legalComments: 'linked',
  }),
  build({
    entryPoints: { workspace: 'packages/web/workspace.ts' },
    bundle: true,
    splitting: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    outdir: 'dist/web',
    entryNames: '[name]',
    chunkNames: 'editor-chunks/[name]-[hash]',
    minify: true,
    legalComments: 'linked',
  }),
  // The editor's stylesheet: packages/web/styles/ holds it by part of the editor, and its workspace.css imports the
  // parts in cascade order. Bundled into the one dist/web/workspace.css that index.html links and both hosts serve,
  // unminified and in UTF-8 as written.
  build({
    entryPoints: ['packages/web/styles/workspace.css'],
    outfile: 'dist/web/workspace.css',
    bundle: true,
    charset: 'utf8',
  }),
]);
