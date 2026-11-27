// The box's controllers in Box settings (box mode): its gamepads, USB and Bluetooth, and Bluetooth pairing, as the box's
// controller service (pi/controllers) sees them, with the screen and place each one has. The service is reached over
// the pads' local socket (--pads-socket, pads-socket.ts), whose JSON control frames carry its views and the owner's
// requests: GET /api/box/controllers lists them, and POST …/scan ({on}), …/pair and …/forget ({address}) ask the
// service, which answers each with its view, which the route answers with. With no service connected they answer 503.
// Owners alone use them: an editor of one game never reaches /api/box/ (box-roles.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZirbelError } from '../core/projects.ts';
import type { Pads } from '../core/pads.ts';
import { controllersAddress, controllersScan, controllersView } from '../sdk/contracts.ts';
import { body, reply } from './http.ts';

/** What the routes need of the pads (core/pads.ts): whether the service is connected, its last view of the controllers
 *  (gone while it isn't), a hook for each new view, a JSON control frame to it, and where a box gamepad is now. */
export type ControllerService = Pick<Pads, 'connected' | 'controllers' | 'viewed' | 'toService' | 'screenOf'>;

export const NO_SERVICE = 'The box’s controller service isn’t running.';
/** How long a request waits for the service's answer before the route answers with the view it has. */
const ANSWER_MS = 2000;

/** The service's views, and the requests waiting for its next one. */
export class BoxControllers {
  private readonly waiting = new Set<() => void>();

  private readonly service: ControllerService;
  private readonly answerMs: number;

  constructor(service: ControllerService, answerMs = ANSWER_MS) {
    this.service = service;
    this.answerMs = answerMs;
    service.viewed = () => { for (const done of this.waiting) done(); };
  }

  /** The service's view now, as the contract reads it. */
  private view() {
    const parsed = controllersView.safeParse(this.service.controllers);
    return parsed.success ? parsed.data : undefined;
  }

  /** Waits for the service's next view, or a while. */
  private next() {
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.waiting.delete(done); resolve(); };
      const timer = setTimeout(done, this.answerMs);
      this.waiting.add(done);
    });
  }

  /** The box's controllers, each with its screen and place, as Box settings lists them. */
  async read() {
    if (!this.service.connected) throw new ZirbelError(503, NO_SERVICE);
    if (!this.view()) await this.next();
    return this.shown();
  }

  /** Asks the service, and answers with the view it sends back. */
  async ask(message: Record<string, unknown>) {
    const answer = this.next();
    if (!this.service.toService(message)) throw new ZirbelError(503, NO_SERVICE);
    await answer;
    return this.shown();
  }

  private shown() {
    const view = this.view();
    if (!view || !this.service.connected) throw new ZirbelError(503, NO_SERVICE);
    const { type: _type, devices, ...rest } = view;
    return { ...rest, devices: devices.map((item) => {
      const screen = item.device === undefined ? undefined : this.service.screenOf(item.device);
      return { ...item, screen: screen ? { code: screen.code, tv: screen.box, place: screen.place } : null };
    }) };
  }
}

/** GET /api/box/controllers and POST /api/box/controllers/scan|pair|forget; whether it answered the request. */
export async function controllersRequest(controllers: BoxControllers | undefined, request: IncomingMessage,
  response: ServerResponse, action: string | undefined) {
  const method = request.method;
  if (!action && method === 'GET') {
    if (!controllers) throw new ZirbelError(503, NO_SERVICE);
    reply(response, await controllers.read());
    return true;
  }
  if (method !== 'POST' || !['scan', 'pair', 'forget'].includes(action ?? '')) return false;
  const input = action === 'scan' ? controllersScan.parse(await body(request, 1024)) : controllersAddress.parse(await body(request, 1024));
  if (!controllers) throw new ZirbelError(503, NO_SERVICE);
  reply(response, await controllers.ask({ type: action, ...input }));
  return true;
}
