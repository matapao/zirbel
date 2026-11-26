// Zod-free so the in-game SDK stays small. The host validates again with the
// full schemas in game.ts.
export const MAX_REGISTERED_OBJECTS = 512;

// Metadata crosses an untrusted window boundary. Bound its size and nesting before
// it reaches the editor, chat history, or a WebSocket snapshot.
export function boundedJson(value: unknown, depth = 0, budget = { remaining: 256 }): boolean {
  if (depth > 8 || --budget.remaining < 0) return false;
  if (typeof value === 'string') return value.length <= 2048;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  // JSON.stringify visits every array index, including holes that Object.keys
  // skips, so walk indices and refuse holes instead of counting keys.
  if (Array.isArray(value)) {
    if (value.length > budget.remaining) return false;
    for (let index = 0; index < value.length; index++) {
      if (!(index in value) || !boundedJson(value[index], depth + 1, budget)) return false;
    }
    return true;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  for (const key of Object.keys(value)) {
    if (key.length > 128 || !boundedJson((value as Record<string, unknown>)[key], depth + 1, budget)) return false;
  }
  return true;
}

/** A copy of bounded JSON: by structuredClone where the browser has it, and as JSON where it doesn't (Chromium before 98,
 *  as some TV browsers are), which for JSON is the same copy. */
export function jsonCopy<T>(value: T, clone: ((value: T) => T) | undefined = globalThis.structuredClone): T {
  return typeof clone === 'function' ? clone(value) : JSON.parse(JSON.stringify(value)) as T;
}

export function compactProperties(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    boundedJson(value) && JSON.stringify(value).length <= 4096;
}
