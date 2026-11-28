// The player page: a room's game for one seat (a built-in game drawn here, or an authored one in its frame:
// player-frame.ts), its lobby and join form, a net game's space, its controllers and Show on TV.
import { legacyScene, type SeatInfo } from '../sdk/contracts.ts';
import { RoomClient, fetchRoom, type RoomInfo } from '../sdk/client.ts';
import { mossState, tileState } from '../games/simulations.ts';
import { templates } from '../games/templates.ts';
import { drawScene } from './scene.ts';
import { screenControllers, type Controllers } from './controllers.ts';
import { fromTv, TV_PAGE } from './tv-return.ts';
import { buildBoard, renderBoard } from './player-board.ts';
import { gameFrame } from './player-frame.ts';
import { controls, keys, motion } from './player-keys.ts';
import { lanternQuest } from './player-quest.ts';
import { handOver, joinSpace, spaceLink, type PageSpace, type Role } from './player-space.ts';

function byId<T extends HTMLElement>(id: string) { return document.getElementById(id) as T; }
const room = location.pathname.split('/').at(-1) ?? '';
// A net game's space with its credential (player-space.ts); else an invitation, or a seat the lobby held for this person
// (#seat=<ticket>), which goes straight in.
const netLink = spaceLink(location.hash);
const ticket = !netLink && location.hash.startsWith('#seat=') ? location.hash.slice('#seat='.length) : '';
const invite = ticket || netLink ? '' : location.hash.slice(1);
const savedKey = 'zirbel-room:' + room;
const soloMessage = byId('message');
const lobby = byId('lobby');
const game = byId('game');
const form = byId<HTMLFormElement>('join-form');
const canvas = byId<HTMLCanvasElement>('view');
const board = byId('board');
const score = byId('score');
const error = byId('error');
const reset = byId<HTMLButtonElement>('reset');
const connection = byId('connection');
let info: RoomInfo;
let client: RoomClient | undefined;
let seat: SeatInfo | undefined;
let moss: ReturnType<typeof mossState.parse> | undefined;
let tile: ReturnType<typeof tileState.parse> | undefined;
let seats: SeatInfo[] = [];
let frame = 0;
let disposeGarden: (() => void) | undefined;
let ready = false;
// The seat's own credential, which Show on TV hands to the box's screen, and the page's controllers once its game starts.
let seatCredential: string | undefined;
let controllers: Controllers | undefined;
// A net game's space, which this page holds and shares with the game's frame (player-frame.ts); handedOver once Show on
// TV gave its member to the TV.
let space: PageSpace | undefined;
let handedOver = false;
const quest = lanternQuest({ byId, canvas, score });

function saved() { try { return sessionStorage.getItem(savedKey) ?? ''; } catch { return ''; } }
function remember(credential?: string) {
  try {
    if (credential) sessionStorage.setItem(savedKey, credential);
    else sessionStorage.removeItem(savedKey);
  } catch { /* Sessions can still play when browser storage is disabled. */ }
}

function move(key: string, down: boolean) {
  if (!controls.includes(key) || (!quest.playing() && info?.manifest.template !== 'mosslight') || seat?.role !== 'player') return;
  if (keys.has(key) === down) return;
  if (down) keys.add(key);
  else keys.delete(key);
  movement();
}

function movement() {
  if (!quest.playing()) client?.send({ type: 'move', ...motion() });
}

window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'e' && !event.repeat) quest.interact();
  if (!game.hidden && controls.includes(key)) { event.preventDefault(); move(key, true); }
});
window.addEventListener('keyup', (event) => move(event.key.toLowerCase(), false));
window.addEventListener('blur', () => { if (keys.size) { keys.clear(); movement(); } });
for (const button of document.querySelectorAll<HTMLButtonElement>('#touch button')) {
  const key = button.dataset.key!.toLowerCase();
  button.addEventListener('pointerdown', (event) => { button.setPointerCapture(event.pointerId); move(key, true); });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, () => move(key, false));
}

