// A net game's space on the player page. Its link is /join/<room>#skalet.space=<id> with the space's invitation
// (&skalet.invite=), a one-time ticket (&skalet.ticket=) or, from Show on TV, the member's own resume (&resume=). The page
// joins with it, holds the connection, and shares the space with the game's sandboxed frame (spaces.bridge), which joins
// through its parent and never holds a credential. Alone (a playtest, a host without the kernel) it shares a space of the
// page's own, and the game plays alone. The spaces SDK is the kernel's /.skalet/spaces.js on this listener; the network
// simulator ?net= asks for is the net module's, /.skalet/net.js, under this page's connection.

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
};
type Spaces = {
  join(options: Record<string, unknown>): Promise<PageSpace>;
  bridge(frame: HTMLIFrameElement, space: PageSpace): () => void;
};
export type SpaceLink = { space: string; invite?: string; ticket?: string; resume?: string };

const SPACE_ID = /^[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{16,128}$/;
/** Where the spaces SDK keeps a member's resume token in this tab, by its space: a reload resumes the same member. */
const resumeKey = (space: string) => 'skalet.space.' + space;

/** The space a player page's address names, with the credential it holds; none for a room's own links. */
export function spaceLink(hash: string): SpaceLink | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const space = params.get('skalet.space') ?? '';
  if (!SPACE_ID.test(space)) return undefined;
  const secret = (name: string) => {
    const value = params.get(name) ?? '';
    return SECRET.test(value) ? { [name.replace('skalet.', '')]: value } : {};
  };
  return { space, ...secret('skalet.invite'), ...secret('skalet.ticket'), ...secret('resume') };
}

// A module of this listener's, loaded at run time rather than bundled into the page.
const load = (path: string) => import(path) as Promise<Record<string, unknown>>;
let loading: Promise<Spaces | undefined> | undefined;
/** The spaces SDK, or none where this host runs no kernel. */
function spacesSdk() {
  loading ??= load('/.skalet/spaces.js').then((module) => module.spaces as Spaces, () => undefined);
  return loading;
}

/** The network simulator ?net= asks for (lag, jitter, loss, kbps), as a WebSocket class; none for stats alone. */
async function simulated() {
  const asked = new URLSearchParams(location.search).get('net');
  if (!asked || !/(?:^|,)(?:lag|jitter|loss|kbps):/.test(asked)) return undefined;
  const net = await load('/.skalet/net.js').catch(() => undefined) as
    { netParams?: (search: string) => object; netsim?: (options: object) => unknown } | undefined;
  if (!net?.netParams || !net.netsim) return undefined;
  return net.netsim(net.netParams('?net=' + asked));
}

/** Joins the space the link names: with a resume this tab holds (or Show on TV handed it), else the link's ticket or
 *  invitation, with the name and role the page asked for. The link's credential then leaves the page's address. */
export async function joinSpace(link: SpaceLink, asked: { name?: string; role?: Role } = {}) {
  const spaces = await spacesSdk();
  if (!spaces) throw new Error('Multiplayer isn’t available on this host now.');
  if (link.resume) try { sessionStorage.setItem(resumeKey(link.space), link.resume); } catch { /* the link's own goes on */ }
  const credential = link.invite ? '&skalet.invite=' + link.invite : link.ticket ? '&skalet.ticket=' + link.ticket : '';
  const WebSocket = await simulated();
  const space = await spaces.join({ link: location.origin + location.pathname + '#skalet.space=' + link.space + credential,
    binary: true, ...asked, ...(WebSocket ? { WebSocket } : {}) });
  history.replaceState(null, '', location.pathname + location.search + '#skalet.space=' + link.space);
  return space;
}

/** Whether this tab holds a member's resume for the space: it goes back in without asking. */
export function holdsPlace(space: string) {
  try { return Boolean(sessionStorage.getItem(resumeKey(space))); } catch { return false; }
}

/** A space of the page's own, for a game that plays alone; none without the SDK. */
export async function localSpace() {
  const spaces = await spacesSdk();
  return spaces?.join({ link: location.origin + location.pathname });
}

/** Shares the space with the game's frame; the returned function ends that, before the frame goes. */
export async function bridgeFrame(frame: HTMLIFrameElement, space: PageSpace) {
  const spaces = await spacesSdk();
  if (!spaces) return () => {};
  const { shared, asked } = held(space, frame);
  const end = spaces.bridge(frame, shared);
  // After the bridge's own: by the time this hears the frame ask, the bridge has the frame's port.
  addEventListener('message', asked);
  return () => { removeEventListener('message', asked); end(); };
}

/** Messages held for a frame that hasn't asked for its space yet, at most. */
const HELD = 1024;
type Listener = (...args: unknown[]) => void;
type Call = (...args: unknown[]) => unknown;
/** A space, or its binary lane, as the bridge uses it. */
type Shared = Record<string, unknown> & { on(event: string, listener: Listener): () => void };
/**
 * The space as the bridge sees it. The page joins before its game's frame has loaded, and the bridge passes on only what
 * comes once the frame has asked: the others' messages (JSON and binary) that come before are held, and passed on in
 * their order as the frame asks. The rest needs no holding: the frame's welcome has the members, the leader and the state
 * as they are then. Every other property is the space's own, read as the bridge reads it.
 */
function held(space: PageSpace, frame: HTMLIFrameElement) {
  let open = false;
  const waiting: (() => void)[] = [];
  const hold = (listener: Listener): Listener => (...args) => {
    if (open) listener(...args);
    else if (waiting.push(() => listener(...args)) > HELD) waiting.shift();
  };
  const through = (target: Shared, keys: readonly string[], calls: readonly string[], holds: (event: string) => boolean) => {
    const out: Record<string, unknown> = { on: (event: string, listener: Listener) => target.on(event, holds(event) ? hold(listener) : listener) };
    for (const key of keys) Object.defineProperty(out, key, { get: () => target[key], enumerable: true });
    for (const key of calls) out[key] = (...args: unknown[]) => (target[key] as Call).apply(target, args);
    return out;
  };
  const real = space as unknown as Shared;
  const lane = real.binary as Shared | undefined;
  const shared = through(real, ['id', 'member', 'members', 'state', 'leader', 'rules', 'local', 'status', 'features', 'limits'],
    ['act', 'send', 'resync', 'time', 'leave'], (event) => event === 'message');
  shared.binary = lane && through(lane, ['stats'], ['send', 'stream', 'flush'], () => true);
  const asked = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (open || event.source !== frame.contentWindow || !data || typeof data !== 'object' ||
      (data as Record<string, unknown>)['skalet.spaces'] !== 'hello') return;
    open = true;
    for (const run of waiting.splice(0)) run();
  };
  return { shared: shared as unknown as PageSpace, asked };
}

/** Show on TV: the link that seats the box's screen as this member, which takes this page's place; this tab keeps the
 *  resume no more, so it doesn't take the place back. */
export function handOver(room: string, space: PageSpace) {
  let token: string | null = null;
  try { token = sessionStorage.getItem(resumeKey(space.id)); } catch { /* nothing to hand over */ }
  return token && SECRET.test(token) ? '/join/' + room + '#skalet.space=' + space.id + '&resume=' + token : undefined;
}

/** Forgets this tab's resume for a space: after Show on TV, or when the space is gone. */
export function forgetPlace(space: string) {
  try { sessionStorage.removeItem(resumeKey(space)); } catch { /* nothing kept */ }
}
