// The way back to the TV page (tv.ts) from a game's player page it went into: its links carry ?screen=tv, and the
// player page that has it goes back to /tv, the same screen resumed, when its game is left.

const SCREEN = 'screen',
  TV = 'tv';
/** The TV page's own address on this listener. */
export const TV_PAGE = '/tv';

/** A player link marked as the TV page's. */
export function tvLink(link: string) {
  const url = new URL(link);
  url.searchParams.set(SCREEN, TV);
  return url.href;
}

/** Whether this player page was opened by the TV page. */
export const fromTv = (search = location.search) => new URLSearchParams(search).get(SCREEN) === TV;
