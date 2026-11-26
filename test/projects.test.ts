import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { legacyScene } from '../packages/sdk/contracts.ts';
import { boundedJson, MAX_REGISTERED_OBJECTS, objectRegistry } from '../packages/sdk/game.ts';
import { head, Projects } from '../packages/core/projects.ts';
import { Rooms } from '../packages/core/rooms.ts';
import { Mcp } from '../packages/server/mcp.ts';
import { rights, legacyProject, install, joinRoom } from './helpers.ts';

test('staged edits stay out of exports, stale siblings cannot apply, restore survives restart', (t) => {
  const { projects, root } = install(t);
  const project = legacyProject(projects, 'mosslight');
  const original = head(project, 'main');
  const next = projects.submit(project.id, { branch: 'main', baseRevision: original.id, label: 'Move campfire',
    operations: [{ op: 'update', id: 'campfire', changes: { x: 450 } }] });
  const sibling = projects.submit(project.id, { branch: 'main', baseRevision: original.id, label: 'Enlarge campfire',
    operations: [{ op: 'update', id: 'campfire', changes: { size: 45 } }] });
  assert.equal(legacyScene(next.preview).objects.find((item) => item.id === 'campfire')?.x, 450);
  assert.equal(projects.export(project.id).project.revisions.length, 1);
  const accepted = projects.commit(project.id, next.proposal.id);
  assert.throws(() => projects.commit(project.id, sibling.proposal.id), /branch has changed/);
  const restored = projects.restore(project.id, 'main', accepted.revision.id, original.id);
  const afterRestart = head(new Projects(root).read(project.id), 'main');
  assert.notEqual(afterRestart.id, original.id);
  assert.equal(afterRestart.restoredFrom, original.id);
  assert.deepEqual(afterRestart.scene, original.scene);
  assert.deepEqual(head(restored, 'main'), afterRestart);
});

test('an asset without delivery rights can stay local and blocks a share or export', (t) => {
  const { projects, releases } = install(t);
  const project = legacyProject(projects, 'mosslight');
  const current = head(project, 'main');
  const file = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
  const asset = { id: 'draft', name: 'Draft texture', author: 'Example artist', source: 'https://example.org/texture',
    license: 'local-only', credit: 'Example artist', media: 'image/png', hash: projects.storeAsset(file) };
  const { proposal } = projects.submit(project.id, { branch: 'main', baseRevision: current.id, label: 'Use a local asset',
    operations: [{ op: 'addAsset', asset }] });
  projects.commit(project.id, proposal.id);
  assert.doesNotThrow(() => releases.package(project.id, 'main', rights, false, true));
  assert.throws(() => releases.package(project.id, 'main', rights, true), /delivery rights.*Draft texture/);
  assert.throws(() => projects.export(project.id), /delivery rights/);
  const remove = projects.submit(project.id, { branch: 'main', baseRevision: head(projects.read(project.id), 'main').id,
    label: 'Remove the draft', operations: [{ op: 'removeAsset', id: 'draft' }] });
  projects.commit(project.id, remove.proposal.id);
  assert.doesNotThrow(() => releases.package(project.id, 'main', rights, true));
});

test('scene projects export and the complex 3D quest gates each encounter and completes', async (t) => {
  const { createQuest } = await import('../packages/games/quest.ts');
  const { projects, releases } = install(t);
  for (const name of ['firefly-fen', 'hollow-crown']) {
    const file = new URL('fixtures/' + name + '.zirbel-project.json', import.meta.url);
    const project = projects.import(JSON.parse(readFileSync(file, 'utf8')));
    const imported = projects.import(projects.export(project.id));
    const release = releases.package(imported.id, 'main', rights, false, true);
    assert.equal(release.manifest.title, project.title);
    assert.deepEqual(release.scene, head(project, 'main').scene);
    if (name !== 'hollow-crown') continue;
    const quest = createQuest(legacyScene(release));
    const travel = (id: string) => {
      const destination = legacyScene(release).objects.find((object) => object.id === id);
      assert.ok(destination);
      for (let i = 0; i < 200 && Math.hypot(quest.state.x - destination.x, quest.state.y - destination.y) >= 8; i++) {
        quest.move(destination.x - quest.state.x, destination.y - quest.state.y, .05);
      }
      assert.ok(Math.hypot(quest.state.x - destination.x, quest.state.y - destination.y) < 8);
    };
    travel('crown-guard');
    quest.interact();
    assert.match(quest.state.message, /Resolve Basalt Ember/);
    for (const [guardian, relic] of [['meadow-guard','seed'], ['ridge-guard','ember'], ['crown-guard','crown']] as const) {
      travel(guardian);
      quest.interact();
      assert.equal(quest.state.fighting, true);
      for (let hit = 0; hit < 4 && quest.state.fighting; hit++) quest.battle('attack');
      assert.ok(quest.state.hidden.has(guardian));
      travel(relic);
      quest.interact();
      assert.ok(quest.state.hidden.has(relic));
      assert.equal(quest.state.won, false);
    }
    assert.equal(quest.state.relics, 3);
    travel('keeper');
    quest.interact();
    assert.equal(quest.state.won, true);
  }
});