byId('full').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen().catch(() => {});
});
// This page as a screen once its game starts: its controllers, and the panel that shows them. In the editor's preview
// it reads only the device's own gamepads.
const controllersButton = byId<HTMLButtonElement>('controllers');
const controllersPanel = byId('controllers-panel');
let panel: { draw(): void } | undefined;
function toggleControllers(open = controllersPanel.hidden) {
  controllersPanel.hidden = !open;
  controllersButton.setAttribute('aria-expanded', String(open));
  if (open) void import('./controllers-panel.ts').then(({ controllersPanel: drawn }) => {
    panel ??= drawn(controllersPanel, controllers!, { showOnTv: () => void showOnTv(), close: () => toggleControllers(false) });
    panel.draw();
  });
}
controllersButton.addEventListener('click', () => toggleControllers());
function startControllers() {
  if (controllers) return;
  const open = document.body.dataset.preview === undefined;
  controllers = screenControllers({ open, onChange: () => { if (!controllersPanel.hidden) panel?.draw(); }, onShown: onTv,
    // The TV goes to a game shown on it: the member it holds here leaves, so the SDK seats it by the link's ticket.
    onLeaving: () => { if (space) { handedOver = true; void space.leave(); space = undefined; } } });
  controllersButton.hidden = !open;
}
// Show on TV: the box's screen takes this seat (a net game's member hands its place over), and this page controls it.
async function showOnTv() {
  let link: string | undefined;
  if (space) {
    link = await handOver(room, space).catch((reason: unknown) => {
      error.textContent = (reason as Error).message;
      return undefined;
    });
  } else if (seatCredential) link = '/join/' + room + '#seat=' + seatCredential;
  if (link) controllers?.show(link);
}
function onTv(code: string) {
  client?.stop(false);
  remember();
  // The TV takes this member's place, which this page doesn't leave: the kernel ends its connection as replaced.
  if (space) { handedOver = true; space = undefined; }
  showLobby();
  controllers?.close();
  controllers = undefined;
  toggleControllers(false);
  controllersButton.hidden = true;
  lobby.hidden = true;
  byId('tv-pad').hidden = false;
  void import('./tv-pad.ts').then(({ controlTv }) => controlTv(code, { place: byId('tv-pad-place'), status: byId('tv-pad-status') }));
}

// A game the TV page went into goes back there when it is left, and its lobby link too.
if (fromTv()) byId<HTMLAnchorElement>('to-lobby').href = TV_PAGE;
function leaveRoom(message = 'You left the room.') {
  client?.stop();
  remember();
  if (space) { void space.leave(); space = undefined; }
  if (fromTv()) { location.assign(TV_PAGE); return; }
  showLobby(message);
}
byId('leave').addEventListener('click', () => leaveRoom());
reset.addEventListener('click', () => client?.send({ type: 'reset' }));

const authored = gameFrame({ room, error, info: () => info, seat: () => seat, seats: () => seats,
  controllers: () => controllers, send: (value) => client?.send(value) });

function showLobby(message = '') {
  authored.close();
  keys.clear();
  cancelAnimationFrame(frame);
  disposeGarden?.();
  disposeGarden = undefined;
  quest.stop();
  ready = false;
  game.hidden = true;
  lobby.hidden = false;
  form.hidden = !(invite || netLink?.invite) || Boolean(info?.solo) || Boolean(space);
  byId('to-lobby').hidden = !ticket;
  soloMessage.textContent = message;
  connection.textContent = '';
  byId('leave').hidden = true;
}

/** The board as the room last had it, once a state has come. */
function showBoard() {
  if (tile) renderBoard({ board, score, reset }, tile, seats, seat);
}

async function showGame() {
  if (ready) return;
  ready = true;
  lobby.hidden = true;
  game.hidden = false;
  byId('leave').hidden = false;
  // In the editor the game fills its pane, without the player's own title bar.
  if (info.solo && window.parent !== window && new URLSearchParams(location.search).has('preview'))
    document.body.dataset.preview = '';
  if (info.gameUrl) {
    canvas.hidden = true;
    game.querySelector('footer')!.hidden = true;
    startControllers();
    authored.open(game, info.gameUrl);
    return;
  }
  switch (info.manifest.template) {
    case 'tessellate':
      canvas.hidden = true;
      board.hidden = false;
      board.style.setProperty('--board-surface', legacyScene(info).background);
      byId('instructions').textContent = 'Connect three tiles in a line.';
      buildBoard(board, (cell) => client?.send({ type: 'place', cell }));
      showBoard();
      break;
    case 'lantern-quest':
      await quest.show(legacyScene(info));
      break;
    case 'orbit-garden': {
      byId('instructions').textContent = 'Drag to orbit · scroll to zoom';
      try {
        const { showGarden } = await import('./garden-3d.ts');
        disposeGarden = showGarden(canvas, legacyScene(info));
      } catch {
        const ctx = canvas.getContext('2d');
        if (ctx) drawScene(ctx, legacyScene(info));
        score.textContent = '3D rendering is unavailable on this device.';
      }
      break;
    }
    default: {
      const hasSimulation = info.manifest.template === 'mosslight';
      byId('touch').hidden = !hasSimulation || seat?.role === 'spectator';
      const movementTip = matchMedia('(pointer: coarse)').matches ? 'Use the arrows' : 'Move with WASD or arrow keys';
      byId('instructions').textContent = hasSimulation ? movementTip + ' · gather the valley lights' : 'Local scene preview';
      const ctx = canvas.getContext('2d')!;
      function render(time: number) {
        drawScene(ctx, legacyScene(info), {
          time, blank: !hasSimulation, collected: new Set(moss?.collected),
          explorers: hasSimulation ? moss?.explorers ?? [] : undefined, currentSeat: seat?.id,
        });
        frame = requestAnimationFrame(render);
      }
      frame = requestAnimationFrame(render);
    }
  }
}

const ENDED: Record<string, string> = { replaced: 'This seat is in use on another screen now.',
  lost: 'The connection to this session was lost.', 'credential-expired': 'This seat has expired. Join again from the lobby.',
  refused: 'This seat has expired. Join again from the lobby.', left: 'You left the room.' };
