// The spaces kernel's local socket as Zirbel's own service speaks it: JSON-RPC 2.0, one message a line, app.hello with
// the token first. Zirbel provides no rules, so whatever the kernel asks of it is answered as no method of Zirbel's.
import { connect, type Socket } from 'node:net';

/** A call the kernel refused: its word for why (data.code, such as full or expired), and its message. */
export class SpacesError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** The longest line read from the kernel, and how long a call waits for its answer. */
const LINE = 4 * 1024 * 1024;
const WAIT = 5000;

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

/** unix:<path>, or tcp:127.0.0.1:<port> where there are no Unix sockets. */
function dial(address: string): Socket {
  if (address.startsWith('unix:')) return connect({ path: address.slice('unix:'.length) });
  const match = /^tcp:(127\.0\.0\.1):(\d{1,5})$/.exec(address);
  if (!match) throw new Error('The spaces socket is unix:<path> or tcp:127.0.0.1:<port>.');
  return connect({ host: match[1]!, port: Number(match[2]) });
}

const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export class SpacesSocket {
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private closed = false;
  private readonly ended: (() => void)[] = [];

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.read(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.end());
  }

  /** Connects and says hello with the token; rejects when the kernel can't be reached or refuses it. */
  static async open(address: string, token: string) {
    const socket = dial(address);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const link = new SpacesSocket(socket);
    try { await link.call('app.hello', { token, protocol: 1 }); } catch (error) { link.close(); throw error; }
    return link;
  }

  /** Calls a method; its result, or a SpacesError. */
  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new SpacesError('unavailable', 'The spaces kernel is not running.'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SpacesError('unavailable', 'The spaces kernel did not answer.'));
      }, WAIT);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** Runs once, when the connection is gone. */
  onEnd(listener: () => void) {
    if (this.closed) listener();
    else this.ended.push(listener);
  }

  close() { this.socket.destroy(); }

  private read(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > LINE) { this.socket.destroy(); return; }
    for (let at = this.buffer.indexOf('\n'); at >= 0; at = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.trim()) this.message(line);
    }
  }

  private message(line: string) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    const message = record(value);
    if (!message) return;
    if (typeof message.method === 'string') {
      // A request of the kernel's (rules Zirbel doesn't provide): no such method here.
      if (message.id !== undefined && message.id !== null) this.socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        error: { code: -32601, message: 'Zirbel provides no ' + message.method + '.' } }) + '\n');
      return;
    }
    const waiting = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!waiting) return;
    this.pending.delete(message.id as number);
    clearTimeout(waiting.timer);
    const error = record(message.error);
    if (error) {
      const code = record(error.data)?.code;
      waiting.reject(new SpacesError(typeof code === 'string' ? code : 'error',
        typeof error.message === 'string' ? error.message : 'The spaces kernel refused that.'));
    } else waiting.resolve(message.result);
  }

  private end() {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new SpacesError('unavailable', 'The spaces kernel is not running.'));
    }
    this.pending.clear();
    for (const listener of this.ended.splice(0)) listener();
  }
}
