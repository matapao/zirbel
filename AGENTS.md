# AGENTS.md

Zirbel: local web-game editor, player and host. TypeScript ESM on Node 24 (esbuild), plus a native Go host in `host/`. No framework.

## Commands

```sh
git submodule update --init && pnpm run deps  # check out and build the two submodule dependencies
pnpm install --frozen-lockfile && pnpm test  # build + node:test unit tests (must pass)
pnpm check               # tsc --noEmit, strict
pnpm lint                # oxlint --type-aware + knip + the 500-line limit, must pass
pnpm check:go            # gofmt, vet, golangci-lint, deadcode, nilaway, stdlib-only, go test -race; --live adds govulncheck
pnpm check:security      # lockfile, hidden characters, licences, Betterleaks, zizmor, actionlint, hadolint; --live adds OSV-Scanner, Semgrep
pnpm coverage            # thresholds: Node 80/70/75% lines/branches/functions, Go 65% incl. contract tests
pnpm format:check        # Prettier (.prettierrc.json); report-only in CI until the one-time reformat
pnpm contracts           # regenerate contracts/*.schema.json from the Zod schemas (CI runs it with --check)
pnpm build:host          # embed dist/web into the Go host binary (host/bin/)
pnpm test:browser        # Playwright e2e (first: pnpm exec playwright install chromium)
pnpm test:pi             # the box's Wi-Fi setup service's unit tests (python3, no hardware); part of pnpm test
```

The two `link:` dependencies in `package.json` are submodules in `deps/`, pinned to the commits this repository records; `pnpm run deps` installs and builds them, and Dependabot proposes updates. Type errors in `harness-activity.ts` or `local-harnesses.ts` usually mean the submodules are not at those commits (`git submodule update --init`, then `pnpm run deps`).

## Layout

