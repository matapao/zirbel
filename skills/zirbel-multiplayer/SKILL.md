---
name: zirbel-multiplayer
description: Make a web game multiplayer on Zirbel with a thin adapter over zirbel-net, Zirbel's multiplayer client and relay. Use when a browser game (canvas, WebGL, three.js, any framework) should play with several people on a Zirbel host, box or desktop app, while it still runs alone anywhere else; when picking a netcode mode (snapshot, predict, actions, events, lockstep) for a kind of game; when writing or reviewing a game's zirbel-adapter.js or its zirbel.json; or when testing a game with two browsers and a simulated bad network on a local Zirbel host.
---

# Multiplayer on Zirbel

Zirbel plays a game's multiplayer over **zirbel-net** (protocol v2): every Zirbel host serves the client as `/zirbel-net.js` and runs a relay at `/mp`. The relay only seats players and passes their messages on. Your game is the simulation, and one player's page, the host's, runs it.

Keep multiplayer a thin, separate layer:

- **The game knows nothing about networks.** It runs alone, hosted anywhere, as a single-player game. It imports no network code.
- **The game exposes a few hooks** on `globalThis.gameHooks`: plain functions over plain data (state out and in, input out and in, players joining and leaving). They are useful without a network too: saves, replays, tests.
- **One small adapter beside it** (`zirbel-adapter.js`) is the only file that knows Zirbel. It calls zirbel-net's `play()` with the hooks and a mode, and play() does the netcode.

## 1. zirbel.json

Put `zirbel.json` beside `index.html` in the built folder. A `players.max` above 1 (up to 16) makes Zirbel import the folder as a net game, and `multiplayer.adapter` names the adapter Zirbel imports in a multiplayer room:

```json
{ "players": { "min": 1, "max": 8 }, "multiplayer": { "adapter": "zirbel-adapter.js" } }
```

Zirbel opens a net game's page with `?room=<room>&key=<key>`. Hosted anywhere else, the adapter never loads, and the game is the single-player game it always was. On a host that doesn't read `multiplayer.adapter`, the game's entry module loads it itself: `if (new URLSearchParams(location.search).has('room')) import('./zirbel-adapter.js');`. Set `globalThis.gameHooks` in the game's first module, before the adapter can run. If a bundler builds the entry into a subfolder, keep `zirbel-adapter.js` beside `index.html` as it is (for Vite, in `public/`).

## 2. Pick a mode

| Mode | For | What travels |
| --- | --- | --- |
| `snapshot` (default) | arcade, casual, physics, party games | The host steps the game and streams state; others send inputs and draw the state, smoothed |
| `predict` | action: shooters, racing, anything you steer at speed | `snapshot`, plus each screen moves its own player at once and corrects it when the host's state comes |
| `actions` | turn-based, cards, board games | Reliable actions to the host, checked there, applied in the host's order on every seat. Tiny and exact |
| `lockstep` | deterministic simulations, strategy, many units | Each tick's inputs reach every seat, and every seat steps the same simulation. Needs a deterministic game |
| `events` | big or destructible worlds, sandboxes | The host runs the world; changes go as reliable events; a newcomer gets the world in chunks, then the events since |

Unsure: `snapshot`. Your own player feels laggy over the network: `predict`. Nothing moves between turns: `actions`.

## 3. The hooks

Player ids are seats, 1 to 253. Alone, the game's own player is 1; once seated, play() moves it to its seat (`leave(1)`, `join(seat)`). A hook a mode doesn't use is never called.