/** Joins a net game's space, as the link says or as the join form asks, proves to the host which member this page is,
 *  for the room's info, and starts the game in it. */
async function enterSpace(asked?: { name: string; role: Role }) {
  if (!netLink) return;
  connection.textContent = 'Connecting…';
  const joined = await joinSpace(netLink, asked);
  // Shared with the game's frame at once, so what the others send waits for the game, which loads once the page has the
  // room's info. A game that left the session and didn't come back gives up this page's place in it too.
  await authored.share(joined, () => { if (joined === space) leaveRoom('The game left the session.'); });
  try { info = await fetchRoom<RoomInfo>(room, 'info', undefined, await joined.proof()); }
  catch (reason) { void joined.leave(); showLobby(); throw reason; }
  describe();
  space = joined;
  joined.on('status', (status) => {
    if (joined === space) connection.textContent = status === 'reconnecting' ? 'Reconnecting…' : '';
  });
  joined.on('closed', ({ reason }) => {
    if (joined !== space || handedOver) return;
    space = undefined;
    showLobby(ENDED[reason] ?? 'This session has ended.');
    form.hidden = true;
  });
  connection.textContent = '';
  void showGame();
}

function connect(credential: string) {
  client = new RoomClient(room, info.manifest.releaseId, credential, (message) => {
    switch (message.type) {
      case 'welcome':
        seat = message.seat;
        seatCredential = message.resume;
        remember(message.resume);
        error.textContent = '';
        if (keys.size) movement();
        authored.update();
        void showGame();
        break;
      case 'snapshot': {
        seats = message.seats;
        if (info.gameUrl) { authored.states(message.state); break; }
        const mossUpdate = mossState.safeParse(message.state);
        if (mossUpdate.success && info.manifest.simulation === 'mosslight-v1') {
          moss = mossUpdate.data;
          score.textContent = moss.finished ? 'All lights collected!' : moss.collected.length + ' / ' + moss.total + ' lights';
        }
        const tileUpdate = tileState.safeParse(message.state);
        if (tileUpdate.success && info.manifest.simulation === 'tessellate-v1') {
          tile = tileUpdate.data;
          showBoard();
        }
        break;
      }
      case 'closed':
        remember();
        showLobby(message.message);
        form.hidden = true;
        break;
      case 'error':
        if (message.code === 'expired') { remember(); showLobby(message.message); }
        else error.textContent = message.message;
        break;
    }
  }, (status) => { connection.textContent = status; });
  connection.textContent = 'Connecting…';
  client.open();
}

form.addEventListener('submit', (event) => void reserveSeat(event));
async function reserveSeat(event: SubmitEvent) {
  event.preventDefault();
  const values = new FormData(form);
  const submit = form.querySelector('button')!;
  submit.disabled = true;
  error.textContent = '';
  try {
    const name = values.get('name');
    if (netLink) await enterSpace({ name: typeof name === 'string' ? name.trim() : '',
      role: values.get('role') === 'spectator' ? 'observer' : 'participant' });
    else {
      const { ticket } = await fetchRoom<{ ticket: string }>(room, 'reserve', { invite, name: values.get('name'), role: values.get('role') });
      connect(ticket);
    }
  } catch (reason) { error.textContent = (reason as Error).message; }
  finally { submit.disabled = false; }
}

/** The badge beside the title: the session's code, else which playtest this is. */
function badgeText(session: RoomInfo) {
  if (session.code) return 'Code ' + session.code;
  if (session.development) return 'Development playtest';
  return session.solo && !ticket ? 'Local playtest' : '';
}

/** The room's title, description and badge, from its info. */
function describe() {
  document.title = info.manifest.title + ' · Zirbel';
  byId('game-title').textContent = info.manifest.title;
  byId('lobby-title').textContent = info.manifest.title;
  byId('lobby-description').textContent = info.gameUrl || !info.manifest.template ? '' : templates[info.manifest.template].description;
  byId('badge').textContent = badgeText(info);
}

try {
  // A net game's room is for its space's members: an invitation asks for a name first; a ticket, or the member this tab
  // holds, goes straight in. Else a seat kept from before, the one the lobby held, or the invitation's.
  if (netLink) await (netLink.invite ? Promise.resolve(showLobby()) : enterSpace());
  else {
    const link = ticket || invite;
    let credential = saved() || link;
    if (!credential) throw new Error('Open the complete invitation link from the room owner.');
    try { info = await fetchRoom<RoomInfo>(room, 'info', undefined, credential); }
    catch (error) {
      if (!link || credential === link) throw ticket ? new Error('This seat has expired. Join again from the lobby.') : error;
      remember();
      credential = link;
      info = await fetchRoom<RoomInfo>(room, 'info', undefined, credential);
    }
    describe();
    if (credential !== invite) connect(credential);
    else if (info.solo) {
      const { ticket } = await fetchRoom<{ ticket: string }>(room, 'reserve', { invite, name: 'Explorer', role: 'player' });
      connect(ticket);
    } else showLobby();
  }
} catch (reason) {
  showLobby((reason as Error).message);
  form.hidden = true;
}
