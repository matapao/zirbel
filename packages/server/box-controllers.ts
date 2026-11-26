// The box's controllers in Box settings (box mode): its gamepads, USB and Bluetooth, and Bluetooth pairing, as the box's
// controllers service (pi/controllers) sees them, with the screen and place each one has. The service is reached over
// the pads' local socket (--pads-socket), whose JSON control frames carry its views and the owner's requests: GET
// /api/box/controllers lists them, and POST …/scan ({on}), …/pair and …/forget ({address}) ask the service, which answers
// each with its view, which the route answers with. With no service connected they answer 503. Owners alone use them:
// an editor of one game never reaches /api/box/ (box-roles.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZirbelError } from '../core/projects.ts';
import { controllersAddress, controllersScan, controllersView, type ControllersView } from '../sdk/contracts.ts';
import { body, reply } from './http.ts';

/** What the routes need of the pads' local socket: whether the service is connected, a JSON control frame to it, its
 *  JSON control frames that the pads' routing leaves alone (its controllers views), and where a box gamepad is now. */
export type ControllerService = {
  connected(): boolean;
  /** Sends the connected service a JSON control frame; false when none is connected. */
  send(message: Record<string, unknown>): boolean;
  /** Each JSON control frame the service sends, as parsed JSON. */
  onControl(listener: (message: unknown) => void): void;
  /** The screen a box gamepad (by its device number) is on now: its code, whether it is the box's own (the TV), and the
   *  place it holds there (0 to 7, shown as P1 to P8). */
  screenOf(device: number): { code: string; box: boolean; place: number } | undefined;
};

export const NO_SERVICE = 'The box’s controller service isn’t running.';
/** How long a request waits for the service's answer before the route answers with the view it has. */
const ANSWER_MS = 2000;

/** The service's latest view, and the requests waiting for its next one. */
export class BoxControllers {
  private view?: ControllersView;
  private readonly waiting = new Set<(view: ControllersView) => void>();

  constructor(private readonly service: ControllerService, private readonly answerMs = ANSWER_MS) {
    service.onControl((message) => this.take(message));
  }

  private take(message: unknown) {
    const parsed = controllersView.safeParse(message);
    if (!parsed.success) return;
    this.view = parsed.data;
    for (const done of this.waiting) done(parsed.data);
  }

  /** The service's next view, or after a while the one it has. */
  private next() {
    return new Promise<ControllersView | undefined>((resolve) => {
      const done = (view?: ControllersView) => { clearTimeout(timer); this.waiting.delete(done); resolve(view); };
      const timer = setTimeout(() => done(this.view), this.answerMs);
      this.waiting.add(done);
    });
  }

  /** The box's controllers, each with its screen and place, as Box settings lists them. */
  async read() {
    if (!this.service.connected()) throw new ZirbelError(503, NO_SERVICE);
    return this.shown(this.view ?? await this.next());
  }

  /** Asks the service, and answers with the view it sends back. */
  async ask(message: Record<string, unknown>) {
    const answer = this.next();
    if (!this.service.send(message)) throw new ZirbelError(503, NO_SERVICE);
    return this.shown(await answer);
  }

  private shown(view?: ControllersView) {
    if (!view || !this.service.connected()) throw new ZirbelError(503, NO_SERVICE);
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
