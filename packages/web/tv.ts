// The TV page (public/tv.html), which every player listener serves at /tv: the lobby ten feet away, for a TV's own
// browser, a console's, a laptop cast to a TV, and the box's HDMI console (docs/box-tv.md). It is a screen from the moment
// it opens (tv-screen.ts): phones join it by its code and play on it, and so do the gamepads of the box and of this
// device. Arrows, Enter and Back (a remote's or a keyboard's), any gamepad's d-pad or stick, A and B move around it
// (tv-input.ts, tv-focus.ts); starting or joining a session goes into the game's player page with the same screen, and
// leaving the game comes back (tv-return.ts). Another page's Show on TV (open) comes here too. Its script runs in
// browsers as old as a TV's (Chromium 80): the build targets them, and nothing here needs more.
import { playerLink } from './lobby-link.ts';
import { nextFocus } from './tv-focus.ts';
import { gamepadInput, keyCommand, PadNavigator, type Command } from './tv-input.ts';
import { TvLobby, type LobbyState } from './tv-lobby.ts';
import { Places } from './tv-places.ts';
import { tvLink } from './tv-return.ts';
import { openScreen, saveResume, savedResume, type Screen, type ScreenInfo } from './tv-screen.ts';

const REFRESH_MS = 5000;
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const error = byId('error');
const say = (text: string) => { error.textContent = text; };

/** Whether this browser plays the games here: WebGL 2 and import maps, which games and their modules use. */
function canPlayGames() {
  try {
    const supports = (HTMLScriptElement as unknown as { supports?: (type: string) => boolean }).supports;
    if (!supports?.('importmap')) return false;
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(gl);
  } catch { return false; }
}
const canPlay = canPlayGames();
byId('cannot').hidden = canPlay;

let screen: Screen | undefined;
let info: ScreenInfo | undefined;
let base = location.origin + '/';

/** Into a game's player page by a link of this listener's, marked to come back here. */
function go(link: string) {
  try { location.assign(tvLink(playerLink(link, location.href))); } catch (reason) { say((reason as Error).message); }
}

async function call<T>(path: string, value?: object): Promise<T> {
  const response = await fetch('/lobby/' + path, value
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) } : {});
  const result = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'The lobby could not do that. Try again.');
  return result as T;
}

/** The tiles that may take focus now: those shown, in the order they are drawn. */
const tiles = () => [...document.querySelectorAll<HTMLElement>('[data-nav]')].filter((node) => node.offsetParent !== null);

function focus(key: string) {
  const shown = tiles();
  (shown.find((node) => node.dataset.key === key) ?? shown.find((node) => !byId('places').contains(node) && node.id !== 'full') ??
    shown[0])?.focus();
}

const lobby = new TvLobby({ call, go, focus, say, canPlay, base: () => base });
const places = new Places(byId('places'), { screen: () => screen, base: () => base, code: () => info?.code, focus, say });

function command(what: Command, fromPad: boolean) {
  const shown = tiles();
  const active = document.activeElement as HTMLElement | null;
  const at = active ? shown.indexOf(active) : -1;
  if (what === 'back') {
    if (!places.back() && !lobby.back() && at >= 0 && byId('places').contains(active)) focus('');
    return;
  }
  if (what === 'choose') {
    // While a place waits for a controller's A, A takes the place: it chooses nothing here.
    if (fromPad && places.claiming) return;
    if (at < 0) focus('');
    else active?.click();
    return;
  }
  const next = nextFocus(shown.map((node) => node.getBoundingClientRect()), at, what);
  if (next !== undefined) shown[next]?.focus();
  else if (at < 0) focus('');
}

const pads = new PadNavigator((what) => command(what, true));

document.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (lobby.key(event.key)) { event.preventDefault(); return; }
  const what = keyCommand(event);
  if (!what) return;
  // A focused button takes Enter as a click of its own, which counts as the person's gesture (full screen needs one).
  if (what === 'choose' && document.activeElement instanceof HTMLButtonElement) return;
  event.preventDefault();
  command(what, false);
});

// Full screen, on a remote's OK, a click or a tap: a gamepad's press is no gesture a browser counts.
const full = byId<HTMLButtonElement>('full');
full.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen().catch(() => say('Press OK on the remote, or click, for full screen.'));
});

// The device's own gamepads, read each frame while the page is shown; each takes a place on its first press.
const pressing = new Map<number, boolean>();
function frame(now: number) {
  const seen = new Set<number>();
  for (const gamepad of navigator.getGamepads?.() ?? []) {
    if (!gamepad?.connected) continue;
    seen.add(gamepad.index);
    const input = gamepadInput(gamepad);
    const down = PadNavigator.pressing(input);
    if (down && !pressing.get(gamepad.index)) places.pressed(gamepad.index, gamepad.id, (input.pressed & 1) === 1);
    pressing.set(gamepad.index, down);
    pads.update('device:' + gamepad.index, input, now);
  }
  for (const index of pressing.keys()) if (!seen.has(index)) {
    pressing.delete(index);
    pads.update('device:' + index, undefined, now);
    places.gone(index);
  }
  pads.tick(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

screen = openScreen({
  resume: savedResume(),
  onScreen: (next) => {
    info = next;
    saveResume(next.resume);
    full.hidden = next.box || !document.fullscreenEnabled;
    places.render();
  },
  onPads: (list) => {
    const slots = new Set(list.map((pad) => pad.slot));
    for (let slot = 0; slot < 8; slot++) if (!slots.has(slot)) pads.update('pad:' + slot, undefined, performance.now());
    places.setPads(list);
  },
  onFrame: (state) => pads.update('pad:' + state.slot, state, performance.now()),
  // Show on TV, from another page: its game comes here.
  onOpen: go,
});

async function refresh() {
  try {
    const state = await call<LobbyState>('state');
    if (state.link && state.link !== base) {
      base = state.link;
      places.render();
    }
    // The tile in focus stays in focus as the tiles are drawn again, while it is still there.
    const kept = (document.activeElement as HTMLElement | null)?.dataset?.key;
    lobby.render(state);
    if (!document.activeElement || document.activeElement === document.body) focus(kept ?? '');
  } catch (reason) { say((reason as Error).message); }
}
setInterval(() => { if (document.visibilityState === 'visible' && lobby.current === 'home') void refresh(); }, REFRESH_MS);
places.render();
void refresh();
