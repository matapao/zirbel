// A project as a bundle (.zirbel-project.json): every revision in full, and the bytes of its assets and game files by
// their hashes, within the 48 MB a portable file can be. Export writes the history its branches reach; import takes a
// bundle's revisions as commits of a new project (migrate.ts). Also the delivery rights a shared asset needs.
import { PORTABLE_FILE_LIMIT, type Asset, type FullRevision, type Revision } from '../sdk/contracts.ts';
import { digest, mediaMatches } from './bytes.ts';
import { ZirbelError } from './errors.ts';
import { updateRefs, type Ident } from './git.ts';
import { revisionMeta } from './git-tree.ts';
import { logCommits } from './history.ts';
import { writeRevisions } from './migrate.ts';
import { projectBundle, type Projects } from './projects.ts';

function checkDeliveryRights(asset: Asset) {
  if (asset.license === 'unknown' || asset.license === 'local-only')
    throw new ZirbelError(422, 'Resolve the delivery rights for ' + asset.name + '.');
  if (asset.license !== 'CC0-1.0' && !asset.credit.trim())
    throw new ZirbelError(422, 'Add the required credit for ' + asset.name + '.');
  const source = new URL(asset.source);
  if (source.username || source.password)
    throw new ZirbelError(422, 'Remove account credentials from the source URL for ' + asset.name + '.');
}

// Check every revision's metadata, but process each distinct file only once.
export function deliveryAssets(revisions: ReadonlyArray<{ assets?: Asset[] }>) {
  const unique = new Map<string, Asset>();
  for (const { assets } of revisions) {
    for (const asset of assets ?? []) {
      checkDeliveryRights(asset);
      const previous = unique.get(asset.hash);
      if (previous && previous.media !== asset.media) throw new ZirbelError(422, 'Conflicting media types for ' + asset.name + '.');
      unique.set(asset.hash, asset);
    }
  }
  return [...unique.values()];
}

// Every file a built game lists, once each.
export function gameFileHashes(revisions: ReadonlyArray<Pick<Revision, 'game'>>) {
  return [...new Set(revisions.flatMap(({ game }) => Object.values(game?.files ?? {})))];
}

// A built game's file carried as base64, which must match its hash.
export function gameFileBytes(hash: string, data: unknown) {
  if (typeof data !== 'string') throw new ZirbelError(422, 'A game file is missing.');
  const bytes = Buffer.from(data, 'base64');
  if (digest(bytes) !== hash) throw new ZirbelError(422, 'A game file does not match its hash.');
  return bytes;
}

export function verifyAssetBytes(asset: Asset, bytes: Buffer) {
  if (digest(bytes) !== asset.hash || !mediaMatches(asset.media, bytes))
    throw new ZirbelError(422, 'The asset bytes do not match ' + asset.name + '.');
}

// The package's assets map carries image assets and a built game's files, each once, by hash.
export function withAssetFiles<T extends object>(read: (hash: string) => Buffer, metadata: T, assets: readonly Asset[],
  gameFiles: readonly string[] = []) {
  let remaining = PORTABLE_FILE_LIMIT - Buffer.byteLength(JSON.stringify({ ...metadata, assets: {} }));
  const files = new Map<string, string>();
  const checkSize = () => {
    if (remaining < 0) throw new ZirbelError(413, 'This package exceeds the 48 MB file limit.');
  };
  checkSize();
  for (const asset of assets) {
    const bytes = read(asset.hash);
    verifyAssetBytes(asset, bytes);
    if (files.has(asset.hash)) continue;
    // Base64 length plus the quoted key, quoted value, colon and optional comma.
    remaining -= 4 * Math.ceil(bytes.length / 3) + asset.hash.length + 5 + Number(files.size > 0);
    checkSize();
    files.set(asset.hash, bytes.toString('base64'));
  }
  for (const hash of gameFiles) {
    if (files.has(hash)) continue;
    const bytes = read(hash);
    if (digest(bytes) !== hash) throw new ZirbelError(422, 'A game file does not match its hash.');
    remaining -= 4 * Math.ceil(bytes.length / 3) + hash.length + 5 + Number(files.size > 0);
    checkSize();
    files.set(hash, bytes.toString('base64'));
  }
  return { ...metadata, assets: Object.fromEntries(files) };
}

/** A bundle of the project: every revision reachable from its branches, in full, oldest first. */
export function exportBundle(projects: Projects, projectId: string) {
  const { notes: _notes, attachments: _attachments, source: _source, revisions: _listed, ...accepted } = projects.read(projectId);
  const repo = projects.repository(projectId);
  const ids = new Set<string>();
  const revisions: FullRevision[] = [];
  for (const info of logCommits(repo, [...new Set(Object.values(accepted.branches))]).reverse()) {
    const { id, parent, restoredFrom, label, date, author } = revisionMeta(info);
    const { scene, game, assets } = projects.history.content(repo, info.id);
    // A bundle's history has one root: a second root of an imported history follows the revision before it.
    const kept = parent && ids.has(parent) ? parent : revisions.at(-1)?.id ?? null;
    revisions.push({ id, parent: kept, ...(restoredFrom && ids.has(restoredFrom) ? { restoredFrom } : {}), label, date, author,
      ...(scene ? { scene } : {}), ...(game ? { game } : {}), assets });
    ids.add(id);
  }
  return withAssetFiles((hash) => projects.readAsset(hash), { project: { ...accepted, revisions, notes: [], attachments: [] } },
    deliveryAssets(revisions), gameFileHashes(revisions));
}

/** A new project from a bundle, its revisions as commits. */
export function importBundle(projects: Projects, raw: unknown, author?: Ident) {
  const bundle = projectBundle.parse(raw);
  const source = bundle.project;
  const ids = new Set<string>();
  for (const revision of source.revisions) {
    if (source.template && !revision.scene && !revision.game)
      throw new ZirbelError(422, 'The imported legacy revision is missing its scene.');
    const validParent = ids.size === 0 ? revision.parent === null : revision.parent !== null && ids.has(revision.parent);
    if (ids.has(revision.id) || !validParent ||
      (revision.restoredFrom && !ids.has(revision.restoredFrom))) throw new ZirbelError(400, 'Revision history is invalid.');
    ids.add(revision.id);
  }
  if (!source.branches.main || Object.values(source.branches).some((id) => !ids.has(id)))
    throw new ZirbelError(400, 'The imported branches have invalid revisions.');
  const assets = new Map<string, Buffer>();
  for (const item of deliveryAssets(source.revisions)) {
    const data = bundle.assets[item.hash];
    if (typeof data !== 'string') throw new ZirbelError(422, 'An asset file is missing.');
    const bytes = Buffer.from(data, 'base64');
    verifyAssetBytes(item, bytes);
    assets.set(item.hash, bytes);
  }
  for (const hash of gameFileHashes(source.revisions)) assets.set(hash, gameFileBytes(hash, bundle.assets[hash]));
  if (Object.keys(bundle.assets).length !== assets.size) throw new ZirbelError(422, 'The package contains undeclared assets.');
  for (const bytes of assets.values()) projects.storeAsset(bytes);
  const { title, template, upstream } = source;
  return projects.createRepository((repo) => {
    const { commits, hashes } = writeRevisions(repo, source.revisions, (hash) => projects.readAsset(hash), author);
    updateRefs(repo, Object.entries(source.branches).map(([branch, revision]) => ({ ref: 'refs/heads/' + branch, to: commits.get(revision)! })));
    return hashes;
  }, { title, ...(template ? { template } : {}), ...(upstream ? { upstream } : {}), imported: true });
}
