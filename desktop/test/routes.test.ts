import assert from 'node:assert/strict';
import test from 'node:test';
import { editorOrigin, mayNavigate, mayOpen, place } from '../src/routes.js';

const editor = 'http://127.0.0.1:41000';

test('only a loopback http address with a port is taken as the editor', () => {
  assert.equal(editorOrigin('http://127.0.0.1:41000'), editor);
  assert.equal(editorOrigin('http://127.0.0.1:41000/'), editor);
  const refused = [
    'https://127.0.0.1:41000',
    'http://example.com:41000',
    'http://127.0.0.1',
    'http://user:secret@127.0.0.1:41000',
    'http://127.0.0.1.example.com:41000',
    'file:///tmp/editor',
    'not an address',
  ];
  for (const address of refused) assert.equal(editorOrigin(address), undefined, address);
});

test("the editor's window stays on the editor's origin", () => {
  assert.equal(place(editor + '/?project=1#x', editor), 'editor');
  assert.ok(mayNavigate(place(editor + '/api/health', editor), true));
  for (const url of ['http://127.0.0.1:41001/join/a', 'http://localhost:41000/', 'https://example.com/', 'about:blank'])
    assert.ok(!mayNavigate(place(url, editor), true), url);
});

test('child windows open on the editor, a loopback player or a blank page, and may navigate there', () => {
  const allowed = [
    '',
    'about:blank',
    editor + '/x',
    'http://127.0.0.1:41001/join/a#invite',
    'http://localhost:4174/',
    'http://[::1]:4174/',
  ];
  for (const url of allowed) {
    assert.ok(mayOpen(place(url, editor)), url);
    assert.ok(mayNavigate(place(url, editor), false), url);
  }
});

test('other web addresses are for the system browser, and other schemes for nothing', () => {
  const web = [
    'https://example.com/',
    'http://192.168.1.20:4174/join/a',
    'https://127.0.0.1:41000/',
    'http://127.0.0.1.example.com:41000/',
    'http://127.0.0.1:41000@example.com/',
  ];
  for (const url of web) assert.equal(place(url, editor), 'web', url);
  const other = [
    'file:///etc/hosts',
    'javascript:alert(1)',
    'data:text/html,hi',
    'mailto:a@example.com',
    'chrome://gpu',
    'x',
  ];
  for (const url of other) assert.equal(place(url, editor), 'other', url);
  for (const where of ['web', 'other'] as const) {
    assert.ok(!mayOpen(where));
    assert.ok(!mayNavigate(where, false) && !mayNavigate(where, true));
  }
});

test('the tests run in UTC', () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC');
});
