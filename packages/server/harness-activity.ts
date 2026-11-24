import { isAbsolute, relative, resolve } from 'node:path';
import type { RunProgress, SessionUpdate } from 'celler/harness';
import type { ActivityEntry, ChatUpdate } from '../sdk/chat-stream.ts';

const toolStates = { pending: 'pending', in_progress: 'running', completed: 'completed', failed: 'failed' } as const;
const planStates = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed' } as const;
const helperStates = new Map<string, ActivityEntry['state']>([['running', 'running'], ['requires_action', 'waiting'], ['idle', 'idle']]);
type Plan = Extract<SessionUpdate, { sessionUpdate: 'plan' }>['entries'];
const planDetail = (entries: Plan) => entries.slice(0, 16).map(({ content, status }) =>
  `${planStates[status]} · ${content.slice(0, 250)}`).join('\n');

export function harnessActivity(name: string, cwd: string, update: (event: ChatUpdate) => void) {
  const entries = new Map<string, ActivityEntry>();
  let message = 0;
  let previous = '';
  let responding = false;
  let notice = 0;
  const emit = (entry: ActivityEntry) => {
    const prior = entries.get(entry.id);
    if (prior?.title === entry.title && prior.kind === entry.kind && prior.detail === entry.detail &&
        prior.state === entry.state && prior.parent === entry.parent) return;
    entries.set(entry.id, entry);
    update({ type: 'activity', entry });
  };
  const tool = (call: string, change: Partial<ActivityEntry>) => {
    const id = 'tool:' + call;
    emit({ id, kind: 'tool', title: 'Tool', ...entries.get(id), ...change });
  };

  return (event: RunProgress) => {
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
        previous = text.slice(0, 2400);
        // The structured game document is validated and shown in the viewport.
        if (!/^[{`]/.test(text)) emit({ id: 'message:' + message, kind: 'message', title: name, detail: previous });
        break;
      }
      case 'tool':
        tool(event.call ?? event.tool, {
          title: event.tool.slice(0, 160), detail: (event.helper || event.summary).slice(0, 1600),
          ...(event.helper ? { kind: 'helper' } : {}), ...(event.parent ? { parent: 'tool:' + event.parent } : {}),
        });
        break;
      case 'helper-done':
        tool(event.call, { kind: 'helper', state: event.ok ? 'completed' : 'failed' });
        break;
      case 'file': {
        const file = relative(cwd, resolve(cwd, event.file));
        if (file && !file.startsWith('..') && !isAbsolute(file)) {
          const label = file.slice(0, 220);
          emit({ id: 'file:' + label, kind: 'file', title: 'Updated ' + label });
        }
        break;
      }
      case 'update': {
        const native = event.update;
        if (native.sessionUpdate === 'tool_call' || native.sessionUpdate === 'tool_call_update') {
          tool(native.toolCallId, {
            ...(native.title ? { title: native.title.slice(0, 160) } : {}),
            ...(native.status ? { state: toolStates[native.status] } : {}),
          });
        }
        if (native.sessionUpdate === 'plan') {
          const detail = planDetail(native.entries);
          if (detail) emit({ id: 'plan', kind: 'plan', title: 'Plan', detail });
        }
        if (native.sessionUpdate === 'plan_update') {
          const plan = native.plan;
          const detail = plan.type === 'items' ? planDetail(plan.entries) : plan.type === 'markdown' ? plan.content.slice(0, 2400) : '';
          if (detail) emit({ id: 'plan:' + plan.planId, kind: 'plan', title: 'Plan', detail });
        }
        if (native.sessionUpdate === 'subagent_update') {
          const id = 'helper:' + native.sessionId;
          const current = entries.get(id);
          emit({ id, kind: 'helper', title: native.title === undefined ? current?.title ?? 'Subagent' : native.title?.slice(0, 160) || 'Subagent',
            detail: native.description === undefined ? current?.detail : native.description?.slice(0, 1600),
            state: native.state === undefined ? current?.state : helperStates.get(native.state?.state ?? '') });
        }
        if (native.sessionUpdate === 'notice') emit({ id: 'notice:' + ++notice, kind: 'notice', title: native.title.slice(0, 200),
          detail: native.description?.slice(0, 1600), ...(native.severity === 'error' ? { state: 'failed' } : {}) });
        break;
      }
    }
  };
}
