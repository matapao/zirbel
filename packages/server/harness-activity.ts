import { isAbsolute, relative, resolve } from 'node:path';
import type { RunProgress, SessionUpdate } from 'celler/harness';
import { boundEntry } from '../sdk/activity.ts';
import type { ActivityEntry, ChatUpdate } from '../sdk/chat-stream.ts';
import { textDiff } from './text-diff.ts';

const toolStates = { pending: 'pending', in_progress: 'running', completed: 'completed', failed: 'failed' } as const;
const planStates = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed' } as const;
const helperStates = new Map<string, ActivityEntry['state']>([['running', 'running'], ['requires_action', 'waiting'], ['idle', 'idle']]);
type Plan = Extract<SessionUpdate, { sessionUpdate: 'plan' }>['entries'];
type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>;
const planDetail = (entries: Plan) => entries.map(({ content, status }) => `${planStates[status]} · ${content}`).join('\n');
/** A message the harness is still writing goes out at most this often; the turn's end sends its last state. */
const MESSAGE_INTERVAL = 200;

/** What a native tool call carries beyond its title: the command it runs, its output and the changes it makes. */
type CallParts = { summary?: string; command?: string; output?: string; diffs: Map<string, string> };

function commandOf(raw: unknown) {
  const command = raw && typeof raw === 'object' ? (raw as { command?: unknown }).command : undefined;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return command.join(' ');
}

export function harnessActivity(name: string, cwd: string, update: (event: ChatUpdate) => void) {
  const entries = new Map<string, ActivityEntry>();
  const calls = new Map<string, CallParts>();
  let message = 0;
  let previous = '';
  let responding = false;
  let notice = 0;
  let pendingMessage: ActivityEntry | undefined;
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let sentAt = 0;
  const send = (entry: ActivityEntry) => {
    const prior = entries.get(entry.id);
    if (prior?.title === entry.title && prior.kind === entry.kind && prior.detail === entry.detail && prior.diff === entry.diff &&
        prior.state === entry.state && prior.parent === entry.parent) return;
    entries.set(entry.id, entry);
    update({ type: 'activity', entry });
  };
  const flush = () => {
    clearTimeout(messageTimer);
    messageTimer = undefined;
    const waiting = pendingMessage;
    pendingMessage = undefined;
    if (waiting) { sentAt = Date.now(); send(waiting); }
  };
  // Steps keep their order: a message still being written goes out before any other step.
  const emit = (entry: ActivityEntry) => {
    const bounded = boundEntry(entry);
    if (bounded.kind !== 'message') { flush(); send(bounded); return; }
    if (pendingMessage && pendingMessage.id !== bounded.id) flush();
    pendingMessage = bounded;
    const wait = MESSAGE_INTERVAL - (Date.now() - sentAt);
    if (wait <= 0) flush();
    else messageTimer ??= setTimeout(flush, wait);
  };
  const tool = (call: string, change: Partial<ActivityEntry>) => {
    const id = 'tool:' + call;
    emit({ id, kind: 'tool', title: 'Tool', ...entries.get(id), ...change });
  };
  const parts = (call: string) => {
    let known = calls.get(call);
    if (!known) calls.set(call, known = { diffs: new Map() });
    return known;
  };
  const detailOf = ({ summary, command, output }: CallParts) =>
    [summary, command && command !== summary ? '$ ' + command : undefined, output].filter(Boolean).join('\n\n') || undefined;
  const diffOf = ({ diffs }: CallParts) => diffs.size ? [...diffs.values()].join('\n') : undefined;
  const native = (update: ToolUpdate) => {
    const known = parts(update.toolCallId);
    const command = (update.kind ?? 'execute') === 'execute' ? commandOf(update.rawInput) : undefined;
    if (command) known.command = command;
    const text: string[] = [];
    for (const item of update.content ?? []) {
      if (item.type === 'diff') known.diffs.set(item.path, textDiff(relative(cwd, resolve(cwd, item.path)) || item.path, item.oldText, item.newText));
      if (item.type === 'content' && item.content.type === 'text') text.push(item.content.text);
    }
    if (text.length) known.output = text.join('\n');
    tool(update.toolCallId, {
      ...(update.title ? { title: update.title } : {}),
      ...(update.status ? { state: toolStates[update.status] } : {}),
      ...(detailOf(known) ? { detail: detailOf(known) } : {}),
      ...(diffOf(known) ? { diff: diffOf(known) } : {}),
    });
  };

  const report = (event: RunProgress) => {
    switch (event.type) {
      case 'session':
        update({ type: 'progress', phase: 'running' });
        break;
      case 'text': {
        const text = event.text.trimStart();
        if (!text) break;
        if (!responding) update({ type: 'progress', phase: 'responding' });
        responding = true;
        if (!text.startsWith(previous)) message++;
        previous = text;
        // The structured game document is validated and shown in the viewport.
        if (!/^[{`]/.test(text)) emit({ id: 'message:' + message, kind: 'message', title: name, detail: text });
        break;
      }
      case 'tool': {
        const call = event.call ?? event.tool;
        const known = parts(call);
        known.summary = event.helper || event.summary;
        tool(call, {
          title: event.tool, ...(detailOf(known) ? { detail: detailOf(known) } : {}),
          ...(event.helper ? { kind: 'helper' } : {}), ...(event.parent ? { parent: 'tool:' + event.parent } : {}),
        });
        break;
      }
      case 'helper-done':
        tool(event.call, { kind: 'helper', state: event.ok ? 'completed' : 'failed' });
        break;
      case 'file': {
        const file = relative(cwd, resolve(cwd, event.file));
        if (file && !file.startsWith('..') && !isAbsolute(file)) emit({ id: 'file:' + file, kind: 'file', title: 'Updated ' + file });
        break;
      }
      case 'update': {
        const change = event.update;
        if (change.sessionUpdate === 'tool_call' || change.sessionUpdate === 'tool_call_update') native(change);
        if (change.sessionUpdate === 'plan') {
          const detail = planDetail(change.entries);
          if (detail) emit({ id: 'plan', kind: 'plan', title: 'Plan', detail });
        }
        if (change.sessionUpdate === 'plan_update') {
          const plan = change.plan;
          const detail = plan.type === 'items' ? planDetail(plan.entries) : plan.type === 'markdown' ? plan.content : '';
          if (detail) emit({ id: 'plan:' + plan.planId, kind: 'plan', title: 'Plan', detail });
        }
        if (change.sessionUpdate === 'subagent_update') {
          const id = 'helper:' + change.sessionId;
          const current = entries.get(id);
          emit({ id, kind: 'helper', title: change.title === undefined ? current?.title ?? 'Subagent' : change.title || 'Subagent',
            detail: change.description === undefined ? current?.detail : change.description ?? undefined,
            state: change.state === undefined ? current?.state : helperStates.get(change.state?.state ?? '') });
        }
        if (change.sessionUpdate === 'notice') emit({ id: 'notice:' + ++notice, kind: 'notice', title: change.title,
          detail: change.description ?? undefined, ...(change.severity === 'error' ? { state: 'failed' } : {}) });
        break;
      }
    }
  };
  return Object.assign(report, { flush });
}
