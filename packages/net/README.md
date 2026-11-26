# zirbel-net

zirbel-net, the earlier Zirbel's multiplayer client (MIT, see LICENSE). A Zirbel game that brings its own netcode uses it to talk to the other players through the host's relay. Up to 16 players can play. Zirbel treats a game as one of these when its document says `net: true`, or when a built folder you import has a `zirbel.json` whose `players.max` is above 1. Such a game releases with `simulation: 'net-v2'`.

Every player listener serves the client as `/zirbel-net.js`, an ES module. The relay is a WebSocket at `/mp` on the same listener. The game page's policy allows exactly these two addresses, and only for net-v2 games. The page itself is at `/game/@<room>/<key>/`, in the shape zirbel-net gives a game's folder on its host (`/<game>/@<version>/`), with the game's files beside it; `net.data('rules.json')` reads its `data/rules.json`.

To make a game multiplayer with a small adapter beside it, and leave the game itself free of network code, use `play()` (below) and follow the skill `skills/zirbel-multiplayer/SKILL.md`. Every player listener serves it to agents as `/zirbel-net/SKILL.md`. The rest of this guide, from Connecting on, is the raw client underneath, for games with netcode of their own.

## play()

```js
import { play } from '/zirbel-net.js';
const session = play(globalThis.gameHooks, { mode: 'predict' });
```

`play(hooks, options)` starts the game alone at once. When the page's address has `?room=` (or `options.connect.room` is set), it connects with `launchParams()`, waits up to `timeout` for a seat, and runs a mode against the game's hooks. It falls back to playing alone when there is no room, the relay refuses it, no seat comes in time, or the room ends. It leaves the room when the page goes away (`pagehide`), unless `keepSeat` is set. It ticks by each frame's own time (requestAnimationFrame's timestamp, not the moment its callback runs), so frames at an even rate get their ticks evenly.

| Mode | For | How |
| --- | --- | --- |
| `snapshot` (default) | arcade, casual, physics | The host steps the game and sends each seat the entities that changed since the state that seat last confirmed (all of them on join and every `full` ms); others send inputs and draw the state, blended a little in the past. |
| `predict` | shooters, racing | `snapshot`, and each screen applies its own numbered inputs at once; the host applies one per tick (two while more than two wait; with none waiting, the player keeps its last input) and says which it reached, and the screen replays the rest on the host's state and draws its own player between its last two ticks (`blend`). A screen keeps 4 s of inputs the host hasn't applied, longer than an away host keeps its role. |
| `actions` | turn-based, cards, board | Actions go reliably to the host, which checks them and numbers them; every seat applies them in that order. Joins and leaves are entries too. |
| `lockstep` | deterministic simulations, strategy | Each tick's inputs reach every seat `delay` ticks ahead; every seat steps the same game; the host decides joins and leaves at ticks nobody has reached; a checksum every `check` ticks finds drift. |
| `events` | big or destructible worlds | `actions`, with the host running the world: its changes are actions too, and a newcomer gets the world in chunks within the relay's message limit, then the entries since. |

The hooks each mode uses (a hook a mode doesn't use is never called; alone, the game's own player is 1). In predict, `restore` brings back everything `predict` reads, and `predict` only changes state: a follower plays the same inputs again on each state, so effects in it repeat. `input()` is sampled each tick, in play()'s own frame callback: read the devices there. `draw(alpha)` comes each frame after the ticks where play() steps the game, `alpha` (0 to 1) how far the frame is from the last tick to the next.

| Hook | snapshot | predict | actions | events | lockstep |
| --- | --- | --- | --- | --- | --- |
| `me(id)` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `join(id)`, `leave(id)` | host; leave everywhere | host; leave everywhere | every seat, in order | every seat, in order | every seat, at a tick |
| `simulate(on)` | ✓ | ✓ | | ✓ | |
| `snapshot()`, `restore(state)` | entities by key | entities by key | the state, for newcomers | the world (also bytes) | the state, for newcomers |
| `input()`, `control(id, input)` | ✓ | ✓ | | | ✓ |
| `step(dt)` | optional: play() steps | ✓ | | | ✓ |
| `draw(alpha)` | with `step`: alone, host | alone, host | | | ✓ |
| `predict(input, dt)`, `player(id)` | | ✓ | | | |
| `blend(a, b, t, key)`, `interest(seat, key, entity)` | optional | optional | | | |
| `validate(id, action)`, `apply(id, action)` | | | ✓ | ✓ | |
| `checksum()` | | | | | optional |

Options: `mode`; `rate` (states a second, 20); `tick` (ticks a second: 30, predict 60, lockstep 20); `smooth` (ms in the past others are drawn); `full` (ms between full states, 10000); `delay` (lockstep's input delay in ticks, 2); `check` (ticks between checksums); `json` (JSON text instead of binary); `f32` (snapshot and predict: states and inputs with `pack32`); `codecs` (`{ state, input, action }`, each `{ write(w, v), read(r) }`); `channels` (the game's own message names); `timeout` (ms, 10000); `keepSeat` (a page that goes away keeps its seat for 15 s instead of leaving); `net` (the simulator and overlay, as in `?net=`); `connect` (what `connect()` gets over `launchParams()`).

The session: `id`, `net` (null alone), `ready` (true once seated), `isHost()`, `act(action)` (actions and events), `send(channel, value, to?)` and `stream(…)` on the game's channels, `leave()` (plays on alone), `stop()`, and the events `online`, `offline`, `host`, `away`, `back`, `drift`, `message (channel, value, from)`. play() uses app message types 0 to 15; the game's channels start at 16.