test('legacy starter migration keeps projects with edits or staged work', (t) => {
  const { root, projects } = install(t);
  const orbit = legacyProject(projects, 'orbit-garden');
  const unusedOrbit = legacyProject(projects, 'orbit-garden');
  const mosslight = legacyProject(projects, 'mosslight');
  const staged = legacyProject(projects, 'mosslight');
  const blank = legacyProject(projects, 'blank', 'Untitled project');
  const renamed = legacyProject(projects, 'orbit-garden', 'Evening Garden');
  const note = { branch: 'main', references: [], attachments: [] };
  projects.addNote(orbit.id, { ...note, role: 'creator', text: 'simple 3D game using three.js' });
  projects.addNote(orbit.id, { ...note, role: 'assistant', text: 'Created Orbit Garden. Explore a small, floating 3D garden. Starting a local playtest. You can describe changes here or say “stop playing”.' });
  projects.addNote(renamed.id, { ...note, role: 'assistant', text: 'Created a draft of Evening Garden. Say “play it” when you want to try it.' });
  const { proposal } = projects.submit(mosslight.id, { branch: 'main', baseRevision: mosslight.branches.main,
    label: 'Move the cabin', operations: [{ op: 'update', id: 'rangers-cabin', changes: { x: 310 } }] });
  projects.commit(mosslight.id, proposal.id);
  projects.submit(staged.id, { branch: 'main', baseRevision: staged.branches.main,
    label: 'Move the cabin', operations: [{ op: 'update', id: 'rangers-cabin', changes: { x: 310 } }] });

  const intentional = legacyProject(projects, 'blank', 'Untitled project', { scene: legacyScene(head(blank, 'main')), assets: [], label: 'Created project' });
  const draft = legacyProject(projects, 'orbit-garden', 'Orbit Garden', { scene: legacyScene(head(orbit, 'main')), assets: [], label: 'Created with harness' });
  const imported = projects.import(projects.export(orbit.id));
  const olderHarnessDraft = legacyProject(projects, 'orbit-garden');
  projects.addNote(olderHarnessDraft.id, { ...note, role: 'assistant', text: 'Your draft is ready.', usage: { source: 'Codex', total: 100 } });
  const kept = [intentional, draft, imported, olderHarnessDraft, mosslight, staged].map(({ id }) => id).sort();
  const previews = [orbit, unusedOrbit, blank, renamed].map(({ id }) => id + '.json').sort();

  projects.archiveLegacyPreviews();
  const reopened = new Projects(root);
  reopened.archiveLegacyPreviews();
  assert.deepEqual(reopened.list().map(({ id }) => id).sort(), kept);
  assert.deepEqual(reopened.summaries().map(({ id }) => id).sort(), kept);
  assert.deepEqual(readdirSync(join(root, 'archived-preview-projects')).filter((file) => file.endsWith('.json')).sort(), previews);
});

