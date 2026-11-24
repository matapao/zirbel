// A harness turn's steps: the bounds every step and turn keeps, the Node editor's saved activity, and how the
// harness's native events become steps.
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENTRY_LIMIT, TITLE_LIMIT, TURN_LIMIT, TURN_STEPS, TurnLog, boundEntry } from '../packages/sdk/activity.ts';
import type { ActivityEntry, ChatUpdate } from '../packages/sdk/chat-stream.ts';
import { ActivityStore } from '../packages/server/activity-log.ts';
import { harnessActivity } from '../packages/server/harness-activity.ts';
import { textDiff } from '../packages/server/text-diff.ts';
import { install } from './helpers.ts';

const step = (id: string, detail = '', kind: ActivityEntry['kind'] = 'tool'): ActivityEntry => ({
  id,
  kind,
  title: 'Step ' + id,
  detail,
});

test('a step keeps up to 64 KB and a turn up to 2 MB, letting its oldest steps go first', () => {
  const long = boundEntry({
    id: 'x'.repeat(900),
    kind: 'message',
    title: 't'.repeat(5000),
    detail: 'd'.repeat(ENTRY_LIMIT),
    diff: '+line',
  });
  assert.equal(long.id.length, 400);
  assert.equal(long.title.length, TITLE_LIMIT);
  assert.equal(long.title.length + (long.detail?.length ?? 0) + (long.diff?.length ?? 0) <= ENTRY_LIMIT, true);
  assert.equal(long.diff, undefined);
  // Text well past the old 2,400-character cut is kept whole.
  assert.equal(boundEntry(step('a', 'z'.repeat(20_000))).detail?.length, 20_000);

  const log = new TurnLog();
  const big = 'b'.repeat(ENTRY_LIMIT - 100);
  let removed: string[] = [];
  for (let index = 0; index < 40; index++) removed = [...removed, ...log.add(step(String(index), big))];
  assert.ok(log.size <= TURN_LIMIT);
  assert.deepEqual(removed.slice(0, 2), ['0', '1']);
  assert.equal(log.dropped, removed.length);
  assert.equal(log.entries.has('39'), true);
  // An update keeps its place and its size counts once.
  const before = [...log.entries.keys()];
  log.add({ ...step('39', 'short'), state: 'completed' });
  assert.deepEqual([...log.entries.keys()], before);
  assert.equal(log.entries.get('39')?.state, 'completed');

  const many = new TurnLog();
  for (let index = 0; index < TURN_STEPS + 5; index++) many.add(step(String(index)));
  assert.equal(many.entries.size, TURN_STEPS);
  assert.equal(many.dropped, 5);
  const copy = TurnLog.from(many.record());
  assert.equal(copy.entries.size, TURN_STEPS);
  assert.equal(copy.dropped, 5);
});

test('the Node editor keeps each turn apart from the project file and validates it on read', (t) => {
  const { root } = install(t);
  const store = new ActivityStore(root);
  const project = 'game-1';
  const note = '0f6c8d0e-6b8a-4c55-9a3e-2c7f5a1b9d10';
  assert.equal(store.save(project, note, new TurnLog()), false);
  assert.throws(() => store.read(project, note), /kept no activity/);
  const log = new TurnLog();
  log.add(step('plan', 'Completed · Design', 'plan'));
  log.add({ ...step('tool:1', 'npm test'), diff: '--- a\n+++ a\n-old\n+new', state: 'completed' });
  assert.equal(store.save(project, note, log), true);
  assert.deepEqual(readdirSync(join(root, 'activity')), [project + '.' + note + '.json']);
  assert.deepEqual(store.read(project, note), { version: 1, ...log.record() });
  assert.throws(() => store.read('../escape', note));

  const file = join(root, 'activity', project + '.' + note + '.json');
  writeFileSync(file, '{"version":1,"entries":[{"id":"x","title":"t","kind":"shell"}],"dropped":0}');
  assert.throws(() => store.read(project, note), /not valid/);
  writeFileSync(file, '{not json');
  assert.throws(() => store.read(project, note), /could not be read/);
  writeFileSync(file, ' '.repeat(TURN_LIMIT * 4 + 1));
  assert.throws(() => store.read(project, note), /larger than a turn keeps/);
});

