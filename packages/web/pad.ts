// The pad page, /pad and /pad/<code> on every player listener: a phone as a controller of a screen. With no code in its
// address it asks for the one the screen shows; then it is a full-screen pad in the standard layout (a left stick, a
// d-pad, A B X Y, LB RB LT RT, Select and Start), every finger its own, and joins the screen at the place its link offers
// (?place=k) or the first free one. It shows its place (P1 to P8) with the name and colour of what it drives, moves to
// another free place, sends the phone's own gamepad instead while one is connected, vibrates when the game rumbles it,
// and comes back at its place when the connection drops. Nothing here needs a secure page: a box serves it over http.
import { MAX_PLACES, type PlaceLabel } from '../sdk/controls.ts';
import { padLink, readPad, type LinkState } from './pad-link.ts';
import { down, inkOn, restingPad, slotColour, type Pad } from './pad-state.ts';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const join = byId('join'), pad = byId('pad'), form = byId<HTMLFormElement>('code-form'), input = byId<HTMLInputElement>('code');
const message = byId('message'), status = byId('status'), placeButton = byId<HTMLButtonElement>('place');
const places = byId('places'), placeList = byId('place-list');
const stick = byId('stick'), knob = byId('knob');

const normalized = (text: string) => text.toUpperCase().replace(/[^0-9A-Z]/g, '');
const asked = new URLSearchParams(location.search).get('place');
const offered = asked !== null && /^[0-7]$/.test(asked) ? Number(asked) : undefined;
// What the fingers hold: each pointer on one button, or on the stick.
const buttons = new Map<number, number>();
let stickPointer: number | undefined;
const axes = [0, 0];
function touchPad(): Pad {
  const state = restingPad();
  for (const button of buttons.values()) state.buttons[button] = down();
  state.axes[0] = axes[0]!;
  state.axes[1] = axes[1]!;
  return state;
}
function shown() {
  const held = new Set(buttons.values());
  for (const element of pad.querySelectorAll<HTMLElement>('[data-button]')) element.classList.toggle('held', held.has(Number(element.dataset.button)));
  stick.classList.toggle('held', stickPointer !== undefined);
}
function steer(event: PointerEvent) {
  const box = stick.getBoundingClientRect();
  const radius = box.width / 2;
  let x = (event.clientX - box.left - radius) / radius, y = (event.clientY - box.top - radius) / radius;
  const length = Math.hypot(x, y);
  if (length > 1) { x /= length; y /= length; }
  axes[0] = x;
  axes[1] = y;
  knob.style.transform = `translate(calc(-50% + ${x * radius * 0.6}px), calc(-50% + ${y * radius * 0.6}px))`;
}
/** The button under a finger, which may slide from one to the next. */
function buttonAt(event: PointerEvent) {
  const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-button]');
  return element && pad.contains(element) ? Number(element.dataset.button) : undefined;
}
pad.addEventListener('pointerdown', (event) => {
  if (places.contains(event.target as Node) || event.target === placeButton) return;
  event.preventDefault();
  if (stick.contains(event.target as Node) && stickPointer === undefined) {
    stickPointer = event.pointerId;
    try { stick.setPointerCapture(event.pointerId); } catch { /* the finger is the stick's either way */ }
    steer(event);
  }
  else {
    const button = buttonAt(event);
    if (button !== undefined) buttons.set(event.pointerId, button);
  }
  shown();
});
pad.addEventListener('pointermove', (event) => {
  if (event.pointerId === stickPointer) { steer(event); return; }
  if (!buttons.has(event.pointerId)) return;
  const button = buttonAt(event);
  if (button === undefined) buttons.delete(event.pointerId); else buttons.set(event.pointerId, button);
  shown();
});
for (const type of ['pointerup', 'pointercancel'] as const) pad.addEventListener(type, (event) => {
  if (event.pointerId === stickPointer) {
    stickPointer = undefined;
    axes[0] = axes[1] = 0;
    knob.style.transform = '';
  }
  buttons.delete(event.pointerId);
  shown();
});
// No scrolling, pinching, double-tap zoom or a long press's menu on the pad.
for (const type of ['touchstart', 'touchmove'] as const) pad.addEventListener(type, (event) => {
  if (!places.contains(event.target as Node) && event.target !== placeButton) event.preventDefault();
}, { passive: false });
pad.addEventListener('contextmenu', (event) => event.preventDefault());
document.addEventListener('gesturestart', (event) => event.preventDefault());

