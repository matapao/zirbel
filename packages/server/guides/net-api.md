# The net module

A Zirbel game with its own netcode plays with the others in a **space** of the spaces kernel that every Zirbel host runs beside it: the space's members, its leader and messages between them, over the space's binary lane. The net module is the client for real-time games. Every player listener serves it as `/.skalet/net.js` (an ES module, bundled), and the spaces SDK underneath it as `/.skalet/spaces.js`. A net game's page may import exactly these two, and nothing else of the host's.

On Zirbel the game runs in a sandboxed frame inside the player page. The player page joins the space (with the invitation or ticket in its own link) and shares it with the frame; the game joins **through its parent**, `via: 'parent'`, and never holds an invitation, a ticket or a resume token. Alone (the editor's playtests, a host without the kernel) the player page shares a space that lives in the page, and the game plays alone. Where there is no host at all, the import of `/.skalet/net.js` fails: wrap it in `try`/`catch` and play alone.

To make a game multiplayer with a small adapter beside it, and leave the game itself free of network code, use `sync()` and follow `zirbel://guide/multiplayer`. The rest of this guide, from `connect()` on, is the raw connection underneath, for games with netcode of their own.

## sync()

```js
const { sync } = await import('/.skalet/net.js');
const session = sync(globalThis.gameHooks, { mode: 'predict', join: { via: 'parent' } });
```

`sync(hooks, options)` starts the game alone at once, as member 1. With `join: { via: 'parent' }` (Zirbel's game frame), `join: { link }`, a space it is given (`space`), or a page address that names a space (`#skalet.space=…`), it joins with the binary lane, waits up to `timeout` for it, and runs a mode against the game's hooks. It carries on alone when there is no space (or only one in the page), the space refuses it, none could be joined in time, or the space ends. It leaves the space when the page goes away (`pagehide`), unless `keepMember` is set. It ticks by each frame's own time, so frames at an even rate get their ticks evenly.

| Mode | For | How |
| --- | --- | --- |
| `snapshot` (default) | arcade, casual, physics | The leader steps the game and sends each member the entities that changed since the state that member last confirmed (all of them on join and every `full` ms); the others send inputs and draw the state, blended a little in the past. |
| `predict` | fast movement, racing | `snapshot`, and each screen applies its own numbered inputs at once; the leader applies one per tick (two while more than two wait; with none waiting, the member keeps its last input) and says which it reached, and the screen replays the rest on the leader's state and draws its own member between its last two ticks (`blend`). |
| `actions` | turns, cards, boards, forms | Actions go reliably to the leader, which checks them and numbers them; every member applies them in that order. Joins and leaves are entries too. |
| `lockstep` | deterministic simulations | Each tick's inputs reach every member `delay` ticks ahead; every member steps the same game; the leader decides joins and leaves at ticks nobody has reached; a checksum every `check` ticks finds drift. |
| `events` | big or destructible worlds | `actions`, with the leader running the world: its changes are actions too, and a newcomer gets the world in chunks within the space's message limit, then the entries since. |

The leader is the space's: its first participant, then, when that one leaves or is away 2.5 s, the lowest connected member. Observers watch: no mode joins them, and their input and actions are never used.

The hooks each mode uses (a hook a mode doesn't use is never called; alone, this screen's member is 1, and once in a space sync() moves it to its number with `leave(1)`, `join(n)`). In predict, `restore` brings back everything `predict` reads, and `predict` only changes state: a follower plays the same inputs again on each state, so effects in it repeat. `input()` is sampled each tick in sync()'s own frame callback: read the devices there. `draw(alpha)` comes each frame after the ticks where sync() steps the game.

| Hook | snapshot | predict | actions | events | lockstep |
| --- | --- | --- | --- | --- | --- |
| `me(id)` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `join(id)`, `leave(id)` | leader; leave everywhere | leader; leave everywhere | every member, in order | every member, in order | every member, at a tick |
| `simulate(on)` | ✓ | ✓ | | ✓ | |
| `snapshot()`, `restore(state)` | entities by key | entities by key | the state, for newcomers | the world (also bytes) | the state, for newcomers |
| `input()`, `control(id, input)` | ✓ | ✓ | | | ✓ |
| `step(dt)` | optional | ✓ | | | ✓ |
| `draw(alpha)` | with `step`: alone, leader | alone, leader | | | ✓ |
| `predict(input, dt)`, `member(id)` | | ✓ | | | |
| `blend(a, b, t, key)`, `interest(member, key, entity)` | optional | optional | | | |
| `validate(id, action)`, `apply(id, action)` | | | ✓ | ✓ | |
| `checksum()` | | | | | optional |

Options: `mode`; `rate` (states a second, 20); `tick` (ticks a second: 30, predict 60, lockstep 20); `smooth` (ms in the past others are drawn); `full` (ms between full states, 10000); `delay` (lockstep's input delay in ticks, 2); `check` (ticks between checksums); `json` (JSON text instead of binary); `f32` (snapshot and predict: states and inputs with `pack32`); `codecs` (`{ state, input, action }`, each `{ write(w, v), read(r) }`); `channels` (the game's own message names); `timeout` (ms, 10000); `keepMember` (a page that goes away keeps its member for the space's grace instead of leaving); `net` (the simulator and overlay, as in `?net=`); `join` (what joining gets: `via: 'parent'`, `link`, `name`, `role`); `space` (a space the page joined itself, with the binary lane).

The session: `id`, `net` (null alone), `ready` (true once in a space), `isLeader()`, `act(action)` (actions and events), `send(channel, value, to?)` and `stream(…)` on the game's channels, `leave()` (carries on alone), `stop()`, and the events `online (id, leaderId)`, `offline (reason, message)`, `leader (leading)`, `away`, `back`, `drift`, `message (channel, value, from)`. sync() keeps channels 0 to 15 (`FIRST_CHANNEL` is 16); the game's own start at 16.

### Named channels, codecs

`channels(net, ['shot', 'chat'], { first, codec })` maps names to channels in the order they are declared, so every member agrees without numbers chosen by hand: `ch.send('shot', { x, y })`, `ch.stream(…)`, `ch.on('shot', (value, from, reliable) => …)`, `ch.close()`. Values go through a codec: `pack` (the default: binary and exact, one byte for whole numbers below 240, keys as UTF-8, `Uint8Array` as it is), `pack32` (the same, with numbers that aren't whole as 32-bit floats) or `json`.

### The network simulator and the stats overlay

`?net=lag:120,jitter:30,loss:5,kbps:256,stats` puts a simulated link under the space's connection: `lag` adds that many ms to the round trip, `jitter` up to that many ms more each way, `loss` drops that percent of unreliable binary messages each way, and `kbps` caps each way. Nothing is simulated unless asked. On a Zirbel host the player page's address takes it before its `#` (`/join/<room>?net=…#…`): the player page holds the connection, so it puts the simulator under it, and hands `?net=` on to the game's frame, where `stats` shows a small overlay in the corner (the mode and member, the round trip, jitter, kB/s each way and drops). The lobby's address takes it too, and carries it onto the sessions it starts and joins. With the raw connection: `connect({ WebSocket: netsim({ lag: 120 }) })` on a page that holds its own connection, and `overlay(net)`.

## connect()

```js
const { connect, ALL, LEADER } = await import('/.skalet/net.js');
const net = connect({ via: 'parent' });
net.on('open', ({ id, leaderId, peers }) => {});
net.on('message', (from, channel, r, reliable) => { if (channel === 16) { const x = r.f32(); } });
net.send(ALL, 17, 'start');                                    // reliable, ordered
net.stream(LEADER, 16, net.begin().u16(seq).q16(x, 0, 960));   // unreliable, latest wins
```

`connect(options)` joins with the binary lane (`via: 'parent'` in Zirbel's frame, or `link`, `name`, `role`), or rides `options.space`, a space the page joined itself. Also: `loopback` (deliver your own `ALL` and `LEADER` messages to yourself, handy when the leader also takes part), `autoFlush: false` (send only when you call `net.flush()`, for example once per tick; by default everything sent during one task leaves together). A dropped link reconnects by itself and resumes the same member.

### Events: net.on(name, listener) and net.off(name, listener)

| Event | Arguments | When |
| --- | --- | --- |
| `open` | `{ id, leaderId, peers }` | In the space. `peers` maps the other members' numbers to their names. |
| `peer` | `id, name` | Someone joined. |
| `leave` | `id` | Someone left for good. |
| `away` | `id` | Someone's link dropped. The space holds the member for its grace. |
| `back` | `id` | Someone who was away is back. |
| `leader` | `leaderId` | The leader changed (0: the space has none now). |
| `message` | `from, channel, reader, reliable` | A binary message from member `from`. Read `reader` before the listener returns, because it is reused. |
| `close` | `reason, message` | The end: you called `close()`, the space refused you, or it closed. |
| `disconnect`, `resume` | | Your own link dropped and came back; a leader should send full state on `resume`. |

### Sending

`net.send(to, channel, data)` is reliable and ordered; `net.stream(to, channel, data)` is unreliable, so the latest message wins: the kernel drops stream messages to a member whose connection is backed up or away, and payloads over 1000 bytes go reliably instead. `to` is `ALL` (everyone else), `LEADER` (whoever leads now) or a member's number; `channel` is 0 to 255. `data` is a string, a `Uint8Array`, an `ArrayBuffer`, a typed array, or a `Writer`: `net.begin()` gives an empty one with `u8`, `u16`, `u32`, `f32`, `f64`, `varint`, `str` and `q16` (a number in a range, in 16 bits); read it back with the reader's methods of the same names, or `reader.text()` for a string. A message can be up to the space's binary limit (1 MiB on Zirbel). `net.close()` leaves the space for good. Also: `net.id`, `net.leaderId`, `net.isLeader()`, `net.member(id)` (its role and kind), `net.now()` (the space's clock, shared by every member), `net.rtt`, `Interp` (smooths snapshots between updates) and `members(net)` (every member's number in order).
