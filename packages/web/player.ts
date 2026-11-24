import { boundedJson, objectRegistry } from '../sdk/game.ts';
import { legacyScene, type SeatInfo } from '../sdk/contracts.ts';
import { RoomClient, fetchRoom, type RoomInfo } from '../sdk/client.ts';
import { mossState, tileState } from '../games/simulations.ts';
import { templates } from '../games/templates.ts';
import { createQuest, type Quest } from '../games/quest.ts';
import { drawScene } from './scene.ts';

function byId<T extends HTMLElement>(id: string) { return document.getElementById(id) as T; }
const room = location.pathname.split('/').at(-1) ?? '';
const invite = location.hash.slice(1);
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
let resumed = false;
let ready = false;
let quest: Quest | undefined;

const keys = new Set<string>();
const north = ['w', 'arrowup'];
const south = ['s', 'arrowdown'];
const west = ['a', 'arrowleft'];
const east = ['d', 'arrowright'];
const controls = [...north, ...south, ...west, ...east];

function saved() { try { return sessionStorage.getItem(savedKey) ?? ''; } catch { return ''; } }
function remember(credential?: string) {
  try {
    if (credential) sessionStorage.setItem(savedKey, credential);
    else sessionStorage.removeItem(savedKey);
  } catch { /* Sessions can still play when browser storage is disabled. */ }
}

function move(key: string, down: boolean) {
  if (!controls.includes(key) || (!quest && info?.manifest.template !== 'mosslight') || seat?.role !== 'player') return;
  if (keys.has(key) === down) return;
  if (down) keys.add(key);
  else keys.delete(key);
  movement();
}

function motion() {
  const held = (list: string[]) => Number(list.some((key) => keys.has(key)));
  return { x: held(east) - held(west), y: held(south) - held(north) };
}

function movement() {
  if (!quest) client?.send({ type: 'move', ...motion() });
}

window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'e' && quest && !event.repeat) { quest.interact(); refreshQuest(); }
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
byId('leave').addEventListener('click', () => {
  client?.stop();
  remember();
  showLobby('You left the room.');
});
reset.addEventListener('click', () => client?.send({ type: 'reset' }));

let authoredFrame: HTMLIFrameElement | undefined;
let gamePort: MessagePort | undefined;
let shared: unknown = {};
function updateRoom() {
  if (!seat) return;
  const message = { type: 'zirbel.room', value: { self: seat, seats, states: shared ?? {} } };
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no target origin
  gamePort?.postMessage(message);
}
// Checked below: the sender is the game frame and its origin is the sandbox's opaque 'null'.
// nosemgrep: javascript.browser.security.insufficient-postmessage-origin-validation.insufficient-postmessage-origin-validation
window.addEventListener('message', (event) => {
  if (!authoredFrame || event.source !== authoredFrame.contentWindow || event.origin !== 'null') return;
  const port = event.ports[0];
  const key = info.gameUrl?.split('/').at(-1);
  if (!port || !key || event.data?.type !== 'zirbel.ready' || event.data.documentKey !== key) return;
  // A WindowProxy survives navigation. This port belongs to the document that opened it.
  gamePort?.close();
  gamePort = port;
  port.onmessage = ({ data }) => { if (gamePort === port) receiveGameMessage(data); };
  updateRoom();
});

// Games may call zirbel.send every frame. Forward only the latest state at the
// server's 20 Hz tick so the room's 60-messages-per-second limit is never hit.
let latestState: unknown;
let stateTimer: ReturnType<typeof setTimeout> | undefined;
function sendLatestState(value: unknown) {
  latestState = value;
  stateTimer ??= setTimeout(() => { stateTimer = undefined; client?.send(latestState); }, 50);
}