| Hook | Modes | Does |
| --- | --- | --- |
| `me(id)` | all | Says which player this screen controls and follows. |
| `join(id)` / `leave(id)` | all | Adds or removes a player. `join` must ignore a player already there. snapshot and predict: join on the host, leave everywhere; the others: on every seat at the same point of the game. |
| `simulate(on)` | snapshot, predict, events | `true`: run the game. `false`: stop stepping and only draw what arrives (predict: play() moves this screen's own player through `predict`). |
| `snapshot()` / `restore(state)` | all | The state out and in. snapshot and predict: **entities by a key that stays the same**, `{ p1: {…}, p2: {…}, rock7: {…} }`, each sent only when it changed. The others: everything a newcomer needs (events: may be a `Uint8Array`). predict: `restore` brings back everything `predict` reads. |
| `input()` / `control(id, input)` | snapshot, predict, lockstep | The local player's input now: **read the devices here**, as play() samples it each tick in its own frame callback, which may run before the game's. Steer player `id` with an input (`null`: none). |
| `step(dt)` | predict, lockstep (snapshot if given) | Advance the whole game one tick of `dt` seconds. play() calls it at a fixed rate, also alone; the game's own loop then only draws. |
| `draw(alpha)` | where play() steps | Each frame after play()'s ticks, alone, on the host and every seat in lockstep: `alpha`, 0 to 1, is how far the frame is from the last tick to the next, to draw between the two. Optional. |
| `predict(input, dt)` | predict | Move this screen's own player one tick with its own input. |
| `player(id)` | predict | The key of player `id`'s entity. Default `'p' + id`. |
| `blend(a, b, t, key)` | snapshot, predict | One entity between two states, `t` from 0 to 1, for smooth drawing. |
| `interest(seat, key, entity)` | snapshot, predict | Whether `seat` gets this entity at all (fog of war, distance). |
| `validate(id, action)` / `apply(id, action)` | actions, events | On the host: may player `id` do this now? On every seat, in order: do it. |
| `checksum()` | lockstep | A number summing up the state; seats that differ from the host are reported as drift. |

## 4. The adapter, snapshot mode

```js
// zirbel-adapter.js: the only file that knows Zirbel.
import { play } from '/zirbel-net.js';            // the host's own, never bundled
play(globalThis.gameHooks, { mode: 'snapshot', rate: 20 });
```

That is all of it. The game beside it keeps its own loop and steps only while it simulates:

```js
const world = { players: new Map([[1, newPlayer()]]) };
let me = 1, simulating = true;
function frame() {
  const self = world.players.get(me);
  if (self) self.input = readKeys();        // the local player is steered locally, also on the host
  if (simulating) step(world, 1 / 60);
  draw(world, me);
  requestAnimationFrame(frame);
}
globalThis.gameHooks = {
  snapshot: () => Object.fromEntries([...world.players].map(([id, p]) => ['p' + id, [p.x, p.y, p.hp]])),
  restore: (s) => { world.players = new Map(Object.entries(s).map(([k, [x, y, hp]]) => [+k.slice(1), { ...newPlayer(), x, y, hp }])); },
  blend: (a, b, t, key) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, b[2]],
  input: () => world.players.get(me)?.input ?? null,
  control: (id, input) => { const p = world.players.get(id); if (p) p.input = input; },
  join: (id) => { if (!world.players.has(id)) world.players.set(id, newPlayer()); },
  leave: (id) => { world.players.delete(id); },
  me: (id) => { me = id; },
  simulate: (on) => { simulating = on; },
};
requestAnimationFrame(frame);
```

Arrays (`[x, y, hp]`) are smaller on the wire than objects with names. Keep each entity small; the host sends an entity only when its bytes changed since the state that seat last confirmed, the whole state when a seat joins, and every 10 seconds as a safety net.

## 5. The adapter, predict mode

```js
import { play } from '/zirbel-net.js';
play(globalThis.gameHooks, { mode: 'predict', tick: 60, rate: 20, f32: true });   // f32: section 8
```

The game still runs alone, with its own loop. It moves players in one function, which the host's `step` and this screen's `predict` share, so the prediction matches the host. Once play() calls `step()`, the loop stops stepping; once it calls `input()`, the loop stops reading the devices:

```js
const move = (p, input, dt) => { p.vx += (input?.x ?? 0) * ACCEL * dt; p.x += p.vx * dt; };   // reads p.vx too
const advance = (dt) => { for (const p of world.players.values()) move(p, p.input, dt); };
let me = 1, simulating = true, stepped = false, sampled = false, last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1), self = world.players.get(me);
  last = now;
  if (!sampled && self) self.input = readKeys();          // alone: the loop reads the devices...
  if (!stepped && simulating) advance(dt);                 // ...and steps; a follower never steps
  draw(world, me);
  effects();                                               // sounds and sparks: below
  requestAnimationFrame(frame);
}
globalThis.gameHooks = {
  ...hooksAsInSnapshotMode,                 // blend, control, join, leave, me, simulate
  snapshot: () => Object.fromEntries([...world.players].map(([id, p]) => ['p' + id, [p.x, p.vx, p.hits]])),
  restore: (s) => { /* every field predict reads, here p.x and p.vx, as in snapshot mode */ },
  input: () => { sampled = true; return readKeys(); },
  step: (dt) => { stepped = true; advance(dt); },
  predict: (input, dt) => { const p = world.players.get(me); if (p) move(p, input, dt); },
};
requestAnimationFrame(frame);
```

play() numbers each input, applies it at once on this screen, and sends it with the last few (in case one is lost). The host applies one input a tick per player (two while more than two wait, so a burst at the start leaves no lag; with none waiting, the player keeps its last input) and says in each state which it reached; this screen takes its own player from that state and replays the inputs after it. On a screen faster than the tick rate, play() draws this screen's player between its last two ticks with `blend`, so it moves every frame. Others are drawn a little in the past, blended.

**restore brings back everything predict reads.** A follower restores the host's state and plays its unconfirmed inputs on it, so `predict` must find exactly what the host's `step` had: velocities, timers, a physics engine's own memory of a body (contacts, sleep, slip), module variables. What `snapshot()` leaves out, `restore` can't bring back, and the prediction drifts.

**Keep effects and display out of predict.** The same inputs are played again and again, on each new state, so whatever `predict` does besides moving the player repeats: a sound or a spark in it plays several times, and display values it adds up (wheel spin, a skid mark, a trip counter) run fast. Let `predict` change state only, and let the game's own frame turn state into effects, once:

```js
let heard = 0;
function effects() {                        // in the frame, from what the state shows now
  const hits = world.players.get(me)?.hits ?? 0;
  if (hits > heard) sound('crash');         // hits is state: snapshot() sends it, restore() brings it back
  heard = hits;
}
```

**One-off actions ride in the input** (respawn, pick a car, honk): as a counter or a field, `{ x, y, respawns: 3, car: 2 }`, never as a flag in one input only. The host may skip inputs that pile up, and keeps the last one when none come, so a one-tick flag can be lost or repeated; the host's `control` acts when the counter differs from the last it saw.

## 6. The other modes

```js
// actions: the game calls act() for every move instead of applying it itself.
const session = play(globalThis.gameHooks, { mode: 'actions' });
globalThis.gameHooks.act = (move) => session.act(move);   // alone, act() checks and applies at once
// hooks: validate(id, move), apply(id, move), snapshot(), restore(state), join(id), leave(id), me(id)

// lockstep: a deterministic game; play() steps it with every player's input for each tick.
play(globalThis.gameHooks, { mode: 'lockstep', tick: 20, delay: 2 })
  .on('drift', (seat, tick) => console.warn('Player', seat, 'drifted at tick', tick));
// hooks: input(), control(id, input), step(dt), snapshot(), restore(state), join(id), leave(id), checksum()

// events: the host runs the world, and every change others must see is an act(), on the host too.
const world = play(globalThis.gameHooks, { mode: 'events' });
// hooks: simulate(on), validate(id, change), apply(id, change), snapshot() (a Uint8Array is fine), restore(world)
```

Lockstep needs the same result from the same inputs on every machine: no `Math.random()` (seed your own, and keep its state in `snapshot()`), no wall-clock time, no iteration over unordered data. A tick waits until every player's input for it is in, so a player whose link drops pauses the game until it is back or gone (15 seconds at most).

## 7. What play() covers

- **Solo fallback.** The game starts alone at once. It stays alone without `?room=`, when the relay refuses it (wrong room or key, full), when no seat comes within `timeout` (10 seconds), and when the room ends; then the other players leave and this screen runs the game. `await session.ready` is `true` once seated.
- **Seats and the host.** The first player is host and runs the game. When the host leaves, or stays away for 2.5 seconds, the relay names another seat host, and it carries on from the last state it has (predict: with its own player where it drove it; a follower keeps 4 seconds of unconfirmed inputs, so it drives on while an away host keeps the role).
- **Leaving with the page.** A page that goes away (`pagehide`) leaves the room at once, so its player goes and another seat takes over the host role in milliseconds, not 2.5 seconds. In Zirbel's sandbox a reload takes a new seat anyway. `keepSeat: true` keeps the seat for 15 seconds instead, for a page that can resume it.
- **Late join.** A newcomer gets the whole current state (snapshot and predict: every entity; the others: `snapshot()`, in chunks within the relay's message limit, then what happened since).
- **Away, back, resume.** A dropped link reconnects by itself and keeps its seat for 15 seconds. The session emits `away` and `back`; a host may stop an away player: `session.on('away', (id) => game.control(id, null))`.
- **Leaving.** `session.leave()` leaves the room for good and plays on alone; `session.stop()` also stops driving the game.
- **Ticks.** play() ticks by each frame's own time, so a screen at the tick rate gets one tick every frame.

Session events: `online`, `offline`, `host`, `away`, `back`, `drift`, `message`. `session.id` is this screen's player, `session.isHost()` whether it runs the game, `session.net` the connection.

## 8. Your own messages

Name them; every seat maps the names to message types in the order you declare them:

```js
const session = play(globalThis.gameHooks, { channels: ['chat', 'boom'] });
session.send('boom', { x, y });                  // reliable, to everyone else; or send(name, value, seat)
session.stream('chat', 'gg');                    // unreliable, latest wins
session.on('message', (channel, value, from) => { if (channel === 'boom') game.explode(value); });
```

Everything play() sends is **binary by default** (`pack`: exact numbers, one byte for small whole numbers, UTF-8 strings). `f32: true` (snapshot and predict) sends numbers that aren't whole as 32-bit floats in states and inputs: about 7 digits, 5 bytes instead of 9, whole numbers still exact; a physics game's state needs no rounding of its own. `json: true` sends JSON text instead. For the tightest states, give your own codec: `codecs: { state: { write(w, v) { w.q16(v[0], 0, 960).q16(v[1], 0, 540); }, read: (r) => [r.q16(0, 960), r.q16(0, 540)] } }` (`w` and `r` are zirbel-net's `Writer` and `Reader`). Rates: inputs 20 to 60 a second, states 10 to 30. A state that changes a lot every tick should stay under 1000 bytes (larger ones go reliably); a world bigger than that belongs in `events`.

## 9. What the relay does, and never does

The relay checks the room's key, gives out seats (the first player is host), routes each message to everyone, the host or a seat with the sender's seat on it, keeps an away seat for 15 seconds, hands the host role on, and shares its clock. It **never reads, checks, changes or keeps game data**: your messages are bytes to it. It runs no game code: no server authority, no anti-cheat, no saves. Whatever must be true, the host's page decides. A `zirbel.json` `authority` is ignored, and no seat 254 (`SERVER`) ever joins.

## 10. The page's sandbox

A game runs in a sandboxed frame with its own opaque origin and a strict content policy:

- Load scripts, styles, images, fonts and `fetch` only from your own folder, by relative path (for Vite: `--base ./`), plus `/zirbel-net.js` and the relay. No CDNs: bundle every dependency. `import 'three'` and `three/addons/…` resolve to the host's three.js.
- Your files come from another origin than the page's, with CORS: an image you read back from a canvas (`getImageData`, `toDataURL`, a WebGL texture) needs `img.crossOrigin = 'anonymous'` before its `src`, or the canvas is tainted. three.js's loaders set it.
- No `<link rel="manifest">`: the page's policy allows none.
- File types: `html`, `js`, `mjs`, `css`, `json`, `map`, `txt`, `csv`, `wasm`; `glb`, `gltf`, `bin`, `ktx2`, `obj`, `mtl`, `fbx`, `hdr`, `exr`; `glsl`, `vert`, `frag`, and source as text (`ts`, `tsx`, `jsx`); `png`, `jpg`, `jpeg`, `webp`, `gif`, `avif`, `svg`, `ico`; `woff2`, `woff`, `ttf`, `otf`; `mp3`, `ogg`, `opus`, `wav`, `m4a`, `aac`, `flac`, `mp4`, `webm`. A format of your own goes as `.bin`.
- `localStorage`, `sessionStorage`, IndexedDB and cookies throw: wrap them in `try`. A reload takes a new seat.
- No popups or navigation of the page around the frame. Pointer lock works, after a click in the game.
- `session.net.data('rules.json')` reads `data/rules.json` from your folder.

## 11. Test with two browsers, then a bad network

1. Build the game to a folder with `index.html`, `zirbel.json` and the adapter at its top. Zirbel takes the file types in section 10 (no hidden files), up to 1000 files and 36 MB.
2. Start a Zirbel host from its repository (`pnpm build` first): `node dist/server.mjs --data /tmp/zirbel-test`. It prints one JSON line with `editor` (default `http://127.0.0.1:4173`) and `player` (`http://127.0.0.1:4174`). The Go host, `host/bin/zirbel-host`, takes the same flags. Add `--lan` to play from phones on your network.
3. In the editor: **Import a game folder…**, then **Share**, and **Publish to this host’s library** with **Offer in the lobby** checked. Or through its API, from the editor's origin:

```js
const editor = 'http://127.0.0.1:4173', headers = { origin: editor, 'content-type': 'application/json' };
const post = async (path, body) => (await fetch(editor + path, { method: 'POST', headers, body: JSON.stringify(body) })).json();
const game = await post('/api/projects/import-game', { title: 'My game', files: { 'index.html': '<base64>', 'zirbel.json': '<base64>' } });
const { releaseId } = await post('/api/projects/' + game.id + '/release', { permissions: { play: true, download: false, remix: false } });
await post('/api/lobby/offer', { release: releaseId, offered: true });
```

4. Open the lobby, `http://127.0.0.1:4174/`, in two browser windows. Start a session of the game in one, and join it with its code in the other.
5. Check in both: the adapter loaded, one window hosts and the other follows, play moves in both. Close the host's window: the other takes over at once (play() leaves at `pagehide`); drop the host's network instead, and it takes over after 2.5 seconds. The console shows no content-policy or script errors.
6. **Now on a bad network.** Add `?net=lag:120,jitter:30,loss:5,kbps:256,stats` to the lobby's address (`http://127.0.0.1:4174/?net=…`): the lobby carries it onto the session it starts or joins by code. Or add it to the player page's own address, `/join/<room>?net=…#…`, before the `#`, which holds the seat. The player page hands it on to the game's frame. While testing, `play(hooks, { mode: 'predict', net: 'lag:120,jitter:30,loss:5,stats' })` does the same. `lag` is the added round trip in ms, `jitter` up to that many ms more each way, `loss` the percent of unreliable messages dropped (never reliable ones), `kbps` a bandwidth cap each way, and `stats` a small overlay with the round trip, jitter, traffic and drops. Play: others should stay smooth, your own player responsive in `predict`, nothing lost in `actions`. Without `net`, nothing is simulated.

For automated checks, Playwright with two browser contexts does the same; on macOS, start Chromium with `--use-angle=metal` for WebGL.

## When you need more

A game with its own netcode uses zirbel-net's client directly, still only in a module that is loaded in a Zirbel room:

- `const net = zn.connect({ ...zn.launchParams(), loopback: true })`: `loopback` also delivers your own `ALL` and `HOST` messages to you, so the host plays through the same message path as everyone else. `autoFlush: false` sends only on `net.flush()`, once per tick.
- Events: `open` `{ id, hostId, peers }`, `peer`, `leave`, `away`, `back`, `host`, `message` `(from, type, reader, reliable)`, `close`, and your own `disconnect` and `resume`.
- `net.send(to, type, data)` is reliable and ordered, `net.stream(to, type, data)` unreliable and latest wins; `to` is `zn.ALL`, `zn.HOST` or a seat; `type` is 0 to 223. `net.begin()` gives a scratch `Writer` (`u8`, `u16`, `f32`, `varint`, `str`, `q16(v, min, max)`…), read back in the same order. `zn.channels(net, ['shot', 'chat'])` names the types for you.
- `net.isHost()`, `net.id`, `net.hostId`, `net.peers`, `zn.players(net)`, `net.now()` (a clock every seat shares), `net.rtt`, `zn.Interp` for smoothing. The host sends full state after `resume`.
- `zn.netsim({ lag: 120, loss: 5 })` is the simulator as a WebSocket class for `connect({ WebSocket })`, and `zn.overlay(net)` the stats overlay.

The client's own guide is `packages/net/README.md` in Zirbel's repository. Every Zirbel host serves this skill on its player address, at `/zirbel-net/SKILL.md` (`http://127.0.0.1:4174/zirbel-net/SKILL.md` on a local host).
