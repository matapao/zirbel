/** Where a game page is and what it was opened with: the hub's default address, the room, the key, its files. */
import { env } from './env.ts';
import { NAME } from './protocol.ts';

export function defaultUrl(path: string): string {
  const loc = env.location;
  if (loc && loc.host && (loc.protocol === 'https:' || loc.protocol === 'http:')) {
    return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + path;
  }
  return 'ws://127.0.0.1:7777' + path;
}

/**
 * This page's own folder on the host, from its path: /<game>/@1.0.0/ on the earlier Zirbel's hub, and on Zirbel
 * /game/@<room>/<key>/, where the room's key is part of the folder; else /<game>/.
 */
export function pageBase(game: string): string {
  const path = env.location?.pathname ?? '';
  const m = /^\/game\/@[0-9a-f]{12}\/[\w-]{32}\//.exec(path) ?? /^\/[\w.-]+\/@[^/]+\//.exec(path);
  return m ? m[0] : '/' + game + '/';
}

/** A file's JSON from the host: the page's own origin, else (a bot, a test) the hub's address. */
export async function fetchJson(path: string, hubUrl: string): Promise<unknown> {
  const f = env.fetch;
  if (!f) throw new Error('zirbel-net: no fetch here to load data with');
  const url = env.location?.host ? path : hubUrl.replace(/^ws(s?):/, 'http$1:').replace(/\/[^/]*$/, '') + path;
  const res = await f(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('zirbel-net: no ' + path + ' on this host');
  return res.json();
}

export interface LaunchParams {
  /** The game's id: the first part of the page's path (/<game>/… is <game>). */
  readonly game: string;
  /** The revision the page was opened at: 'r8' for /<game>/@r8/…, else ''. */
  readonly rev: string;
  /** From ?room=; a missing or unusable room becomes a random four-letter code. */
  readonly room: string;
  /** From ?key=: the host key the lobby passes to the window that should host. */
  readonly key: string;
}

/**
 * What a game page was opened with. Hosts serve each game under /<id>/, and the lobby opens it
 * with ?room=…&key=…, so connect({ ...launchParams(), loopback: true }) is all a game needs.
 */
export function launchParams(where: { readonly pathname?: string; readonly search?: string } = env.location ?? {}): LaunchParams {
  const search = where.search ?? '';
  const get = (name: string): string => {
    const m = new RegExp('[?&]' + name + '=([^&#]*)').exec(search);
    if (!m) return '';
    try {
      return decodeURIComponent((m[1] ?? '').replace(/\+/g, ' '));
    } catch {
      return '';
    }
  };
  const room = get('room').toUpperCase().replace(/[^\w.-]/g, '').slice(0, 32);
  let game = 'game';
  const first = /^\/([^/@?#]+)/.exec(where.pathname ?? '');
  try {
    const id = first ? decodeURIComponent(first[1] ?? '') : '';
    if (NAME.test(id)) game = id;
  } catch {
    // a broken escape: keep the default
  }
  const rev = /^\/[^/]+\/@(r[\w.-]{1,40})\//.exec(where.pathname ?? '');
  return { game, room: room || randomRoom(), key: get('key'), rev: rev ? (rev[1] ?? '') : '' };
}

function randomRoom(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = env.crypto.getRandomValues(new Uint8Array(4));
  let s = '';
  for (const b of bytes) s += letters.charAt(b % letters.length);
  return s;
}
