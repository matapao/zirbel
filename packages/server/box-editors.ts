// A box's editors of one game (box mode, --box): each game's edit code, and the sessions of the devices that redeemed
// one. A game has one code at a time, six characters that several people may use until it expires, seven days after it
// was made, or its owner stops it; a new code replaces the old, and devices already editing stay. An editor's session
// is a cookie of 32 random bytes, kept as its SHA-256 like a paired device's. The account folder keeps both, beside the
// paired devices (box/editors.json), and the file is read on every use.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite, newId, ZirbelError } from '../core/projects.ts';
import { id } from '../sdk/contracts.ts';
import { privateDirectory } from './account.ts';
import { WRONG_CODES } from './box-pairing.ts';

/** No 0, 1, I or O, which read as each other. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const EDIT_CODE_MS = 7 * 24 * 3_600_000;
/** The people one game's codes may let in at once. */
export const EDITORS_PER_GAME = 64;
/** How often a session's last use is written down. */
const SEEN_MS = 60_000;
export const EDITOR_COOKIE = 'zirbel_editor';
/** The cookie that ends an editor's session on a device, when it pairs as an owner. */
export const END_EDITOR = EDITOR_COOKIE + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
export const WRONG_EDIT_CODE = "That code doesn't open a game.";
/** What an editor whose session ended is told: the owner removed it, or its game. */
export const ENDED = 'This device’s edit access has ended. Ask the box’s owner for a new edit code.';
export const ONE_GAME = 'This device edits one game only.';

/** The name a device gives, as its owner sees it: trimmed, of 1 to 24 characters. */
export const editorName = z.string().trim().min(1).max(24);
const iso = z.iso.datetime();
const plainCode = z.string().regex(/^[2-9A-HJ-NP-Z]{6}$/);
const code = z.strictObject({ project: id, code: plainCode, createdAt: iso, expiresAt: iso });
const editor = z.strictObject({
  id,
  project: id,
  name: z.string().min(1).max(24),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  since: iso,
  lastSeen: iso,
});
const store = z.strictObject({
  version: z.literal(1),
  codes: z.array(code).max(4096),
  editors: z.array(editor).max(4096),
});
type Code = z.infer<typeof code>;
type Editor = z.infer<typeof editor>;
type Store = z.infer<typeof store>;

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const shown = (plain: string) => plain.slice(0, 3) + '-' + plain.slice(3);

/** An edit code as a person types it: any case, with or without its dash or spaces. Its six characters, or none. */
export function plainEditCode(input: string) {
  const plain = input.toUpperCase().replace(/[\s-]/g, '');
  return plainCode.safeParse(plain).success ? plain : undefined;
}

/** An edit code as it is shown, XXX-XXX, or none. */
export const editCode = (input: string) => {
  const plain = plainEditCode(input);
  return plain && shown(plain);
};

