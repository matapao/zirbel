import { PROTOCOL_VERSION, ServerMessage, type Manifest, type Scene, type SeatInfo } from './contracts.ts';

export type RoomInfo = {
  id: string; manifest: Manifest; solo: boolean; development: boolean; gameUrl?: string; registerObjects?: boolean; scene?: Scene; seats: SeatInfo[];
};

export class RoomClient {
  private socket?: WebSocket;
  private ack = 0;
  private stopped = false;
  private attempts = 0;
  private retry?: number;

  constructor(
    private roomId: string, private releaseId: string, private credential: string,
    private onMessage: (message: ServerMessage) => void, private onStatus: (status: string) => void,
  ) {}

  open() {
    const url = new URL('/rooms/' + this.roomId + '/socket', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      type: 'hello', version: PROTOCOL_VERSION, credential: this.credential, releaseId: this.releaseId,
    })));
    socket.addEventListener('message', (event) => {
      let decoded: unknown;
      try { decoded = JSON.parse(String(event.data)); } catch { return; }
      const parsed = ServerMessage.safeParse(decoded);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === 'welcome') {
        if (message.releaseId !== this.releaseId) { this.stop(); return; }
        this.credential = message.resume;
        this.ack = message.ack;
        this.attempts = 0;
        this.onStatus('Connected');
      } else if (message.type === 'snapshot') {
        this.ack = Math.max(this.ack, message.ack);
      } else if (message.type === 'closed' || (message.type === 'error' && ['expired','protocol','closed'].includes(message.code))) {
        this.stopped = true;
      }
      this.onMessage(message);
    });
    socket.addEventListener('close', (event) => {
      if (event.code === 4001 || this.stopped) return;
      this.onStatus('Reconnecting…');
      if (++this.attempts > 8) { this.onStatus('Disconnected'); return; }
      this.retry = window.setTimeout(() => this.open(), Math.min(5000, this.attempts * 450));
    });
  }

  send(action: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'action', sequence: ++this.ack, action }));
  }

  stop() {
    this.stopped = true;
    if (this.retry !== undefined) window.clearTimeout(this.retry);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'leave' }));
    this.socket?.close();
  }
}

export async function fetchRoom<T>(room: string, route: string, value?: object, credential?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (value) headers['content-type'] = 'application/json';
  if (credential) headers.authorization = 'Bearer ' + credential;
  const response = await fetch('/rooms/' + room + '/' + route, {
    method: value ? 'POST' : 'GET', headers, body: value ? JSON.stringify(value) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Unable to open the game.');
  return result as T;
}