// Full screen where the browser has it, on a tap, a click or a key: never on a gamepad's press, which browsers don't
// count as a gesture.
function fill() {
  if (document.fullscreenElement || typeof document.documentElement.requestFullscreen !== 'function') return;
  void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
for (const type of ['pointerup', 'keydown'] as const) document.addEventListener(type, () => { if (!pad.hidden) fill(); });

let link: ReturnType<typeof padLink> | undefined;
let stopReading: (() => void) | undefined;
let place: number | undefined;
let moving: number | undefined;
function showPlace(at: number, label: PlaceLabel | null) {
  place = at;
  const colour = label?.color ?? slotColour(at);
  document.documentElement.style.setProperty('--place', colour);
  document.documentElement.style.setProperty('--place-ink', inkOn(colour));
  placeButton.textContent = 'P' + (at + 1) + (label?.name ? ' · ' + label.name : '');
  placeButton.setAttribute('aria-label', placeButton.textContent + ': move to another place');
  for (const button of placeList.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(Number(button.dataset.place) === at));
}
function onState(code: string, state: LinkState) {
  if (state.state === 'joining') status.textContent = 'Joining ' + code + '…';
  else if (state.state === 'joined') {
    join.hidden = true;
    pad.hidden = false;
    status.textContent = '';
    if (moving === state.place) moving = undefined;
    showPlace(state.place, state.label);
  } else end(code, state.message, state.retry);
}
function end(code: string, text: string, retry: boolean) {
  link?.close();
  link = undefined;
  stopReading?.();
  stopReading = undefined;
  pad.hidden = true;
  places.hidden = true;
  join.hidden = false;
  message.textContent = text;
  input.value = retry ? code : '';
  history.replaceState(null, '', retry ? '/pad/' + code + location.search : '/pad' + location.search);
}

function start(code: string) {
  message.textContent = '';
  history.replaceState(null, '', '/pad/' + code + location.search);
  document.title = 'Zirbel · Controller ' + code;
  link = padLink(code, (state) => onState(code, state),
    { place: offered });
  // The phone's own gamepad while one is connected, else the touch pad.
  stopReading = readPad(touchPad, (state) => link?.update(state),
    (gamepad) => { pad.classList.toggle('gamepad', Boolean(gamepad)); status.textContent = gamepad ? 'Sending your gamepad: ' + gamepad : ''; });
}

// Another place, where it is free: the host moves this pad, or leaves it where it is.
for (let at = 0; at < MAX_PLACES; at++) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.place = String(at);
  button.textContent = 'P' + (at + 1);
  button.style.borderColor = slotColour(at);
  button.addEventListener('click', () => {
    places.hidden = true;
    placeButton.setAttribute('aria-expanded', 'false');
    if (at === place) return;
    moving = at;
    link?.move(at);
    // The host moves a pad only to a free place, and says nothing when it doesn't.
    window.setTimeout(() => {
      if (moving !== at) return;
      moving = undefined;
      status.textContent = 'P' + (at + 1) + ' isn’t free.';
    }, 1500);
  });
  placeList.append(button);
}
placeButton.addEventListener('click', () => {
  places.hidden = !places.hidden;
  placeButton.setAttribute('aria-expanded', String(!places.hidden));
});
byId('places-close').addEventListener('click', () => { places.hidden = true; placeButton.setAttribute('aria-expanded', 'false'); });

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = normalized(input.value);
  if (code.length !== 4) { message.textContent = 'A screen’s code has four letters and numbers.'; return; }
  start(code);
});
const fromAddress = normalized(decodeURIComponent(location.pathname.split('/')[2] ?? ''));
if (fromAddress.length === 4) start(fromAddress);
else input.focus();
