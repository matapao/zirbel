// What makes every run of the tests give the same answer: the time zone, and no Web Storage shared across what each test
// means as a tab of its own (test/setup.ts). The order is random, seeded:
// node:test prints the seed, and `--test-random-seed=<seed>` runs that order again.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('the tests run in UTC', () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC');
  assert.equal(new Date(0).getHours(), 0);
});

test('the tests share no Web Storage between the screens and pads they open', () => {
  assert.equal(typeof globalThis.sessionStorage, 'undefined');
  assert.equal(typeof globalThis.localStorage, 'undefined');
});
