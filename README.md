# Zirbel

Author, play and host web games locally. Describe a game and a harness (Codex or Claude Code) writes it. Zirbel stores each revision, runs the game in a sandboxed player, and can host it for LAN guests.

## Run

Needs Node 24 (`.nvmrc`) with pnpm (`corepack enable pnpm`), Go 1.27 for the native host, and the two `link:` dependencies in `package.json`, which are submodules in `deps/`: clone with `--recurse-submodules` (or run `git submodule update --init`), then `pnpm run deps` builds them.

```sh
pnpm install --frozen-lockfile && pnpm test   # install, build, unit and contract tests
pnpm lint && pnpm check:go && pnpm check:security && pnpm coverage
pnpm start --open                             # editor at http://127.0.0.1:4173/
```

`pnpm build:host && host/bin/zirbel-host --open` runs the same editor natively, without Node. It has no harness chat yet, so use an MCP agent there: start it with `--enable-mcp` and connect over loopback `POST /mcp` with a project grant, or over stdio with `node dist/server.mjs mcp` and `ZIRBEL_MCP_TOKEN`. Projects live in `~/.zirbel`. Override with `--data DIR` or `ZIRBEL_DATA`. Harness credentials live outside the data dir (`ZIRBEL_ACCOUNT_DIR` overrides). `node dist/server.mjs --help` lists every flag.

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

Its windows are sandboxed, with context isolation and no Node or preload. The editor's window stays on the editor's origin, playtests open in windows of their own on loopback player origins, other web links open in the system browser, and pages get no permission but fullscreen. The packed app runs your own Codex through the Codex SDK. Claude Code's SDK is under Anthropic's terms and is not bundled, so use Claude Code from a checkout (`pnpm start` in `desktop/`) or the web editor. Quitting while a turn runs asks first, and the editor the app started always ends with it. A distributable build (`node scripts/pack.mjs` without `--dir`) needs a Developer ID and notarization credentials.

## Use

The game runs in the middle, playable, with its thread beside it. Before a game exists, the editor shows one prompt.

- **The game's title** at the top left switches games, starts a **New game** and opens the **Library**, which imports `.zirbel-project.json` files (samples in `examples/`) and built game folders. **Remove…** moves a project to `removed-projects/`; published releases stay.
- **The thread**: pick a harness and **Model**, then describe the game or a change. Each turn shows the harness's tool calls, file edits, messages and requests inline, with the current step and the time it has run. The Node editor keeps each turn's steps in `activity/` in the data directory as they come. A thread keeps one working folder and one harness session in the account folder (`turns/`), so each turn continues where the last one left off; they go when the project is removed. A turn belongs to the editor: closing the window leaves it running, and opening the thread again shows it where it is. Only **Stop** ends it. A turn the editor was running when it ended shows **Interrupted**, and **Continue** resumes it.
- **Edit** (or the E key) shows the editing tools on the running game: the object list to mark objects for chat, the **Source**, which you can change and save as a revision, and the scene tools of a template scene. A click into the game ends Edit.
- A change staged for review is a card in the thread: **Before** and **After** switch the running game, then **Apply** or **Discard** it. **⋯ → History** switches branches, applies a proposal to a new branch and restores revisions.
- **Assets** lists the imported images and imports another. **Share → Development multiplayer** opens an invite-only LAN room pinned to the saved revision (up to 4 players, if the game declares it).

## Game API

A revision is one HTML document, or a built web folder imported with its files. Module scripts can `import * as THREE from 'three'`, and three.js's addons from `three/addons/...` (for example `three/addons/loaders/GLTFLoader.js`); the host serves both from its own build, with the Draco, Basis and meshopt decoders the addons load. Every game gets the same sandbox: WebAssembly, workers, and `data:` and `blob:` URLs, but no network. The sandbox provides:

| API | Purpose |
| --- | --- |
| `zirbel.register(id, props)` / `unregister(id)` | Show or update an object in the inspector (max 512 entries, 4096 chars each) |
| `zirbel.assets[id]` | Data URL for an imported image |
| `zirbel.send(state)` | Share this player's JSON state |
| `zirbel.onRoom(cb)` | Get seat, room seats and state per seat. Returns an unsubscribe function |

## Host

Edit on a laptop, export a release, and host it anywhere. The Node and Go hosts are interchangeable on one data directory; the contract tests in `test/` run against both.

```sh
pnpm build:host linux/arm64            # native Go host for an os/arch[/arm] target -> host/bin/
zirbel-host --host-only --lan --data DIR --import release.json --release ID
node --max-semi-space-size=2 dist/server.mjs --host-only --lan ...   # same flags on Node
```

The Go host is one static binary with the player files embedded, so it needs no Node. A release plays only on a host built from the same runtime. For Docker, build first, then `docker build -f Dockerfile.host .` (Go) or `docker build .` (Node), and run the image with `-p 4174:4174 -v DIR:/data --lan --player-host HOST`.

## Security

The editor and MCP listen only on loopback. Keep those ports and the data dir private. Game JS runs in an opaque-origin iframe, so only play games from creators you trust. LAN room links are secrets. End the room to revoke its link. Behind Docker port publishing every client looks private, so expose the port only on a trusted network. Report vulnerabilities privately through the repository's security advisories.

## License

MIT, see [LICENSE](LICENSE).
