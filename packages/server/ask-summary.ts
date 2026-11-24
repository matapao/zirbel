// A harness's permission request in plain language: a headline that says what it wants to do, whether that stays in
// the turn's sandbox, and the command, file or change for the details. The harness's own title for a shell command is
// the raw command, and it does not say why it asks, so the headline comes from what the request carries.
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { AgentAsk } from 'celler/harness';
import type { ActionReach, PermissionRequest } from '../sdk/chat-stream.ts';
import { textDiff } from './text-diff.ts';

const HEADLINE = 200;
const COMMAND_LIMIT = 12_000;
const DIFF_LIMIT = 64 * 1024;
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'local_shell', 'exec_command', 'container.exec']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
/** The editor's own MCP server, as it names itself. */
const OWN_SERVER = 'zirbel';
export const SANDBOXED = 'Runs in this turn’s folder on this computer, with no network and no access to your files.';

/** Where a request comes from: the turn's working folder and the harness that asks. */
export type AskPlace = { folder?: string; harness?: string };

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const cap = (value: string, room: number) => (value.length <= room ? value : value.slice(0, room - 1) + '…');
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A path as the person reads it: relative to the turn's folder when it is inside it. */
function inFolder(path: string, folder?: string) {
  if (!folder) return isAbsolute(path) ? basename(path) : path;
  const inside = relative(folder, resolve(folder, path));
  return inside === '' ? '.' : inside.startsWith('..') || isAbsolute(inside) ? path : inside;
}

function shellCommand(input: Record<string, unknown>, title: string) {
  const command = input.command ?? input.cmd;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
    // ["bash", "-lc", "…"]: the script is the last part.
    const [shell = '', flag = '', script = ''] = command;
    if (command.length === 3 && /^(?:ba|z)?sh$/.test(basename(shell)) && /^-l?c$/.test(flag)) return script;
    return command.join(' ');
  }
  return title;
}

/** The programs a shell command runs, by the first word of each part between &&, ||, ; and |. Display only. */
export function programsOf(command: string) {
  const names: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const word = segment
      .trim()
      .replace(/^[({!\s]+/, '')
      .split(/\s+/)
      .find((part) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(part));
    const name = word?.replace(/^['"]+|['"]+$/g, '');
    const program = name?.includes('/') ? basename(name) : name;
    if (program && !names.includes(program)) names.push(program);
  }
  return names;
}

function programList(names: string[]) {
  let list = '';
  for (const name of names) {
    const next = list ? list + ', ' + name : name;
    if (next.length > HEADLINE - 20) return list + ', …';
    list = next;
  }
  return list;
}

/** A leading `cd <folder> &&`: the folder, and the command after it. */
function leadingFolder(command: string) {
  const match = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/.exec(command);
  return match ? { folder: match[1]!.replace(/^['"]|['"]$/g, ''), rest: command.slice(match[0].length) } : undefined;
}

function shell(question: AgentAsk, input: Record<string, unknown>, place: AskPlace): PermissionRequest {
  const command = shellCommand(input, question.title);
  const stated = text(input.cwd) ?? text(input.workdir) ?? text(input.working_directory);
  const leading = leadingFolder(command);
  const folder = stated ?? leading?.folder;
  const description = text(input.description);
  const programs = programList(programsOf(leading && !stated ? leading.rest : command));
  return {
    summary: description ? cap(description, HEADLINE) : programs ? 'Run a command: ' + programs : 'Run a command',
    tool: question.tool,
    command: cap(command, COMMAND_LIMIT),
    ...(folder ? { folder: cap(inFolder(folder, place.folder), 1000) } : {}),
  };
}

function editDiff(file: string, input: Record<string, unknown>) {
  if (typeof input.new_string === 'string')
    return textDiff(file, typeof input.old_string === 'string' ? input.old_string : '', input.new_string);
  if (Array.isArray(input.edits))
    return (
      input.edits
        .map(record)
        .filter((edit) => typeof edit.new_string === 'string')
        .map((edit) =>
          textDiff(file, typeof edit.old_string === 'string' ? edit.old_string : '', edit.new_string as string),
        )
        .join('\n') || undefined
    );
  if (typeof input.content === 'string') return textDiff(file, '', input.content);
  if (typeof input.new_source === 'string') return textDiff(file, '', input.new_source);
  const patch = text(input.patch) ?? text(input.input);
  return patch?.startsWith('*** Begin Patch') ? patch : undefined;
}

function edit(question: AgentAsk, input: Record<string, unknown>, place: AskPlace): PermissionRequest {
  const path = text(input.file_path) ?? text(input.path) ?? text(input.notebook_path);
  const file = path ? cap(inFolder(path, place.folder), 1000) : undefined;
  const diff = editDiff(file ?? 'file', input);
  return {
    summary: file ? cap('Edit ' + file, HEADLINE) : 'Edit a file',
    tool: question.tool,
    ...(file ? { file } : {}),
    ...(diff ? { diff: cap(diff, DIFF_LIMIT) } : {}),
  };
}

function readable(name: string) {
  return name.replace(/[_-]+/g, ' ').trim();
}

const verbs: Record<string, string> = {
  read: 'Read',
  delete: 'Delete',
  move: 'Move',
  search: 'Search with',
  fetch: 'Fetch a page with',
  think: 'Think with',
  switch_mode: 'Switch mode with',
};

/** The plain headline, scope and details of a permission request. */
export function describeAsk(question: AgentAsk, place: AskPlace = {}): PermissionRequest & ActionReach {
  const input = record(question.input);
  const tool = question.tool.slice(0, 160);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(question.tool);
  if (mcp) {
    const [, server = '', name = ''] = mcp;
    const title = text(question.title);
    const label = title && !title.includes('mcp__') && title !== name ? title : readable(name);
    return {
      summary: cap(label + ' (' + server + ')', HEADLINE),
      tool,
      scope: 'outside',
      reach: server === OWN_SERVER ? 'Changes your game' : cap('Reaches ' + server, HEADLINE),
    };
  }
  const sandboxed = { scope: 'sandboxed', reach: SANDBOXED } as const;
  if (SHELL_TOOLS.has(question.tool) || question.kind === 'execute')
    return { ...shell(question, input, place), ...sandboxed, tool };
  if (EDIT_TOOLS.has(question.tool) || question.kind === 'edit')
    return { ...edit(question, input, place), ...sandboxed, tool };
  const path = text(input.file_path) ?? text(input.path);
  const target = path ? ' ' + inFolder(path, place.folder) : '';
  const verb = verbs[question.kind ?? ''];
  const summary =
    verb && (question.kind === 'read' || question.kind === 'delete' || question.kind === 'move')
      ? verb + (target || ' a file')
      : verb
        ? verb + ' ' + readable(tool || 'a tool')
        : 'Use ' + (readable(tool) || 'a tool');
  return {
    summary: cap(summary, HEADLINE),
    tool,
    ...(path ? { file: cap(inFolder(path, place.folder), 1000) } : {}),
    ...sandboxed,
  };
}
