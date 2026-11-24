import type { Note } from './contracts.ts';

export const chatStreamType = 'application/x-ndjson';
type ChatPhase = 'running' | 'responding' | 'validating';
export type ActivityEntry = {
  id: string;
  title: string;
  detail?: string;
  kind: 'message' | 'plan' | 'tool' | 'helper' | 'file' | 'notice';
  state?: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed';
  parent?: string;
};
export type ActionField = {
  name: string;
  title: string;
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  required: boolean;
  choices?: { value: string; label: string }[];
};
export type HarnessAction = { id: string; title: string } & (
  | { kind: 'permission'; detail?: string; options: { id: string; title: string }[] }
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