test('an empty project has no engine, scene, objects, or source until the author writes it', (t) => {
  const { projects, releases } = install(t);
  const p = projects.createGame('Untitled');
  const empty = head(p, 'main');
  const saved = JSON.parse(JSON.stringify(projects.export(p.id).project));
  assert.equal(Object.hasOwn(saved, 'template'), false);
  assert.equal(Object.hasOwn(saved.revisions[0], 'scene'), false);
  assert.equal(Object.hasOwn(saved.revisions[0], 'game'), false);
  assert.throws(() => releases.package(p.id, 'main', rights, false, true), /no game source/);

  const game = { html: '<button onclick="this.textContent=17">Count</button>', maxPlayers: 3 };
  const staged = projects.submit(p.id, { branch: 'main', baseRevision: empty.id, label: 'Write counter', operations: [{ op: 'writeGame', game }] });
  const candidate = releases.package(p.id, 'main', rights, false, true, staged.proposal.id);
  assert.deepEqual(candidate.game, game);
  assert.deepEqual(releases.import(candidate).game, game);
  assert.equal(head(projects.read(p.id), 'main').game, undefined);
  projects.commit(p.id, staged.proposal.id);
  const released = releases.package(p.id, 'main', rights, true);
  assert.equal(released.manifest.simulation, 'shared-state-v1');
  const imported = projects.import(projects.export(p.id));
  const remixed = releases.remix(released.manifest.releaseId);
  for (const copy of [imported, remixed]) {
    assert.deepEqual(head(copy, 'main').game, game);
    assert.equal(copy.template, undefined);
  }
  const changed = structuredClone(released);
  changed.game!.html += '<p>changed</p>';
  assert.throws(() => releases.import(changed), /hash/);
});

test('removing a project closes its rooms and disables its grants while keeping releases', (t) => {
  const { projects, releases, root } = install(t);
  const project = projects.createGame('Archive me', { html: '<canvas></canvas>', maxPlayers: 2 });
  const mcp = new Mcp(projects, new Map());
  const grant = mcp.create({ projectId: project.id, hours: 1, write: false });
  const rooms = new Rooms();
  t.after(() => rooms.dispose());
  const release = releases.package(project.id, 'main', rights, true);
  const room = rooms.create(release, false);
  const seat = joinRoom(room, room.reserve(room.invite, 'Alex', 'player'));

  projects.remove(project.id);
  rooms.closeProject(project.id);

  assert.deepEqual(projects.summaries(), []);
  assert.throws(() => projects.read(project.id), /does not exist/);
  assert.throws(() => mcp.verify('Bearer ' + grant.token), /current project grant/);
  assert.equal(seat.messages.at(-1)?.type, 'closed');
  assert.equal(releases.read(release.manifest.releaseId).game?.html, '<canvas></canvas>');
  assert.equal(JSON.parse(readFileSync(join(root, 'removed-projects', project.id + '.json'), 'utf8')).id, project.id);
});

test('bridge JSON validation bounds sparse arrays before serialization', () => {
  assert.equal(boundedJson({ inventory: Array(100_000_000) }), false);
  assert.equal(boundedJson({ inventory: [null, 'torch'] }), true);
  // Nested holes used to pass the length check and cost one stringify each.
  assert.equal(boundedJson(Array.from({ length: 120 }, () => Array(120))), false);
  assert.equal(boundedJson([1, , 3]), false); // oxlint-disable-line no-sparse-arrays
  assert.equal(objectRegistry.safeParse(Array(MAX_REGISTERED_OBJECTS + 1)).success, false);
  const item = { id: 'lantern', properties: { lit: true } };
  assert.equal(objectRegistry.safeParse([item]).success, true);
  assert.equal(objectRegistry.safeParse([item, item]).success, false);
});

test('project and release packaging refuse files above the shared import limit', (t) => {
  const { projects, releases } = install(t);
  const bytes = Buffer.alloc(4_500_000);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  const assets = Array.from({ length: 8 }, (_, index) => {
    bytes[8] = index;
    return { id: 'asset-' + index, hash: projects.storeAsset(bytes), media: 'image/png' as const,
      name: 'Test image ' + index, license: 'CC0-1.0' as const, author: 'Test', credit: '', source: 'https://example.org/image' };
  });
  const project = projects.createRevision('Large game', {
    game: { html: '<canvas></canvas>', maxPlayers: 1 }, label: 'Initial source', assets,
  });
  assert.throws(() => projects.export(project.id), /exceeds the 48 MB file limit/);
  assert.throws(() => releases.package(project.id, 'main', rights, true), /exceeds the 48 MB file limit/);
  assert.deepEqual(releases.list(), []);
});
