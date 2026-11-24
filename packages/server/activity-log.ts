// Each harness turn's steps, kept by the Node editor beside the projects so a thread shows its whole history after a
// reload: <data>/activity/<projectId>.<noteId>.json, keyed by the creator's message that started the turn, written once
// when the turn ends and validated on every read. The project file and its contract stay as they are.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
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
    const file = this.path(projectId, noteId);
    if (!existsSync(file)) throw new ZirbelError(404, 'This turn kept no activity.');
    if (statSync(file).size > FILE_LIMIT) throw new ZirbelError(422, 'The saved activity is larger than a turn keeps.');
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new ZirbelError(422, 'The saved activity could not be read.');
    }
    const record = turnActivity.safeParse(data);
    if (!record.success) throw new ZirbelError(422, 'The saved activity is not valid.');
    return record.data;
  }
}
