// The TV page's lobby (tv.ts): big tiles of the games the owner offers and of the sessions being played, a session's
// code typed on letters a remote or a gamepad moves over, and a new session's code for the others to join with. Its
// own listener's /lobby/ API answers it as it answers the lobby page (lobby.ts), for a seat named "TV".
import { qrPicture } from './qr.ts';

type Game = { release: string; title: string; players: { min: number; max: number }; multiplayer: boolean };
type Session = { id: string; title: string; players: number; max: number; started: string };
/** link: the lobby's address for other devices, on the LAN listener. */
export type LobbyState = { games: Game[]; sessions: Session[]; link: string | null };
type Context = {
  call: <T>(path: string, value?: object) => Promise<T>;
  /** Goes into a game's player page by the link the lobby handed back. */
  go: (link: string) => void;
  focus: (key: string) => void; say: (text: string) => void;
  /** Reads the lobby again, as the page comes back to it. */
  refresh: () => void;
  /** Whether this browser can play games (tv.ts checks), and the lobby's address for other devices. */
  canPlay: boolean; base: () => string;
};

/** A session's code: four of these, which never read as one another (core/lobby.ts). */
const CODE_LETTERS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SEAT_NAME = 'TV';
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};

function tile(key: string, title: string, lines: string[], action: string, act: () => void) {
  const item = el('li');
  const button = el('button', undefined, 'tile');
  button.type = 'button';
  button.dataset.nav = '';
  button.dataset.key = key;
  button.append(el('strong', title), ...lines.map((line) => el('small', line)), el('span', action, 'action'));
  button.setAttribute('aria-label', action + ': ' + title);
  button.addEventListener('click', act);
  item.append(button);
  return item;
}

const seats = (game: Game) => game.players.max === 1 ? '1 player' : 'Up to ' + game.players.max + ' players';
/** What a game's tile says it does: here, where games can play, a session or a game alone; else a phone plays it. */
function gameAction(canPlay: boolean, multiplayer: boolean) {
  if (!canPlay) return 'Play on a phone';
  return multiplayer ? 'Start a session' : 'Play';
}

function ago(when: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(when)) / 60_000));
  if (minutes < 1) return 'Started just now';
  return minutes < 60 ? 'Started ' + minutes + ' min ago' : 'Started ' + Math.floor(minutes / 60) + ' h ago';
}

type View = 'home' | 'code' | 'started' | 'elsewhere';
/** Where each view puts the focus first. */
const VIEW_FOCUS: Record<View, string> = { home: '', code: 'letter:2', started: 'go-in', elsewhere: 'elsewhere-back' };

export class TvLobby {
  private view: View = 'home';
  private typed = '';
  private busy = false;

  private readonly context: Context;

  constructor(context: Context) {
    this.context = context;
    const letters = byId('letters');
    for (const letter of CODE_LETTERS) {
      const button = el('button', letter);
      button.type = 'button';
      button.dataset.nav = '';
      button.dataset.key = 'letter:' + letter;
      button.addEventListener('click', () => this.type(letter));
      letters.append(button);
    }
    byId('delete').addEventListener('click', () => this.erase());
    for (const id of ['code-back', 'started-back', 'elsewhere-back']) byId(id).addEventListener('click', () => this.show('home'));
  }

  get current() { return this.view; }

  render(state: LobbyState) {
    const { canPlay } = this.context;
    byId('games').replaceChildren(...state.games.map((game) => tile('game:' + game.release, game.title, [seats(game)],
      gameAction(canPlay, game.multiplayer), () => void this.start(game))));
    byId('no-games').hidden = state.games.length > 0;
    byId('sessions').replaceChildren(
      tile('join', 'Join with a code', ['A session’s code, from whoever started it'], 'Enter a code', () => this.enter()),
      ...state.sessions.map((session) => tile('session:' + session.id, session.title,
        [session.players + ' of ' + session.max + ' players', ago(session.started)], 'Join', () => this.enter(session.title))));
  }

  /** Back: from a step to the lobby; true when it went somewhere. */
  back() {
    if (this.view === 'code' && this.typed) { this.erase(); return true; }
    if (this.view === 'home') return false;
    this.show('home');
    return true;
  }

  /** A letter of a code typed on a keyboard, while the code is asked for. */
  key(text: string) {
    const letter = text.toUpperCase();
    if (this.view !== 'code' || letter.length !== 1 || !CODE_LETTERS.includes(letter)) return false;
    this.type(letter);
    return true;
  }

  private show(view: View, focus?: string) {
    this.view = view;
    for (const id of ['home', 'code', 'started', 'elsewhere'] as const) byId(id).hidden = id !== view;
    if (view === 'home') this.context.refresh();
    this.context.focus(focus ?? VIEW_FOCUS[view]);
  }

  private enter(title?: string) {
    if (!this.context.canPlay) { this.elsewhere(title ?? 'a session'); return; }
    this.typed = '';
    this.paint();
    byId('code-title').textContent = title ? 'Join ' + title : 'Join a session';
    this.show('code');
  }

  private paint() {
    const slots = byId('slots');
    slots.replaceChildren(...Array.from({ length: 4 }, (_, index) => el('span', this.typed[index] ?? '')));
    slots.setAttribute('aria-label', this.typed ? 'Code ' + this.typed.split('').join(' ') : 'No letters yet');
  }

  private type(letter: string) {
    if (this.busy || this.typed.length >= 4) return;
    this.typed += letter;
    this.paint();
    if (this.typed.length === 4) void this.join(this.typed);
  }

  private erase() {
    this.typed = this.typed.slice(0, -1);
    this.paint();
  }

  private async attempt(work: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.context.say('');
    try { await work(); } catch (reason) { this.context.say((reason as Error).message); } finally { this.busy = false; }
  }

  private join(code: string) {
    return this.attempt(async () => {
      try {
        const { link } = await this.context.call<{ link: string }>('join', { code, name: SEAT_NAME });
        this.context.go(link);
      } finally {
        this.typed = '';
        this.paint();
      }
    });
  }

  private start(game: Game) {
    if (!this.context.canPlay) { this.elsewhere(game.title); return Promise.resolve(); }
    return this.attempt(async () => {
      const { code, link } = await this.context.call<{ code: string | null; link: string }>('sessions', { release: game.release, name: SEAT_NAME });
      if (!code) { this.context.go(link); return; }
      byId('session-code').textContent = code;
      byId('session-code').setAttribute('aria-label', 'Code ' + code.split('').join(' '));
      byId('go-in').onclick = () => this.context.go(link);
      const invite = new URL(this.context.base());
      invite.searchParams.set('code', code);
      byId('session-qr').replaceChildren(await qrPicture(invite.href, 'QR code that joins this session'));
      this.show('started');
    });
  }

  /** A browser that can't play games here: the lobby on a phone or a laptop, by its QR code. */
  private elsewhere(title: string) {
    byId('elsewhere-title').textContent = 'Play ' + title + ' on a phone or a laptop';
    void qrPicture(this.context.base(), 'QR code that opens the lobby').then((picture) => byId('elsewhere-qr').replaceChildren(picture));
    byId('elsewhere-link').textContent = this.context.base();
    this.show('elsewhere');
  }
}
