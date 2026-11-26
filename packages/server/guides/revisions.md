# Revisions, branches and proposals

## History

A project's history is its revisions. Each holds the whole game as it was, and never changes. `list_revisions` lists them, oldest first:

- `id`: the revision's id;
- `parent`: the revision it was made from (`null` for the first);
- `label`: what changed, as History shows it;
- `date`: when it was made;
- `restoredFrom`: for a restore, the earlier revision it brought back.

Revisions come from proposals applied (yours, or the editor's own agents'), and from restores: in History the owner can bring back any earlier revision, which makes a new revision with the earlier one's content on top of the current one. Nothing is lost; an earlier file is always there for `read_file` with its `revision`.

## Branches

A branch names a revision, its head. Every project has `main`; `read_project` lists the branches with their heads. The owner makes a new branch in the editor by applying a proposal to it ("Apply to a new branch" in History) and switches between branches there. Every tool that reads or stages takes a `branch` (`main` unless you say), and you can stage on any branch the project has; you can't make one.

## Proposals

Every change starts as a proposal: a change against one branch and the revision at its head when you made it, its `baseRevision`. `write_files` and `propose` stage one; `preview_proposal` shows the game as it would be. Staging changes nothing yet.

Applying a proposal makes a new revision, its parent the base, and moves the branch to it. Who applies depends on the grant:

- **A grant without write proposes.** Your proposal waits in the editor, on a card in the project's thread: the owner switches the running game between Before and After, then applies or discards it. Several proposals on one head show as options to choose between. The owner may also apply one to a new branch, keeping the current one as it is.
- **A grant with write applies straight in.** `apply_proposal` applies a proposal at once, on its branch, and answers `{ "revision", "branch" }`. Apply only what the person you work with wants in the game.

Up to 50 proposals can wait on one branch head. A proposal can be applied once; after that, or once the branch has moved on, it stays out of the editor's view.

## When the branch has moved on

A proposal applies only while its base is still the branch's head. If anything lands first (another proposal applied, a turn of the editor's own agents, a restore), staging, previewing or applying it answers:

> The branch has changed. Request a new proposal against its current revision.

Nothing was changed. To carry your change over:

1. `read_scene` (or `read_project`) for the branch's new head, and `list_revisions` to see what came in between.
2. `read_file` again, at the new head, every file you changed: someone else may have changed it too.
3. Make your change again on those files, keeping what the new revision brought, and stage it with the new head's id as `baseRevision`.

Never send back files you read from the old revision as they were: that would undo whatever came in between. Proposals don't merge: each replaces the files it names, whole.
