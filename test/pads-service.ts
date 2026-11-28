// A fake controller service (pi/controllers) on a host's local socket (--pads-socket): frames of a u16 length (LE), then
// 0 and JSON, or 1, a device's number and its pad state. answer gives the view it sends back for each request the host
// relays (scan, pair, forget); the requests it heard are kept.
import { connect } from 'node:net';
import type { TestContext } from 'node:test';

export type ServiceMessage = { type: string; [key: string]: unknown };

export async function padsService(
  t: TestContext,
  path: string,
  answer: (message: ServiceMessage) => object | undefined = () => undefined,
) {
  const socket = connect(path);
  t.after(() => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const heard: ServiceMessage[] = [];
  const frame = (payload: Buffer) => {
    const head = Buffer.alloc(2);
    head.writeUInt16LE(payload.length);
    socket.write(Buffer.concat([head, payload]));
  };
  const json = (value: object) => frame(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value))]));
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2 && pending.length >= 2 + pending.readUInt16LE(0)) {
      const payload = pending.subarray(2, 2 + pending.readUInt16LE(0));
      pending = pending.subarray(2 + payload.length);
      if (payload[0] !== 0) continue;
      const message = JSON.parse(payload.subarray(1).toString('utf8')) as ServiceMessage;
      heard.push(message);
      const reply = answer(message);
      if (reply) json(reply);
    }
  });
  return {
    heard,
    json,
    input(device: number, pad: Uint8Array) {
      frame(Buffer.concat([Buffer.from([1, device]), pad]));
    },
    async close() {
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.end();
      await closed;
    },
  };
}
