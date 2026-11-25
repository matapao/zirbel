// view_game's renderer in the desktop app: the app that started this editor renders the game in a hidden window of its
// own Electron, asked over the IPC channel it started the editor with (desktop/src/view-game.ts), so nothing else needs
// installing. Each request carries an id, and the app's answer the same id.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chromeRenderer } from './browser-cdp.ts';
import type { Renderer } from './view-game.ts';

/** The message type both ends use. */
const VIEW_GAME = 'zirbel:view-game';
const answer = z.object({
  type: z.literal(VIEW_GAME), id: z.string().max(100),
  images: z.array(z.string().max(32_000_000)).max(8).optional(),
  console: z.array(z.object({ level: z.string().max(40), text: z.string().max(10_000) })).max(1000).optional(),
  unavailable: z.string().max(1000).optional(), error: z.string().max(1000).optional(),
});

type Channel = { send(message: unknown): void; on(listener: (message: unknown) => void): () => void };

/** The IPC channel to the app, when this editor was started with one. */
function parentChannel(): Channel | undefined {
  if (!process.send || !process.channel) return undefined;
  return {
    send: (message) => process.send?.(message),
    on: (listener) => { process.on('message', listener); return () => process.off('message', listener); },
  };
}

export function appRenderer(channel: Channel): Renderer {
  return {
    render(request, signal) {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const done = () => { stop(); signal.removeEventListener('abort', abort); };
        const abort = () => { done(); reject(new Error('Rendering the game took too long.')); };
        const stop = channel.on((message) => {
          const reply = answer.safeParse(message);
          if (!reply.success || reply.data.id !== id) return;
          done();
          const { images, console: lines, unavailable, error } = reply.data;
          if (error) reject(new Error(error));
          else if (unavailable) resolve({ unavailable });
          else resolve({ images: (images ?? []).map((image) => Buffer.from(image, 'base64')), console: lines ?? [] });
        });
        signal.addEventListener('abort', abort, { once: true });
        channel.send({ type: VIEW_GAME, id, request });
      });
    },
  };
}

/** The renderer this editor uses: the app's, when the desktop app started it (ZIRBEL_VIEW_GAME=app), else a browser. */
export function chooseRenderer(env: NodeJS.ProcessEnv = process.env): Renderer {
  const channel = env.ZIRBEL_VIEW_GAME === 'app' ? parentChannel() : undefined;
  return channel ? appRenderer(channel) : chromeRenderer();
}
