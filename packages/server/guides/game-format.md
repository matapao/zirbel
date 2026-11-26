# The game format

A Zirbel game is a web page and the files it loads: a built folder, as a bundler leaves it or as you write it by hand.

```
index.html          the page, at the top
zirbel.json         optional: how many play, and the keys gamepads press
assets/main.js      everything else, beside it, loaded by relative paths
models/hero.glb
sounds/jump.ogg
```

## index.html

`index.html` at the top is the game's page. It is UTF-8 text of at most 400,000 characters; Zirbel keeps it without a byte order mark or the white space around it. A game can be this page alone, with its scripts and styles inline, or the page of a folder of files.

## The files beside it

Every other file sits beside `index.html` at a relative path, which the page and its scripts load by that path (`./assets/main.js`, or `assets/main.js`). A path:

- has at most 8 parts (up to 7 folders and the file), and at most 240 characters;
- has parts of letters, digits, `.`, `_` and `-`, each starting with a letter, a digit or `_`, so no hidden files or folders, and no `..`;
- ends in one of these extensions, in lower case, which set the type the file is served with:

| Kind | Extensions |
| --- | --- |
| Pages, code and data | `html` `js` `mjs` `css` `json` `map` `txt` `csv` `wasm` |
| Models and scenes | `glb` `gltf` `bin` `ktx2` `obj` `mtl` `fbx` `hdr` `exr` |
| Shaders and source, served as plain text and never run | `glsl` `vert` `frag` `ts` `tsx` `jsx` |
| Images | `png` `jpg` `jpeg` `webp` `gif` `avif` `svg` `ico` |
| Fonts | `woff2` `woff` `ttf` `otf` |
| Sound and video | `mp3` `ogg` `opus` `wav` `m4a` `aac` `flac` `mp4` `webm` |

A game holds up to 1000 files besides `index.html`, and up to 36 MB in all, `index.html` included. Imported in the editor, a folder travels as 48 MB of base64, the limit of every package Zirbel moves.

## Players: maxPlayers and net

A game says how many play:

- `maxPlayers`: 1 to 16, 1 unless it says otherwise.
- Without `net`, up to 4 players share state through the host: each sends its own small state with `window.zirbel.send`, and every player gets them all with `window.zirbel.onRoom` (below). The game applies its own rules; the host only relays the states.
- With `net: true`, the game brings its own netcode, for up to 16 players: a session of it is a space of the spaces kernel every host runs, and the game joins that space through the player page around it with the net module (`/.skalet/net.js`). More than 4 players needs `net`. How to make a game multiplayer this way is in `zirbel://guide/multiplayer`, and the net module's API in `zirbel://guide/net-api`.

A game without files sets them in `propose`'s `writeGame` (`maxPlayers`, `net`). A folder game sets them with `zirbel.json`.

## zirbel.json

`zirbel.json` beside `index.html` describes the game, as it did for the earlier Zirbel. Zirbel reads `players.max`, a net game's `multiplayer.adapter` (`zirbel://guide/multiplayer`) and `controls` (below) from it, and nothing else:

```json
{ "players": { "min": 1, "max": 8 } }
```

An integer `players.max` above 1 makes the game a net game for that many players, up to 16. Anything else (no `players.max`, 1, not an integer, not JSON, or a file over 64 KB) makes it a game for one. Zirbel reads it when a folder is imported, and when `write_files` writes it; a change that leaves `zirbel.json` as it is keeps the game's players, adapter and controls as they are.

## Controllers: gamepads, phones and the keyboard

Every screen that shows a game takes controllers: the gamepads of the device it runs on, phones that open the screen's pad page (`/pad/<code>`, from the QR code in the player's **Controllers** panel), and gamepads on a Zirbel box. The game reads them all through the standard Gamepad API, `navigator.getGamepads()` and the `gamepadconnected` and `gamepaddisconnected` events, so **a game that reads gamepads plays with phones and the box's gamepads unchanged**, with no line about Zirbel.

