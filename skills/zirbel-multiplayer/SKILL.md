---
name: zirbel-multiplayer
description: Make a web game multiplayer on Zirbel with a thin adapter over zirbel-net, Zirbel's multiplayer client and relay. Use when a browser game (canvas, WebGL, three.js, any framework) should play with several people on a Zirbel host, box or desktop app, while it still runs alone anywhere else; when writing or reviewing a game's zirbel-adapter.js or its zirbel.json; or when testing a game with two browsers on a local Zirbel host.
---

# Multiplayer on Zirbel

Zirbel plays a game's multiplayer over **zirbel-net** (protocol v2): every Zirbel host serves the client as `/zirbel-net.js` and runs a relay at `/mp`. The relay only seats players and passes their messages on. Your game is the simulation, and one player's page runs it.

Keep multiplayer a thin, separate layer:

- **The game knows nothing about networks.** It runs alone, hosted anywhere, as a single-player game. It imports no network code.
- **One small adapter beside it** (`zirbel-adapter.js`, tens of lines) is the only file that knows Zirbel. It loads only in a Zirbel multiplayer room, and wires a few game hooks to zirbel-net.
- **The game exposes a few hooks**: state out and in, input out and in, players joining and leaving, and who runs the simulation.

## 1. Declare players in zirbel.json

Put `zirbel.json` beside `index.html` in the built folder. A `players.max` above 1 (up to 16) makes Zirbel import the folder as a net game:

```json
{ "players": { "min": 1, "max": 8 } }
```

Zirbel reads `players.max` and `multiplayer.adapter` (below) from this file, and nothing else.

## 2. Name the adapter in zirbel.json

```json
{ "players": { "min": 1, "max": 8 }, "multiplayer": { "adapter": "zirbel-adapter.js" } }
```

In a multiplayer room, Zirbel's game page loads the adapter as a module after the game's own document, opened with `?room=<room>&key=<key>`. The game's own code carries no line about Zirbel; hosted anywhere else, nothing loads the adapter. The path is relative to `index.html`, without `./`, to a `.js` or `.mjs` file in the folder; anything else leaves the game without an adapter. The adapter runs after the game's module scripts start, so set `globalThis.gameHooks` before the entry's first `await`. Ship `zirbel-adapter.js` as it is, so no bundler renames it (for Vite, in `public/`).

Only for a host that doesn't load the adapter itself does the game's entry carry one line, after it has set up its hooks: `if (new URLSearchParams(location.search).has('room')) import('./zirbel-adapter.js');`

## 3. The hooks

The game sets `globalThis.gameHooks` to plain functions over plain data. They are useful without a network too: saves, replays, tests.

| Hook | Does |
| --- | --- |
| `snapshot()` | Returns the state another screen needs to draw: JSON-safe data, kept small. |
| `restore(state)` | Replaces the drawn state with a snapshot. |
| `input()` | Returns the local player's input right now, such as `{ x, y, fire }`. |
| `control(id, input)` | Steers player `id` with that input from the next simulation step on. |
| `join(id)` / `leave(id)` | Adds or removes player `id`. `join` must ignore a player that is already there. |
| `me(id)` | Says which player this screen controls and follows. |
| `simulate(on)` | `true`: step the simulation. `false`: only draw what `restore` gives. |

