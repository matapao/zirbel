// A harness run's progress as the turn's steps: what the agent writes, each tool call with what it is for (a call to
// one of the turn's MCP servers by that server and tool), the helpers it starts, the files it changes and the settings
// its run started with. The reply itself is the turn's result, never a step.
import { isAbsolute, relative, resolve } from 'node:path';
import type { RunProgress } from 'celler/harness';
import { boundEntry } from '../sdk/activity.ts';
import type { ActivityEntry, ChatUpdate } from '../sdk/chat-stream.ts';

/** A message the harness is still writing goes out at most this often; the turn's end sends its last state. */
const MESSAGE_INTERVAL = 200;

export function harnessActivity(name: string, cwd: string, update: (event: ChatUpdate) => void) {
  const entries = new Map<string, ActivityEntry>();
  let message = 0;
  let previous = '';
  let responding = false;
  let pendingMessage: ActivityEntry | undefined;
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let sentAt = 0;
  const send = (entry: ActivityEntry) => {
    const prior = entries.get(entry.id);
    if (
      prior?.title === entry.title &&
      prior.kind === entry.kind &&
      prior.detail === entry.detail &&
      prior.state === entry.state &&
      prior.parent === entry.parent
    )
      return;
    entries.set(entry.id, entry);
    update({ type: 'activity', entry });
  };
  const flush = () => {
    clearTimeout(messageTimer);
    messageTimer = undefined;
    const waiting = pendingMessage;
    pendingMessage = undefined;
    if (waiting) {
      sentAt = Date.now();
      send(waiting);
    }
  };
  // Steps keep their order: a message still being written goes out before any other step.
  const emit = (entry: ActivityEntry) => {
    const bounded = boundEntry(entry);
    if (bounded.kind !== 'message') {
      flush();
      send(bounded);
      return;
    }
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
        // The reply's JSON is the turn's result, which the thread shows on its own.
        if (!/^[{`]/.test(text)) emit({ id: 'message:' + message, kind: 'message', title: name, detail: text });
        break;
      }
      case 'tool': {
        const { mcp } = event;
        tool(event.call ?? event.tool, {
          title: mcp ? mcp.tool + ' (' + mcp.server + ')' : event.tool,
          detail: event.helper || event.summary || undefined,
          ...(event.helper ? { kind: 'helper' } : {}),
          ...(event.parent ? { parent: 'tool:' + event.parent } : {}),
        });
        break;
      }
      case 'helper-done':
        tool(event.call, { kind: 'helper', state: event.ok ? 'completed' : 'failed' });
        break;
      case 'file': {
        const file = relative(cwd, resolve(cwd, event.file));
        if (file && !file.startsWith('..') && !isAbsolute(file))
          emit({ id: 'file:' + file, kind: 'file', title: 'Updated ' + file });
        break;
      }
      case 'settings':
        if (event.settings.length)
          emit({
            id: 'settings',
            kind: 'notice',
            title: name + ' · ' + event.settings.map(({ name: setting, value }) => setting + ': ' + value).join(' · '),
          });
        break;
    }
  };
  return Object.assign(report, { flush });
}
