// A net game's space on the player page. Its link is /join/<room>#skalet.space=<id> with the space's invitation
// (&skalet.invite=) or a one-time ticket (&skalet.ticket=: the lobby's, or from Show on TV the member's own place, handed
// over); a reload resumes the member the SDK keeps for this tab. The page joins with it, holds the connection, proves to
// the host which member it is (the room's info is for members alone), and shares the space with the game's sandboxed
// frame (spaces.bridge), which joins through its parent and never holds a credential. Alone (a playtest, a host without
// the kernel) it shares a space of the page's own, and the game plays alone. The spaces SDK is the kernel's
// /.skalet/spaces.js on this listener; the network simulator ?net= asks for is the net module's, /.skalet/net.js, under
// this page's connection.

export type Role = 'participant' | 'observer';
type Closed = { reason: string; message: string };
/** As much of a space as this page uses. */
export type PageSpace = {
  readonly id: string;
  readonly member: { readonly id: string; readonly n: number; readonly name: string; readonly role: Role };
  readonly local: boolean;
  on(event: 'closed', listener: (closed: Closed) => void): () => void;
  on(event: 'status', listener: (status: string) => void): () => void;
  leave(): Promise<void>;
  handover(): Promise<{ link: string; ticket: string }>;
  proof(): Promise<string>;
};
type Spaces = {
  join(options: Record<string, unknown>): Promise<PageSpace>;
  bridge(frame: HTMLIFrameElement, space: PageSpace, options: { onLeave?(): void }): () => void;
};
export type SpaceLink = { space: string; invite?: string; ticket?: string };

const SPACE_ID = /^[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{16,128}$/;
/** How long a game's frame that left its space has for its next page to ask for it again, as long as the space holds a
 *  member who dropped, before the page gives up its place too. */
const FRAME_BACK = 15_000;

/** The space a player page's address names, with the credential it holds; none for a room's own links. */
export function spaceLink(hash: string): SpaceLink | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const space = params.get('skalet.space') ?? '';
  if (!SPACE_ID.test(space)) return undefined;
  const secret = (name: string) => {
    const value = params.get('skalet.' + name) ?? '';
    return SECRET.test(value) ? { [name]: value } : {};
  };
  return { space, ...secret('invite'), ...secret('ticket') };
}

// A module of this listener's, loaded at run time rather than bundled into the page.
const load = (path: string) => import(path) as Promise<Record<string, unknown>>;
let loading: Promise<Spaces | undefined> | undefined;
/** The spaces SDK, or none where this host runs no kernel. */
function spacesSdk() {
  loading ??= load('/.skalet/spaces.js').then(
    (module) => module.spaces as Spaces,
    () => undefined,
  );
  return loading;
}

/** The network simulator ?net= asks for (lag, jitter, loss, kbps), as a WebSocket class; none for stats alone. */
async function simulated() {
  const asked = new URLSearchParams(location.search).get('net');
  if (!asked || !/(?:^|,)(?:lag|jitter|loss|kbps):/.test(asked)) return undefined;
  const net = (await load('/.skalet/net.js').catch(() => undefined)) as
    { netParams?: (search: string) => object; netsim?: (options: object) => unknown } | undefined;
  if (!net?.netParams || !net.netsim) return undefined;
  return net.netsim(net.netParams('?net=' + asked));
}

/** Joins the space the link names: as the member this tab holds, else with the link's ticket or invitation, with the
 *  name and role the page asked for. The link's credential then leaves the page's address. */
export async function joinSpace(link: SpaceLink, asked: { name?: string; role?: Role } = {}) {
  const spaces = await spacesSdk();
  if (!spaces) throw new Error('Multiplayer isn’t available on this host now.');
  let credential = '';
  if (link.invite) credential = '&skalet.invite=' + link.invite;
  else if (link.ticket) credential = '&skalet.ticket=' + link.ticket;
  const WebSocket = await simulated();
  const space = await spaces.join({
    link: location.origin + location.pathname + '#skalet.space=' + link.space + credential,
    binary: true,
    ...asked,
    ...(WebSocket ? { WebSocket } : {}),
  });
  history.replaceState(null, '', location.pathname + location.search + '#skalet.space=' + link.space);
  return space;
}

/** A space of the page's own, for a game that plays alone; none without the SDK. */
export async function localSpace() {
  const spaces = await spacesSdk();
  return spaces?.join({ link: location.origin + location.pathname });
}

/** The frame every authored game plays in, sandboxed in an opaque origin, which a net game's space is shared with:
 *  pointer lock, for games aimed with the mouse, starts only on a click in the game, and the browser always shows how to
 *  leave it (Esc); the device's own gamepads go to the game at the places the page gives them. */
export function gameFrame() {
  const frame = document.createElement('iframe');
  frame.className = 'authored-game';
  frame.sandbox.add('allow-scripts', 'allow-pointer-lock');
  frame.allow = 'gamepad';
  frame.referrerPolicy = 'no-referrer';
  return frame;
}

/**
 * Shares the space with the game's frame; the returned function ends that. The bridge holds what comes while the frame
 * isn't in (before it asks, and between its pages). A frame that leaves (its game's leave(), or its page going) ends its
 * own view alone, and the page keeps the place for the frame's next page: gone hears when none asked again in time.
 */
export async function bridgeFrame(frame: HTMLIFrameElement, space: PageSpace, gone: () => void) {
  const spaces = await spacesSdk();
  if (!spaces) return () => {};
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const back = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      event.source === frame.contentWindow &&
      data &&
      typeof data === 'object' &&
      (data as Record<string, unknown>)['skalet.spaces'] === 'hello'
    )
      clearTimeout(waiting);
  };
  addEventListener('message', back);
  const end = spaces.bridge(frame, space, {
    onLeave() {
      clearTimeout(waiting);
      waiting = setTimeout(gone, FRAME_BACK);
    },
  });
  return () => {
    clearTimeout(waiting);
    removeEventListener('message', back);
    end();
  };
}

/** Show on TV: the link that seats the box's screen as this member, from the place the page hands over itself; this
 *  page's connection then ends as replaced, and can't take the place back. */
export async function handOver(room: string, space: PageSpace) {
  const { ticket } = await space.handover();
  if (!SECRET.test(ticket)) throw new Error('The spaces kernel handed over no ticket.');
  return '/join/' + room + '#skalet.space=' + space.id + '&skalet.ticket=' + ticket;
}
