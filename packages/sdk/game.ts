import { z } from 'zod';
import { compactProperties, MAX_REGISTERED_OBJECTS } from './bounded.ts';

export { boundedJson, MAX_REGISTERED_OBJECTS } from './bounded.ts';

// The document owns the game's rendering, input, objects and rules.
export const gameDocument = z.strictObject({
  html: z.string().trim().min(1).max(400_000),
  maxPlayers: z.number().int().min(1).max(4).default(1),
  registerObjects: z.boolean().optional(),
});
export type GameDocument = z.infer<typeof gameDocument>;

const registeredObject = z.strictObject({
  id: z.string().min(1).max(120),
  properties: z.custom<Record<string, unknown>>(compactProperties, 'Provide compact JSON properties.'),
});
export type RegisteredObject = z.infer<typeof registeredObject>;
export const objectRegistry = z.custom<unknown[]>((value) => Array.isArray(value) && value.length <= MAX_REGISTERED_OBJECTS,
  'Provide at most 512 registered objects.').pipe(z.array(registeredObject))
  .refine((objects) => new Set(objects.map(({ id }) => id)).size === objects.length, 'Object IDs must be unique.');
