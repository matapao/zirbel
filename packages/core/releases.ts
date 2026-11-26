import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION, SDK_VERSION, distribution, portableRelease, type Asset, type Manifest, type Revision, type Release } from '../sdk/contracts.ts';
import type { GameDocument } from '../sdk/game.ts';
import { templates } from '../games/templates.ts';
import { atomicWrite, deliveryAssets, digest, gameFileBytes, gameFileHashes, head, newId, readData, safeId, verifyAssetBytes, ZirbelError, type Projects } from './projects.ts';

function runtimeSettings(template: Manifest['template'], game?: Revision['game']) {
  if (game) return { simulation: game.net ? 'net-v2' as const : game.maxPlayers > 1 ? 'shared-state-v1' as const : null,
    max: game.maxPlayers, capabilities: game.net || game.maxPlayers > 1 ? ['multiplayer' as const] : [] };
  if (template) return templates[template];
  throw new ZirbelError(422, 'This project has no game source yet.');
}

export class Releases {
  readonly runtime: ReadonlyMap<string, Buffer>;
  readonly fileHashes: Manifest['files'];
  private readonly files: Release['files'];

  // webRoot is the build the runtime comes from (dist/web), which the player listeners also serve from.
  constructor(private projects: Projects, readonly webRoot: string) {
    const files = ['player.html', 'player.js', 'garden-3d.js', 'garden-3d.js.LEGAL.txt', 'player.css',
      'game-sdk.js', 'three.module.js', 'three-license.txt', 'zod-license.txt',
      ...readdirSync(join(webRoot, 'chunks')).map((file) => 'chunks/' + file)];
    this.runtime = new Map(files.map((file) => [file, readFileSync(join(webRoot, file))]));
    this.fileHashes = Object.freeze(Object.fromEntries([...this.runtime].map(([file, bytes]) => [file, digest(bytes)])));
    this.files = Object.freeze(Object.fromEntries([...this.runtime].map(([name, bytes]) => [name, bytes.toString('base64')])));
  }

  private path(releaseId: string) { return join(this.projects.root, 'releases', safeId(releaseId) + '.json'); }

  private save(release: Release) {
    const path = this.path(release.manifest.releaseId);
    try {
      const existing = this.read(release.manifest.releaseId);
      if (JSON.stringify(existing) !== JSON.stringify(release))
        throw new ZirbelError(409, 'That release ID already identifies a different package.');
      return existing;
    } catch (error) {
      if (!(error instanceof ZirbelError) || error.status !== 404) throw error;
    }
    atomicWrite(path, JSON.stringify(release));
    return release;
  }

  package(projectId: string, branch: string, rawPermissions: unknown, publish: boolean, draft = false, proposalId?: string) {
    if (publish && draft) throw new ZirbelError(400, 'A draft playtest is private to this host.');
    const project = this.projects.read(projectId);
    const base = head(project, branch);
    const staged = proposalId ? this.projects.preview(projectId, proposalId) : undefined;
    if (staged && (!draft || staged.proposal.branch !== branch))
      throw new ZirbelError(409, 'This proposal cannot be played on that branch.');
    const revision = staged ? { ...base, ...staged.preview } : base;
    const permissions = distribution.parse(rawPermissions);
    const template = runtimeSettings(project.template, revision.game);
    const manifest: Manifest = {
      format: 1, releaseId: newId(), gameId: project.id, sourceRevision: revision.id,
      title: project.title, template: project.template,
      sdk: SDK_VERSION, protocol: PROTOCOL_VERSION, client: 'player.html', simulation: template.simulation,
      players: { min: 1, max: template.max },
      capabilities: [...template.capabilities],
      permissions, assets: revision.assets, credits: [
        { name: project.title, credit: 'Project creator', license: 'Original project content' },
        { name: 'Three.js', credit: 'Three.js authors', license: 'MIT' },
        { name: 'Zod', credit: 'Zod authors', license: 'MIT' },
        ...revision.assets.map((asset) => ({
          name: asset.name, credit: asset.author + ' · ' + asset.credit + ' · ' + asset.source, license: asset.license,
        })),
      ], files: this.fileHashes,
    };
    const release = this.projects.withAssetFiles({
      manifest, game: revision.game, scene: revision.scene, sceneHash: digest(JSON.stringify(revision.game ?? revision.scene)), files: this.files,
    }, draft ? revision.assets : deliveryAssets([revision]), gameFileHashes([revision]));
    return publish ? this.save(release) : release;
  }

