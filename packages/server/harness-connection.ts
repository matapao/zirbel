import { request, type IncomingMessage, type RequestOptions } from 'node:http';
import { z } from 'zod';
import { ZirbelError } from '../core/projects.ts';
import { processorId, type ProcessorRun, type Processors } from './processors.ts';

const access = z.object({
  app: z.literal('zirbel'),
  storage: z.string().optional(),
  processors: z.array(z.object({ id: processorId, name: z.string(), ready: z.boolean().optional() })),
});
const runResult = z.object({
  task: z.string(), stopReason: z.string(), text: z.string().optional(),
  usage: z.object({ totalTokens: z.number().int().nonnegative() }).optional(),
});

async function requestJSON(url: string, options: RequestOptions, payload?: string) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(url, { ...options, agent: false }, resolve);
    req.once('error', reject);
    req.end(payload);
  });
  const status = response.statusCode ?? 502;
  if (status < 200 || status >= 300) {
    response.destroy();
    return { status, data: undefined };
  }
  const bytes: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += (chunk as Buffer).length;
    if (size > 4_000_000) throw new ZirbelError(502, 'The harness reply was too large.');
    bytes.push(chunk as Buffer);
  }
  return { status, data: JSON.parse(Buffer.concat(bytes).toString('utf8')) as unknown };
}

export class HarnessConnection implements Processors {
  private readonly endpoint: string;

  constructor(endpoint: string, private readonly token: string, private readonly send = requestJSON) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password)
      throw new Error('Expected a loopback harness endpoint.');
    this.endpoint = url.origin;
  }

  async describe(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(3000);
    const data = await this.call('/access', signal ? AbortSignal.any([signal, timeout]) : timeout).catch((error) => {
      signal?.throwIfAborted();
      throw error;
    });
    const info = access.parse(data);
    return { ...info, processors: info.processors.map((processor) => ({ ...processor, activity: 'host' as const })) };
  }
  async list() { return (await this.describe()).processors; }

  async start(processor: string, prompt: string, { signal, update, selection }: ProcessorRun = {}) {
    if (selection?.model || selection?.effort) throw new ZirbelError(422, 'The host does not expose model settings for this harness.');
    const choice = (await this.describe(signal)).processors.find(({ id }) => id === processor);
    if (!choice) throw new ZirbelError(403, 'This connection does not offer that harness.');
    if (choice.ready === false) throw new ZirbelError(409, 'Sign in to ' + choice.name + ' to continue.');
    update?.({ type: 'progress', phase: 'running' });
    // The host owns the run deadline. This loopback request stays open until the host replies or the turn is stopped.
    const result = await this.call('/runs', signal, { processor, prompt, connectors: [] });
    return { name: choice.name, ...runResult.parse(result) };
  }

  private async call(path: string, signal?: AbortSignal, payload?: unknown) {
    try {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const headers = { authorization: 'Bearer ' + this.token, 'content-type': 'application/json',
        ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }) };
      const { status, data } = await this.send(this.endpoint + path, { method: body === undefined ? 'GET' : 'POST', headers, signal }, body);
      if (status >= 200 && status < 300) return data;
      throw new ZirbelError(status, 'The harness connection could not complete the request.');
    } catch (error) {
      if (payload !== undefined) signal?.throwIfAborted();
      if (error instanceof ZirbelError) throw error;
      throw new ZirbelError(503, 'The harness connection is unavailable.');
    }
  }
}

export function hostedHarnesses() {
  const { HARNESS_URL, HARNESS_TOKEN } = process.env;
  if (!HARNESS_URL && !HARNESS_TOKEN) return;
  if (!HARNESS_URL || !HARNESS_TOKEN) throw new Error('A harness connection requires an address and access token.');
  return new HarnessConnection(HARNESS_URL, HARNESS_TOKEN);
}
