# Reading and writing the game's files

Over this connection you read the game's files one at a time by their paths, change them where you work, and send back only what you changed, as one proposal. The format the files keep to is in `zirbel://guide/game-format`.

## Download the game

1. `read_scene` (optionally with `branch`, `main` unless you say) returns the branch head's revision. Keep its `id`: it is the revision you read, and the `baseRevision` your change will start from. Its `game` lists the files: `html` is `index.html`, and `files` maps every other path to its SHA-256.
2. For `index.html` and each path in `game.files`, call `read_file` with that `path` and `revision` set to the id. Naming the revision keeps every file from the same one, even if the branch moves on while you read.
3. Each answer is `{ "revision", "path", "size", "text" }` for a file that is UTF-8 text, and `{ "revision", "path", "size", "base64" }` for any other. `size` is the file's length in bytes. Write `text` as UTF-8, or decode `base64`, at the same path in a folder of your own, and you have the game as Zirbel keeps it.

`read_file` reads from the branch head when you leave `revision` out, and from any revision of `list_revisions` when you name it: that is how you bring back an earlier version of a file.

## Change it

Work in your folder, then send what changed with `write_files`:

```json
{
  "baseRevision": "<the revision id you read>",
  "branch": "main",
  "label": "Jump higher, and a new jump sound",
  "files": [
    { "path": "index.html", "text": "<!doctype html>…" },
    { "path": "assets/main.js", "text": "…" },
    { "path": "sounds/jump.ogg", "base64": "T2dnUwACAAAA…" },
    { "path": "sounds/old-jump.wav", "remove": true }
  ]
}
```

- Each entry writes a file as `text` (UTF-8) or `base64`, or removes it with `"remove": true`. Name each path once.
- Files you leave out stay as they are. A new path adds a file.
- `index.html` can be written, never removed. A project without a game yet needs it in the change.
- `label` (1 to 120 characters) is the revision's name in History: say what changed.
- Writing `zirbel.json` sets the game's players as an import reads it (`zirbel://guide/game-format`).
- A folder game keeps at least one file besides `index.html`.

`write_files` stages a proposal, and answers `{ "proposal", "preview" }`: the proposal's `id`, and the game as it would be. `preview_proposal` reads it again later. What happens next depends on the grant:

- **Without write**, the proposal waits in the editor, where the owner compares it with the current revision and applies or discards it. Tell the person you work with what you staged.
- **With write**, `apply_proposal` with its `proposalId` applies it at once, as the branch's next revision, and answers `{ "revision", "branch" }`.

A game that is one page, without files beside it, can also change with `propose` and a `writeGame` operation holding the whole page (and `maxPlayers` or `net`). `propose` refuses that for a folder game, since one page alone would drop its files: change a folder game with `write_files`. Writing a file beside `index.html` of a one-page game makes it a folder game.

The images in `zirbel.assets` are not files of the folder: they are imported in the editor with their author and licence, and `propose`'s `addAsset` can only reuse one this project already credits. A new image for the game goes in its folder, as a file.

## Limits

| What | Limit |
| --- | --- |
| One request to `/mcp` | 512,000 bytes of JSON, so about 380 KB of binary files as base64, or a bit under 500 KB of text |
| `index.html` | 400,000 characters |
| Files besides `index.html` | 1000 |
| The whole game | 36 MB, `index.html` included |
| Proposals waiting on a branch head | 50 |

A request over 512,000 bytes gets HTTP 413 and stages nothing. Send big files in calls of their own: with a write grant, apply each proposal before you stage the next on top of it; without one, every proposal starts from the same revision and the first one applied makes the others stale, so put a change in one proposal, or ask the owner to apply one before you stage the next. A game whose assets are too big for this is best imported again in the editor as a built folder.

This connection can't run the game. Check what you can where you work: a static web server on your folder plays it much as Zirbel does, if `three` and `three/addons/` resolve there; keep to the sandbox's rules in `zirbel://guide/game-format`, which a plain server doesn't enforce.

## When a change is refused

The tool answers with `isError` and a message, and stages nothing.

| Message | What to do |
| --- | --- |
| The branch has changed. Request a new proposal against its current revision. | The branch moved on since you read it: read it again and redo your change on it (`zirbel://guide/revisions`). |
| The game has no file at … | The path isn't in that revision: `read_scene` lists its files. |
| Name each file once: … | One path appears twice in `files`. |
| A game keeps its index.html: write it instead. | `index.html` can't be removed. |
| index.html must be UTF-8 text. / index.html must hold the game's page, at most 400,000 characters. | Fix the page: UTF-8, not empty, within the limit. |
| This project has no game yet: write its index.html too. | Add `index.html` to the change. |
| A game imported as a folder keeps at least one file beside index.html. | Keep or add a file besides `index.html`. |
| A game folder holds up to 1000 files besides index.html. / The game would be larger than a game can be (36 MB). | Remove or shrink files in the same change. |
| This game is a folder of files, which this change would drop. … | `propose` with `writeGame` on a folder game: use `write_files`. |
| Apply or discard pending proposals before staging more. | 50 proposals wait on this branch head: ask the owner to apply or discard some. |
