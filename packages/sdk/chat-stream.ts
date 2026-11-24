import type { ActivityEntry, Note } from './contracts.ts';

export type { ActivityEntry } from './contracts.ts';
export const chatStreamType = 'application/x-ndjson';
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
/** A permission request in plain language: a headline, and what it runs or changes for the details. */
export type PermissionRequest = {
  summary: string;
  tool: string;
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
