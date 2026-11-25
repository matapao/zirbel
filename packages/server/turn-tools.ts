// The packages a turn's node_modules links to, as the editor has them: three.js 0.187.0 with its addons from the
// editor's own build (<webRoot>/three), and TypeScript and esbuild at the versions the editor is built with, with their
// platform binaries, as installed beside it. The harness's sandbox reads them where they are and writes none of them:
// each is a place the turn may read (the library's `readable`), outside its folder.
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import type { ToolLink } from './turn-folder.ts';

/** A package's folder by its real path, found from `from`, or undefined where it isn't installed. */
function packageFolder(name: string, from: NodeJS.Require) {
  try { return realpathSync(dirname(from.resolve(name + '/package.json'))); } catch { return undefined; }
}

/** The node_modules folder a package is in, which holds what it resolves its own dependencies from. */
function modulesOf(folder: string) {
  const parent = dirname(folder);
  return basename(parent).startsWith('@') ? dirname(parent) : parent;
}

/** A package and its platform binary's package, each found from where the editor is installed. */
function withBinary(name: string, binary: string, from: NodeJS.Require) {
  const folder = packageFolder(name, from);
  if (!folder) return undefined;
  const native = packageFolder(binary, createRequire(join(folder, 'package.json')));
  return native ? { folder, readable: [modulesOf(folder), native] } : undefined;
}

/** The links a turn's node_modules gets, and the places outside the folder the turn may read for them. */
export function turnTools(webRoot: string, from = createRequire(import.meta.url)) {
  const links: ToolLink[] = [];
  const readable = new Set<string>();
  const three = join(webRoot, 'three');
  if (existsSync(join(three, 'package.json'))) {
    const real = realpathSync(three);
    links.push({ name: 'three', target: real });
    readable.add(real);
  }
  const platform = process.platform + '-' + process.arch;
  for (const [name, binary] of [['typescript', '@typescript/typescript-' + platform], ['esbuild', '@esbuild/' + platform]] as const) {
    const found = withBinary(name, binary, from);
    if (!found) continue;
    links.push({ name, target: found.folder });
    for (const place of found.readable) readable.add(place);
  }
  return { links, readable: [...readable] };
}
