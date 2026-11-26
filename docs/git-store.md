# Git as Zirbel's revision engine

Every game on a host is a bare git repository, every save is a commit, and the editor's listener is a git remote that
clients clone from and push to. Clients without git keep using the editor and MCP; the host commits for them. Both
hosts implement this document; `test/git.contract.test.ts` holds them to it, and `test/editor.contract.test.ts`,
`test/mcp.contract.test.ts` and `test/box.contract.test.ts` compare them as before. The Node host is the reference:
`packages/core/git.ts` (running git), `git-tree.ts` (a tree and the revision it holds), `history.ts` (a project's
history and heads), `projects.ts` (the store), `migrate.ts` (old projects and bundles), `git-source.ts` (import from a
URL, update from source), and in `packages/server/` `git-http.ts` (smart HTTP), `git-tokens.ts` and `git-hook.ts`.

Git is run as the `git` program (2.38 or later: `merge-tree --write-tree`), never through a library. Every git the host
runs gets `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<null device>`, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_REPLACE_OBJECTS=1`
and `LC_ALL=C`, so none of the person's or the system's settings (credential helpers, `insteadOf`, hooks) apply.

## Storage

In the data directory:

| Path | What |
| --- | --- |
| `git/<project>.git/` | The project's bare repository (SHA-1 objects, `files` refs, `HEAD` → `refs/heads/main`). |
| `git/<project>.git/zirbel-sha256` | Optional cache: lines `<blob id> <sha256 of its bytes>\n`. Rebuilt by hashing when missing. |
| `projects/<project>.json` | The project's metadata, version 2 (below): everything that isn't the game's content. |
| `proposals/<project>.<proposal>.json` | A staged proposal, as before (`saved-proposal` schema); its commit is `refs/zirbel/proposals/<proposal>`. |
| `assets/<sha256>` | As before: the bytes of image assets and of every game file a revision the host has read lists, by SHA-256. |
| `migrated-projects/<project>.json` | The version-1 file a project was migrated from, kept. |
| `removed-projects/`, `archived-preview-projects/` | As before, now `<project>.json` with its `<project>.git` beside it. |
| `git-hooks/pre-receive` | Written at every start: runs the host's own push check (below). |

`projects/<project>.json`, version 2:

```json
{ "version": 2, "id": "…", "title": "…", "template": "mosslight", "notes": [], "attachments": [],
  "upstream": "<release>", "imported": true, "source": { "url": "https://…", "ref": "main" } }
