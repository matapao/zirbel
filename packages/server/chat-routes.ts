// The editor's harness chat over HTTP: starting a turn in a thread and streaming it, attaching to a running turn,
// what a thread has running or interrupted, Stop and the answers to what the harness asks, and each turn's kept steps.
// A turn belongs to the editor: a request only streams it (chat-runs.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { ThreadView } from '../sdk/chat-stream.ts';
import { id, workspaceHistory } from '../sdk/contracts.ts';
import { objectRegistry } from '../sdk/game.ts';
import { head, newId, safeId, ZirbelError, type Projects } from '../core/projects.ts';
import type { ActivityStore } from './activity-log.ts';
import { streamTurn, type ChatRuns } from './chat-runs.ts';
import { runHarnessChat, runWorkspaceChat } from './harness-chat.ts';
import { body, checkOrigin, reply } from './http.ts';
import { modelSelection, processorId, type Processors } from './processors.ts';
import { inThread, type TurnTools } from './thread-turns.ts';
import { projectThread, workspaceThread, type Threads } from './threads.ts';

export type ChatContext = {
  projects: Projects; harnesses: Processors; chat: ChatRuns; activity: ActivityStore; threads: Threads; tools: TurnTools;
};

const text = z.string().trim().min(1).max(3000);
const workspaceInput = z.strictObject({ text, provider: processorId, conversation: workspaceHistory.default([]),
  registerObjects: z.boolean().default(true), modelSettings: modelSelection.optional(),
  /** The chat's own id, which the editor keeps so it can come back to a turn that is running. */
  thread: id.optional() });
const promptInput = z.object({ branch: id.default('main'), baseRevision: id }).extend({
  text, references: z.array(z.unknown()).max(32).default([]),
  attachments: z.array(id).max(12).default([]), proposalId: id.optional(),
  provider: processorId, registerObjects: z.boolean().default(true), modelSettings: modelSelection.optional(),
  objects: objectRegistry.optional(), markedIds: z.array(z.string().max(120)).max(32).optional(),
});

async function harnessName(harnesses: Processors, provider: string) {
  return (await harnesses.list()).find(({ id }) => id === provider)?.name ?? provider;
}

/** What a thread has: the turn running in it, or one interrupted when its editor ended; before a project, its
 *  messages so far, and the project its first game became. */
function threadView({ chat, threads }: ChatContext, key: string): ThreadView {
  const running = chat.running(key);
  const state = threads.read(key);
  const interrupted = !running && state?.turn?.state === 'interrupted' ? state.turn : undefined;
  return {
    ...(running ? { turn: { id: running.id, name: running.name, text: running.text, noteId: running.note?.id, startedAt: running.startedAt } } : {}),
    ...(interrupted ? { interrupted: { text: interrupted.text, harness: interrupted.harness, noteId: interrupted.noteId } } : {}),
    ...(state?.conversation ? { conversation: state.conversation } : {}),
    ...(state?.project ? { project: state.project } : {}),
  };
}

/** /api/chat/…: the chat before a project, a turn's stream, Stop and answers. */
export async function chatRequest(ctx: ChatContext, request: IncomingMessage, response: ServerResponse,
  pathID: string | undefined, action: string | undefined, tail: string | undefined) {
  const { chat, harnesses, projects, threads, tools, activity } = ctx;
  const method = request.method;
  if (!pathID && method === 'POST') {
    const input = workspaceInput.parse(await body(request));
    const key = workspaceThread(input.thread ?? newId());
    if (threads.read(key)?.project) throw new ZirbelError(409, 'This chat already became a game. Open it to go on.');
    if (chat.running(key)) throw new ZirbelError(409, 'A turn is already running in this thread. Stop it, or wait for it to end.');
    if (response.destroyed) return true;
    const turn = chat.start(key, { name: await harnessName(harnesses, input.provider), text: input.text }, async (run, turn) => {
      const result = await inThread(threads, harnesses, key, { id: turn.id, harness: input.provider, text: input.text }, tools,
        run.signal, (harness) => runWorkspaceChat(harness, input.provider, projects, input.text, input.conversation,
          { ...run, selection: input.modelSettings }, input.registerObjects));
      if ('projectId' in result) {
        threads.moveToProject(key, result.projectId);
        // A turn that created a game keeps its activity under the message that started it, in the new project.
        const started = projects.read(result.projectId).notes.findLast(({ role }) => role === 'creator');
        if (started) activity.save(result.projectId, started.id, turn.log);
      } else threads.update(key, { conversation: result.conversation });
      return result;
    });
    await streamTurn(request, response, turn);
    return true;
  }
  if (pathID === 'workspace' && action && !tail && method === 'GET') {
    reply(response, threadView(ctx, workspaceThread(safeId(action))));
    return true;
  }
  if (!pathID || method !== 'POST') return false;
  if (action === 'stop' && !tail) {
    checkOrigin(request, true);
    chat.stop(safeId(pathID));
    reply(response, {});
    return true;
  }
  if (action === 'attach' && !tail) {
    checkOrigin(request, true);
    await streamTurn(request, response, chat.get(safeId(pathID)));
    return true;
  }
  if (action === 'actions' && tail) {
    checkOrigin(request, true);
    chat.answer(safeId(pathID), safeId(tail), await body(request, 64_000));
    reply(response, {});
    return true;
  }
  return false;
}

/** /api/projects/<id>/…: a turn in one of the project's threads, what a thread has, and a turn's kept steps. */
export async function projectChat(ctx: ChatContext, request: IncomingMessage, response: ServerResponse, url: URL,
  projectId: string, action: string | undefined, tail: string | undefined) {
  const { chat, harnesses, projects, threads, tools, activity } = ctx;
  const method = request.method;
  if (action === 'prompt' && method === 'POST' && !tail) {
    const input = promptInput.parse(await body(request));
    if (input.attachments.length) throw new ZirbelError(422, 'Harness chat accepts text and marked references.');
    const references = projects.select(projectId, input.branch, input.baseRevision, input.references);
    const project = projects.read(projectId);
    const base = head(project, input.branch);
    const key = projectThread(projectId, input.branch);
    if (chat.running(key)) throw new ZirbelError(409, 'A turn is already running in this thread. Stop it, or wait for it to end.');
    if (response.destroyed) return true;
    const name = await harnessName(harnesses, input.provider);
    const note = projects.addNote(projectId, { text: input.text, branch: input.branch, role: 'creator', references, attachments: [] });
    const turn = chat.start(key, { name, text: input.text, note }, async (run, turn) => {
      const kept = activity.keep(projectId, note.id, turn.log, () => projects.has(projectId));
      try {
        return await inThread(threads, harnesses, key, { id: turn.id, harness: input.provider, text: input.text, noteId: note.id },
          tools, run.signal, (harness) => runHarnessChat(harness, input.provider, projects, project, base, input, references,
            { ...run, selection: input.modelSettings }));
      } finally { kept.close(); }
    });
    await streamTurn(request, response, turn, 201);
    return true;
  }
  if (action === 'thread' && method === 'GET' && !tail) {
    if (!projects.has(projectId)) throw new ZirbelError(404, 'Project does not exist.');
    reply(response, threadView(ctx, projectThread(projectId, safeId(url.searchParams.get('branch') ?? 'main'))));
    return true;
  }
  if (action === 'activity' && method === 'GET' && tail) {
    if (!projects.has(projectId)) throw new ZirbelError(404, 'Project does not exist.');
    reply(response, activity.read(projectId, safeId(tail)));
    return true;
  }
  return false;
}
