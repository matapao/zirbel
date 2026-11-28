// For the lobby contract: releases to offer (of a two-player game twice, a one-player game, the tile game and one that
// may not be played) and the editor started with them, with its player listener.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Projects } from '../packages/core/projects.ts';
import { Releases } from '../packages/core/releases.ts';
import type { Release } from '../packages/sdk/contracts.ts';
import { launch, legacyProject, rights, tempDir } from './helpers.ts';

export function fixtures(t: TestContext) {
  const root = tempDir(t, 'zirbel-lobby-');
  const projects = new Projects(join(root, 'source'));
  const releases = new Releases(projects, 'dist/web');
  const write = (name: string, release: Release) => {
    const file = join(root, name + '.json');
    writeFileSync(file, JSON.stringify(release));
    return { file, id: release.manifest.releaseId };
  };
  const game = (title: string, maxPlayers: number) =>
    projects.createGame(title, { html: '<!doctype html><canvas></canvas>', maxPlayers }).id;
  const shared = game('Shared', 2);
  const fixture = {
    data: join(root, 'data'),
    shared: write('shared', releases.package(shared, 'main', rights, false)),
    again: write('again', releases.package(shared, 'main', rights, false)),
    alone: write('alone', releases.package(game('Alone', 1), 'main', rights, false)),
    tiles: write('tiles', releases.package(legacyProject(projects, 'tessellate').id, 'main', rights, false)),
    closed: write('closed', releases.package(game('Closed', 2), 'main', { ...rights, play: false }, false)),
  };
  return {
    ...fixture,
    imports: [fixture.shared, fixture.again, fixture.alone, fixture.tiles, fixture.closed].flatMap(({ file }) => [
      '--import',
      file,
    ]),
  };
}

export async function startEditor(t: TestContext, command: string[], data: string, imports: string[]) {
  return launch(t, command, ['--data', data, '--port', '0', '--player-port', '0', ...imports], (line) =>
    typeof line.editor === 'string' && typeof line.player === 'string'
      ? { editor: line.editor, player: line.player }
      : undefined,
  ).ready;
}
