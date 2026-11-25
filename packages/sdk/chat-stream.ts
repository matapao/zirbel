import type { ActivityEntry, Note } from './contracts.ts';

export type { ActivityEntry } from './contracts.ts';
export const chatStreamType = 'application/x-ndjson';
/** The message a continued turn sends, once its editor ended while it ran. */
export const CONTINUE_TEXT = 'The previous turn was interrupted. Continue where you left off.';
/** What a thread has, as the editor reports it: the turn running in it, or the one interrupted when its editor ended;
 *  before a project, its messages so far and the project its first game became. */
export type ThreadView = {
  turn?: { id: string; name: string; text: string; noteId?: string; startedAt: string };
  interrupted?: { text: string; harness: string; noteId?: string };
  conversation?: { role: 'creator' | 'assistant'; text: string; usage?: Note['usage'] }[];
  project?: string;
};
type ChatPhase = 'running' | 'responding' | 'validating';
export type ActionField = {
  name: string;
  title: string;
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  required: boolean;
  choices?: { value: string; label: string }[];
};
/** Where an answered request takes effect: inside the turn's sandbox, or outside it; reach says so in plain words. */
export type ActionReach = { scope: 'sandboxed' | 'outside'; reach: string };
/** A permission request in plain language: a headline, the harness's reason in its own words (plain text, never markup),
 *  and what it runs or changes for the details. */
export type PermissionRequest = {
  summary: string;
  tool: string;
  reason?: string;
  command?: string;
  file?: string;
  folder?: string;
  diff?: string;
};
export type HarnessAction = { id: string; title: string } & ActionReach & (
  | ({ kind: 'permission'; detail?: string; options: { id: string; title: string }[] } & PermissionRequest)
  | { kind: 'form'; fields: ActionField[] }
  | { kind: 'link'; url: string }
);
export type ActionValue = string | number | boolean | string[];
export type ChatUpdate =
  | { type: 'progress'; phase: ChatPhase }
  | { type: 'note'; note: Note }
  | { type: 'run'; id: string }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'action'; action: HarnessAction }
  | { type: 'action-closed'; id: string }
  | { type: 'heartbeat' };
export type ChatEvent<T> = ChatUpdate | { type: 'result'; result: T } | { type: 'error'; error: string };
