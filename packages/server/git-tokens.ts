// A box's git tokens: what a git client sends as its password for a paired device or an editor of one game. A token is
// derived from a secret the account folder keeps (box/git-secret), so the editor can show a device its token at any
// time, and both hosts agree on it: <kind>.<holder id>.<mac>, kind o for a paired device and e for an editor, mac the
// unpadded base64url of HMAC-SHA256(secret, "zirbel-git-token\n" + kind + "\n" + holder id). A token works while its
// device stays paired or its editor's session lasts. The git store in AGENTS.md is the design.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../core/projects.ts';
import { privateDirectory } from './account.ts';

export type Holder = { kind: 'o' | 'e'; id: string };
const shape = /^([oe])\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export class GitTokens {
  private readonly file: string;

  constructor(folder: string) {
    privateDirectory(folder);
    this.file = join(folder, 'git-secret');
  }

  private secret() {
    try {
      const kept = readFileSync(this.file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(kept)) return Buffer.from(kept, 'hex');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const made = randomBytes(32);
    atomicWrite(this.file, made.toString('hex') + '\n');
    return made;
  }

  private mac(kind: Holder['kind'], id: string) {
    return createHmac('sha256', this.secret()).update('zirbel-git-token\n' + kind + '\n' + id).digest('base64url');
  }

  /** The token of a paired device (o) or an editor (e). */
  token({ kind, id }: Holder) { return kind + '.' + id + '.' + this.mac(kind, id); }

  /** Whose token this is, if it is one this box made. */
  holder(token: string): Holder | undefined {
    const match = shape.exec(token);
    if (!match) return undefined;
    const kind = match[1] as Holder['kind'], id = match[2]!;
    const given = Buffer.from(match[3]!), expected = Buffer.from(this.mac(kind, id));
    return given.length === expected.length && timingSafeEqual(given, expected) ? { kind, id } : undefined;
  }
}