function receiveGameMessage(data: MessageEvent['data']) {
  const { type, value } = data ?? {};
  if (type === 'zirbel.error' && typeof value === 'string') error.textContent = value.slice(0, 500);
  if (type === 'zirbel.state' && info.manifest.simulation === 'shared-state-v1' && seat?.role === 'player' &&
      boundedJson(value) && JSON.stringify(value).length <= 4096) sendLatestState(value);
  if (type === 'zirbel.objects' && window.parent !== window && info.solo && info.registerObjects !== false) {
    const objects = objectRegistry.safeParse(value);
    // frame-ancestors lets only the editor frame the player, so the parent is the editor; the payload is the validated registry.
    // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
    if (objects.success) window.parent.postMessage({ type, room, value: objects.data }, '*');
  }
}

function showLobby(message = '') {
  clearTimeout(stateTimer);
  stateTimer = undefined;
  gamePort?.close();
  gamePort = undefined;
  authoredFrame?.remove();
  authoredFrame = undefined;
  keys.clear();
  cancelAnimationFrame(frame);
  disposeGarden?.();
  disposeGarden = undefined;
  quest = undefined;
  byId('quest-panel').hidden = true;
  ready = false;
  game.hidden = true;
  lobby.hidden = false;
  form.hidden = !invite || Boolean(info?.solo);
  soloMessage.textContent = message;
  connection.textContent = '';
  byId('leave').hidden = true;
}

function renderBoard() {
  if (!tile) return;
  const name = (id: string) => id === 'bot' ? 'Computer' : seats.find((seat) => seat.id === id)?.name ?? 'Player';
  for (const button of board.querySelectorAll<HTMLButtonElement>('button')) {
    const index = Number(button.dataset.cell);
    const value = tile.board[index];
    const mark = value ? tile.order.indexOf(value) + 1 : 0;
    button.textContent = mark === 1 ? '✧' : mark === 2 ? '●' : '·';
    button.disabled = !!value || !seat || seat.id !== tile.turn;
    delete button.dataset.mark;
    if (mark) button.dataset.mark = String(mark);
    button.setAttribute('aria-label', value ? name(value) + ', tile ' + (index + 1) : 'Place on tile ' + (index + 1));
  }
  score.textContent = tile.winner ? name(tile.winner) + ' wins' : tile.draw ? 'Draw' : !tile.turn ? 'Waiting for another player' :
    seat?.id === tile.turn ? 'Your turn' : name(tile.turn) + '’s turn';
  reset.hidden = !tile.winner && !tile.draw || seat?.role !== 'player';
}

