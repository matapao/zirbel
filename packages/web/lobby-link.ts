// The lobby's links into a game (lobby.ts): to its own listener's /join/ pages and nowhere else, with the simulated
// network for testing (zirbel-net's ?net=lag:120,…) carried from the lobby's own address, which the player page then
// hands on to the game's.

/** A player link from the lobby at here, and none from anywhere else, with here's ?net= on it. */
export function playerLink(link: string, here: string) {
  const url = new URL(link, here), lobby = new URL(here);
  if (url.origin !== lobby.origin || !url.pathname.startsWith('/join/')) throw new Error('The lobby answered with an unexpected link.');
  const net = lobby.searchParams.get('net');
  if (net) url.searchParams.set('net', net);
  return url.href;
}
