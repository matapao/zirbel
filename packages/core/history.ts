// A project's history and heads, read from its repository: the newest commits reachable from its branches as revisions'
// metadata, and each branch head's content. A commit never changes, so what it holds is kept by its id; the history
// is kept while the branches stay where they are. The SHA-256 of a game file's blob is kept beside the repository
// (zirbel-sha256), and a game file the host reads is kept in the asset store, where releases, turns and MCP read it.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Asset } from '../sdk/contracts.ts';
import { git, listTree, parseCommit, readObjects, type CommitInfo, type Entry } from './git.ts';
import { readTree, revisionMeta, type Content, type RevisionMeta, type TreeSource } from './git-tree.ts';
import { digest, mediaMatches } from './bytes.ts';

/** How many of the newest revisions a project's history lists. */
const HISTORY = 200;
const CONTENTS = 64;

/** Where the host keeps bytes by their SHA-256: the data folder's assets/. */
export type AssetStore = { hasAsset(hash: string): boolean; storeAsset(bytes: Buffer): string };

/** Commits by id, as `git log` lists them from some tips: newest first, children before parents. */
export function logCommits(repo: string, tips: string[], max?: number): CommitInfo[] {
  if (!tips.length) return [];
  const out = git(repo, ['log', '--topo-order', '-z', '--format=%H%n%T%n%P%n%an%n%ct%n%B',
    ...(max ? ['--max-count=' + max] : []), ...tips, '--']).stdout.toString('utf8');
  const commits: CommitInfo[] = [];
  for (const record of out.split('\0')) {
    if (!record.trim()) continue;
    const lines = record.replace(/^\n/, '').split('\n');
    const [id, tree, parents, author, time] = lines;
    commits.push({ id: id!, tree: tree!, parents: parents ? parents.split(' ') : [], author: author ?? '', time: Number(time),
      message: lines.slice(5).join('\n') });
  }
  return commits;
}

export class History {
  private readonly logs = new Map<string, { key: string; revisions: RevisionMeta[] }>();
  private readonly contents = new Map<string, Content>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly store: AssetStore;

  constructor(store: AssetStore) {
    this.store = store;
  }

  /** The history of a repository with these branches: its newest commits and every head, oldest first. */
  revisions(repo: string, branches: Record<string, string>) {
    const key = JSON.stringify(branches);
    const known = this.logs.get(repo);
    if (known?.key === key) return known.revisions;
    const heads = [...new Set(Object.values(branches))];
    const listed = logCommits(repo, heads, HISTORY);
    const ids = new Set(listed.map(({ id }) => id));
    const missing = heads.filter((head) => !ids.has(head));
    const found = readObjects(repo, missing);
    const commits = [...listed, ...missing.flatMap((id) => found.has(id) ? [parseCommit(id, found.get(id)!)] : [])];
    const revisions = commits.map(revisionMeta).reverse();
    this.logs.set(repo, { key, revisions });
    return revisions;
  }

  /** One commit's metadata. */
  meta(repo: string, commit: string) {
    const found = readObjects(repo, [commit]).get(commit);
    if (!found) throw new Error('The commit ' + commit + ' is missing.');
    return revisionMeta(parseCommit(commit, found));
  }

  /** A commit's content, its game files and assets kept in the asset store; and the problems its tree has. */
  read(repo: string, commit: string) {
    const entries = listTree(repo, commit);
    const result = readTree(entries, this.source(repo));
    if (!result.problems.length) this.remember(commit, result.content);
    return { ...result, entries };
  }

  /** A commit's content, as it was read before or read now. */
  content(repo: string, commit: string): Content {
    const kept = this.contents.get(commit);
    if (kept) { this.contents.delete(commit); this.contents.set(commit, kept); return kept; }
    const { content } = this.read(repo, commit);
    this.remember(commit, content);
    return content;
  }

  /** The SHA-256 of a blob the host has read or written, if it knows it. */
  sha256(repo: string, oid: string) { return this.cache(repo).get(oid); }

  /** Notes the SHA-256 of blobs the host wrote. */
  learn(repo: string, pairs: [string, string][]) {
    const cache = this.cache(repo);
    const fresh = pairs.filter(([oid]) => !cache.has(oid));
    for (const [oid, hash] of fresh) cache.set(oid, hash);
    if (fresh.length) appendFileSync(join(repo, 'zirbel-sha256'), fresh.map(([oid, hash]) => oid + ' ' + hash + '\n').join(''));
  }

  /** Forgets a repository's history, after its refs moved outside the host's own writes. */
  forget(repo: string) { this.logs.delete(repo); }

  private remember(commit: string, content: Content) {
    this.contents.set(commit, content);
    if (this.contents.size > CONTENTS) this.contents.delete(this.contents.keys().next().value!);
  }

  private cache(repo: string) {
    let cache = this.hashes.get(repo);
    if (cache) return cache;
    cache = new Map();
    try {
      for (const line of readFileSync(join(repo, 'zirbel-sha256'), 'utf8').split('\n')) {
        const match = /^([0-9a-f]{40}) ([0-9a-f]{64})$/.exec(line);
        if (match) cache.set(match[1]!, match[2]!);
      }
    } catch { /* none yet: hashed as read */ }
    this.hashes.set(repo, cache);
    return cache;
  }

  private source(repo: string): TreeSource {
    return {
      bytes: (oids) => readObjects(repo, oids),
      sha256: (entries) => {
        const cache = this.cache(repo);
        const hashes = new Map<string, string>();
        const unread: Entry[] = [];
        for (const entry of entries) {
          const hash = cache.get(entry.oid);
          if (hash && this.store.hasAsset(hash)) hashes.set(entry.oid, hash);
          else unread.push(entry);
        }
        const bytes = readObjects(repo, unread.map(({ oid }) => oid));
        const learnt: [string, string][] = [];
        for (const { oid } of unread) {
          const found = bytes.get(oid);
          if (!found) continue;
          const hash = this.store.storeAsset(found);
          hashes.set(oid, hash);
          learnt.push([oid, hash]);
        }
        this.learn(repo, learnt);
        return hashes;
      },
      assets: (found) => checkAssets(found, (oids) => readObjects(repo, oids), this.store),
    };
  }
}

/** Each asset's bytes, as its tree holds them, matching its hash and media type; kept in the store when there is one. */
export function checkAssets(found: { asset: Asset; entry: Entry }[], bytes: (oids: string[]) => Map<string, Buffer>, store?: AssetStore) {
  const unread = found.filter(({ asset }) => !store?.hasAsset(asset.hash));
  const read = bytes(unread.map(({ entry }) => entry.oid));
  const wrong: string[] = [];
  for (const { asset, entry } of unread) {
    const data = read.get(entry.oid);
    if (!data || digest(data) !== asset.hash || !mediaMatches(asset.media, data)) wrong.push(asset.name);
    else store?.storeAsset(data);
  }
  return wrong.length ? ['The bytes of these assets don’t match them: ' + wrong.slice(0, 8).join(', ') + '.'] : [];
}
