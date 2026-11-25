// view_game: a turn's game/ as the editor runs it, seen in a real browser outside the harness's sandbox. The folder is
// read as a turn's reply would be (turn-folder.ts), served through the editor's own player and game sandbox in a
// temporary solo room on loopback (the same policy, no network), and rendered by a browser: the desktop app's own,
// or an installed Chrome, Edge or Chromium (browser-cdp.ts). It returns PNG screenshots and the page's console.
import { z } from 'zod';
import { digest, type Projects } from '../core/projects.ts';
import type { Releases } from '../core/releases.ts';
import type { Rooms } from '../core/rooms.ts';
import type { Asset } from '../sdk/contracts.ts';
import { gamePath } from './player-listener.ts';
import { readGameFolder } from './turn-folder.ts';

const step = z.union([
  z.strictObject({ key: z.string().min(1).max(32), hold: z.number().int().min(0).max(5000).optional() }),
  z.strictObject({ click: z.strictObject({ x: z.number().min(0).max(4096), y: z.number().min(0).max(4096) }) }),
  z.strictObject({ wait: z.number().int().min(0).max(10_000) }),
  z.strictObject({ text: z.string().min(1).max(1000) }),
]);
export type Step = z.infer<typeof step>;
/** The tool's arguments, all optional: the steps to take, when to take a screenshot (after how many steps), the size. */
export const viewGameInput = z.strictObject({
  actions: z.array(step).max(40).default([]),
  captures: z.array(z.number().int().min(0).max(40)).min(1).max(8).optional()
    .describe('The moments to take a screenshot, each the number of actions done before it. Without it: one, after them all.'),
  width: z.number().int().min(64).max(1920).default(960),
  height: z.number().int().min(64).max(1200).default(600),
}).refine(({ actions, captures }) => (captures ?? []).every((moment) => moment <= actions.length),
  'A capture can come after at most as many actions as there are.')
  .refine(({ actions }) => actions.reduce((total, action) => total + ('wait' in action ? action.wait : 0), 0) <= 60_000,
    'The actions wait at most 60 seconds in all.');

export type ViewRequest = { url: string; origin: string; width: number; height: number; actions: Step[]; captures: number[] };
export type ConsoleLine = { level: string; text: string };
type ViewResult = { images: Buffer[]; console: ConsoleLine[] } | { unavailable: string };
/** What renders a page: the desktop app's own browser, or an installed one. */
export interface Renderer { render(request: ViewRequest, signal: AbortSignal): Promise<ViewResult> }

/** The game a turn works on, besides its folder: its title, its imported assets and its number of players. */
export type TurnGame = { title: string; assets: Asset[]; maxPlayers: number };
type Deps = { projects: Projects; releases: Releases; rooms: Rooms; playerPort: () => number | undefined; renderer: Renderer };

/** The longest a render may take, start to end. */
const RENDER_MS = 120_000;
const CONSOLE_LINES = 200;
const LINE_CHARS = 2000;

const text = (value: string) => ({ type: 'text' as const, text: value });

/** view_game's result as MCP content: the screenshots, then what the page said. A failure is the tool's own error. */
export async function viewGame(raw: unknown, folder: string, game: TurnGame, deps: Deps) {
  const input = viewGameInput.parse(raw);
  const { html, files } = readGameFolder(folder);
  const paths: Record<string, string> = {};
  const bytes = new Map<string, Buffer>();
  for (const [path, file] of files) {
    const hash = digest(file);
    paths[path] = hash;
    bytes.set(hash, file);
  }
  for (const asset of game.assets) bytes.set(asset.hash, deps.projects.readAsset(asset.hash));
  const release = deps.releases.draft(game.title, { html, maxPlayers: game.maxPlayers, ...(files.size ? { files: paths } : {}) },
    game.assets, bytes);
  const port = deps.playerPort();
  if (!port) return { isError: true, content: [text('The editor’s player is not running.')] };
  const room = deps.rooms.create(release, true);
  const origin = 'http://127.0.0.1:' + port;
  try {
    const captures = input.captures ?? [input.actions.length];
    const result = await deps.renderer.render({ url: origin + gamePath(room), origin, width: input.width, height: input.height,
      actions: input.actions, captures }, AbortSignal.timeout(RENDER_MS));
    if ('unavailable' in result) return { isError: true, content: [text(result.unavailable)] };
    const lines = result.console.slice(0, CONSOLE_LINES).map(({ level, text: line }) => ({ level, text: line.slice(0, LINE_CHARS) }));
    return { content: [
      ...result.images.map((image) => ({ type: 'image' as const, data: image.toString('base64'), mimeType: 'image/png' })),
      text(JSON.stringify({ screenshots: captures.map((after) => ({ afterActions: after })), size: { width: input.width, height: input.height },
        console: lines, ...(result.console.length > CONSOLE_LINES ? { consoleDropped: result.console.length - CONSOLE_LINES } : {}) })),
    ] };
  } finally {
    deps.rooms.close(room.id);
  }
}
