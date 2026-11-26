// Split from workspace.ts; shares state through ws in state.ts.
import { type Asset, type ChatUsage, type Note, type Project, type Reference, type Scene } from '../sdk/contracts.ts';
import { type GameDocument, type RegisteredObject } from '../sdk/game.ts';
import { type HarnessAction } from '../sdk/chat-stream.ts';
import { TurnLog } from '../sdk/activity.ts';
import type { modelPicker } from './model-picker.ts';

/** What /api/health says of a box (box mode): its switches, whether harnesses can run on it, and its memory. */
export type BoxHealth = {
  harnesses: boolean; externalMcp: boolean; onboarded: boolean; setupRequested: boolean; ownNetwork: boolean;
  canRunHarnesses: boolean; harnessesUnavailable?: string; memoryMB: number; name: string;
};

export type Proposal = { id: string; label: string; baseRevision: string };
export type Preview = { proposal: Proposal; preview: { scene?: Scene; game?: GameDocument; assets: Asset[] } };
export type Box = { x: number; y: number; width: number; height: number };
export type WorkspaceMessage = { role: 'creator' | 'assistant'; text: string; usage?: ChatUsage };
export type ChatReply = { projectId?: string; branch?: string; conversation?: WorkspaceMessage[]; proposalId?: string };
export type ProjectCard = Pick<Project, 'id' | 'title' | 'template'>;
export type ActivityTurn = {
  name: string; text: string; references: Reference[]; status: string; pending: boolean; showPrompt: boolean;
  connection?: AbortController; id?: string; note?: Note; failed?: boolean; stopping?: boolean;
  /** Stop was pressed before the turn's id arrived: it is sent once the id does. */
  stopRequested?: boolean;
  startedAt: number; log: TurnLog; actions: Map<string, HarnessAction>;
  /** The turn's steps as the thread draws them, kept while the turn is shown. */
  steps?: HTMLElement;
};
// Mutable workspace state that more than one workspace module reads or
// writes. State with a single owner lives in that module.
export const ws = {
  project: undefined as Project | undefined,
  /** The conversation before a project exists; the harness's first game takes it into the new project. */
  conversation: [] as WorkspaceMessage[],
  /** That conversation's own thread, kept in browser storage so a page that comes back finds its running turn. */
  workspaceThread: '',
  /** A turn of the open thread that was interrupted when its editor ended, which Continue resumes. */
  interrupted: undefined as { key: string; text: string; harness: string; noteId?: string } | undefined,
  branch: 'main',
  /** Edit shows the editing affordances on the running game; otherwise the person plays it. */
  editing: false,
  objectsOpen: false,
  sourceVisible: false,
  threadOpen: true,
  selected: new Set<string>(),
  region: undefined as Box | undefined,
  /** The proposal the running game shows, while its card is switched to After. */
  candidate: undefined as Preview | undefined,
  proposals: [] as Proposal[],
  /** The proposal the card shows, among several. */
  proposalChoice: undefined as string | undefined,
  projectCards: [] as ProjectCard[],
  modelControl: undefined as ReturnType<typeof modelPicker> | undefined,
  registerObjects: true,
  health: { mcp: false } as { mcp: boolean; chat?: boolean; box?: BoxHealth },
  view: { x: 0, y: 0, zoom: 1, grid: false, tool: 'select' as 'select' | 'pan' },
  playtest: undefined as { id: string; link: string } | undefined,
  playtestKey: undefined as string | undefined,
  previewError: '',
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
export const workspaceThreadKey = 'zirbel-workspace-thread-v1';
export const recentProjectsKey = 'zirbel-recent-projects-v1';
export const threadOpenKey = 'zirbel-thread-open-v1';
export const chatSettingsKey = 'zirbel-chat-settings-v1';
export const chatSettings = { suggestions: true, count: 3 };
/** Suggested messages, once a game exists: they ask about or explain the game on screen, never propose content. */
export const SUGGESTIONS = ['Describe this game', 'Suggest two changes', 'Explain the controls'] as const;
export const MAX_SUGGESTIONS = SUGGESTIONS.length;
export const objectPreferenceKey = 'zirbel-register-objects';
export const markedObjects = new Set<string>();
