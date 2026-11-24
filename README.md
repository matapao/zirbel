# Zirbel

Author, play and host web games locally. Describe a game in Activity and a harness (Codex or Claude Code) writes it. Zirbel stores each revision, runs the game in a sandboxed player, and can host it for LAN guests.

## Run

Needs Node 24 (`.nvmrc`) with pnpm (`corepack enable pnpm`), Go 1.27 for the native host, and the two `link:` dependencies in `package.json` built in sibling checkouts (`pnpm install --frozen-lockfile && pnpm build` in each; CI pins their revisions).

```sh
pnpm install --frozen-lockfile && pnpm test   # install, build, unit and contract tests
pnpm lint && pnpm check:go && pnpm check:security && pnpm coverage
pnpm start --open                             # editor at http://127.0.0.1:4173/
```

`pnpm build:host && host/bin/zirbel-host --open` runs the same editor natively, without Node. It has no harness chat yet, so use an MCP agent there: start it with `--enable-mcp` and connect over loopback `POST /mcp` with a project grant, or over stdio with `node dist/server.mjs mcp` and `ZIRBEL_MCP_TOKEN`. Projects live in `~/.zirbel`. Override with `--data DIR` or `ZIRBEL_DATA`. Harness credentials live outside the data dir (`ZIRBEL_ACCOUNT_DIR` overrides). `node dist/server.mjs --help` lists every flag.

## Use

- **Projects…** opens or creates a project. **Library** imports `.zirbel-project.json` files (samples in `examples/`). **Remove…** moves one to `removed-projects/`; published releases stay.
- **Activity**: pick a harness and **Model**, then describe the game or edit. A turn gets one hour of active runtime. **Stop turn** cancels it.
- **Source** shows the HTML, CSS and JS. In Edit mode you can change it and save a revision.
- **Share → Development multiplayer** opens an invite-only LAN room pinned to the saved revision (up to 4 players, if the game declares it).

## Game API

A revision is one HTML document. Module scripts can `import * as THREE from 'three'`. The sandbox provides:

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
