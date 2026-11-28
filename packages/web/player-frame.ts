// An authored game on the player page, in its sandboxed frame: the port its document opens to this page, the room it is
// told of, what it sends back (its state, errors, rumble, places and objects), and a net game's space shared with it.
import { boundedJson, objectRegistry } from '../sdk/game.ts';
import type { SeatInfo } from '../sdk/contracts.ts';
import type { RoomInfo } from '../sdk/client.ts';
import type { Controllers } from './controllers.ts';
import { bridgeFrame, gameFrame as sandboxedFrame, localSpace, type PageSpace } from './player-space.ts';

/** What the frame needs of the page: its room and seats as they are now, its controllers, and the room to send to. */
type Page = {
  room: string;
  error: HTMLElement;
  info: () => RoomInfo;
  seat: () => SeatInfo | undefined;
  seats: () => SeatInfo[];
  controllers: () => Controllers | undefined;
  send: (value: unknown) => void;
};

/** The page's authored game: none until a session's space or open makes its frame, and none again after close. */
export function gameFrame({ room, error, info, seat: self, seats, controllers, send }: Page) {
  let authoredFrame: HTMLIFrameElement | undefined;
  let gamePort: MessagePort | undefined;
  let shared: unknown = {};
  let endBridge: (() => void) | undefined;
  function updateRoom() {
    const seat = self();
    if (!seat) return;
    const message = { type: 'zirbel.room', value: { self: seat, seats: seats(), states: shared ?? {} } };
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no target origin
    gamePort?.postMessage(message);
  }
  // Checked below: the sender is the game frame and its origin is the sandbox's opaque 'null'.
  // nosemgrep: javascript.browser.security.insufficient-postmessage-origin-validation.insufficient-postmessage-origin-validation -- checked below
  window.addEventListener('message', (event) => {
    if (!authoredFrame || event.source !== authoredFrame.contentWindow || event.origin !== 'null') return;
    const port = event.ports[0];
    const key = info().gameUrl?.split('/')[3]; // /game/<room>/<key>/, a net game's /game/@<room>/<key>/
    if (!port || !key || event.data?.type !== 'zirbel.ready' || event.data.documentKey !== key) return;
    // A WindowProxy survives navigation. This port belongs to the document that opened it.
    gamePort?.close();
    gamePort = port;
    port.onmessage = ({ data }) => {
      if (gamePort === port) receiveGameMessage(data);
    };
    updateRoom();
    controllers()?.attach(port);
  });

  // Games may call zirbel.send every frame. Forward only the latest state at the
  // server's 20 Hz tick so the room's 60-messages-per-second limit is never hit.
  let latestState: unknown;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  function sendLatestState(value: unknown) {
    latestState = value;
    stateTimer ??= setTimeout(() => {
      stateTimer = undefined;
      send(latestState);
    }, 50);
  }

  function receiveGameMessage(data: MessageEvent['data']) {
    const { type, value } = data ?? {};
    if (type === 'zirbel.rumble' || type === 'zirbel.place') controllers()?.fromGame(type, value);
    if (type === 'zirbel.error' && typeof value === 'string') error.textContent = value.slice(0, 500);
    if (
      type === 'zirbel.state' &&
      info().manifest.simulation === 'shared-state-v1' &&
      self()?.role === 'player' &&
      boundedJson(value) &&
      JSON.stringify(value).length <= 4096
    )
      sendLatestState(value);
    if (type === 'zirbel.objects' && window.parent !== window && info().solo && info().registerObjects !== false) {
      const objects = objectRegistry.safeParse(value);
      // frame-ancestors lets only the editor frame the player, so the parent is the editor; the payload is the validated registry.
      // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- the parent is the editor
      if (objects.success) window.parent.postMessage({ type, room, value: objects.data }, '*');
    }
  }

  /** A game with its own netcode that plays alone joins a space of the page's own through it. */
  async function playAlone(frame: HTMLIFrameElement) {
    const alone = await localSpace().catch(() => undefined);
    const end = alone && frame === authoredFrame ? await bridgeFrame(frame, alone, () => {}) : undefined;
    if (frame === authoredFrame) endBridge = end;
    else end?.();
  }

  return {
    /** The frame of a net game's session, its space shared with it at once: what the others send waits for the game,
     *  which loads once the page has the room's info (open). gone hears when the game left the space and didn't come back
     *  in time. */
    share: async (space: PageSpace, gone: () => void) => {
      const frame = (authoredFrame = sandboxedFrame());
      endBridge = await bridgeFrame(frame, space, () => {
        if (frame === authoredFrame) gone();
      });
    },
    /** Opens the game at gameUrl in a frame first in the view (a session's own, else a new one); a net game that plays
     *  alone shares a space of the page's own with it. */
    open: (view: HTMLElement, gameUrl: string) => {
      authoredFrame ??= sandboxedFrame();
      authoredFrame.title = info().manifest.title;
      // A simulated network for testing (the net module's ?net=lag:120,…,stats) goes from the player's address to the
      // game's, whose overlay shows it; the simulator itself is under this page's connection.
      const simulated = new URLSearchParams(location.search).get('net');
      const net = info().manifest.simulation === 'net-v2';
      authoredFrame.src = gameUrl + (net && simulated ? '?net=' + encodeURIComponent(simulated) : '');
      view.prepend(authoredFrame);
      if (net && !endBridge) void playAlone(authoredFrame);
    },
    /** Tells the game of the room as it is now. */
    update: updateRoom,
    /** The room's states as its last snapshot had them, which the game is told of. */
    states: (states: unknown) => {
      shared = states;
      updateRoom();
    },
    /** Stops forwarding, closes the port, ends the shared space and removes the frame. */
    close: () => {
      clearTimeout(stateTimer);
      stateTimer = undefined;
      gamePort?.close();
      gamePort = undefined;
      endBridge?.();
      endBridge = undefined;
      authoredFrame?.remove();
      authoredFrame = undefined;
    },
  };
}
