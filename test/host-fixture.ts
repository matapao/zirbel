// For the contract tests that run a host with --host-only: releases of each kind of game to import, and the host
// started with them (its player address and the rooms it opened), or run until it exits.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { importGameFolder } from '../packages/core/game-files.ts';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import type { Release } from '../packages/sdk/contracts.ts';
import { launch, legacyProject, rights, tempDir } from './helpers.ts';

// A built game: a document, a module script, models beside it, and its TypeScript source.
export const builtFiles = {
  'index.html': '<!doctype html><script type="module" src="./assets/main.js"></script>',
  'assets/main.js': 'fetch("./models/hero.glb")',
  'models/hero.glb': Buffer.from([103, 108, 84, 70, 2, 0, 0, 0]),
  'models/hero.obj': 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
  'src/main.ts': 'export const speed: number = 2;',
};

export function fixtures(t: TestContext) {
  const root = tempDir(t, 'zirbel-contract-');
  const projects = new Projects(join(root, 'source'));
  const releases = new Releases(projects, 'dist/web');
  const write = (name: string, release: Release) => {
    const file = join(root, name + '.json');
    writeFileSync(file, JSON.stringify(release));
    return { file, id: release.manifest.releaseId, release };
  };
  const shared = projects.createGame('Shared', { html: '<!doctype html><canvas></canvas>', maxPlayers: 2 });
  return {
    root,
    shared: write('shared', releases.package(shared.id, 'main', rights, false)),
    tiles: write('tiles', releases.package(legacyProject(projects, 'tessellate').id, 'main', rights, false)),
    moss: write('moss', releases.package(legacyProject(projects, 'mosslight').id, 'main', rights, false)),
    built: write('built', releases.package(importGameFolder(projects, { title: 'Built', files: Object.fromEntries(
      Object.entries(builtFiles).map(([path, data]) => [path, Buffer.from(data).toString('base64')])) }).id, 'main', rights, false)),
  };
}

type Started = { process: ChildProcessWithoutNullStreams; player: string; rooms: { id: string; link: string; manifest: { releaseId: string } }[] };

// The host prints one line per room it opens, then the line naming its player address.
export async function startHost(t: TestContext, command: string[], args: string[]): Promise<Started> {
  const rooms: Started['rooms'] = [];
  const { child, ready } = launch(t, command, ['--host-only', '--player-port', '0', ...args], (line) => {
    if (typeof line.player === 'string') return line.player;
    rooms.push(line as unknown as Started['rooms'][number]);
    return undefined;
  });
  return { process: child, player: await ready, rooms };
}

export function exitOf(command: string[], args: string[]) {
  const child = spawn(command[0]!, [...command.slice(1), '--host-only', '--player-port', '0', ...args]);
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
  return new Promise<{ code: number | null; errors: string }>((resolve) => child.once('exit', (code) => resolve({ code, errors })));
}
