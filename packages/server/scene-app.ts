// This resource runs in the MCP client's isolated frame. The project grant stays with the client.
import type { Revision } from '../sdk/contracts.ts';

export const sceneResource = {
  uri: 'ui://zirbel/scene',
  name: 'Scene',
  mimeType: 'text/html;profile=mcp-app',
};

function sceneApp() {
  const byId = (id: string) => document.getElementById(id)!;
  const form = byId('scene') as HTMLFormElement;
  const branch = byId('branch') as HTMLInputElement;
  const button = byId('read') as HTMLButtonElement;
  let nextId = 2;
  let pending: number | undefined;

  // An MCP Apps view cannot know its host frame's origin; it sends only JSON-RPC tool calls.
  // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- no origin to name
  const send = (message: object) => parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const fail = (message: string) => {
    byId('result').hidden = true;
    byId('error').textContent = message;
  };
  const show = (result: { isError?: boolean; content?: { type: string; text?: string }[] }) => {
    const value = result.content?.find(block => block.type === 'text')?.text;
    if (result.isError || !value) { fail(value || 'The scene could not be read.'); return; }
    try {
      const revision = JSON.parse(value) as Revision;
      if (typeof revision.id !== 'string' || typeof revision.label !== 'string') throw new Error();
      byId('revision-label').textContent = revision.label;
      byId('revision-id').textContent = revision.id;
      byId('source').textContent = revision.game?.html ?? '';
      byId('game').hidden = !revision.game;
      const list = byId('objects');
      list.replaceChildren(...(revision.scene?.objects ?? []).map(object => {
        const item = document.createElement('li');
        item.textContent = object.name;
        return item;
      }));
      byId('result').hidden = false;
      byId('error').textContent = '';
    } catch { fail('The connector returned an unreadable revision.'); }
  };

  // MCP Apps gives the view no fixed host origin; the sender must be the parent frame and the message JSON-RPC.
  // nosemgrep: javascript.browser.security.insufficient-postmessage-origin-validation.insufficient-postmessage-origin-validation -- the sender is checked
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== parent || message?.jsonrpc !== '2.0') return;
    if (message.id === 1 && message.result) {
      send({ method: 'ui/notifications/initialized', params: {} });
      button.disabled = false;
    } else if (message.method === 'ui/notifications/tool-input') {
      branch.value = message.params?.arguments?.branch ?? 'main';
    } else if (message.method === 'ui/notifications/tool-result') {
      show(message.params);
    } else if (pending !== undefined && message.id === pending) {
      pending = undefined;
      button.disabled = false;
      if (message.error) fail(message.error.message || 'The scene could not be read.');
      else show(message.result);
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (button.disabled || !branch.value.trim()) return;
    button.disabled = true;
    pending = nextId++;
    send({ id: pending, method: 'tools/call', params: { name: 'read_scene', arguments: { branch: branch.value.trim() } } });
  });
  send({ id: 1, method: 'ui/initialize', params: { appInfo: { name: 'Zirbel', version: '0.1.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' } });
}

export const sceneDocument = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;font:14px/1.45 Inter,system-ui,sans-serif;color:#eef2ed;background:#1b1f1f}
*{box-sizing:border-box}body{margin:0;padding:.8rem}form{display:flex;flex-wrap:wrap;gap:.5rem;align-items:end}
label{display:grid;gap:.25rem;flex:1;min-width:8rem;color:#a6b1aa}
button,input{font:inherit;color:inherit;background:#222828;border:1px solid #343d39;border-radius:.45rem;padding:.4rem .65rem}
button{cursor:pointer}button:disabled{opacity:.6}#result{margin-top:.8rem}
#revision-id{color:#a6b1aa;font-family:monospace;overflow-wrap:anywhere}pre{max-height:16rem;overflow:auto}
ul:empty,[hidden]{display:none}
</style></head><body>
<form id="scene"><label>Branch<input id="branch" required maxlength="80" value="main"></label><button id="read" disabled>Read scene</button></form>
<div id="error" role="status"></div><section id="result" aria-live="polite" hidden>
<strong id="revision-label"></strong><div id="revision-id"></div><ul id="objects"></ul>
<details id="game" hidden><summary>Game source</summary><pre id="source"></pre></details>
</section><script>(${sceneApp.toString()})();</script></body></html>`;