async function showGame() {
  if (ready) return;
  ready = true;
  lobby.hidden = true;
  game.hidden = false;
  byId('leave').hidden = false;
  if (info.gameUrl) {
    if (info.solo && window.parent !== window && new URLSearchParams(location.search).has('preview'))
      document.body.dataset.preview = '';
    canvas.hidden = true;
    game.querySelector('footer')!.hidden = true;
    authoredFrame = document.createElement('iframe');
    authoredFrame.title = info.manifest.title;
    authoredFrame.className = 'authored-game';
    authoredFrame.sandbox.add('allow-scripts');
    authoredFrame.referrerPolicy = 'no-referrer';
    authoredFrame.src = info.gameUrl;
    game.prepend(authoredFrame);
    return;
  }
  switch (info.manifest.template) {
    case 'tessellate':
      canvas.hidden = true;
      board.hidden = false;
      board.style.setProperty('--board-surface', legacyScene(info).background);
      byId('instructions').textContent = 'Connect three tiles in a line.';
      board.replaceChildren();
      for (let index = 0; index < 9; index++) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.cell = String(index);
        button.addEventListener('click', () => client?.send({ type: 'place', cell: index }));
        board.append(button);
      }
      renderBoard();
      break;
    case 'lantern-quest':
      await showQuest();
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

function refreshQuest() {
  if (!quest) return;
  const { state } = quest;
  byId('quest-message').textContent = state.message;
  byId('interact').hidden = state.fighting || !state.health || state.won;
  byId('attack').hidden = !state.fighting;
  byId('guard').hidden = !state.fighting;
  byId('restart-quest').hidden = Boolean(state.health) && !state.won;
  score.textContent = 'HP ' + state.health + ' / ' + quest.maxHealth +
    (state.fighting ? ' · ' + state.enemyName + ' HP ' + state.enemyHealth : '') +
    (state.total > 1 ? ' · Relics ' + state.relics + '/' + state.total : '');
}

async function showQuest() {
  const active = quest = createQuest(legacyScene(info));
  byId('quest-panel').hidden = false;
  byId('touch').hidden = false;
  byId('instructions').textContent = matchMedia('(pointer: coarse)').matches ? 'Move with the arrows' : 'WASD or arrow keys · E to interact';
  byId('interact').onclick = () => { active.interact(); refreshQuest(); };
  byId('attack').onclick = () => { active.battle('attack'); refreshQuest(); };
  byId('guard').onclick = () => { active.battle('guard'); refreshQuest(); };
  byId('restart-quest').onclick = () => { active.restart(); refreshQuest(); };
  refreshQuest();
  let fallback: CanvasRenderingContext2D | null = null;
  try {
    const { showGarden } = await import('./garden-3d.ts');
    if (quest !== active) return;
    disposeGarden = showGarden(canvas, legacyScene(info), active);
  } catch {
    if (quest !== active) return;
    fallback = canvas.getContext('2d');
  }

  let last = performance.now();
  function animate(time: number) {
    if (quest !== active) return;
    const { x, y } = motion();
    active.move(x, y, (time - last) / 1000);
    last = time;
    if (fallback) drawScene(fallback, legacyScene(info), { time, collected: active.state.hidden,
      explorers: [{ id: 'you', x: active.state.x, y: active.state.y, color: '#f3f6ad', score: 0 }], currentSeat: 'you' });
    frame = requestAnimationFrame(animate);
  }
  frame = requestAnimationFrame(animate);
}

function connect(credential: string) {
  client = new RoomClient(room, info.manifest.releaseId, credential, (message) => {
    switch (message.type) {
      case 'welcome':
        seat = message.seat;
        remember(message.resume);
        error.textContent = '';
        if (keys.size) movement();
        updateRoom();
        void showGame();
        break;
      case 'snapshot': {
        seats = message.seats;
        if (info.gameUrl) { shared = message.state; updateRoom(); break; }
        const mossUpdate = mossState.safeParse(message.state);
        if (mossUpdate.success && info.manifest.simulation === 'mosslight-v1') {
          moss = mossUpdate.data;
          score.textContent = moss.finished ? 'All lights collected!' : moss.collected.length + ' / ' + moss.total + ' lights';
        }
        const tileUpdate = tileState.safeParse(message.state);
        if (tileUpdate.success && info.manifest.simulation === 'tessellate-v1') {
          tile = tileUpdate.data;
          renderBoard();
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
    const { ticket } = await fetchRoom<{ ticket: string }>(room, 'reserve', { invite, name: values.get('name'), role: values.get('role') });
    connect(ticket);
  } catch (reason) { error.textContent = (reason as Error).message; }
  finally { submit.disabled = false; }
}

try {
  const credential = saved() || invite;
  if (!credential) throw new Error('Open the complete invitation link from the room owner.');
  try { info = await fetchRoom<RoomInfo>(room, 'info', undefined, credential); resumed = credential !== invite; }
  catch (error) {
    if (!invite || credential === invite) throw error;
    remember();
    info = await fetchRoom<RoomInfo>(room, 'info', undefined, invite);
  }
  document.title = info.manifest.title + ' · Zirbel';
  byId('game-title').textContent = info.manifest.title;
  byId('lobby-title').textContent = info.manifest.title;
  byId('lobby-description').textContent = info.gameUrl || !info.manifest.template ? '' : templates[info.manifest.template].description;
  byId('badge').textContent = info.development ? 'Development playtest' : info.solo ? 'Local playtest' : '';
  if (resumed) connect(credential);
  else if (info.solo) {
    const { ticket } = await fetchRoom<{ ticket: string }>(room, 'reserve', { invite, name: 'Explorer', role: 'player' });
    connect(ticket);
  } else showLobby();
} catch (reason) {
  showLobby((reason as Error).message);
  form.hidden = true;
}
