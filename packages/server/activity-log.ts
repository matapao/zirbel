// Each harness turn's steps, kept by the Node editor beside the projects so a thread shows its whole history after a
// reload: <data>/activity/<projectId>.<noteId>.json, keyed by the creator's message that started the turn, written once
// when the turn ends and validated on every read. The project file and its contract stay as they are.
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, safeId, ZirbelError } from '../core/projects.ts';
import { TURN_LIMIT, type TurnLog } from '../sdk/activity.ts';
import { turnActivity } from '../sdk/contracts.ts';

/** A saved turn is JSON text: at most this many bytes for TURN_LIMIT characters and their escapes. */
const FILE_LIMIT = TURN_LIMIT * 4;

export class ActivityStore {
  private readonly directory: string;

  constructor(root: string) {
    this.directory = join(root, 'activity');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  private path(projectId: string, noteId: string) {
    return join(this.directory, safeId(projectId) + '.' + safeId(noteId) + '.json');
  }

  /** Keeps a turn's steps under the message that started it. A turn that showed no steps keeps nothing, and a turn
   *  whose steps cannot be kept still ends as it would have. */
  save(projectId: string, noteId: string, log: TurnLog) {
    if (!log.entries.size) return false;
    try {
      const record = turnActivity.parse({ version: 1, ...log.record() });
      atomicWrite(this.path(projectId, noteId), JSON.stringify(record));
      return true;
    } catch (error) {
      console.warn('Could not keep the activity of a harness turn: ' + (error as Error).message);
      return false;
    }
  }

  read(projectId: string, noteId: string) {
    const text = readBounded(this.path(projectId, noteId), FILE_LIMIT);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ZirbelError(422, 'The saved activity could not be read.');
    }
    const record = turnActivity.safeParse(data);
    if (!record.success) throw new ZirbelError(422, 'The saved activity is not valid.');
    return record.data;
  }
}

/** A saved turn's text, through one open handle: its size is checked on that handle, and no more than that size is
 *  read, so a file that grows or is replaced meanwhile can't get past the limit. */
function readBounded(file: string, limit: number) {
  let handle: number;
  try {
    handle = openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ZirbelError(404, 'This turn kept no activity.');
    throw new ZirbelError(422, 'The saved activity could not be read.');
  }
  try {
    const size = fstatSync(handle).size;
    if (size > limit) throw new ZirbelError(422, 'The saved activity is larger than a turn keeps.');
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < buffer.length; length += read)
      read = readSync(handle, buffer, length, buffer.length - length, null);
    if (length > size) throw new ZirbelError(422, 'The saved activity changed while it was read.');
    return buffer.toString('utf8', 0, length);
  } finally {
    closeSync(handle);
  }
}
