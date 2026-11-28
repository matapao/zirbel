// The player page's Controllers panel: how phones join this screen (its code in large letters, and a QR code of the pad
// page for the next free place), each place P1 to P8 with its controller and what it drives there, in its colour, a QR
// code for each empty place, "Press A to take Pk", swapping two places, letting a controller go, a gamepad on the box,
// and Show on TV while the box shows its own screen.
import { MAX_PLACES } from '../sdk/controls.ts';
import type { Controllers } from './controllers.ts';
import { slotColour } from './pad-state.ts';
import { qrPicture } from './qr.ts';

const KINDS = { phone: 'Phone', box: 'Gamepad on the box', own: 'Gamepad on this device' } as const;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// A QR code for each link, drawn once.
const pictures = new Map<string, Promise<HTMLImageElement>>();
async function picture(link: string, alt: string, className: string) {
  if (!pictures.has(link)) pictures.set(link, qrPicture(link, alt));
  const drawn = (await pictures.get(link)!).cloneNode() as HTMLImageElement;
  drawn.classList.add(className);
  return drawn;
}

/** Draws the panel into its aside each time the controllers change. */
export function controllersPanel(
  panel: HTMLElement,
  controllers: Controllers,
  actions: { showOnTv?(): void; close(): void },
) {
  let ticking: number | undefined;
  let drawing = 0;
  const padLink = (place?: number) =>
    location.origin + '/pad/' + (controllers.info?.code ?? '') + (place === undefined ? '' : '?place=' + place);

  function claimText() {
    const claim = controllers.claiming;
    if (!claim) return '';
    const left = Math.max(0, Math.ceil((claim.until - Date.now()) / 1000));
    return (
      'Press A on the controller that takes ' +
      (claim.place === undefined ? 'the next free place' : 'P' + (claim.place + 1)) +
      ' (' +
      left +
      ' s).'
    );
  }

  async function draw() {
    const turn = ++drawing;
    const { info, claiming: claim } = controllers;
    const head = element('div', '', 'controllers-head');
    const title = element('h2', 'Controllers');
    title.id = 'controllers-title';
    const close = element('button', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => actions.close());
    head.append(title, close);
    const parts: HTMLElement[] = [head];

    if (info) {
      const join = element('section', '', 'join-phones');
      join.append(
        element('p', 'Phones open ' + location.host + '/pad and enter', ''),
        element('p', info.code, 'pad-code'),
      );
      const frame = element('span', '', 'qr-frame');
      frame.append(
        await picture(padLink(), 'QR code that makes a phone a controller at the next free place', 'qr-next'),
      );
      join.append(frame, element('p', 'or scan this with the phone’s camera.', 'quiet'));
      parts.push(join);
    }

    const list = element('ol', '', 'places');
    for (let place = 0; place < MAX_PLACES; place++) {
      const item = element('li');
      const label = controllers.labels.get(place);
      item.style.setProperty('--place', label?.color ?? slotColour(place));
      const who = controllers.occupant(place);
      item.append(element('strong', 'P' + (place + 1), 'place-tag'));
      const what = element('span', '', 'who');
      what.textContent = who ? KINDS[who.kind] + (who.name ? ': ' + who.name.slice(0, 40) : '') : 'Empty';
      if (label?.name) what.append(element('span', ' · ' + label.name, 'drives'));
      item.append(what);
      if (who) {
        const swap = element('select');
        swap.setAttribute('aria-label', 'Swap P' + (place + 1) + ' with');
        swap.append(new Option('Swap with…', ''));
        for (let other = 0; other < MAX_PLACES; other++)
          if (other !== place) swap.append(new Option('P' + (other + 1), String(other)));
        swap.addEventListener('change', () => {
          if (swap.value) controllers.swap(place, Number(swap.value));
        });
        const release = element('button', 'Let go');
        release.type = 'button';
        release.setAttribute('aria-label', 'Let go of P' + (place + 1) + '’s controller');
        release.addEventListener('click', () => controllers.release(place));
        item.append(swap, release);
      } else {
        const take = element(
          'button',
          claim?.place === place ? 'Press A on a controller…' : 'Press A to take P' + (place + 1),
          'take',
        );
        take.type = 'button';
        take.addEventListener('click', () => controllers.claim(place));
        item.append(take);
        if (info) item.append(await picture(padLink(place), 'QR code that makes a phone P' + (place + 1), 'qr-place'));
      }
      list.append(item);
    }
    parts.push(list);

    const footer = element('div', '', 'controllers-actions');
    if (info && !info.box) {
      const box = element('button', 'Use a controller on the box');
      box.type = 'button';
      box.addEventListener('click', () => controllers.claim());
      footer.append(box);
    }
    if (info?.tv && !info.box && actions.showOnTv) {
      const tv = element('button', 'Show on TV', 'primary');
      tv.type = 'button';
      tv.addEventListener('click', () => actions.showOnTv?.());
      footer.append(tv);
    }
    const waiting = element('p', claimText(), 'claim-status');
    waiting.setAttribute('role', 'status');
    footer.append(waiting);
    parts.push(footer);
    // A later change drew over this one while its pictures came.
    if (turn === drawing) panel.replaceChildren(...parts);
  }

  return {
    draw() {
      void draw();
      // The countdown alone, each second, so a choice being made in the panel stays.
      if (controllers.claiming && ticking === undefined)
        ticking = window.setInterval(() => {
          if (!controllers.claiming) {
            clearInterval(ticking);
            ticking = undefined;
          }
          const status = panel.querySelector('.claim-status');
          if (status) status.textContent = claimText();
        }, 1000);
    },
  };
}
