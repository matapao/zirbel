// Split from workspace.ts; shares state through ws in state.ts.
import { type Asset, type ChatUsage, type Note, type Project, type Reference, type Scene } from '../sdk/contracts.ts';
import { type GameDocument, type RegisteredObject } from '../sdk/game.ts';
import { type ActivityEntry, type HarnessAction } from '../sdk/chat-stream.ts';
import { modelPicker } from './model-picker.ts';

export const modes = ['edit', 'context', 'review', 'play'] as const;
export type Mode = typeof modes[number];
export type Proposal = { id: string; label: string; baseRevision: string };
export type Preview = { proposal: Proposal; preview: { scene?: Scene; game?: GameDocument; assets: Asset[] } };
export type Box = { x: number; y: number; width: number; height: number };
export type WorkspaceMessage = { role: 'creator' | 'assistant'; text: string; usage?: ChatUsage };
export type ChatReply = { projectId?: string; branch?: string; conversation?: WorkspaceMessage[]; mode?: 'edit' | 'review' | 'play'; proposalId?: string };
export type ActivityTurn = {
  name: string; text: string; references: Reference[]; status: string; pending: boolean; showPrompt: boolean;
  connection?: AbortController; id?: string; note?: Note; failed?: boolean; stopping?: boolean;
  entries: Map<string, ActivityEntry>; actions: Map<string, HarnessAction>;
};
// Mutable workspace state that more than one workspace module reads or
// writes. State with a single owner lives in that module.
export const ws = {
  project: undefined as Project | undefined,
  branch: 'main',
  mode: 'edit' as Mode,
  selected: new Set<string>(),
  region: undefined as Box | undefined,
  candidate: undefined as Preview | undefined,
  modelControl: undefined as ReturnType<typeof modelPicker> | undefined,
  registerObjects: true,
  health: undefined as unknown as { mcp: boolean },
  view: { x: 0, y: 0, zoom: 1, grid: false, tool: 'select' as 'select' | 'pan' },
  playtest: undefined as { id: string; link: string } | undefined,
  playtestKey: undefined as string | undefined,
  previewError: '',
  sourceVisible: false,
  navigation: 0,
  registered: [] as RegisteredObject[],
};

export const activityTurns = new Map<string, ActivityTurn>();
export const promptDrafts = new Map<string, string>();
export const threadKey = (id: string | undefined, name: string) => id ? id + '/' + name : '';
export const activityKey = () => threadKey(ws.project?.id, ws.branch);
export const visibleTurn = () => activityTurns.get(activityKey());
export const chatBusy = () => visibleTurn()?.pending === true;
export const lastProjectKey = 'zirbel-last-project-v1';
export const chatSettingsKey = 'zirbel-chat-settings-v1';
export const chatSettings = { suggestions: true, count: 3 };
export const objectPreferenceKey = 'zirbel-register-objects';
export const markedObjects = new Set<string>();
