// A built-in starter nobody changed: a project an earlier editor made as a template's preview, which the store moves
// aside at start (archiveLegacyPreviews), before or after its migration.
import { isDeepStrictEqual } from 'node:util';
import type { Project, ProjectBundle } from '../sdk/contracts.ts';
import { starterScene, templates } from '../games/templates.ts';

/** Whether a project is still a template's starter as it was made: its one revision, its title and its introduction. */
export function isLegacyPreview(project: Project | ProjectBundle) {
  if (
    !project.template ||
    project.upstream ||
    project.imported ||
    project.attachments.length ||
    project.revisions.length !== 1
  )
    return false;
  const first = project.revisions[0];
  if (
    !first ||
    first.label !== 'Initial scene' ||
    first.parent !== null ||
    first.assets?.length ||
    first.game ||
    !isDeepStrictEqual(first.scene, starterScene(project.template))
  )
    return false;
  const builtInTitle = templates[project.template].title;
  const title = project.title;
  if (!project.notes.length) return title === (project.template === 'blank' ? 'Untitled project' : builtInTitle);

  const introduction = project.notes.find(({ role }) => role === 'assistant');
  if (!introduction || introduction.usage || project.notes.length > 2 || project.notes.at(-1) !== introduction)
    return false;
  return (
    introduction?.text === 'Created a draft of ' + title + '. Say “play it” when you want to try it.' ||
    introduction?.text === 'Created a draft of ' + title + '. Starting a local playtest.' ||
    introduction?.text.startsWith(
      'Created ' + title + '. ' + templates[project.template].description + ' Starting a local playtest.',
    ) === true
  );
}