test('harness events become steps with their commands, output and diffs, without the game document', () => {
  const events: ChatUpdate[] = [];
  const cwd = '/work/turn-1';
  const report = harnessActivity('Codex', cwd, (event) => events.push(event));
  const long = 'A long thought. '.repeat(400);
  report({ type: 'text', text: long });
  report({
    type: 'update',
    update: {
      sessionUpdate: 'plan',
      entries: Array.from({ length: 20 }, (_, index) => ({
        content: 'Step ' + index + ' '.repeat(300) + 'end',
        priority: 'medium',
        status: index ? 'pending' : 'completed',
      })),
    },
  });
  report({ type: 'tool', tool: 'Bash', call: 'run', summary: 'Run the tests' });
  report({
    type: 'update',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'run',
      kind: 'execute',
      status: 'completed',
      rawInput: { command: 'npm test' },
      content: [{ type: 'content', content: { type: 'text', text: '3 passing' } }],
    },
  });
  report({
    type: 'update',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'edit',
      title: 'Edit index.html',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: cwd + '/index.html', oldText: 'a\nb\nc', newText: 'a\nB\nc' }],
    },
  });
  report({ type: 'text', text: '{"action":"edit","game":{"html":"<p>"}}' });
  report({ type: 'file', file: '/elsewhere/secret.txt' });
  report.flush();
  const steps = new Map(events.flatMap((event) => (event.type === 'activity' ? [[event.entry.id, event.entry]] : [])));
  assert.equal(steps.get('message:0')?.detail?.length, long.length);
  assert.equal(steps.get('plan')?.detail?.split('\n').length, 20);
  assert.match(steps.get('plan')?.detail ?? '', /end$/);
  assert.equal(steps.get('tool:run')?.detail, 'Run the tests\n\n$ npm test\n\n3 passing');
  assert.equal(steps.get('tool:edit')?.diff, '--- index.html\n+++ index.html\n@@ line 1 @@\n a\n-b\n+B\n c');
  assert.equal(
    [...steps.values()].some(({ detail }) => detail?.includes('"action"')),
    false,
  );
  assert.equal(
    [...steps.keys()].some((id) => id.startsWith('file:')),
    false,
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'progress').map((event) => event.type === 'progress' && event.phase),
    ['responding'],
  );
});

test('a message the harness is still writing goes out at most every 200 ms, and in full at the end', async () => {
  const events: ChatUpdate[] = [];
  const report = harnessActivity('Codex', '/work', (event) => events.push(event));
  const messages = () =>
    events.flatMap((event) =>
      event.type === 'activity' && event.entry.kind === 'message' ? [event.entry.detail] : [],
    );
  report({ type: 'text', text: 'One' });
  report({ type: 'text', text: 'One two' });
  report({ type: 'text', text: 'One two three' });
  assert.deepEqual(messages(), ['One']);
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.deepEqual(messages(), ['One', 'One two three']);
  report({ type: 'text', text: 'One two three four' });
  report({ type: 'tool', tool: 'Read', call: 'read', summary: 'Read a file' });
  // A step of another kind sends the message first, so the steps stay in order.
  const kinds = events.flatMap((event) => (event.type === 'activity' ? [event.entry.kind] : []));
  assert.deepEqual(kinds, ['message', 'message', 'message', 'tool']);
  report.flush();
});

test('a diff keeps the changed lines and a little context', () => {
  assert.equal(textDiff('a.txt', null, 'new'), '--- a.txt\n+++ a.txt\n@@ line 1 @@\n+new');
  const before = Array.from({ length: 50 }, (_, index) => 'line ' + index).join('\n');
  const after = before.replace('line 25', 'line twenty-five');
  assert.equal(
    textDiff('b', before, after),
    '--- b\n+++ b\n@@ line 24 @@\n line 23\n line 24\n-line 25\n+line twenty-five\n line 26\n line 27',
  );
});
