// The editor API's harness routes (/api/processors[/<id>/…]): the harnesses this editor runs, a harness's model
// settings and its sign-in, for who asked.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ZirbelError } from '../core/projects.ts';
import type { Access } from './box-routes.ts';
import { body, checkOrigin, reply } from './http.ts';
import { modelId, processorId, type Processors } from './processors.ts';

/** Answers /api/processors and a harness's routes: says whether it did. */
export async function processorRoutes(
  harnesses: Processors,
  request: IncomingMessage,
  response: ServerResponse,
  access: Access,
  route: { pathID?: string | undefined; action?: string | undefined; tail?: string | undefined },
) {
  const { pathID, action, tail } = route;
  const method = request.method;
  if (!pathID && method === 'GET') {
    reply(response, { processors: await harnesses.list() });
    return true;
  }
  if (action === 'model-settings' && !tail && method === 'POST' && harnesses.settings) {
    checkOrigin(request, true);
    const { model } = z.strictObject({ model: modelId.optional() }).parse(await body(request, 4096));
    const disconnected = new AbortController();
    response.once('close', () => disconnected.abort(new ZirbelError(409, 'The model settings request closed.')));
    const settings = await harnesses.settings(processorId.parse(pathID), model, disconnected.signal);
    if (!response.destroyed) reply(response, settings);
    return true;
  }
  if (action === 'sign-in' && !tail && method === 'GET' && harnesses.signInStatus) {
    reply(response, harnesses.signInStatus(processorId.parse(pathID)));
    return true;
  }
  if (action === 'sign-in' && !tail && method === 'POST' && harnesses.beginSignIn && harnesses.submitSignInCode) {
    checkOrigin(request, true);
    const processor = processorId.parse(pathID);
    const { code } = z
      .strictObject({ code: z.string().trim().min(1).max(2048).regex(/^\S+$/).optional() })
      .parse(await body(request));
    // On a box, a paired device signs in from elsewhere than the box the harness runs on.
    reply(
      response,
      code === undefined
        ? await harnesses.beginSignIn(processor, { elsewhere: !access.local })
        : harnesses.submitSignInCode(processor, code),
    );
    return true;
  }
  return false;
}
