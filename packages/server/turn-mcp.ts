// Each turn's own MCP server, which the editor serves on its loopback listener at /turn-mcp: one tool, view_game, for
// that turn's thread folder alone, behind a credential made for the turn and given up as it ends. The harness reaches
// it from outside its sandbox, as it reaches any of a run's MCP servers.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { McpServerSpec } from 'celler/harness';
import { z } from 'zod';
import { digest, ZirbelError } from '../core/projects.ts';
import { viewGame, viewGameInput, type TurnGame } from './view-game.ts';

/** The name the harness knows the server by: its tool is mcp__zirbel__view_game to Claude Code. */
const TURN_SERVER = 'zirbel';
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const envelope = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string().max(200), z.number()]).optional(), method: z.string().max(200),
  params: z.record(z.string(), z.unknown()).optional(),
});

const viewGameTool = {
  name: 'view_game',
  description: 'Renders game/ in a browser as the editor runs it, in the game\'s sandbox, and returns PNG screenshots and the page\'s console messages and errors. ' +
    'actions: up to 40 steps, each {"key":"ArrowLeft"} (hold in ms optional), {"click":{"x":10,"y":20}}, {"wait":500} or {"text":"..."}. ' +
    'captures: up to 8 moments, each the number of actions done before its screenshot; without it, one after all of them. width and height: the page\'s size.',
  annotations: { readOnlyHint: true },
  inputSchema: z.toJSONSchema(viewGameInput, { io: 'input' }),
};

type Turn = { folder: string; game: TurnGame };
type ViewDeps = Parameters<typeof viewGame>[3];

export class TurnServers {
  /** The turns with a server, by their credential's hash. */
  private turns = new Map<string, Turn>();

  constructor(private deps: ViewDeps, private url: () => string) {}

  /** A server for one turn's folder; revoke() takes its credential back. */
  open(folder: string, game: TurnGame): { servers: McpServerSpec[]; revoke(): void } {
    const token = randomBytes(32).toString('base64url');
    const key = digest(token);
    this.turns.set(key, { folder, game });
    return {
      servers: [{ name: TURN_SERVER, transport: 'http', url: this.url(), headers: { authorization: 'Bearer ' + token } }],
      revoke: () => { this.turns.delete(key); },
    };
  }

  private verify(header: string | undefined) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? '')?.[1];
    if (token) {
      const key = digest(token);
      for (const [known, turn] of this.turns)
        if (timingSafeEqual(Buffer.from(known, 'hex'), Buffer.from(key, 'hex'))) return turn;
    }
    throw new ZirbelError(401, 'This turn has ended, or its credential is not valid.');
  }

  /** One JSON-RPC message: its answer, or undefined for a notification. */
  async handle(raw: unknown, credential: string | undefined): Promise<object | undefined> {
    const turn = this.verify(credential);
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    const { method, params, id } = parsed.data;
    if (id === undefined) return undefined;
    const response = { jsonrpc: '2.0', id };
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      return { ...response, result: {
        protocolVersion: typeof requested === 'string' && SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
        capabilities: { tools: {} }, serverInfo: { name: TURN_SERVER, version: '0.1.0' },
      } };
    }
    if (method === 'ping') return { ...response, result: {} };
    if (method === 'tools/list') return { ...response, result: { tools: [viewGameTool] } };
    if (method !== 'tools/call') return { ...response, error: { code: -32601, message: 'Method not found' } };
    if (params?.name !== viewGameTool.name)
      return { ...response, result: { isError: true, content: [{ type: 'text', text: 'Unknown tool: this server has view_game only.' }] } };
    try {
      return { ...response, result: await viewGame(params.arguments ?? {}, turn.folder, turn.game, this.deps) };
    } catch (error) {
      const text = error instanceof ZirbelError ? error.message : error instanceof z.ZodError
        ? 'Check the arguments: ' + error.issues.slice(0, 3).map(({ path, message }) => (path.length ? path.join('.') + ': ' : '') + message).join('; ')
        : 'The game could not be rendered: ' + (error instanceof Error ? error.message : String(error)).slice(0, 500);
      return { ...response, result: { isError: true, content: [{ type: 'text', text }] } };
    }
  }
}
