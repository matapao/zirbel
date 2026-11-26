// The lobby page (public/lobby.html) every player listener serves at /: the games the owner offers, a code to join a
// session with, and the sessions being played. Mostly used on phones. It talks to its own listener's /lobby/ alone, and
// goes only to the player links that listener hands back.
type Game = { release: string; title: string; players: { min: number; max: number }; multiplayer: boolean };
type Session = { id: string; title: string; players: number; max: number; started: string };
type State = { games: Game[]; sessions: Session[]; pair: string | null };

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nameField = byId<HTMLInputElement>('name');
const error = byId('error');
const home = byId('home');
const started = byId('started');
const NAME_KEY = 'zirbel-lobby-name';
const REFRESH_MS = 5000;

try { nameField.value = localStorage.getItem(NAME_KEY) ?? ''; } catch { /* the name is typed again */ }
nameField.addEventListener('change', () => {
  try { localStorage.setItem(NAME_KEY, nameField.value.trim()); } catch { /* kept for this page only */ }
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function call<T>(path: string, value?: object): Promise<T> {
  const response = await fetch('/lobby/' + path, value
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) } : {});
  const result = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'The lobby could not do that. Try again.');
  return result as T;
}

/** A player link from this listener, and none from anywhere else. */
function playerLink(link: string) {
  const url = new URL(link, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/join/')) throw new Error('The lobby answered with an unexpected link.');
  return url.href;
}

function playerName() {
  const name = nameField.value.trim();
  if (!name) {
    nameField.focus();
    throw new Error('Enter your name first.');
  }
  try { localStorage.setItem(NAME_KEY, name); } catch { /* kept for this page only */ }
  return name;
}

const seats = (game: Game) => game.players.max === 1 ? '1 player' : 'Up to ' + game.players.max + ' players';

function ago(when: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(when)) / 60_000));
  if (minutes < 1) return 'Started just now';
  if (minutes < 60) return 'Started ' + minutes + ' min ago';
  return 'Started ' + Math.floor(minutes / 60) + ' h ago';
}

async function attempt(button: HTMLButtonElement, work: () => Promise<void>) {
  error.textContent = '';
  button.disabled = true;
  try { await work(); } catch (reason) { error.textContent = (reason as Error).message; }
  finally { button.disabled = false; }
}

function render(state: State) {
  const games = byId('games');
  games.replaceChildren(...state.games.map((game) => {
    const item = el('li');
    const about = el('div');
    about.append(el('strong', game.title), el('small', seats(game)));
    const button = el('button', game.multiplayer ? 'Start session' : 'Play', 'primary');
    button.type = 'button';
    button.setAttribute('aria-label', (game.multiplayer ? 'Start session of ' : 'Play ') + game.title);
    button.addEventListener('click', () => void attempt(button, () => start(game)));
    item.append(about, button);
    return item;
  }));
  byId('no-games').hidden = state.games.length > 0;
  const sessions = byId('sessions');
  sessions.replaceChildren(...state.sessions.map((session) => {
    const item = el('li');
    item.dataset.session = session.id;
    const about = el('div');
    about.append(el('strong', session.title), el('small', ago(session.started)));
    const count = el('span', session.players + ' / ' + session.max, 'count');
    count.setAttribute('aria-label', session.players + ' of ' + session.max + ' players');
    item.append(about, count);
    return item;
  }));
  byId('no-sessions').hidden = state.sessions.length > 0;
  const pair = byId<HTMLAnchorElement>('pair');
  pair.hidden = !state.pair;
  if (state.pair) pair.href = state.pair;
}

async function refresh() {
  try { render(await call<State>('state')); } catch (reason) { error.textContent = (reason as Error).message; }
}

async function start(game: Game) {
  const { code, link } = await call<{ code: string | null; link: string }>('sessions', { release: game.release, name: playerName() });
  const target = playerLink(link);
  if (!code) { location.assign(target); return; }
  byId('code').textContent = code;
  byId('code').setAttribute('aria-label', 'Code ' + code.split('').join(' '));
  byId<HTMLAnchorElement>('go-in').href = target;
  home.hidden = true;
  started.hidden = false;
  byId('go-in').focus();
}

byId('back').addEventListener('click', () => {
  started.hidden = true;
  home.hidden = false;
  void refresh();
});

const joinForm = byId<HTMLFormElement>('join-form');
joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const button = joinForm.querySelector('button')!;
  void attempt(button, async () => {
    const code = byId<HTMLInputElement>('join-code').value;
    const { link } = await call<{ link: string }>('join', { code, name: playerName() });
    location.assign(playerLink(link));
  });
});

setInterval(() => { if (document.visibilityState === 'visible' && started.hidden) void refresh(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
void refresh();
