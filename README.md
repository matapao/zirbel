# Zirbel

Author, play and host web games locally. Describe a game and a harness (Codex or Claude Code) writes it. Zirbel stores each revision, runs the game in a sandboxed player, and can host it for LAN guests.

## Run

Needs Node 24 (`.nvmrc`) with pnpm (`corepack enable pnpm`), git 2.38 or later (every game is a git repository: the editor says so and doesn't start without it), Go 1.27 for the native host, and three submodules in `deps/`: the two `link:` dependencies in `package.json`, and the spaces kernel games with their own netcode play over. Clone with `--recurse-submodules` (or run `git submodule update --init`), then `pnpm run deps` builds them, the kernel's binary with Go.

```sh
pnpm install --frozen-lockfile && pnpm test   # install, build, unit and contract tests
pnpm lint && pnpm check:go && pnpm check:security && pnpm coverage
pnpm start --open                             # editor at http://127.0.0.1:4173/
```

`pnpm build:host && host/bin/zirbel-host --open` runs the same editor natively, without Node. It has no harness chat yet, so use an MCP agent there: start it with `--enable-mcp` and connect over loopback `POST /mcp` with a project grant, or over stdio with `node dist/server.mjs mcp` and `ZIRBEL_MCP_TOKEN`. The server tells an agent as it connects what its grant allows, and serves guides to working on a game as resources (`zirbel://guide/overview` first), so the agent needs no skill of its own; `read_file` and `write_files` read and change a game's files by path. Projects live in `~/.zirbel`. Override with `--data DIR` or `ZIRBEL_DATA`. Harness credentials live outside the data dir (`ZIRBEL_ACCOUNT_DIR` overrides). `node dist/server.mjs --help` lists every flag.

## Desktop app

`desktop/` is an Electron app around the same editor, a pnpm project of its own. It starts the editor from the built `dist/` on loopback and a free port, with the same data folder (`~/.zirbel` or `ZIRBEL_DATA`), and opens it in its window. If an editor already owns that folder, the app opens that one and leaves it running. Quitting stops the editor the app started.

```sh
pnpm build                                              # the editor the app runs
cd desktop
pnpm install --frozen-lockfile && pnpm electron:fetch   # install scripts don't run: this fetches Electron itself
pnpm build && pnpm start                                # run it from the checkout
pnpm typecheck && pnpm lint && pnpm test                # Playwright drives the app; its windows show meanwhile
pnpm pack:app && pnpm test:packed                       # a local macOS bundle in desktop/out/, signed ad hoc
```

The app's editor needs git 2.38 or later, as any Zirbel editor does (on a Mac, the Command Line Tools' git: `xcode-select --install`); without it the app says so and doesn't start. Its windows are sandboxed, with context isolation and no Node or preload. The editor's window stays on the editor's origin, playtests open in windows of their own on loopback player origins, other web links open in the system browser, and pages get no permission but fullscreen. The packed app runs your own Codex and Claude Code through their SDKs. Claude Code's SDK is under Anthropic's terms and is not bundled: the first Claude Code turn fetches the version the app was built with from the npm registry, keeps it only if it matches the lockfile's hash, and stores it in your account folder. An editor that already has it, installed or fetched before, fetches nothing. Quitting while a turn runs asks first, and the editor the app started always ends with it. A distributable build (`node scripts/pack.mjs` without `--dir`) needs a Developer ID and notarization credentials.

## Use

The game runs in the middle, playable, with its thread beside it. Before a game exists, the editor shows one prompt.