```

`template`, `upstream`, `imported` and `source` are optional. Branches and revisions are git's alone. A project exists
while both its file and its repository do. A host reads a version-1 file only to migrate it.

### Refs

- `refs/heads/<branch>`: the branches. A branch name is an `id` (`^[a-z0-9][a-z0-9_-]{0,79}$`); other names are ignored.
- `refs/zirbel/proposals/<proposal>`: a staged proposal's commit, its parent the proposal's base.
- `refs/zirbel/source`: what an import from a URL or an update from source last fetched.
- `refs/zirbel/` is hidden from git clients (`transfer.hideRefs=refs/zirbel`), and can't be pushed to.

## A revision's tree

What a client sees after `git clone` is the game's folder:

| Path | What |
| --- | --- |
| `index.html` | The game's page (`game.html`: the blob decoded as UTF-8 and trimmed, 1–400,000 characters). |
| any other game path | A game file: a path `gameFilePath` takes (packages/sdk/game.ts), listed in `game.files` by its SHA-256. |
| `zirbel.json` | Optional, the game's own: read on every revision (below). It is a game file like any other. |
| `.zirbel/game.json` | The game document's own fields, written only when one differs from its default. |
| `.zirbel/scene.json` | An older scene project's scene (`scene` schema). |
| `.zirbel/assets.json` | The revision's imported assets (array of `asset`, at most 80). |
| `.zirbel/assets/<sha256>.<png\|jpg\|webp>` | Each asset's bytes. |
| anything else | Kept as it is (a README, `.gitignore`, `LICENSE`, `.github/`…), never served, never changed by the host. |

Zirbel writes each JSON file as JavaScript's `JSON.stringify(value, null, 2) + "\n"` writes it: two-space indent, keys
in the schema's order (the property order of `contracts/*.schema.json`), no HTML escaping (Go: `SetEscapeHTML(false)`),
numbers in their shortest round-trip form, non-ASCII as is. Both hosts must write the same bytes: the contract test
compares their trees and migrated commits. `.zirbel/game.json` holds `{ "maxPlayers"?, "net"?: true,
"registerObjects"? }` (in that order): `maxPlayers` when it isn't 1 and `net` when true, unless the game's `zirbel.json`
describes a net game (then neither), and `registerObjects` when the document has it. With none of them there is no file.

Reading a tree into a revision's content, the rules every host applies:

1. **Hard problems** (a push, an import, an update or a restore is refused; a revision read with one shows no content):
   more than 4,000 entries; a symbolic link or a submodule anywhere; more than 48 MB of blobs in all.
2. **The game**, when there is a regular `index.html` at the top: it must be UTF-8 and 1–400,000 characters trimmed; at
   most 1,000 game files besides it; `index.html` and the game files at most 36 MB together. `game.files` is present when
   there is at least one game file (a folder of `index.html` alone reads as a single-document game).
3. **Players** (spec: "a game's players, net and adapter are read from the zirbel.json in each revision's tree"): when
   the tree's `zirbel.json` describes a net game as `describedGame` reads one (an integer `players.max` above 1), it sets
   `maxPlayers` (at most 16), `net: true` and the `adapter` its `multiplayer.adapter` names, if that is one of the game's
   `.js`/`.mjs` files. Otherwise `.zirbel/game.json` does: `maxPlayers` (default 1; above 4 only with `net`), `net`.
   `registerObjects` comes from `.zirbel/game.json` either way.
4. **The scene**: `.zirbel/scene.json`, valid under `scene`.
5. **Assets**: `.zirbel/assets.json`, valid; each asset's bytes present at its path, matching its hash and media type.

A push, an import or an update needs a game (a scene project: a game or a scene). Problems are reported as one message,
the first found; the texts are `git-tree.ts`'s (`It holds links or submodules, which a game can’t: <paths>.`,
`index.html must be UTF-8 text.`, `.zirbel/game.json gives more than 4 players to a game without net.`, …).

Writing content over a base commit, the host changes only what it manages: `index.html`, every game path, and
`.zirbel/`; everything else stays. A game file whose SHA-256 is unchanged keeps its blob. Commits are written with
`git fast-import` (one run per commit; a migration in a run per stretch of revisions up to the next restore, whose
trailer needs its target's commit id), moved onto branches with `git update-ref --stdin`, whose old values make every
move compare-and-swap. A Go host may write trees with `mktree`/`commit-tree` instead: only the resulting objects count.

## Revision ids and the API

A revision's id is its full commit hash, 40 lowercase hex digits, which the `id` schema already takes. Revision ids in
requests (`baseRevision`, `target`, `revision`) are commit hashes; a UUID from before the migration names nothing (409 or
404 as for any unknown revision).

A commit read as a revision:

| Field | From |
| --- | --- |
| `id` | the commit hash |
| `parent` | its first parent, or `null` |
| `restoredFrom` | a `Zirbel-Restored-From: <commit>` trailer |
| `label` | the message's first line, trimmed, at most 120 code points; `Untitled revision` when empty |
| `date` | the committer date, ISO 8601 in UTC with `.000Z` |
| `author` | **new**: the author's name, trimmed, at most 120 code points; `Unknown` when empty |
| `scene`, `game`, `assets` | the tree, as above |

Keys are written in that order (`id, parent, restoredFrom, label, date, author, scene, game, assets`); a game document
as `html, maxPlayers, net, adapter, registerObjects, files`, `files` sorted by path. MCP answers carry these as JSON text,
so the order is part of the contract.

### What changes in the API

- **A project's `revisions`** (every route that answers a project: `GET /api/projects/:id`, create, import, restore,
  title, import-game, import-git, remix) list the history: the newest 200 commits reachable from the branches in
  topological order, given oldest first, with every branch head among them. Every entry has
  `id, parent, restoredFrom?, label, date, author`; **only branch heads also carry `scene`, `game` and `assets`**. A
  parent may be older than the list. (Before: every revision, each in full.)
- **New** `GET /api/projects/:id/revisions/:revision`: one revision in full. 404 for a commit outside the project's
  history. An editor of one game may use it.
- `revision` gains `author` (optional in the `project` and `project-bundle` schemas). Export (`GET …/export`) writes every
  revision reachable from the branches, in full, with their commit ids; import takes a bundle as before (ids are
  replaced by the new commits'), and drops `source`.
- Project summaries, `branches`, proposals, apply, restore and the 409 for a stale base keep their shapes.
- `preview` in a proposal's answers is the staged commit read back: `{ scene?, game?, assets }`.
- `list_revisions` (MCP) adds `author` to each entry.
- A project has `source: { url, ref? }` after an import from a URL.
- **New** `GET /api/projects/:id/clone`, `POST /api/projects/import-git`, `POST /api/projects/:id/update-from-source`
  (below), and `/git/<project>.git/…`.

## Commits and their authors

The committer of every commit the host makes is `Zirbel <zirbel@zirbel.invalid>`. The author is who asked:

| Who | Author |
| --- | --- |
| The machine the editor runs on (loopback; on a box, the box itself) | `Owner <owner@zirbel.invalid>` |
| A box's paired device | `<its label, e.g. Safari on iPhone> <device.<id>@zirbel.invalid>` |
| An editor of one game | `<the name it gave> <editor.<id>@zirbel.invalid>` |
| An MCP grant | `MCP grant <first 8 of its id> <grant.<id>@zirbel.invalid>` |
| A harness turn | `<the harness's name> <harness.<processor id>@zirbel.invalid>` |
| Migration | `Zirbel <zirbel@zirbel.invalid>`, with the revision's own date as author and committer date |

Names lose `<`, `>`, control characters and surrounding space. Commits pushed or imported keep their own authors.

The message is the label (line breaks as spaces), then, after a blank line, trailers: `Zirbel-Restored-From: <commit>`
for a restore, `Zirbel-Revision: <old id>` for a migrated revision.

### Every way a revision is made

| Path | Commit |
| --- | --- |
| New project, folder import, remix, a harness's first game | A root commit on `refs/heads/main` of a new repository. |
| Proposal (`POST …/proposals`, `asset`, MCP `propose`/`write_files`, a harness edit) | A commit on `refs/zirbel/proposals/<id>`, parent the base, the content applied as today (same checks, same 409s/422s). |
| Apply (`POST …/apply/:proposal`, `apply_proposal`, a harness edit applied) | `update-ref refs/heads/<branch> <proposal commit> <base>` (or create `<fork>`), deleting the proposal's ref, in one transaction. The revision is the proposal's commit. Its base no longer the head: 409 as before. |
| Discard | The proposal's file and ref go. |
| Restore, undo in chat | A commit with the target's tree exactly, parent the head, label `Restore <label>` (cut to 120), the trailer. The target must be reachable from a branch (404 otherwise) and read without problems (422). |
| Import of a bundle | One commit per revision, as migration does. |
| Import from a URL | The source's own commits; `main` at the fetched commit. |
| Update from source | A fast-forward, or a merge commit (below). |
| Push | The client's commits, checked before the ref moves. |

## Git over HTTP

On the editor's listener (loopback, or every interface on a box), smart HTTP only:

- `GET /git/<project>.git/info/refs?service=git-upload-pack|git-receive-pack`
- `POST /git/<project>.git/git-upload-pack`, `POST /git/<project>.git/git-receive-pack`

Anything else under `/git/` is 404. The host runs `git http-backend` as CGI (Go: `net/http/cgi`) with
`GIT_PROJECT_ROOT=<data>/git`, `GIT_HTTP_EXPORT_ALL=1`, `PATH_INFO`, `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`,
`CONTENT_LENGTH` (when sent), `HTTP_CONTENT_ENCODING`, `GIT_PROTOCOL` (from `Git-Protocol`), `REMOTE_ADDR`,
`REMOTE_USER` (the author's name), and these settings as `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`:
`http.receivepack=true`, `receive.denyNonFastForwards=true`, `receive.denyDeletes=true`, `receive.fsckObjects=true`,
`receive.maxInputSize=134217728`, `receive.autogc=false`, `transfer.hideRefs=refs/zirbel`,
`core.hooksPath=<data>/git-hooks`; and `ZIRBEL_GIT_GRANT=1` when a project grant pushes (the hook reads it). The
response is the CGI's (`Status:` and its headers, then the body). The Node editor caches a project's history keyed by
its branches' commits, so a push needs no notice. The editor's request timeout is 5 minutes, for a push over a slow
network; headers still have 10 seconds.

### Who may

| Request | May |
| --- | --- |
| Loopback (the editor's machine; on a box, the box itself) | Every game: fetch and push. No credentials. |
| A box's paired device with its git token | Every game: fetch and push. |
| An editor of one game with its git token | That game: fetch and push. Another game: 403. |
| An MCP grant as the token (box: while external MCP access is on, else 403) | Its game: fetch; push only with a write grant (else 403), and only to branches that exist. |
| Anything else from the box's network | 401 with `WWW-Authenticate: Basic realm="Zirbel", charset="UTF-8"`. |

Credentials are HTTP Basic (any user name, the token as password) or `Authorization: Bearer <token>`. A request with an
`Origin` must come from the editor's own origin. A project that doesn't exist is 404.

**Git tokens** (box mode) are derived, so the editor can show one again at any time and both hosts agree on it: the
account folder keeps a secret, `box/git-secret` (64 hex digits and a newline, mode 0600, made on first use), and a token
is `<kind>.<holder id>.<mac>`, where kind is `o` (a paired device) or `e` (an editor), and mac is the unpadded base64url
of HMAC-SHA256(secret, `"zirbel-git-token\n" + kind + "\n" + holder id`). A token works while its device is paired or its
editor's session lasts; removing the device or the editor ends it. An MCP grant's token is `<grant id>.<secret>`.

`GET /api/projects/:id/clone` answers `{ url, command, token? }`: `url` is
`http://<the host name the request came by>:<port>/git/<id>.git`; on loopback `command` is `git clone <url>`; for a
paired device or an editor, `token` is its git token and `command` is `git clone http://zirbel:<token>@…/git/<id>.git`.
An editor of one game may use it for its game.

### Push check

`<data>/git-hooks/pre-receive` runs the host's own check before any ref moves (Node: `node dist/server.mjs git-hook`; Go:
`zirbel-host git-hook`). It reads `<old> <new> <ref>` lines and refuses the whole push (exit 1, the reason on stderr,
which the client shows as `remote:`) unless every update:

1. is to `refs/heads/<id>` (`<ref>: Zirbel takes branches alone, named in lowercase letters, digits, - and _.`);
2. is no deletion (`<branch>: a branch isn’t deleted by a push.`), makes no branch when a grant pushes
   (`<branch>: a project grant pushes to the game’s branches, and makes none.`), and, for a branch that exists, is a
   fast-forward (`merge-base --is-ancestor old new`; `<branch>: it has moved on. Pull, then push again (history isn’t
   rewritten).`);
3. ends at a commit whose tree reads without problems (`<branch>: this isn’t a game Zirbel can keep. <problem>`) and
   holds a game, a scene project a game or a scene (`<branch>: there is no index.html at its top: a game needs one.`).

Git's own settings refuse some of these first (`denying non-fast-forward`, `deny deleting`, a hidden ref); the client
sees either.

It reads the pushed objects in receive-pack's quarantine (the environment git gives the hook), so a refused push leaves
nothing behind. The project comes from the repository's directory name, the data directory from its parent's parent.

## Import from a URL, update from source

`POST /api/projects/import-git { url, ref? }` → 201 with the project. Owners only. `url`: `https:` with a host, no user
name, password, query or fragment, at most 2,048 characters. `ref`: a branch or tag name,
`^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$` without `..`, `//`, `@{`, a trailing `/`, `.` or `.lock`; without one, the
remote's default branch. The host fetches into a new bare repository:

```sh
git -c protocol.allow=never -c protocol.https.allow=always -c credential.helper= \
  fetch --no-tags --no-recurse-submodules --quiet <url> +<ref or HEAD>:refs/zirbel/source
```

with a 120-second limit (504) and the repository's size checked as it grows (192 MB at most: 413); a fetch that fails
is 502 `The source could not be fetched: <git's reason>`. It holds no outside credentials and never pushes outside. The
fetched commit must read as a head does (422 `This repository isn’t a game Zirbel can keep. <problem>`); `main` is set
to it, the project's title is the URL's last path segment without `.git` (`Imported game` when none), and `source` keeps
`url` (as `new URL(url).href` writes it) and `ref`. A bad URL or ref is 400. With
`ZIRBEL_GIT_ALLOW_LOCAL=1` in the host's environment (tests only), `file:` URLs and `http://127.0.0.1` or `localhost`
are taken too.

`POST /api/projects/:id/update-from-source { branch?: "main", baseRevision }` → `{ updated, project }`. Owners and the
game's editors. 409 when `baseRevision` isn't the head; 404 for a game without a source. The host fetches the source again
into `refs/zirbel/source`, then:

- the source's commit is already in the branch's history: `updated: false`;
- the branch's head is in the source's history (no own commits since): a fast-forward to it;
- else a merge, the host's commits kept on top as the first parent: `git merge-tree --write-tree -z --name-only <head> <source>`;
  a clean tree is checked as a push is and committed with parents `<head> <source>`, label `Update from source`, author
  who asked. A conflict is 409 naming the files (`The source's changes conflict with this game's in: …`), and nothing
  moves; unrelated histories are 409 as well. The merge is not a rebase: the host's revision ids stay what clients and
  releases hold.

## Migration

At the editor's start, before it listens, for every `projects/<id>.json` of version 1 (after the legacy previews are
archived, as before):

1. copy the file to `migrated-projects/<id>.json` (unless a copy is there already);
2. build `git/<id>.git` from scratch in `git/<id>.git.migrating`: one commit per revision in the file's order, parent
   its parent's commit, the revision's date as author and committer date, author Zirbel, the label as message with
   `Zirbel-Revision: <old id>` (and `Zirbel-Restored-From` mapped); the branches; for each pending proposal of the
   project, its commit on `refs/zirbel/proposals/<id>` and its file's `baseRevision` mapped;
3. rename it to `git/<id>.git` (replacing an unfinished one);
4. map the notes' `references[].revision`, then write the version-2 file. That write is the migration's commit point:
   a start that finds a version-1 file again does it all again, and one that finds version 2 leaves it.

## A host without git

The editor checks `git --version` before it starts and refuses to start, exit code 1, with the message on stderr:
`Zirbel needs git 2.38 or later to keep its games' history (found …). Install git and start Zirbel again.` The desktop
app shows that line. `--host-only` serves releases alone and doesn't need git. The Pi image installs git on both
architectures.

## The contract cases a host makes pass

`test/git.contract.test.ts`, for each host:

- `<host> editor saves become commits, which a clone sees`: proposals applied and a restore as commits (ids, parents,
  authors `Owner <owner@zirbel.invalid>`, committer Zirbel, the restore's trailer); history with the head alone in full,
  `GET …/revisions/:revision`, 404 for an unknown one; `GET …/clone`; `ls-remote` shows `HEAD` and `refs/heads/main`
  alone while a proposal waits; the clone's files (`.zirbel/game.json` byte for byte); an imported folder's files at the
  top.
- `<host> takes a push of a game as its head and refuses anything else`: a push becomes the head (label, author, files,
  a README kept out of the game); a new branch; refused: no `index.html`, a symbolic link, more than 4 players without
  net, a forced non-fast-forward, a deletion, a branch name that isn't an id, a tag, a hidden ref; the dumb protocol and
  an unknown game are 404.
- `<host> imports a game from a git URL and updates it from its source` (with `ZIRBEL_GIT_ALLOW_LOCAL=1`): the import
  (title, source, history, files); 400 for http, credentials, ftp or a bad ref, 502 for a missing ref or repository, 422
  for a repository without a game; updates: up to date, stale base 409, fast-forward, merge under a pushed host commit
  (parents, label, author, net from the host's `zirbel.json`), a conflict 409 naming `index.html` with nothing moved, a
  game without a source 404. Without the switch, `file:` is 400.
- `<host> migrates the version-1 projects of its data folder at start-up`: the fixtures and a game with history,
  branches, a restore, assets, a pending proposal and a note; the old files kept; the same commits after a restart.
- `<host> editor refuses to start without git, and says so`: exit code 1, the message above.

And with both hosts: `both hosts write the same trees for the same games`, `both hosts migrate a data folder to the same
commits`. `test/git-box.contract.test.ts`: `<host> box serves git by role and token` (loopback without credentials; the
401 challenge; a paired device's token for every game; an editor's for its game alone, 403 for another; grants: 403
while external MCP access is off, fetch with any, push with a write grant to existing branches only; tokens end with
their device or editor; every push's author). The editor, MCP and box contract tests compare both hosts as before, with
commit ids normalized like other generated ids.