Player ids are zirbel-net seats, 1 to 253. Playing alone, the game's own player is 1 and it simulates. Its loop stays its own:

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
  snapshot: () => ({ players: [...world.players].map(([id, p]) => [id, p.x, p.y, p.hp]) }),
  restore: (s) => { world.players = new Map(s.players.map(([id, x, y, hp]) => [id, { ...newPlayer(), x, y, hp }])); },
  input: () => world.players.get(me)?.input ?? {},
  control: (id, input) => { const p = world.players.get(id); if (p) p.input = input; },
  join: (id) => { if (!world.players.has(id)) world.players.set(id, newPlayer()); },
  leave: (id) => { world.players.delete(id); },
  me: (id) => { me = id; },
  simulate: (on) => { simulating = on; },
};
requestAnimationFrame(frame);
if (new URLSearchParams(location.search).has('room')) import('./zirbel-adapter.js');
```

## 4. The adapter

The default authority model: **the host's page runs the game.** One seat, the host, steps the simulation and streams snapshots to everyone. The others stream their input to the host and draw the snapshots. When the host leaves, or stays away for 2.5 seconds, the relay names another seat host, which carries on from the last snapshot it drew.

```js
// zirbel-adapter.js: the only file that knows Zirbel. The game loads it only in a Zirbel room.
const STATE = 1, INPUT = 2;                    // this game's own message types, 0 to 223
const game = globalThis.gameHooks;
const zn = await within(5000, import('/zirbel-net.js')).catch(() => null);   // never bundled: the host's own
if (zn && game) {
  const net = zn.connect(zn.launchParams());   // ?room= and ?key= from the page's address
  const giveUp = setTimeout(() => net.close(), 10000);   // no seat in time: stay alone
  let timer;
  const role = () => {                         // on open, on a new host, after a dropped link
    clearTimeout(giveUp);
    clearInterval(timer);
    game.me(net.id);
    game.simulate(net.isHost());
    if (net.isHost()) {
      for (const id of zn.players(net)) game.join(id);
      timer = setInterval(() => net.stream(zn.ALL, STATE, JSON.stringify(game.snapshot())), 50);
    } else {
      timer = setInterval(() => net.stream(zn.HOST, INPUT, JSON.stringify(game.input())), 33);
    }
  };
  net.on('open', role).on('host', role).on('resume', role);
  net.on('peer', (id) => { if (net.isHost()) game.join(id); });
  net.on('leave', (id) => game.leave(id));     // everywhere: a follower may be the next host
  net.on('message', (from, type, r) => {       // read r before returning: it is reused
    if (type === STATE && from === net.hostId && !net.isHost()) game.restore(JSON.parse(r.text()));
    else if (type === INPUT && net.isHost()) game.control(from, JSON.parse(r.text()));
  });
  net.on('close', () => { clearTimeout(giveUp); clearInterval(timer); game.simulate(true); });   // play on alone
}
function within(ms, promise) {
  return Promise.race([promise, new Promise((_, fail) => setTimeout(() => fail(new Error('timeout')), ms))]);
}
```

What it covers:

- **Solo fallback.** The game starts alone and keeps playing alone when the import fails, when no seat comes within 10 seconds (the client keeps retrying a relay it can't reach), and after `close`: the room closed (code 5), it is full (2), or the room or key is wrong (6).
- **Host handover.** `host` runs `role` again on every seat: the new host starts simulating from its last snapshot and streaming; the old one, if it comes back, follows. A closed tab counts as away: the role moves after 2.5 seconds, and its player leaves after 15.
- **Resume.** A dropped link reconnects by itself and keeps its seat for 15 seconds (`resume`); the others see `away` and `back`. Snapshots are whole states, so the next one repairs whatever was lost. A host may freeze an away player: `net.on('away', (id) => game.control(id, {}))`.
- **Players.** The host adds every seat, and each newcomer (`peer`). Seats are numbered, never named: `zn.playerName(3)` is `"Player Three"`.

## 5. Messages

- **Types** are yours: 0 to 223, one per kind of message.
- **`net.stream(to, type, data)`** is unreliable, and the latest wins: for state sent many times a second (inputs, snapshots). The relay drops it for a player whose link is backed up or away. A payload over 1000 bytes goes reliably instead.
- **`net.send(to, type, data)`** is reliable and ordered: for events that must arrive once (a round starts, a hit, a chat line).
- **`to`** is `zn.ALL` (everyone else), `zn.HOST` (whoever is host now) or a seat.
- **`data`** is a string, a `Uint8Array`, an `ArrayBuffer` or a `Writer`, up to 1 MiB. JSON is fine for small or rare messages. For frequent ones, write binary: `net.begin()` returns a scratch `Writer` (`u8`, `u16`, `u32`, `f32`, `f64`, `varint`, `str`, and `q16(v, min, max)`, a number in a range in two bytes); read it back in the same order:

```js
net.stream(zn.HOST, INPUT, net.begin().u8(keys).q16(aim, -Math.PI, Math.PI));
// on the host:
if (type === INPUT) game.control(from, { keys: r.u8(), aim: r.q16(-Math.PI, Math.PI) });
```

- **Rates and sizes.** Inputs at 20 to 30 a second, snapshots at 10 to 20. Keep a streamed snapshot under 1000 bytes: send only what others draw, and quantize it (`q16`, `q8`). A larger world sends what changed, reliably, or less often.
- **Time.** `net.now()` is a clock every seat shares. `net.rtt` is the round trip to the relay.

## 6. Smooth movement

Snapshots arrive 10 to 20 times a second. Draw others a little in the past, between two snapshots, with `zn.Interp`. Give the game one more hook, `blend(a, b, t)`, which mixes two snapshots, and have the adapter stamp each snapshot with `net.now()`:

```js
const past = new zn.Interp();
// host:      net.stream(zn.ALL, STATE, JSON.stringify({ t: net.now(), s: game.snapshot() }));
// follower:  on STATE, const m = JSON.parse(r.text()); past.push(m.t, m.s);
(function draw() {
  const at = past.sample(net.now() - 100);     // about 1.5 snapshot intervals behind
  if (at && !net.isHost()) game.restore(at.t >= 1 ? at.b : game.blend(at.a, at.b, at.t));
  requestAnimationFrame(draw);
})();
```

Call `past.clear()` when the host changes.

## 7. What the relay does, and never does

The relay checks the room's key, gives out seats (the first player is host), routes each message to `ALL`, `HOST` or a seat with the sender's seat on it, keeps an away seat for 15 seconds, hands the host role on, and shares its clock. It **never reads, checks, changes or keeps game data**: your messages are bytes to it. It runs no game code: no server authority, no anti-cheat, no saves. Whatever must be true, the host's page decides. A `zirbel.json` `authority` is ignored, and no seat 254 (`SERVER`) ever joins.

## 8. The page's sandbox

A game runs in a sandboxed frame with its own opaque origin and a strict content policy:

- Load scripts, styles, images, fonts and `fetch` only from your own folder, by relative path (for Vite: `--base ./`), plus `/zirbel-net.js` and the relay. No CDNs: bundle every dependency. `import 'three'` and `three/addons/…` resolve to the host's three.js.
- `localStorage`, `sessionStorage`, IndexedDB and cookies throw: wrap them in `try`. A reload takes a new seat.
- No pointer lock, popups or navigation of the page around the frame. Offer the game's controls without pointer lock.
- `net.data('rules.json')` reads `data/rules.json` from your folder.

## 9. Test with two browsers on a local host

1. Build the game to a folder with `index.html` and `zirbel.json` at its top. Zirbel takes common web file types (no hidden files), up to 1000 files and 36 MB.
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
5. Check in both: the adapter loaded, `open` came, one window hosts and the other follows; play moves in both. Close the host's window: the other takes over within a few seconds. The console shows no content-policy or script errors.

For automated checks, Playwright with two browser contexts does the same; on macOS, start Chromium with `--use-angle=metal` for WebGL.

## When you need more

A game with its own authority, or netcode beyond snapshots and inputs, uses zirbel-net directly, still only in a module that is loaded in a Zirbel room:

- `zn.connect({ ...zn.launchParams(), loopback: true })` also delivers your own `ALL` and `HOST` messages to you, so the host can play through the same message path as everyone else.
- `autoFlush: false` sends only on `net.flush()`, once per tick.
- Events: `open` `{ id, hostId, peers }`, `peer`, `leave`, `away`, `back`, `host`, `message`, `close`, and your own `disconnect` and `resume`.
- `net.isHost()`, `net.id`, `net.hostId`, `net.peers`, `zn.players(net)`; the host sends full state after `resume`.
- The authority runs in the host's page: start it on `open` or `host` when `net.isHost()`, stop it when the role moves on.

The client's own guide is `packages/net/README.md` in Zirbel's repository. Every Zirbel host serves this skill on its player address, at `/zirbel-net/SKILL.md` (`http://127.0.0.1:4174/zirbel-net/SKILL.md` on a local host).