| Path | Role |
| --- | --- |
| `packages/sdk` | Zod contracts, file formats, room protocol, browser client |
| `packages/core` | Project revisions, release validation, room state; `relay.ts` the relay a net-v2 room runs (seats, routing, the host role, away seats); `lobby.ts` the lobby: the releases the owner offers (`lobby.json` in the data dir), session codes, its limits and wrong-code counts |
| `packages/net` | zirbel-net, the earlier Zirbel's multiplayer client (MIT), for games with their own netcode: the build bundles `index.ts` to `dist/web/zirbel-net.js`, which every player listener serves as `/zirbel-net.js`; `protocol.ts` the wire format (v2), `README.md` how a game uses it |
| `packages/server` | `cli.ts` launcher. `main.ts` editor API and MCP; `chat-routes.ts` harness chat over HTTP, `chat-runs.ts` the turns the editor owns and streams, `threads.ts` each thread's folder and session in the account dir, `thread-turns.ts` one turn in its thread, `turn-folder.ts` the folder's game/ written and read back, `turn-tools.ts` what its node_modules links to, `turn-mcp.ts` each turn's own MCP server with `view_game` (`view-game.ts`, rendered by `browser-app.ts` in the desktop app or `browser-cdp.ts` in an installed Chrome), `local-harnesses.ts` the harness library's agents (`claude-sdk.ts` fetches Claude Code's SDK on first use for an editor installed without it), `activity-log.ts` keeps each turn's steps as they come. Box mode (`--box`): `box-routes.ts` its door and API, `box-pairing.ts` codes and paired devices (its owners), `box-editors.ts` each game's edit code and the sessions of its editors, `box-edit-routes.ts` the `/edit` page and the owners' API for codes and editors, `box-roles.ts` the routes an editor of one game may use, `box-page.ts` the door's pages' form and headers, `box-settings.ts` its switches and capabilities, `box-network.ts` the box's own Wi-Fi (its name and password as the setup service keeps them, and the wake for its switch). `host.ts` + `hosting.ts` headless host and listeners. `player-listener.ts` player HTTP and WebSocket, `relay-socket.ts` the relay's WebSocket at `/mp`, `lobby-routes.ts` the lobby on every player listener (its page at `/`, its API at `/lobby/`) |
| `packages/web` | Workspace UI (`turn-runner.ts` follows and re-attaches to turns, `box.ts` a box's first-run choice and Box settings, with its own Wi-Fi, `editors.ts` a game's Invite editors… and an editor's own agent), player, the lobby page (`lobby.ts`, built apart from the release runtime), QR codes drawn in the page (`qr.ts`, for the lobby and the editor's `lobby-address.ts`: the Lobby… dialog and Box settings' Players), sandboxed game SDK (`game-sdk.ts`) |
| `packages/games` | Runtimes for older scene-based projects |
| `public/` | Static HTML and CSS, copied into `dist/web` |
| `contracts/` | Generated JSON Schemas (do not edit) and the Go loader that validates against them |
| `host/` | Go host: `projects.go` store, `editor.go` API, `mcp.go`, `package.go` releases, `release.go` import checks, `rooms.go`, `listener.go` player, `relay.go`, `relay_socket.go`, `relay_wire.go` the zirbel-net relay at `/mp`, `lobby.go`, `sessions.go` (codes and limits) and `lobby_routes.go` the lobby; box mode in `box_routes.go`, `box_pairpage.go`, `box_pairing.go`, `box_settings.go`, `box_network.go` and `account.go` |
| `desktop/` | Electron app, a pnpm project with its own lockfile: `src/main.ts` window and hardening, `editor.ts` starts and stops `dist/server.mjs` (which ends with the app through its IPC channel), `routes.ts` where pages may go, `view-game.ts` renders games for the editor's `view_game`, `bluetooth.ts` the chooser for a box to set up, `scripts/pack.mjs` packs it for macOS. Its `typecheck`, `lint` (this repo's oxlint config) and Playwright `test` run in `desktop/` after `pnpm build` here |
| `pi/` | The Zirbel box on a Raspberry Pi. `image/build.mjs` builds its image from Raspberry Pi OS Lite (arm64 with the Node editor and harnesses, armhf with the Go host). `setup/` its Wi-Fi setup service (Python, stdlib with the system's D-Bus bindings): Improv Wi-Fi over Bluetooth (`improv.py`, `bluetooth.py`), a setup hotspot with its page (`portal.py`, `network.py`), the box's own Wi-Fi, a WPA2 access point phones join to play, its password made once and kept in `/var/lib/zirbel-setup` for the editor's group alone (`own_network.py`; the service alone changes the Wi-Fi, following the editor's `ownNetwork`), when it runs (`policy.py`, including a reset from the card: an empty `zirbel-reset-wifi` file on the boot partition makes the box forget its networks and go to setup at the next boot), and the systemd and NetworkManager files the image installs; `test_*.py` beside it (`pnpm test:pi`). The editor's side is `packages/web/improv.ts` and `box-setup.ts` |
| `scripts/` | `build.mjs` (dist), `build-host.mjs` (Go binaries), `contracts.ts` (schemas) |
| `test/` | `projects`, `rooms`, `mcp`, `harness`, `threads`, `turn-folder`, `view-game`, `parent`, `claude-sdk`, `box`, `box-editors`, `improv`, `activity`, `ask-summary`, `chat-control`, `relay`, `relay-socket` and `lobby` `.test.ts` unit; `host.contract`, `lobby.contract`, `editor.contract` + `box.contract` run on both hosts; `browser.mjs`, `browser-workspace.mjs`, `browser-turns.mjs`, `browser-folder.mjs`, `browser-box.mjs` + `host-browser.ts` e2e (`browser-editor.mjs` starts `fixture-editor.ts`, the editor with a fake harness). Go unit tests sit beside the code in `host/` and `contracts/` |

## Rules

- Validate all external input with the Zod schemas in `packages/sdk/contracts.ts`. Keep the existing size limits (48 MB files, 512 inspector entries).
- Keep the trust boundary. The editor and MCP bind to loopback only, except in box mode (`--box`): there a request from the box's own network needs a paired device's session (an owner's), or an editor's session from a game's edit code, which reaches that one game's routes alone (`box-roles.ts`), `/pair` and `/edit` aside, and `/mcp` answers it only while external MCP access is on, with a project grant. Game HTML runs in an opaque-origin sandbox with a CSP and never gets editor APIs, credentials or other projects; a net-v2 game also reaches its host's `/zirbel-net.js` and relay `/mp`, which seats a connection only with its room's document key. LAN guests reach the lobby (offered games, sessions without their codes, starting a session of an offered game, joining one by its code) and the rooms they hold a seat or link for; never the editor, other projects, credentials, or a session's code through the lobby.
- Never write credentials into the project data dir or the repo. Account files go in the per-user account dir; the box's own Wi-Fi password is the setup service's, outside both.
- `host.ts`, `hosting.ts` and everything they import must not import editor code (harnesses, MCP). That keeps `--host-only` small for low-memory hosts.
- Player and editor behaviour lives in both hosts. Change both; `test/editor.contract.test.ts` requires identical normalized responses. Harness chat is Node-only for now. The relay (`/mp`, zirbel-net protocol v2) and `/zirbel-net.js` run in both, held together by `test/host.contract.test.ts`; the lobby too, by `test/lobby.contract.test.ts`. Box mode runs in both, held together by `test/box.contract.test.ts`; the Go host's box runs no harnesses.
- `game-sdk.ts` runs in every game frame. Keep it free of Zod and use `sdk/bounded.ts`.
- Pin exact dependency versions, each at least a week old (pnpm-workspace.yaml). Run `pnpm check:security --live` after changing them; CI adds `pnpm audit`.
- Go is standard library only (`check:go` fails on any module dependency). Tools run through `go run tool@version`.
- No hand-written file over 500 lines; split by responsibility. The editor shares state through `ws` in `packages/web/state.ts`.
- Keep changes small, typed (`strict`, `noUnusedLocals`) and covered by a test in `test/`.
- `dist/` is generated. Don't edit it.
