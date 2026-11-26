import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { newId, Projects } from '../core/projects.ts';
import { Releases } from '../core/releases.ts';
import { Rooms } from '../core/rooms.ts';
import { importReleases, Players, readLanHost, readPort, stopOnSignal } from './hosting.ts';
import { claimDirectory } from './service-lock.ts';

// Headless host (`--host-only`): serves releases to players without the editor,
// harnesses or MCP, so it stays small enough for a Raspberry Pi.
const { values } = parseArgs({
  options: {
    'host-only': { type: 'boolean' }, data: { type: 'string' }, lan: { type: 'boolean' },
    'player-port': { type: 'string' }, 'player-host': { type: 'string' }, 'pads-socket': { type: 'string' },
    release: { type: 'string', multiple: true }, import: { type: 'string', multiple: true },
  },
});

async function start() {
  const root = resolve(values.data ?? process.env.ZIRBEL_DATA ?? join(homedir(), '.zirbel'));
  const playerPort = readPort(values['player-port'] ?? process.env.ZIRBEL_PLAYER_PORT ?? '4174');
  const lanHost = readLanHost(values['player-host'] ?? process.env.ZIRBEL_LAN_HOST);
  const boot = newId();
  const releases = new Releases(new Projects(root), fileURLToPath(new URL('./web/', import.meta.url)));
  const players = new Players(new Rooms(), releases, { playerPort, lanHost });
  const claim = claimDirectory(root, { pid: process.pid, port: 0, boot, editor: false });
  if (!claim.owner) throw new Error('This project directory is owned by process ' + claim.pid + '.');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await players.close();
    claim.release();
  };
  try {
    importReleases(releases, values.import ?? []);
    const local = await players.openLocal(values.lan ? 0 : playerPort);
    if (values.lan) await players.startLan();
    // Where the box's controller service brings its gamepads (pads-socket.ts).
    const pads = values['pads-socket'] || process.env.ZIRBEL_PADS_SOCKET;
    if (pads) await players.listenForPads(pads);
    for (const id of values.release ?? []) console.log(JSON.stringify(await players.start(id, Boolean(values.lan))));
    console.log(JSON.stringify({ pid: process.pid, data: root, editor: null, player: 'http://127.0.0.1:' + local.port, mcp: false }));
    process.once('SIGINT', () => void stopOnSignal(stop));
    process.once('SIGTERM', () => void stopOnSignal(stop));
  } catch (error) { await stop(); throw error; }
}

try { await start(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
