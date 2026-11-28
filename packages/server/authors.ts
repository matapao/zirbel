// Who a commit the host makes names as its author: the person or agent who asked (AGENTS.md: The git store). Zirbel itself is
// every such commit's committer.
import { ident, OWNER, type Ident } from '../core/git.ts';
import type { Access } from './box-routes.ts';

/** The machine the editor runs on (on a box, the box itself), a box's paired device, or an editor of one game. */
export function authorOf(access: Access): Ident {
  if (access.editor) return ident(access.name ?? 'Editor', 'editor.' + access.editor.id + '@zirbel.invalid');
  if (access.device) return ident(access.name ?? 'Owner', 'device.' + access.device + '@zirbel.invalid');
  return OWNER;
}

/** An agent with a project grant, over MCP or git. */
export const grantAuthor = (grant: string) =>
  ident('MCP grant ' + grant.slice(0, 8), 'grant.' + grant + '@zirbel.invalid');

/** One of the editor's harnesses, in a turn. */
export const harnessAuthor = (processor: string, name: string) =>
  ident(name, 'harness.' + processor + '@zirbel.invalid');
