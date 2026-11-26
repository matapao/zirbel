/**
 * A small stats overlay in a corner of the page: round trip, jitter, bytes each way and drops, twice a second.
 * Its style is set on the element itself, so it needs nothing from the game's sandbox but a document.
 */
import type { Connection } from './connection.ts';
import { clock, env } from './env.ts';

interface Doc {
  createElement(tag: string): { style: { cssText: string }; textContent: string | null; remove(): void };
  readonly body?: { appendChild(node: unknown): void } | null;
}

/** Shows net's stats until the returned function is called. line adds a first line, such as the mode and role. */
export function overlay(net: Connection, line: () => string = () => ''): () => void {
  const doc = (env as { document?: Partial<Doc> }).document;
  if (!doc?.createElement || !doc.body) return () => {};
  const el = doc.createElement('div');
  el.style.cssText = 'position:fixed;left:4px;top:4px;z-index:2147483647;padding:2px 6px;font:11px/1.4 ui-monospace,monospace;' +
    'color:#fff;background:rgba(0,0,0,.65);border-radius:3px;pointer-events:none;white-space:pre';
  doc.body.appendChild(el);
  let { bytesIn, bytesOut } = net.stats, t = clock(), timer: unknown = null, on = true;
  const kb = (n: number, s: number): string => (n / 1024 / s).toFixed(1);
  const show = (): void => {
    if (!on) return;
    const s = net.stats, now = clock(), dt = Math.max(0.001, (now - t) / 1000);
    const first = line();
    el.textContent = (first ? first + '\n' : '') + 'rtt ' + Math.round(net.rtt) + ' ms  jitter ' + Math.round(net.jitter) + ' ms\n' +
      'in ' + kb(s.bytesIn - bytesIn, dt) + ' kB/s  out ' + kb(s.bytesOut - bytesOut, dt) + ' kB/s\ndropped ' + s.dropped;
    ({ bytesIn, bytesOut } = s);
    t = now;
    timer = env.setTimeout(show, 500);
  };
  show();
  return () => {
    on = false;
    env.clearTimeout(timer);
    el.remove();
  };
}
