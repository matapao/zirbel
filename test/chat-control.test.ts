import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatControl } from '../packages/sdk/chat-control.ts';
import { MAX_SUGGESTIONS, SUGGESTIONS } from '../packages/web/state.ts';

test('chat answers undo, apply and discard itself, and leaves playing to the game', () => {
  for (const text of ['undo', 'Undo that.', 'revert my last change', 'please undo'])
    assert.equal(chatControl(text)?.action, 'undo', text);
  assert.deepEqual(chatControl('Apply option 2'), { action: 'apply', index: 1 });
  assert.deepEqual(chatControl('accept it'), { action: 'apply', index: undefined });
  assert.deepEqual(chatControl('reject proposal b'), { action: 'discard', index: 1 });
  // There are no modes to switch: these go to the harness as ordinary messages.
  for (const text of [
    'play',
    'Play it!',
    'stop',
    'stop the game',
    'go back to the editor',
    'preview option 1',
    'apply and play',
  ])
    assert.equal(chatControl(text), undefined, text);
});

test('a long message is matched without exponential backtracking', () => {
  // A chat message may hold 3,000 characters.
  const started = performance.now();
  assert.equal(chatControl('apply ' + 'this it '.repeat(370) + 'x'), undefined);
  assert.equal(chatControl('undo ' + 'that '.repeat(590)), undefined);
  assert.ok(performance.now() - started < 100);
});

test('suggested messages ask about or explain the game, and never propose content', () => {
  assert.deepEqual([...SUGGESTIONS], ['Describe this game', 'Suggest two changes', 'Explain the controls']);
  assert.equal(MAX_SUGGESTIONS, 3);
});