/** The editor's session a Cookie header carries, if it carries one in the form this box makes. */
export function editorToken(cookie = '') {
  for (const part of cookie.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === EDITOR_COOKIE && value && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return undefined;
}

export class Editors {
  private readonly wrong = new Map<string, { since: number; count: number }>();
  private readonly file: string;
  private readonly now: () => number;

  constructor(folder: string, now = Date.now) {
    this.now = now;
    privateDirectory(folder);
    this.file = join(folder, 'editors.json');
  }

  /** A new code for a game, replacing the one it had; never another game's code now, as a code opens one game. */
  createCode(project: string) {
    const kept = this.read();
    const taken = new Set(
      this.live(kept)
        .filter((known) => known.project !== project)
        .map((known) => known.code),
    );
    let plain: string;
    do plain = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    while (taken.has(plain));
    const at = this.now();
    const made: Code = {
      project,
      code: plain,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + EDIT_CODE_MS).toISOString(),
    };
    this.write({ ...kept, codes: [...kept.codes.filter((known) => known.project !== project), made] });
    return { code: shown(plain), plain, expiresAt: made.expiresAt };
  }

  /** A game's code while it opens the game. */
  code(project: string) {
    const known = this.live(this.read()).find((item) => item.project === project);
    return known && { code: shown(known.code), plain: known.code, expiresAt: known.expiresAt };
  }

  stopCode(project: string) {
    const kept = this.read();
    this.write({ ...kept, codes: kept.codes.filter((known) => known.project !== project) });
  }

  /** Lets a device in to the game a code opens, under a name: its new session's token. The session the device held
   *  (previous, its Cookie header) ends. */
  redeem(input: string, name: string, address: string, previous?: string) {
    const given = editorName.parse(name);
    const at = this.now();
    const tries = this.wrong.get(address);
    if (tries && at - tries.since < 60_000 && tries.count >= WRONG_CODES)
      throw new ZirbelError(429, 'Too many wrong codes. Wait a minute and try again.');
    for (const [known, counted] of this.wrong) if (at - counted.since >= 60_000) this.wrong.delete(known);
    const kept = this.read();
    const hash = sha256(plainEditCode(input) ?? '');
    // Every live code is compared, in constant time, whichever matches.
    let found: Code | undefined;
    for (const known of this.live(kept)) if (timingSafeEqual(sha256(known.code), hash)) found = known;
    if (!found) {
      const fresh = !tries || at - tries.since >= 60_000;
      this.wrong.set(address, fresh ? { since: at, count: 1 } : { since: tries.since, count: tries.count + 1 });
      throw new ZirbelError(403, WRONG_EDIT_CODE);
    }
    const { project } = found;
    const ending = this.find(kept, previous);
    const editors = kept.editors.filter((known) => known !== ending);
    if (editors.filter((known) => known.project === project).length >= EDITORS_PER_GAME)
      throw new ZirbelError(409, 'This game has as many editors as it keeps. Remove one first.');
    const token = randomBytes(32).toString('base64url');
    const stamp = new Date(at).toISOString();
    const made: Editor = {
      id: newId(),
      project,
      name: given,
      tokenHash: sha256(token).toString('hex'),
      since: stamp,
      lastSeen: stamp,
    };
    this.write({ ...kept, editors: [...editors, made] });
    return { token, editor: made };
  }

  /** The editor a Cookie header's session belongs to, if any; its last use is noted. */
  session(cookie: string | undefined): Editor | undefined {
    if (!editorToken(cookie)) return undefined;
    const kept = this.read();
    const found = this.find(kept, cookie);
    if (found && this.now() - Date.parse(found.lastSeen) > SEEN_MS) {
      found.lastSeen = new Date(this.now()).toISOString();
      this.write(kept);
    }
    return found;
  }

  /** Ends the session a Cookie header carries, if it is an editor's. */
  end(cookie: string | undefined) {
    const kept = this.read();
    const found = this.find(kept, cookie);
    if (found) this.write({ ...kept, editors: kept.editors.filter((known) => known !== found) });
  }

  /** The people editing a game, by the names they gave. */
  list(project: string) {
    return this.read()
      .editors.filter((known) => known.project === project)
      .map(({ id, name, since, lastSeen }) => ({ id, name, since, lastSeen }));
  }

  /** An editor by its id, while its session lasts. */
  editor(editorId: string) {
    const found = this.read().editors.find((known) => known.id === editorId);
    return found && { id: found.id, project: found.project, name: found.name };
  }

  /** Ends one editor's session, at once. */
  remove(project: string, editorId: string) {
    const kept = this.read();
    const editors = kept.editors.filter((known) => known.project !== project || known.id !== editorId);
    if (editors.length === kept.editors.length) throw new ZirbelError(404, "That device doesn't edit this game.");
    this.write({ ...kept, editors });
  }

  /** A removed game takes its code and its editors with it. */
  removeProject(project: string) {
    const kept = this.read();
    this.write({
      version: 1,
      codes: kept.codes.filter((known) => known.project !== project),
      editors: kept.editors.filter((known) => known.project !== project),
    });
  }

  private live(kept: Store) {
    return kept.codes.filter((known) => Date.parse(known.expiresAt) > this.now());
  }

  private find(kept: Store, cookie: string | undefined) {
    const token = editorToken(cookie);
    if (!token) return undefined;
    const hash = sha256(token);
    let found: Editor | undefined;
    for (const known of kept.editors) if (timingSafeEqual(Buffer.from(known.tokenHash, 'hex'), hash)) found = known;
    return found;
  }

  private read(): Store {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, codes: [], editors: [] };
      throw error;
    }
    try {
      return store.parse(JSON.parse(text));
    } catch {
      throw new ZirbelError(500, 'The game editors could not be read.');
    }
  }

  /** Writes what is kept, without the codes that have expired. */
  private write(kept: Store) {
    atomicWrite(this.file, JSON.stringify(store.parse({ version: 1, codes: this.live(kept), editors: kept.editors })));
  }
}
