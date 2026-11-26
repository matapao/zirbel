// What the project MCP server tells an agent about working with Zirbel, so the agent needs no skill of its own: a short
// orientation when it connects (initialize's instructions), and guides it reads as resources. The guides' text is in
// files: Zirbel's own in packages/server/guides, and the multiplayer skill and zirbel-net's README as they are. The
// build puts them together in <web>/mcp-guides/<name>.md (scripts/build.mjs), and both hosts serve those bytes; this
// catalogue goes to the Go host in contracts/mcp-tools.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKDOWN = 'text/markdown';
const guide = (name: string, title: string, description: string) =>
  ({ uri: 'zirbel://guide/' + name, name, title, description, mimeType: MARKDOWN });

/** The guides, in the order to read them. */
export const guideResources = [
  guide('overview', 'Zirbel overview', 'What Zirbel is: games, revisions, the editor, the lobby and its sessions, a box, and what this grant allows.'),
  guide('game-format', 'Game format', 'A game as a folder: index.html and the files beside it, zirbel.json, players, the sandbox it runs in and window.zirbel.'),
  guide('files', 'Reading and writing files', 'How to download the game’s files and stage changes to them with read_file and write_files.'),
  guide('revisions', 'Revisions and proposals', 'History, branches, proposals and changes applied straight in, and what to do when the branch has moved on.'),
  guide('multiplayer', 'Multiplayer', 'The skill for making a game multiplayer with a thin adapter over zirbel-net, and how to do it over this connection.'),
  guide('net-api', 'zirbel-net API', 'The zirbel-net client’s API: connecting, events, sending, and playing alone.'),
];

const orientation = 'Zirbel is a local editor, player and host for browser games. This connection reaches one game, the ' +
  'project its grant names, and nothing else. Read zirbel://guide/overview first, then zirbel://guide/game-format and ' +
  'zirbel://guide/files before you change anything; zirbel://guide/revisions explains history and conflicts, and ' +
  'zirbel://guide/multiplayer games for several players. Every change is staged as a proposal against the branch’s ' +
  'current revision (its baseRevision), with propose or write_files.';

/** initialize's instructions, by the grant: one that only proposes, and one that may also apply. */
export const instructions = {
  propose: orientation + ' This grant reads and proposes: what you stage waits in the editor until the game’s owner ' +
    'applies or discards it.',
  write: orientation + ' This grant may also apply: apply_proposal makes a staged proposal the branch’s next revision ' +
    'straight away.',
};

/** The guides' text by URI, from the build (dist/web/mcp-guides). A build without them stops the editor. */
export function readGuides(webRoot: string): ReadonlyMap<string, string> {
  return new Map(guideResources.map(({ uri, name }) => {
    try {
      return [uri, readFileSync(join(webRoot, 'mcp-guides', name + '.md'), 'utf8')];
    } catch {
      throw new Error('The editor is missing mcp-guides/' + name + '.md; run `pnpm build`.');
    }
  }));
}
