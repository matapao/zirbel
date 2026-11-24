import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatControl } from '../packages/sdk/chat-control.ts';

test('chat commands start play without exponential matching', () => {
  for (const text of ['play', 'Run it!', 'can we start the game now', 'test this game', 'play this', 'launch my playtest'])
    assert.equal(chatControl(text)?.action, 'play', text);
  for (const text of ['play the', 'run this thing', 'play the the game']) assert.notEqual(chatControl(text)?.action, 'play', text);
  // A chat message may hold 3,000 characters; this one once took far longer than a test run.
  const started = performance.now();
  assert.equal(chatControl('run ' + 'this it '.repeat(370) + 'x'), undefined);
  assert.ok(performance.now() - started < 100);
});
