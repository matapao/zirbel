/**
 * zirbel-net, the earlier Zirbel's multiplayer client: the transport for games with their own netcode.
 * The host serves this entry point, bundled, as /zirbel-net.js.
 *
 *   const { connect, launchParams, ALL, HOST } = await import('/zirbel-net.js');
 *
 *   const net = connect({ ...launchParams(), loopback: true });   // game from /<id>/, ?room=…&key=… from the lobby
 *   net.on('message', (from, type, r) => { if (type === 1) { const x = r.f32(); } });
 *   net.send(ALL, 2, 'start');                     // reliable, ordered
 *   net.stream(HOST, 1, net.begin().u16(seq).q16(x, 0, 960));   // unreliable, latest wins
 *
 * Or let play() run the netcode against a game's hooks, in the mode that suits it:
 *
 *   play(globalThis.gameHooks, { mode: 'snapshot' });   // or predict, actions, events, lockstep
 *
 * See README.md beside this file.
 */
export { connect } from './client.ts';
export type { ClientEvents, ConnectOptions, Connection, Lane, Stats } from './connection.ts';
export { launchParams, type LaunchParams } from './launch.ts';
export { Reader, Writer, type Payload } from './codec.ts';
export { clock } from './env.ts';
export type { StorageLike, WebSocketConstructor, WebSocketLike } from './env.ts';
export { DATA_FILE, players, type Authority, type GameEvents, type GameNet, type OpenInfo, type Revision, type RoomInfo } from './game.ts';
export { Interp, lerp, type Sample } from './interp.ts';
export { ALL, HOST, LIMITS, MAX_SEAT, MAX_TYPE, SERVER, VERSION, playerName, seqNewer, seqOk } from './protocol.ts';
export { channels, type ChannelListener, type ChannelOptions, type Channels } from './channels.ts';
export type { Hooks, ModeName, PlayOptions, Session, SessionEvents } from './hooks.ts';
export { netParams, netsim, type NetOptions, type NetSim, type SimSocket } from './netsim.ts';
export { overlay } from './overlay.ts';
export { json, pack, type Codec } from './pack.ts';
export { play } from './play.ts';
