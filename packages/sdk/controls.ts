// A game that reads only the keyboard can take gamepads anyway: its zirbel.json maps the inputs of the standard layout
// (up/down/left/right: the d-pad, and the left stick beyond half way) to KeyboardEvent codes, which the game frame
// presses as a keyboard would (packages/web/game-keys.ts). controls.keys are P1's keys; controls.players gives each
// place (P1 to P8) its own keys, and the name and colour of what it drives, and where it is given controls.keys is not
// used. The map is the folder's, never part of the game itself. No Zod: the game frame reads these too.
export const CONTROL_INPUTS = [
  'a',
  'b',
  'x',
  'y',
  'lb',
  'rb',
  'lt',
  'rt',
  'select',
  'start',
  'ls',
  'rs',
  'up',
  'down',
  'left',
  'right',
  'home',
] as const;
export type ControlInput = (typeof CONTROL_INPUTS)[number];
export const KEY_CODE = /^[A-Za-z0-9]{1,24}$/;
/** A screen's places, P1 to P8 (0 to 7 on the wire). */
export const MAX_PLACES = 8;
export const PLACE_NAME = 24;
export const PLACE_COLOR = /^#[0-9a-fA-F]{6}$/;
export type ControlKeys = Partial<Record<ControlInput, string>>;
export type PlaceLabel = { name?: string | undefined; color?: string | undefined };
type ControlPlayer = { keys?: ControlKeys } & PlaceLabel;
export type Controls = { keys?: ControlKeys; players?: ControlPlayer[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const byInput = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : 1);

/** A map of keys: known inputs with codes, at least one, sorted by input (as the Go host writes a map); or nothing. */
export function checkedKeys(value: unknown): ControlKeys | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  const known = (input: string): input is ControlInput => (CONTROL_INPUTS as readonly string[]).includes(input);
  return entries.length &&
    entries.every(([input, code]) => known(input) && typeof code === 'string' && KEY_CODE.test(code))
    ? Object.fromEntries(entries.sort(byInput))
    : undefined;
}

/** A place's name (1 to 24 characters) and colour (#rrggbb), each where given and right; nothing where either is wrong. */
export function checkedLabel(value: unknown): PlaceLabel | undefined {
  if (!isObject(value)) return undefined;
  const { name, color } = value;
  if (name !== undefined && (typeof name !== 'string' || !name.length || name.length > PLACE_NAME)) return undefined;
  if (color !== undefined && (typeof color !== 'string' || !PLACE_COLOR.test(color))) return undefined;
  return { ...(name === undefined ? {} : { name }), ...(color === undefined ? {} : { color }) };
}

/** A game's controls as zirbel.json gives them: its keys, and its players (1 to 8, each an object whose keys, name and
 *  colour are right where given; other fields aside), each part only where it is right, in the order both hosts write. */
export function checkedControls(value: unknown): Controls | undefined {
  if (!isObject(value)) return undefined;
  const keys = checkedKeys(value.keys);
  const list = value.players;
  let players: ControlPlayer[] | undefined =
    Array.isArray(list) && list.length && list.length <= MAX_PLACES ? [] : undefined;
  for (const item of players ? (list as unknown[]) : []) {
    const label = checkedLabel(item);
    const own = isObject(item) && item.keys !== undefined ? checkedKeys(item.keys) : undefined;
    if (!label || (isObject(item) && item.keys !== undefined && !own)) {
      players = undefined;
      break;
    }
    players!.push({ ...(own ? { keys: own } : {}), ...label });
  }
  return keys || players ? { ...(keys ? { keys } : {}), ...(players ? { players } : {}) } : undefined;
}

/** The keys place k presses: its player's where the game lists players, else controls.keys for P1. */
export function placeKeys(controls: Controls, place: number) {
  if (controls.players) return controls.players[place]?.keys;
  return place === 0 ? controls.keys : undefined;
}
