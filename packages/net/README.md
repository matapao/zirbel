# zirbel-net

zirbel-net, the earlier Zirbel's multiplayer client (MIT, see LICENSE). A Zirbel game that brings its own netcode uses it to talk to the other players through the host's relay. Up to 16 players can play. Zirbel treats a game as one of these when its document says `net: true`, or when a built folder you import has a `zirbel.json` whose `players.max` is above 1. Such a game releases with `simulation: 'net-v2'`.

Every player listener serves the client as `/zirbel-net.js`, an ES module. The relay is a WebSocket at `/mp` on the same listener. The game page's policy allows exactly these two addresses, and only for net-v2 games. The page itself is at `/game/@<room>/<key>/`, in the shape zirbel-net gives a game's folder on its host (`/<game>/@<version>/`), with the game's files beside it; `net.data('rules.json')` reads its `data/rules.json`.

To make a game multiplayer with a small adapter beside it, and leave the game itself free of network code, follow the skill `skills/zirbel-multiplayer/SKILL.md`. Every player listener serves it to agents as `/zirbel-net/SKILL.md`.

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
