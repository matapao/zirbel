import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/web', { recursive: true });
await cp('public', 'dist/web', { recursive: true });
await Promise.all([
  cp('node_modules/three/LICENSE', 'dist/web/three-license.txt'),
  cp('node_modules/zod/LICENSE', 'dist/web/zod-license.txt'),
]);

await Promise.all([
  build({
    entryPoints: ['packages/web/game-sdk.ts'], outfile: 'dist/web/game-sdk.js',
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
  }),
  build({
    entryPoints: ['node_modules/three/build/three.module.js'], outfile: 'dist/web/three.module.js',
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true, legalComments: 'inline',
  }),
  // server.mjs is a small launcher. `--host-only` loads only the player chunk,
  // not the editor's harness and MCP code. Chunks stay beside it in dist/
  // because the code resolves ./web/ relative to its own file.
  build({
    entryPoints: { server: 'packages/server/cli.ts' },
    bundle: true, splitting: true, platform: 'node', target: 'node24', format: 'esm',
    outdir: 'dist', outExtension: { '.js': '.mjs' }, chunkNames: 'server-[name]-[hash]',
    banner: { js: "import { createRequire as __zirbelCreateRequire } from 'node:module'; const require = __zirbelCreateRequire(import.meta.url);" },
  }),
  // The player runtime ships inside every release and on the LAN listener, so
  // build it apart from the editor: editor-only code never lands in chunks/.
  build({
    entryPoints: { player: 'packages/web/player.ts', 'garden-3d': 'packages/web/garden-3d.ts' },
    bundle: true, splitting: true, platform: 'browser', target: 'es2022', format: 'esm',
    outdir: 'dist/web', entryNames: '[name]', chunkNames: 'chunks/[name]-[hash]',
    minify: true, legalComments: 'linked',
  }),
  build({
    entryPoints: { workspace: 'packages/web/workspace.ts' },
    bundle: true, splitting: true, platform: 'browser', target: 'es2022', format: 'esm',
    outdir: 'dist/web', entryNames: '[name]', chunkNames: 'editor-chunks/[name]-[hash]',
    minify: true, legalComments: 'linked',
  }),
]);
