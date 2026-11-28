// The files the project store keeps beside its repositories, by their schemas: projects/<id>.json, a proposal's
// proposals/<project>.<proposal>.json and a bundle; the ids they are named by, and how each is written and read.
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { attachment, id, note, project, storedProposalInput } from '../sdk/contracts.ts';
import { ZirbelError } from './errors.ts';

/** The date a saved note or proposal carries. */
export const now = () => new Date().toISOString();
export const newId = () => randomUUID();
export const safeId = (input: unknown) => id.parse(input);

export const savedProposal = storedProposalInput.extend({ id, projectId: id, date: z.iso.datetime() });
export type Proposal = z.infer<typeof savedProposal>;

export function atomicWrite(path: string, contents: string | Buffer) {
  const temporary = path + '.' + newId() + '.tmp';
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readData(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ZirbelError(404, 'The requested item does not exist.');
    throw error;
  }
}

export const savedNote = note.omit({ id: true, date: true });
export const projectBundle = z.strictObject({ project, assets: z.record(z.string(), z.string()) });
export const titleSchema = project.shape.title;
/** projects/<id>.json: what of a project isn't its game's content. Its branches and revisions are its repository's. */
export const storedProject = z.strictObject({
  version: z.literal(2),
  id,
  title: titleSchema,
  template: project.shape.template,
  notes: z.array(note),
  attachments: z.array(attachment),
  upstream: id.optional(),
  imported: z.literal(true).optional(),
  source: project.shape.source,
});
export type Stored = z.infer<typeof storedProject>;
