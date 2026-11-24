// A permission request in plain language: its headline, its scope and the details behind it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentAsk } from 'celler/harness';
import { describeAsk, programsOf, SANDBOXED } from '../packages/server/ask-summary.ts';

const folder = '/work/zirbel/turn-1';
const ask = (tool: string, input: unknown, extra: Partial<AgentAsk> = {}): AgentAsk => ({
  call: 'c',
  tool,
  title: tool,
  input,
  options: [],
  ...extra,
});

test('a shell request reads as the agent described it, with the command only in the details', () => {
  const command = 'cd ' + folder + ' && sed -n 1,40p src/draw.c && cc -o draw src/draw.c | node check.js; cp draw out/';
  const described = describeAsk(
    ask(
      'Bash',
      { command, description: 'Render only the ship draws to find the black polygon' },
      { kind: 'execute', title: command },
    ),
    { folder },
  );
  assert.equal(described.summary, 'Render only the ship draws to find the black polygon');
  assert.equal(described.scope, 'sandboxed');
  assert.equal(described.reach, SANDBOXED);
  assert.equal(described.command, command);
  assert.equal(described.folder, '.');
  assert.equal(described.summary.includes('sed'), false);

  const bare = describeAsk(ask('Bash', { command }, { title: command }), { folder });
  assert.equal(bare.summary, 'Run a command: sed, cc, node, cp');
  assert.equal(describeAsk(ask('Bash', { command: 'ls', description: 'x'.repeat(400) })).summary.length, 200);
  // Codex's shell: an argument list, a script for the shell, and its own working folder.
  const codex = describeAsk(
    ask('shell', { command: ['bash', '-lc', 'FOO=1 ./build.sh && /usr/bin/env node a.js'], workdir: folder + '/game' }),
    { folder },
  );
  assert.equal(codex.summary, 'Run a command: build.sh, env');
  assert.equal(codex.command, 'FOO=1 ./build.sh && /usr/bin/env node a.js');
  assert.equal(codex.folder, 'game');
  assert.deepEqual(programsOf('make || make test; git status | head -3 && make'), ['make', 'git', 'head']);
  assert.equal(describeAsk(ask('exec_command', {})).summary, 'Run a command: exec_command');
});

test('an edit names its file in the turn folder and carries the change', () => {
  const edit = describeAsk(
    ask('Edit', { file_path: folder + '/src/game.js', old_string: 'speed = 1', new_string: 'speed = 2' }),
    { folder },
  );
  assert.equal(edit.summary, 'Edit src/game.js');
  assert.equal(edit.file, 'src/game.js');
  assert.equal(edit.scope, 'sandboxed');
  assert.equal(edit.diff, '--- src/game.js\n+++ src/game.js\n@@ line 1 @@\n-speed = 1\n+speed = 2');
  const write = describeAsk(ask('Write', { file_path: '/elsewhere/notes.txt', content: 'hello' }), { folder });
  assert.equal(write.summary, 'Edit /elsewhere/notes.txt');
  assert.match(write.diff ?? '', /\+hello/);
  assert.equal(
    describeAsk(ask('MultiEdit', { file_path: 'a.js', edits: [{ old_string: 'a', new_string: 'b' }] })).diff?.includes(
      '+b',
    ),
    true,
  );
  assert.equal(
    describeAsk(ask('apply_patch', { input: '*** Begin Patch\n*** End Patch' })).diff,
    '*** Begin Patch\n*** End Patch',
  );
  assert.equal(describeAsk(ask('NotebookEdit', {}, { kind: 'edit' })).summary, 'Edit a file');
});

test('an MCP tool is outside the sandbox and names its server', () => {
  const own = describeAsk(ask('mcp__zirbel__propose_change', {}, { title: 'mcp__zirbel__propose_change' }));
  assert.equal(own.summary, 'propose change (zirbel)');
  assert.equal(own.scope, 'outside');
  assert.equal(own.reach, 'Changes your game');
  const other = describeAsk(ask('mcp__github__create_issue', {}, { title: 'Create an issue' }));
  assert.equal(other.summary, 'Create an issue (github)');
  assert.equal(other.reach, 'Reaches github');
});

test('any other request is a short sentence from its kind and tool', () => {
  assert.equal(
    describeAsk(ask('Read', { file_path: folder + '/a.txt' }, { kind: 'read' }), { folder }).summary,
    'Read a.txt',
  );
  assert.equal(describeAsk(ask('Delete', {}, { kind: 'delete' })).summary, 'Delete a file');
  assert.equal(describeAsk(ask('Grep', {}, { kind: 'search' })).summary, 'Search with Grep');
  assert.equal(describeAsk(ask('WebFetch', {}, { kind: 'fetch' })).summary, 'Fetch a page with WebFetch');
  assert.equal(describeAsk(ask('TodoWrite', null)).summary, 'Use TodoWrite');
  assert.equal(describeAsk(ask('', [])).summary, 'Use a tool');
  assert.equal(describeAsk(ask('Glob', {})).scope, 'sandboxed');
});