- Each controller holds a place, P1 to P8: its gamepad's `index` is its place (0 to 7), with `null` at empty places, so "gamepad i is player i + 1" puts P1 on player 1. People choose and swap places on the screen.
- A phone has the standard layout (`mapping` `'standard'`, 17 buttons and 4 axes: a left stick, a d-pad, A B X Y, LB RB LT RT, Select and Start), and its `vibrationActuator.playEffect('dual-rumble', …)` vibrates it where the phone can. A box gamepad has its own layout, or the standard one where it maps to it.
- A gamepad's press doesn't count as a user gesture in every browser: unlock audio and fullscreen on a click, a tap or a key too (a TV remote's OK arrives as Enter).

A game that reads only the keyboard gets keys from its `zirbel.json`, written beside the game and never in it. `controls.keys` are P1's keys; `controls.players`, a list of up to 8, gives each place its own `keys`, and the `name` (at most 24 characters) and `color` (`#rrggbb`) of what it drives there, which the screen and that place's phone show. Where `players` is given, `keys` is not used:

```json
{ "controls": { "keys": { "a": "Space", "start": "Enter", "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight" } } }
```

```json
{ "controls": { "players": [
  { "keys": { "up": "KeyW", "down": "KeyS", "left": "KeyA", "right": "KeyD", "a": "Space" }, "name": "Red car", "color": "#d03030" },
  { "keys": { "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight", "a": "Enter" }, "name": "Blue car", "color": "#3050d0" }
] } }
```

The inputs are `a` `b` `x` `y` `lb` `rb` `lt` `rt` `select` `start` `ls` `rs` `up` `down` `left` `right` `home`; `up`, `down`, `left` and `right` are the d-pad, and the left stick past half way. The values are `KeyboardEvent.code`s: letters and digits, 1 to 24 of them (`KeyA`, `Digit1`, `Space`, `ShiftLeft`, `ArrowUp`, `Enter`, `Escape`). Each press of the gamepad at a place is one `keydown`, each release one `keyup`, with the `code`, and the `key` and `keyCode` a keyboard gives, at the focused element, bubbling to `document` and `window`. Keys with an input Zirbel doesn't know, or a code that isn't one, leave the game without `keys`; a player that isn't right leaves it without `players`.

## Where the game runs

Players open a game in Zirbel's player, which runs the page in a sandboxed frame of its own, at `/game/<room>/<key>/` on the host's player side (a net game at `/game/@<room>/<key>/`), with its files beside it. The host serves the page with its own start in front of it: the character set and viewport, an import map, the game's assets, and the SDK that makes `window.zirbel`. A `<!doctype html>` at the top of the page is replaced by the host's own.

The frame has an opaque origin of its own and a strict content policy. A game can:

- load scripts, styles, images, fonts, sounds, video and data from its own folder, by relative path, and `fetch` them;
- run inline scripts and styles, ES modules, WebAssembly and workers (from its folder or `blob:` URLs);
- make and read `data:` and `blob:` URLs, as loaders do with embedded textures and decoders;
- import three.js as `three`, and its addons as `three/addons/…` (for example `three/addons/loaders/GLTFLoader.js`), both from the host's own build: the import map is there already, so bundle `three` as an external or import it by those names. `THREE.REVISION` says which three.js it is.
- lock the pointer, from a click in the game (the browser shows how to leave it);
- as a net game, import `/.skalet/net.js` and `/.skalet/spaces.js` from its host and reach `/.skalet/spaces`, and nothing else there.

A game can't:

- reach any other origin: no CDNs, web fonts, analytics or APIs on the internet, and no address of the host outside its folder (a path starting with `/` leaves the folder: use relative paths, for Vite `--base ./`);
- use storage: `localStorage`, `sessionStorage`, IndexedDB and cookies throw, so wrap them in `try` and keep going without them;
- run `eval` or `new Function`;
- open popups or frames, submit forms, use `<base>`, or navigate the page around it;
- reach the editor, other projects or anything of the owner's.

## window.zirbel

The SDK the host puts in every game's page, before the game's own scripts:

- `zirbel.assets`: the images imported into the project in the editor, with their author and licence, as `data:` URLs by asset id.
- `zirbel.register(id, properties)`: shows one of the game's objects in the editor's inspector. The id has 1 to 120 characters; the properties are compact JSON (at most 4096 characters, 8 levels deep and 256 values, strings up to 2048 characters). Call it again when the object changes, for up to 512 objects. A game whose `registerObjects` is `false` has it do nothing.
- `zirbel.unregister(id)`: takes an object out of the inspector.
- `zirbel.send(state)`: in a game sharing state, this player's state for the others: compact JSON of at most 4096 characters, bounded as properties are. A larger one is dropped.
- `zirbel.place(k, { name, color })`: what place `k` (0 to 7) drives, for the screen and that place's phone to show, as `controls.players` says it for a game that knows it ahead. It is an adapter's, for what a game decides as it runs; a game needs no line about Zirbel.
- `zirbel.onRoom(listener)`: calls `listener({ self, seats, states })` now, if the room is known, and whenever it changes, also after a reconnect. `self` and each of `seats` are `{ id, name, role, connected }`, `role` being `player` or `spectator`; `states` holds each seat's last state by its id. It returns a function that removes the listener.

Errors the page doesn't catch, and rejected promises nobody handles, go to the page around the frame: in the editor, the owner sees them.
