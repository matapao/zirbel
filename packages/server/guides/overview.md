# Zirbel

Zirbel is a local editor, player and host for browser games. People make games in its editor, with its own agents or with you, play them on the same computer, and host them for others on their network. The games stay on that computer, or on a box.

This connection is for one game. Its grant names the project, and you reach that project and nothing else.

## Games

A game is a project. Each project has a title and a history of revisions, and each revision holds the whole game: a page, `index.html`, and for a game built as a folder, the files beside it (scripts, models, textures, sounds). How a game is laid out and what its page may do is in `zirbel://guide/game-format`; how to read and change its files over this connection is in `zirbel://guide/files`.

A few older projects started from a built-in template are a scene instead: a 960 by 600 world of objects that `read_scene` returns as `scene`, changed by `propose`'s scene operations. Everything else is a game page.

## Revisions

A revision never changes. A change makes a new revision whose parent is the one it started from, and moves a branch to it. `main` is the branch every project has; the editor can make more. A change is staged first as a proposal against a branch and the revision at its head, then applied, or discarded. History, branches, proposals and conflicts are in `zirbel://guide/revisions`.

## The editor

The editor runs on the owner's computer (or on a box, below) and is the owner's alone. In it they talk with agents in threads, play the game as it is now, compare a proposal with the current revision (Before and After) and apply or discard it, browse History, and share the game. Revisions come from the editor's own agents, from restores in History and from proposals like yours; importing a built folder makes a new project.

Sharing publishes a release: a fixed copy of one revision, with what others may do with it (play it, download it, remix it into a project of their own). Releases are what the lobby offers and what players play; a change you make reaches players only when the owner publishes a new release.

## The lobby and sessions

Every Zirbel host has a player side, apart from the editor. Its front page is the lobby: the games the owner offers there, and the sessions being played. Anyone who reaches it may start a session of an offered game. A multiplayer session gets a short code of four letters and digits, and others join it by typing the code; the lobby lists the sessions but never their codes. The lobby keeps up to 16 sessions open, and up to 3 started from one address.

A game for one player is played alone in its session. A game for several players shares state through the host (up to 4 players), or brings its own netcode over the host's relay (up to 16): see `zirbel://guide/game-format` and `zirbel://guide/multiplayer`.

## A box

A Zirbel box is a small computer that runs Zirbel for a home or a room, with the editor on its network address instead of only on its own loopback.

- **Players** are anyone on the box's network. A device that isn't paired is sent to the lobby, where it starts sessions of the offered games and joins sessions by their codes. Players need no pairing and never reach the editor.
- **Owners** use devices paired with the box, with a one-time code from the box (or, for a new box, by claiming it first). They use its editor as on a computer: they make and change games, publish them, offer them in the lobby and give agents grants. Only owners use the box's own agents, which run on the owner's accounts. In Box settings the owner chooses what the box allows, including whether agents elsewhere on its network may use MCP at all (external MCP access, off until it is turned on).
- **Editors** of one game redeem that game's edit code, which an owner makes and shares (`/edit` on the box). They edit that game alone, and their changes go straight into it as new revisions. They can't see other games, publish, offer in the lobby, open Box settings or use the box's agents. While external MCP access is on, an editor can give their own agent (Claude Code, Codex) a grant for their game: that is how an agent on someone else's computer works on a box's game.

None of this changes what your grant allows.

## What a grant allows

A grant is a bearer token for one project, made in the editor (a game's More menu, Agent access, or Box settings on a box; on a box an editor of one game can make one for that game). It lasts from 1 hour to a week, and the owner can revoke it at any time; a revoked or expired grant gets the same refusal as a wrong one. Send it as `Authorization: Bearer <grant>` to the editor's `/mcp`.

| Tool | Grant | Does |
| --- | --- | --- |
| `read_project` | any | The project's id, title and branches, each with its head revision. |
| `read_scene` | any | A branch head's revision: its id and label, the game (`html`, `maxPlayers`, `net`, `registerObjects`, and `files`, each path with its SHA-256), the imported assets, and an older project's scene. |
| `list_revisions` | any | The revisions' ids (commit hashes), parents, labels, dates and authors, and what a restore restored. |
| `read_file` | any | One of the game's files by its path. |
| `write_files` | any | Stages a proposal that writes or removes files by path. |
| `propose` | any | Stages a proposal of operations: `writeGame` with a whole page for a game without files, `addAsset` and `removeAsset`, and an older project's scene operations. |
| `preview_proposal` | any | A staged proposal's candidate revision. |
| `apply_proposal` | write | Applies a staged proposal as the branch's next revision. |

The game is also a git repository at the editor's `/git/<project>.git`, which any grant clones and fetches with its token as a bearer token (`git -c http.extraHeader="Authorization: Bearer <grant>" clone …/git/<project>.git`). A grant with write may push to the game's branches: a push that leaves a game the editor can keep becomes the branch's next revision, and anything else is refused.

A grant without write proposes: what you stage waits in the editor until the owner applies or discards it. A grant with write may also apply, so a change goes straight in. No grant reaches other projects, the editor's other parts (releases, the lobby, settings, the editor's agents), credentials or the files of the computer it runs on, and none publishes, restores, discards or makes branches: those are the owner's, in the editor.
