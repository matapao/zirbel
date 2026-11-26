// A game that reads only the keyboard can take gamepads anyway: its zirbel.json maps the inputs of the standard layout
// (up/down/left/right: the d-pad, and the left stick beyond half way) to KeyboardEvent codes, which the game frame
// presses as a keyboard would (packages/web/game-keys.ts). The map is the folder's, never part of the game itself.
// No Zod: the game frame reads these too.
export const CONTROL_INPUTS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'select', 'start', 'ls', 'rs', 'up', 'down', 'left',
  'right', 'home'] as const;
export type ControlInput = (typeof CONTROL_INPUTS)[number];
export const KEY_CODE = /^[A-Za-z0-9]{1,24}$/;
export type ControlKeys = Partial<Record<ControlInput, string>>;

/** A map of keys as gameControls reads one: known inputs with codes, at least one, or nothing. */
export function checkedKeys(value: unknown): ControlKeys | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  const known = (input: string): input is ControlInput => (CONTROL_INPUTS as readonly string[]).includes(input);
  return entries.length && entries.every(([input, code]) => known(input) && typeof code === 'string' && KEY_CODE.test(code))
    ? Object.fromEntries(entries) : undefined;
}