  /** A release of a game that no revision holds yet, for one solo room on this host: a harness turn's game/ as it is,
   *  its files and assets as bytes by their hashes. It is never saved, shared or downloaded. */
  draft(title: string, game: GameDocument, assets: Asset[], bytes: ReadonlyMap<string, Buffer>): Release {
    const template = runtimeSettings(undefined, game);
    const manifest: Manifest = {
      format: 1, releaseId: newId(), gameId: newId(), sourceRevision: newId(), title,
      sdk: SDK_VERSION, protocol: PROTOCOL_VERSION, client: 'player.html', simulation: template.simulation,
      players: { min: 1, max: template.max }, capabilities: [...template.capabilities],
      permissions: { play: true, download: false, remix: false }, assets, credits: [], files: this.fileHashes,
    };
    return { manifest, game, sceneHash: digest(JSON.stringify(game)), files: this.files,
      assets: Object.fromEntries([...bytes].map(([hash, file]) => [hash, file.toString('base64')])) };
  }

  read(releaseId: string) {
    const release = portableRelease.parse(readData(this.path(releaseId)));
    if (release.manifest.releaseId !== releaseId) throw new ZirbelError(422, 'The stored release ID does not match its filename.');
    return release;
  }

  list() {
    return readdirSync(join(this.projects.root, 'releases')).filter((file) => file.endsWith('.json'))
      .map((file) => this.read(file.slice(0, -5)).manifest);
  }

  import(raw: unknown) {
    const release = portableRelease.parse(raw);
    const { manifest } = release;
    if (!release.game && !release.scene) throw new ZirbelError(422, 'The release has no playable content.');
    const template = runtimeSettings(manifest.template, release.game);
    if (manifest.simulation !== template.simulation || manifest.players.max !== template.max ||
      manifest.players.min !== 1 || manifest.capabilities.join() !== template.capabilities.join())
      throw new ZirbelError(422, 'The package declares unsupported game capabilities.');
    if (digest(JSON.stringify(release.game ?? release.scene)) !== release.sceneHash) throw new ZirbelError(422, 'The game content hash does not match.');
    const files = Object.keys(this.fileHashes);
    if (Object.keys(release.files).length !== files.length || Object.keys(manifest.files).length !== files.length)
      throw new ZirbelError(422, 'The package has unsupported runtime files.');
    for (const file of files) {
      const data = release.files[file];
      if (typeof data !== 'string' || manifest.files[file] !== this.fileHashes[file] ||
        digest(Buffer.from(data, 'base64')) !== this.fileHashes[file])
        throw new ZirbelError(422, 'This package requires a verified build of the matching Zirbel runtime.');
    }
    const assets = deliveryAssets([manifest]);
    const gameFiles = gameFileHashes([release]);
    if (Object.keys(release.assets).length !== new Set([...assets.map(({ hash }) => hash), ...gameFiles]).size)
      throw new ZirbelError(422, 'The package has undeclared assets.');
    for (const asset of assets) {
      const data = release.assets[asset.hash];
      if (typeof data !== 'string') throw new ZirbelError(422, 'An asset file is missing.');
      verifyAssetBytes(asset, Buffer.from(data, 'base64'));
    }
    for (const hash of gameFiles) gameFileBytes(hash, release.assets[hash]);
    return this.save(release);
  }

  remix(releaseId: string) {
    const release = this.read(releaseId);
    if (!release.manifest.permissions.remix) throw new ZirbelError(403, 'The creator has disabled remixing.');
    for (const asset of deliveryAssets([release.manifest])) {
      const bytes = Buffer.from(release.assets[asset.hash] ?? '', 'base64');
      verifyAssetBytes(asset, bytes);
      this.projects.storeAsset(bytes);
    }
    for (const hash of gameFileHashes([release])) this.projects.storeAsset(gameFileBytes(hash, release.assets[hash]));
    return this.projects.createRevision((release.manifest.title + ' remix').slice(0, 80), {
      label: 'Remixed release', template: release.manifest.template,
      game: release.game, scene: release.scene, assets: release.manifest.assets, upstream: releaseId,
    });
  }
}