### Named channels, codecs

`channels(net, ['shot', 'chat'], { first, codec })` maps names to app message types in the order they are declared, so every seat agrees without numbers chosen by hand: `ch.send('shot', { x, y })`, `ch.stream(…)`, `ch.on('shot', (value, from, reliable) => …)`, `ch.close()`. Values go through a codec: `pack` (the default: binary and exact, one byte for whole numbers below 240, keys as UTF-8, `Uint8Array` as it is), `pack32` (the same, with numbers that aren't whole as 32-bit floats: about 7 digits, 5 bytes instead of 9) or `json`.

### The network simulator and the stats overlay

`?net=lag:120,jitter:30,loss:5,kbps:256,stats` in a game page's address, or `play(hooks, { net: 'lag:120,stats' })`, puts a simulated link under play()'s connection: `lag` adds that many ms to the round trip (half each way), `jitter` up to that many ms more each way at random, `loss` drops that percent of unreliable app messages each way (reliable ones and the client's pings never), and `kbps` caps each way, so frames queue and the client drops stale unreliable data behind the queue as it would on a slow link. Frames keep their order, as on a WebSocket. Closing goes at once, after what is still on its way, so a page that unloads still leaves cleanly. Nothing is simulated unless asked. On a Zirbel host, the player page's address takes it before its `#` (`/join/<room>?net=…#…`) and hands it on to the game's frame; the lobby's address takes it too, and carries it onto the sessions it starts and joins. `stats` shows a small overlay in the page's corner: the mode and seat, the round trip, jitter, kB/s each way and drops. With the raw client: `connect({ ...launchParams(), WebSocket: netsim({ lag: 120 }) })` and `overlay(net)`.

## Connecting

```js
const zn = await import('/zirbel-net.js');
const net = zn.connect(zn.launchParams());
```

The player page opens the game with `?room=<room>&key=<key>`. `launchParams()` reads both: it upper-cases the room and passes the key on for the relay to check. It also takes `game` from the first part of the path, and Zirbel's relay only checks that it is a valid name. `connect()` opens `ws(s)://<the page's host>/mp`. You can pass extra options with the launch parameters, for example `zn.connect({ ...zn.launchParams(), loopback: true })`:

- `loopback`: also deliver your own `ALL` and `HOST` messages to yourself. This helps when the host also plays.
- `autoFlush: false`: send only when you call `net.flush()`, for example once per tick. By default, everything sent during one task leaves together.
- `reconnect: false`: end the session when the link drops instead of reconnecting.
- `storage`: where the resume token is kept. The default is `sessionStorage`, which a game's sandboxed frame can't use. So in Zirbel a reload gets a new seat, while a dropped link still comes back on the same one.

## Events

`net.on(name, listener)` and `net.off(name, listener)`:

| Event | Arguments | When |
| --- | --- | --- |
| `open` | `{ id, hostId, peers }` | You have a seat. `peers` maps the other seats to "Player Two" and so on. |
| `peer` | `id, label` | Someone took a seat. |
| `leave` | `id` | Someone left for good. |
| `away` | `id` | Someone's link dropped. The relay keeps their seat for 15 seconds. |
| `back` | `id` | Someone who was away is back on the same seat. |
| `host` | `hostId` | The host changed. The first player in the room is host. When the host leaves, or stays away for 2.5 seconds, the lowest seat that is still connected takes over (the lowest seat, if none is). |
| `message` | `from, type, reader, reliable` | An app message from seat `from`. Read `reader` before the listener returns, because it is reused. |
| `close` | `code, message` | The end: you called `close()`, the relay refused you, or the room closed (code 5, "the room closed"). |

The client also emits `disconnect` and `resume` when your own link drops and comes back, and `lane` (`'ws'` or `'none'`).

## Sending

- `net.send(to, type, data)`: reliable and ordered.
- `net.stream(to, type, data)`: unreliable, so the latest message wins. The relay drops stream messages to a player whose connection is backed up or away. Payloads over 1000 bytes go reliably instead.
- `to` can be `zn.ALL` (everyone else), `zn.HOST` (whoever is host now) or a seat number. `type` is your own message id, from 0 to 223.
- `data` can be a string, a `Uint8Array`, an `ArrayBuffer`, a typed array, or a `Writer`. `net.begin()` gives you an empty `Writer` with `u8`, `u16`, `u32`, `f32`, `f64`, `varint`, `str` and `q16` (a number in a range, in 16 bits): `net.stream(zn.HOST, 1, net.begin().u16(seq).q16(x, 0, 960))`. On the receiving side, read it back in the same order with the reader's methods of the same names, or `reader.text()` for a string.
- A message can be up to 1 MiB: `send` and `stream` throw for a larger one.
- `net.close()` leaves the room for good, and the others see `leave` at once.

Other useful parts: `net.id`, `net.hostId` and `net.isHost()`; `net.now()`, a clock shared by every player in the room; `net.rtt`; `zn.Interp`, which smooths snapshots between updates; and `zn.players(net)`, every seat in order.

## Playing alone

Without `?room=` and `?key=`, `launchParams()` makes up a random room, and the relay refuses it with `close` code 6 ("no game with that code is running"). Where there is no relay at all, the import of `/zirbel-net.js` fails, or, on a host without `/mp`, the client keeps trying to reconnect and never opens. So start the game alone at once, and add players when `open` arrives. Keep playing alone after `close`. Wrap the import in `try`/`catch`.