- **The game's title** at the top left switches games, starts a **New game** and opens the **Library**, which imports `.zirbel-project.json` files and built game folders. **Remove…** moves a project to `removed-projects/`; published releases stay.
- **The thread**: pick a harness and **Model**, then describe the game or a change. Each turn shows the harness's tool calls, file edits, messages and requests inline, with the current step and the time it has run. The Node editor keeps each turn's steps in `activity/` in the data directory as they come. A thread keeps one working folder and one harness session in the account folder (`turns/`), so each turn continues where the last one left off; they go when the project is removed. A turn belongs to the editor: closing the window leaves it running, and opening the thread again shows it where it is. Only **Stop** ends it. A turn the editor was running when it ended shows **Interrupted**, and **Continue** resumes it.
- **The game is a folder the harness builds**: each turn starts with `game/` in the thread's folder holding the current revision (`index.html` at its top, with the files it loads), and `node_modules/` linking three.js with its addons, TypeScript and esbuild, which the harness may read and never write. When the harness replies, the editor keeps `game/` as the next revision under the same rules as an imported folder (up to 1,000 files and 36 MB).
- **`view_game`**: each turn gets one MCP tool from the editor, on a server of its own for that turn's folder. It serves `game/` through the editor's player and game sandbox in a temporary room, renders it in a real browser with WebGL outside the harness's sandbox, takes the keys, clicks, waits and text it is given, and returns PNG screenshots with the page's console. The desktop app renders with its own Electron; the web editor uses an installed Chrome, Edge or Chromium, headless with a throwaway profile (`ZIRBEL_BROWSER` names another), and says so when there is none.
- **Edit** (or the E key) shows the editing tools on the running game: the object list to mark objects for chat, the **Source**, which you can change and save as a revision, and the scene tools of a template scene. A click into the game ends Edit.
- **Every game is a git repository** (`docs/git-store.md`): each revision is a commit, and **⋯ → History** shows who made it and when. **⋯ → Clone with git…** gives the clone command (on a box, with this device's git token); push to the game's branches and the editor takes a push as the branch's next revision while it is still a game (an `index.html` at the top, the files a game folder takes, within the limits), and refuses anything else before the branch moves. **Import from a git URL…** makes a game of a public https repository with its history, and **⋯ → Update from source** fetches it again and merges its changes under the game's own, saying which files conflict rather than forcing them. A game's multiplayer can live in the editor alone: its `zirbel.json` and adapter are commits on top of a source that never has them.
- A change staged for review is a card in the thread: **Before** and **After** switch the running game, then **Apply** or **Discard** it. **⋯ → History** switches branches, applies a proposal to a new branch and restores revisions.
- **Assets** lists the imported images and imports another. **Share → Development multiplayer** opens an invite-only LAN room pinned to the saved revision (up to 4 players, or 16 for a game with its own netcode, if the game declares it).

## Game API

A revision is one HTML document, or a built web folder imported with its files. Module scripts can `import * as THREE from 'three'`, and three.js's addons from `three/addons/...` (for example `three/addons/loaders/GLTFLoader.js`); the host serves both from its own build, with the Draco, Basis and meshopt decoders the addons load. Every game gets the same sandbox: WebAssembly, workers, and `data:` and `blob:` URLs, but no network. The sandbox provides:

| API | Purpose |
| --- | --- |
| `zirbel.register(id, props)` / `unregister(id)` | Show or update an object in the inspector (max 512 entries, 4096 chars each) |
| `zirbel.assets[id]` | Data URL for an imported image |
| `zirbel.send(state)` | Share this player's JSON state |
| `zirbel.onRoom(cb)` | Get seat, room seats and state per seat. Returns an unsubscribe function |

A game can bring its own netcode instead, for up to 16 players: its document says `net: true`, or the built folder it was imported from has a `zirbel.json` whose `players.max` is above 1. A session of it is a **space** of the spaces kernel, which each host runs beside it as a child process (its binary from `deps/`, or `--spaces-binary`, `ZIRBEL_SPACES_BINARY`): the space's members are the session's players, one of them leads, and the space carries their messages without reading them. The host passes `/.skalet/*` on its listeners to the kernel. The player page joins the space with the invitation or ticket in its link and shares it with the game's frame, and the game joins it through its parent with the net module, which it imports from `/.skalet/net.js`; its sandbox may reach that module, `/.skalet/spaces.js` and `/.skalet/spaces`, and nothing else on the network. Its `zirbel.json` can also name an adapter, `"multiplayer": { "adapter": "zirbel-adapter.js" }`, one of the folder's `.js` or `.mjs` files: the game page loads it as a module after the game's own document, so the game itself carries nothing of Zirbel's. [`skills/zirbel-multiplayer/SKILL.md`](skills/zirbel-multiplayer/SKILL.md) shows how, and [`packages/server/guides/net-api.md`](packages/server/guides/net-api.md) describes the net module's API. Without the kernel's binary, the lobby says multiplayer isn't available and these games play alone; under a host that runs the kernel already (its socket in `SKALET_SPACES`), Zirbel runs none and uses that one.

## Host

Edit on a laptop, export a release, and host it anywhere. The Node and Go hosts are interchangeable on one data directory; the contract tests in `test/` run against both.

```sh
pnpm build:host linux/arm64            # native Go host for an os/arch[/arm] target -> host/bin/
zirbel-host --host-only --lan --data DIR --import release.json --release ID
node --max-semi-space-size=2 dist/server.mjs --host-only --lan ...   # same flags on Node
```

The Go host is one static binary with the player files embedded, so it needs no Node. A release plays only on a host built from the same runtime. For Docker, build first, then `docker build -f Dockerfile.host .` (Go) or `docker build .` (Node), and run the image with `-p 4174:4174 -v DIR:/data --lan --player-host HOST`.

### A Zirbel box

`node dist/server.mjs --box --port 80` (or `ZIRBEL_BOX=1`) runs the editor for a small computer on your network, such as a single-board computer without a screen, reached at `http://<hostname>.local`. The box itself uses the editor as on a laptop. Other devices on its network must pair first, at `/pair`: with a one-time code from a device already paired or from the box's setup page, valid for ten minutes, or, while no device has ever paired, by claiming the box with one click. Paired devices and their sessions are kept hashed in the account folder, and can be removed in Box settings.

A box made from `pi/` comes online through its own Wi-Fi. While it has no network, it opens one named "Zirbel setup" and four letters and digits. Join it on a phone or computer, and its page opens: pick the Wi-Fi network the box should join, or keep the box on its own Wi-Fi, which has a password and no internet, for phones, tablets and computers to join and play. Change Wi-Fi in Box settings opens that page again, and so does an empty `zirbel-reset-wifi` file on the card's boot partition, which also makes the box forget its networks. A box on a wired network needs none of this.

A box made from `pi/` also takes gamepads, joysticks and wheels: plugged into its USB, or paired over Bluetooth in Box settings' Controllers, where **Pair a Bluetooth controller** looks for 30 seconds and lists the gamepads it finds, and **Forget** lets one go. Each plays on a screen as a standard gamepad, and Controllers shows which screen and place it has. A service of its own reads them, never as root and with no network of its own, and hands them to the host; their input is never kept.

Box settings has three switches. **Harnesses** runs Claude Code or Codex on the box. It starts on where they are made for the system and the box has at least 2 GB of memory, and while it is off nothing of theirs runs. **External MCP access** lets agents elsewhere on the network use the box's games at `/mcp`, each with a project grant from the game's Agent access. It starts off, and while off `/mcp` answers only the box itself. **Show the lobby on a TV** shows the lobby on a TV or monitor plugged into the box's HDMI: on a 64-bit box, Chromium runs full screen on the lobby's TV page as a user of its own, whenever a display is plugged in and the switch is on. It starts on where the box has at least 2 GB of memory. See [docs/box-tv.md](docs/box-tv.md).

Every player listener also serves the lobby's TV page at `/tv`, for a TV's own browser, a console's or a laptop cast to a TV: big tiles moved around with a remote's arrows, OK and Back or any gamepad, and places P1 to P8 that phones take by a QR code and gamepads by pressing A. Starting or joining a session there plays the game on that screen, and leaving it comes back.

The Go host takes `--box` too (`zirbel-host --box --port 80`), with the same pairing, switches and files. It runs no harnesses, so it suits a box whose system Claude Code and Codex are not made for, such as a 32-bit board: agents on your own computer use its games over MCP, and it shows a pairing link and code without a QR code.

## Security

The editor and MCP listen only on loopback, except in box mode, where devices on the box's network reach the editor only once paired, `/mcp` only while external MCP access is on and with a project grant, and a game's git repository (`/git/<game>.git`) only with a paired device's or an editor's git token, or a project grant while external MCP access is on. The editor imports and updates games only from public https repositories, holds no outside credentials and never pushes outside. A box serves plain HTTP, so pair devices and use it only on a network you trust. Keep those ports and the data dir private. Game JS runs in an opaque-origin iframe, so only play games from creators you trust. LAN room links are secrets, and so are a net game's space links. End the room to revoke its link; its space closes with it. The spaces kernel listens on loopback alone, for Zirbel's own proxy, which sends each request with the kernel's token and the listener it came by and drops whatever of that a client sent. Behind Docker port publishing every client looks private, so expose the port only on a trusted network. Report vulnerabilities privately through the repository's security advisories.

## License

MIT, see [LICENSE](LICENSE).
