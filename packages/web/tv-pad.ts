// A player page whose game went to the TV (Show on TV) is that game's controller, as the pad page is a phone's: its
// device's gamepad while one is connected, else its keyboard (arrows or WASD the left stick, Space A, ShiftLeft B, KeyE
// X, KeyQ Y, Enter Start, Escape Select), joined to the TV's screen by its code.
import { padLink, readPad } from './pad-link.ts';
import { isPadKey, keyboardPad, slotColour } from './pad-state.ts';

const KEYS = 'arrows or WASD to move, Space for A, Shift for B, E for X, Q for Y, Enter for Start and Escape for Select';

/** Controls the TV's game from this page until stop. */
export function controlTv(code: string, view: { place: HTMLElement; status: HTMLElement }) {
  const held = new Set<string>();
  const press = (event: KeyboardEvent, down: boolean) => {
    if (!isPadKey(event.code)) return;
    event.preventDefault();
    if (down) held.add(event.code); else held.delete(event.code);
  };
  const keydown = (event: KeyboardEvent) => press(event, true), keyup = (event: KeyboardEvent) => press(event, false);
  const blur = () => held.clear();
  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);
  window.addEventListener('blur', blur);
  let gamepad: string | undefined;
  let joined = false;
  const say = () => {
    if (joined) view.status.textContent = gamepad ? 'Your gamepad plays: ' + gamepad + '.' : 'Your keyboard plays: ' + KEYS + '.';
  };
  const link = padLink(code, (state) => {
    joined = state.state === 'joined';
    if (state.state === 'joined') {
      view.place.textContent = 'P' + (state.place + 1) + (state.label?.name ? ' · ' + state.label.name : '');
      view.place.style.setProperty('--place', state.label?.color ?? slotColour(state.place));
      say();
    } else if (state.state === 'ended') { view.status.textContent = state.message; stop(); }
    else view.status.textContent = state.state === 'lost' ? 'Reconnecting to the TV…' : 'Joining the TV…';
  });
  const stopReading = readPad(() => keyboardPad(held), (state) => link.update(state), (id) => { gamepad = id; say(); });
  function stop() {
    stopReading();
    link.close();
    window.removeEventListener('keydown', keydown);
    window.removeEventListener('keyup', keyup);
    window.removeEventListener('blur', blur);
  }
  return stop;
}
