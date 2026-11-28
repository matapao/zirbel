// The TV page's places (tv.ts): P1 to P8, each with the controller that holds it (a phone, a gamepad on the box, or a
// gamepad of this device's own) and what it drives there, in its colour. A phone takes the next free place by the big QR
// code, or a place by its own; "Press A to take P3" gives a place to the next controller whose A goes down; two places
// swap, and a place's controller is let go. The host keeps the places of the screen's controllers, and this page those
// of the device's own gamepads, which it tells the host so it gives them to no one else.
import type { openScreen, PadInfo } from './pads-client.ts';
import { qrPicture } from './qr.ts';

type Screen = ReturnType<typeof openScreen>;

const PLACES = 8;
/** Each place's colour where what it drives names none, the same everywhere a place is shown. */
const PLACE_COLORS = ['#ef5b4f', '#3f8fe5', '#f2c33a', '#46c06a', '#a46be3', '#f28b3c', '#36c6c0', '#e16fb3'] as const;
/** How long a place waits for a controller's A, as the host waits. */
const CLAIM_MS = 30_000;

type Holder = {
  kind: 'phone' | 'box' | 'gamepad';
  name: string;
  label: { name: string; color: string } | null;
  slot?: number;
};
/** A place's controller as its tile names it. */
function holderKind(holder: Holder) {
  if (holder.kind === 'phone') return 'Phone';
  if (holder.kind === 'box') return 'Gamepad on the box';
  return holder.name;
}
type Context = {
  /** The screen, once open; the lobby's address for other devices; the screen's code. */
  screen: () => Screen | undefined;
  base: () => string;
  code: () => string | undefined;
  /** Moves focus to a tile by its key, once the places are drawn. */
  focus: (key: string) => void;
  say: (text: string) => void;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const label = (place: number) => 'P' + (place + 1);
const colour = (place: number, holder?: Holder) =>
  holder?.label?.color && /^#[0-9a-f]{6}$/i.test(holder.label.color)
    ? holder.label.color
    : PLACE_COLORS[place % PLACES]!;

export class Places {
  private pads: PadInfo[] = [];
  /** The device's own gamepads' places, by gamepad index. */
  private readonly native = new Map<number, { place: number; name: string }>();
  private claim: { place: number; until: number; timer: ReturnType<typeof setInterval> } | undefined;
  /** The controller that took the last place waiting for A, and when: that A chooses nothing here either. */
  private took?: { source: string; at: number };
  private chosen: number | undefined;
  private swapping: number | undefined;
  private readonly codes = new Map<string, Promise<HTMLImageElement>>();

  private readonly root: HTMLElement;
  private readonly context: Context;

  constructor(root: HTMLElement, context: Context) {
    this.root = root;
    this.context = context;
  }

  /** Whether a controller's A now takes a place rather than choosing on the page: while a place waits for one, and
   *  for the controller that just took it (its frame may come after the host's word that it did). */
  taking(source: string) {
    return this.claim !== undefined || (this.took?.source === source && performance.now() - this.took.at < 1000);
  }

  /** The address that adds a phone at a place, or at the next free one. */
  padLink(place?: number) {
    const code = this.context.code();
    if (!code) return undefined;
    const link = new URL('pad/' + encodeURIComponent(code), this.context.base());
    if (place !== undefined) link.searchParams.set('place', String(place));
    return link.href;
  }

  /** What a place's tile says: its holder's label and kind, else a claim's countdown, else Free. */
  private holderText(place: number, holder: Holder | undefined) {
    if (holder) return [holder.label?.name, holderKind(holder)].filter(Boolean).join(' · ');
    if (this.claim?.place === place)
      return 'Press A · ' + Math.max(0, Math.ceil((this.claim.until - Date.now()) / 1000)) + ' s';
    return 'Free';
  }

  holders() {
    const holders: (Holder | undefined)[] = Array.from({ length: PLACES }, () => undefined);
    for (const pad of this.pads)
      if (pad.connected && pad.place >= 0 && pad.place < PLACES)
        holders[pad.place] = { kind: pad.kind, name: pad.name, label: pad.label, slot: pad.slot };
    for (const { place, name } of this.native.values()) holders[place] ??= { kind: 'gamepad', name, label: null };
    return holders;
  }

  setPads(pads: PadInfo[]) {
    this.pads = pads;
    // A place the host filled while it waited for a controller's A is taken.
    if (this.claim && this.holders()[this.claim.place]) {
      this.took = { source: 'pad:' + this.claim.place, at: performance.now() };
      this.endClaim();
    }
    this.render();
  }

  /** The place a device gamepad's press takes: the claimed one, for A, if it is free or already this gamepad's; for
   *  one without a place, the first free (-1 when none is); else none. */
  private placeFor(a: boolean, holders: (Holder | undefined)[], own: { place: number } | undefined) {
    if (a && this.claim && (!holders[this.claim.place] || own?.place === this.claim.place)) return this.claim.place;
    return own ? undefined : holders.findIndex((holder) => !holder);
  }

  /** A device gamepad's button went down: one without a place takes the place waiting for A, or the first free one. */
  pressed(index: number, name: string, a: boolean) {
    if (this.native.has(index) && !(a && this.claim)) return;
    const holders = this.holders();
    const own = this.native.get(index);
    const place = this.placeFor(a, holders, own);
    if (place === undefined || place < 0) return;
    this.native.set(index, { place, name: name.replace(/\s*\(.*$/, '').slice(0, 40) || 'Gamepad' });
    if (this.claim?.place === place) {
      this.took = { source: 'device:' + index, at: performance.now() };
      this.endClaim();
    }
    this.tellLocal();
    this.render();
  }

  /** A device gamepad went away: its place is free. */
  gone(index: number) {
    if (this.native.delete(index)) {
      this.tellLocal();
      this.render();
    }
  }

  /** Back, while the places have a step open: true when it closed one. */
  back() {
    if (this.claim) {
      this.endClaim();
      this.render();
      this.context.focus('place:' + this.chosen);
      return true;
    }
    if (this.swapping !== undefined || this.chosen !== undefined) {
      const place = this.swapping ?? this.chosen;
      this.swapping = this.chosen = undefined;
      this.render();
      this.context.focus('place:' + place);
      return true;
    }
    return false;
  }

  private tellLocal() {
    this.context.screen()?.local([...this.native.values()].map(({ place }) => place));
  }

  private endClaim() {
    if (this.claim) clearInterval(this.claim.timer);
    this.claim = undefined;
  }

  private startClaim(place: number) {
    this.endClaim();
    this.context.screen()?.claim(place);
    const timer = setInterval(() => {
      if (this.claim && Date.now() >= this.claim.until) this.endClaim();
      this.render();
    }, 1000);
    this.claim = { place, until: Date.now() + CLAIM_MS, timer };
    this.chosen = undefined;
    this.render();
    this.context.focus('place:' + place);
    this.context.say('Press A on a controller to take ' + label(place) + '.');
  }

  /** Two places swap their controllers, the device's own gamepads here and the screen's at the host. */
  private swap(from: number, to: number) {
    this.swapping = this.chosen = undefined;
    if (from !== to) {
      let moved = false;
      for (const own of this.native.values())
        if (own.place === from || own.place === to) {
          own.place = own.place === from ? to : from;
          moved = true;
        }
      this.context.screen()?.move(from, to);
      if (moved) this.tellLocal();
    }
    this.render();
    this.context.focus('place:' + to);
  }

  private choose(place: number) {
    if (this.swapping !== undefined) {
      this.swap(this.swapping, place);
      return;
    }
    this.chosen = this.chosen === place ? undefined : place;
    this.render();
    this.context.focus(this.chosen === undefined ? 'place:' + place : 'menu:0');
  }

  private picture(link: string, alt: string) {
    let made = this.codes.get(link);
    if (!made) this.codes.set(link, (made = qrPicture(link, alt)));
    const frame = el('span', undefined, 'qr-frame');
    void made.then((picture) => frame.append(picture.cloneNode()));
    return frame;
  }

  render() {
    // The tile in focus stays in focus as the places are drawn again.
    const focused = this.root.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.key
      : undefined;
    const holders = this.holders();
    const code = this.context.code();
    const next = this.padLink();
    const join = el('div', undefined, 'join');
    if (code && next) {
      const about = el('div');
      about.append(
        el('p', 'Scan to play with a phone'),
        el('strong', code, 'code'),
        el('small', new URL('pad', this.context.base()).href.replace(/^https?:\/\//, '') + ' · this code'),
      );
      join.append(this.picture(next, 'QR code that adds a phone at the next free place'), about);
    } else join.append(el('p', 'Connecting the controllers…'));
    const list = el('ol', undefined, 'places');
    holders.forEach((holder, place) => {
      const item = el('li');
      const tile = el(
        'button',
        undefined,
        'place' + (holder ? '' : ' empty') + (this.swapping === place ? ' moving' : ''),
      );
      tile.type = 'button';
      tile.dataset.nav = '';
      tile.dataset.key = 'place:' + place;
      tile.style.setProperty('--place', colour(place, holder));
      const who = this.holderText(place, holder);
      tile.append(el('span', label(place), 'tag'), el('span', who, 'who'));
      tile.setAttribute('aria-label', label(place) + ': ' + who);
      const link = holder ? undefined : this.padLink(place);
      if (link) tile.append(this.picture(link, 'QR code that adds a phone at ' + label(place)));
      tile.addEventListener('click', () => this.choose(place));
      item.append(tile);
      list.append(item);
    });
    const menu = el('div', undefined, 'menu');
    const chosen = this.chosen;
    if (this.swapping !== undefined)
      menu.append(el('p', 'Choose the place to swap ' + label(this.swapping) + ' with.'));
    else if (chosen !== undefined) {
      const holder = holders[chosen];
      const actions: [string, () => void][] = [
        ...(holder
          ? []
          : [['Press A to take ' + label(chosen), () => this.startClaim(chosen)] as [string, () => void]]),
        [
          'Swap ' + label(chosen) + ' with…',
          () => {
            this.swapping = chosen;
            this.chosen = undefined;
            this.render();
            this.context.focus('place:' + chosen);
          },
        ],
        ...(holder?.slot !== undefined
          ? [
              [
                'Let ' + label(chosen) + ' go',
                () => {
                  this.context.screen()?.release(holder.slot!);
                  this.chosen = undefined;
                  this.render();
                  this.context.focus('place:' + chosen);
                },
              ] as [string, () => void],
            ]
          : []),
      ];
      actions.forEach(([text, act], index) => {
        const button = el('button', text);
        button.type = 'button';
        button.dataset.nav = '';
        button.dataset.key = 'menu:' + index;
        button.addEventListener('click', act);
        menu.append(button);
      });
    }
    menu.hidden = !menu.firstChild;
    this.root.replaceChildren(el('h2', 'Players'), join, list, menu);
    if (focused) this.root.querySelector<HTMLElement>('[data-key="' + focused + '"]')?.focus();
  }
}
