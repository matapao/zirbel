// One harness turn's steps, in the order they first arrived, within bounds that keep a long turn small enough to
// stream, keep and draw. The editor keeps a turn's steps in a TurnLog while it runs, and the Node editor saves the
// same log when the turn ends. No Zod here: the editor and the server both use it.
import type { ActivityEntry } from './contracts.ts';

/** Characters of one step's text: its title, detail and diff together. */
export const ENTRY_LIMIT = 64 * 1024;
/** Characters of a step's title. */
export const TITLE_LIMIT = 1000;
/** Characters of a step's id or parent. */
export const STEP_ID_LIMIT = 400;
/** Characters of one turn's steps together. */
export const TURN_LIMIT = 2 * 1024 * 1024;
/** Steps in one turn. */
export const TURN_STEPS = 2000;

function clip(text: string, room: number) {
  return text.length <= room ? text : text.slice(0, Math.max(0, room - 1)) + '…';
}

/** A step within the bounds: an id and title that fit, and detail and diff sharing what is left of ENTRY_LIMIT. */
export function boundEntry(entry: ActivityEntry): ActivityEntry {
  const { detail, diff, parent, ...rest } = entry;
  const title = clip(entry.title, TITLE_LIMIT);
  const bounded: ActivityEntry = { ...rest, id: entry.id.slice(0, STEP_ID_LIMIT), title };
  let room = ENTRY_LIMIT - title.length;
  if (detail !== undefined) {
    bounded.detail = clip(detail, room);
    room -= bounded.detail.length;
  }
  if (diff !== undefined && room > 0) bounded.diff = clip(diff, room);
  if (parent !== undefined) bounded.parent = parent.slice(0, STEP_ID_LIMIT);
  return bounded;
}

export function entryWeight(entry: ActivityEntry) {
  return entry.title.length + (entry.detail?.length ?? 0) + (entry.diff?.length ?? 0);
}

export type TurnRecord = { entries: ActivityEntry[]; dropped: number };

export class TurnLog {
  readonly entries = new Map<string, ActivityEntry>();
  /** Steps let go, oldest first, to stay within TURN_LIMIT and TURN_STEPS. */
  dropped = 0;
  private weight = 0;

  /** Adds a step or updates it in place, and returns the ids of older steps let go to make room for it. */
  add(raw: ActivityEntry): string[] {
    const entry = boundEntry(raw);
    const prior = this.entries.get(entry.id);
    if (prior) this.weight -= entryWeight(prior);
    this.entries.set(entry.id, entry);
    this.weight += entryWeight(entry);
    const removed: string[] = [];
    for (const [id, old] of this.entries) {
      if (this.weight <= TURN_LIMIT && this.entries.size <= TURN_STEPS) break;
      if (id === entry.id) continue;
      this.entries.delete(id);
      this.weight -= entryWeight(old);
      this.dropped++;
      removed.push(id);
    }
    return removed;
  }

  get size() {
    return this.weight;
  }

  record(): TurnRecord {
    return { entries: [...this.entries.values()], dropped: this.dropped };
  }

  static from(record: TurnRecord) {
    const log = new TurnLog();
    for (const entry of record.entries) log.add(entry);
    log.dropped += record.dropped;
    return log;
  }
}
