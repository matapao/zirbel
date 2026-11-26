// The editor for the browser tests, with a harness that relays each run to the test's HTTP fixture at
// FIXTURE_HARNESS_URL: GET /access lists its processors, and POST /runs answers one run. The fixture is told the
// run's thread folder and session; an answer may list steps to show (activity) and requests to put to the person
// (asks) before its reply, each waiting for the person's answer, files to write into the folder's game/ (files) or the
// folder itself (sources), and whether to compile src/main.ts with the folder's own TypeScript (compile), as a real
// turn's harness would; and with
// view, a call to the turn's own MCP server's view_game, whose answer it shows as a step.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AgentAsk, McpServerSpec } from 'celler/harness';
import { newId, ZirbelError } from '../packages/core/projects.ts';
import { main } from '../packages/server/main.ts';
import type { ActivityEntry } from '../packages/sdk/chat-stream.ts';
import { fakeHarnesses } from './fake-harnesses.ts';

const fixture = process.env.FIXTURE_HARNESS_URL ?? '';
const { processors } = await (await fetch(fixture + '/access')).json() as { processors: { id: string; name: string }[] };
/** The working folder the fixture's requests name, as a real turn's would be. */
const FIXTURE_FOLDER = '/work/zirbel/turn-fixture';

type FixtureReply = {
  task: string; stopReason: string; text?: string; activity?: ActivityEntry[]; asks?: AgentAsk[];
  files?: Record<string, string>; sources?: Record<string, string>; compile?: boolean; view?: object;
};

/** Calls the turn's MCP server as a harness does, and says what it answered: its tools, and view_game's content. */
async function viewThrough(server: McpServerSpec, args: object) {
  const rpc = async (id: number, method: string, params: object) => (await (await fetch(server.url, { method: 'POST',
    headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json()) as { result: Record<string, unknown> };
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  const tools = (await rpc(2, 'tools/list', {})).result.tools as { name: string }[];
  const viewed = (await rpc(3, 'tools/call', { name: 'view_game', arguments: args })).result as
    { isError?: boolean; content: { type: string; mimeType?: string; text?: string }[] };
  return { tools: tools.map(({ name }) => name), isError: viewed.isError ?? false,
    content: viewed.content.map(({ type, mimeType, text }) => type === 'text' ? text?.slice(0, 200) : type + ':' + mimeType) };
}

await main({
  webRoot: resolve('dist/web'),
  harnesses: () => fakeHarnesses(processors, async (processor, prompt, { signal, update, ask, place, session }) => {
    const sessionId = place?.resume && place.sessionId ? place.sessionId : newId();
    session?.(sessionId);
    let reply: FixtureReply;
    try {
      const response = await fetch(fixture + '/runs', { method: 'POST', signal: signal ?? null,
        body: JSON.stringify({ processor, prompt, cwd: place?.cwd, resume: place?.resume, sessionId }) });
      if (!response.ok) throw new ZirbelError(response.status, 'The harness connection could not complete the request.');
      reply = await response.json() as FixtureReply;
    } catch (error) {
      signal?.throwIfAborted(); // a stopped turn ends with its own reason
      throw error;
    }
    for (const entry of reply.activity ?? []) update?.({ type: 'activity', entry });
    const name = processors.find(({ id }) => id === processor)?.name;
    for (const question of reply.asks ?? []) await ask?.(question, signal ?? new AbortController().signal, { folder: FIXTURE_FOLDER, harness: name });
    signal?.throwIfAborted();
    const folder = place?.cwd;
    if (folder) {
      const written = [...Object.entries(reply.files ?? {}).map(([path, content]) => [join('game', path), content]),
        ...Object.entries(reply.sources ?? {})];
      for (const [path, content] of written) {
        const file = join(folder, path!);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content!);
      }
      // The one command a fake turn runs, fixed here: the folder's own TypeScript compiles src/main.ts into game/.
      if (reply.compile)
        execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--target', 'es2022', '--module', 'es2022',
          '--outDir', 'game', 'src/main.ts'], { cwd: folder, stdio: 'pipe' });
      const server = place.mcpServers?.[0];
      if (reply.view && server) update?.({ type: 'activity', entry: { id: 'view', kind: 'notice', title: 'Viewed the game',
        detail: JSON.stringify(await viewThrough(server, reply.view)) } });
    }
    return { task: reply.task, stopReason: reply.stopReason, text: reply.text, sessionId };
  }),
});
