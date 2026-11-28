import { timingSafeEqual } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { hash, id, proposalInput } from '../sdk/contracts.ts';
import { atomicWrite, digest, head, newId, readData, safeId, ZirbelError, type Projects } from '../core/projects.ts';
import { secret } from '../core/room.ts';
import { guideResources, instructions } from './mcp-guides.ts';
import { readFileInput, readGameFile, stageFiles, writeFilesInput } from './mcp-files.ts';
import { sceneDocument, sceneResource } from './scene-app.ts';
import type { Ident } from '../core/git.ts';
import { grantAuthor } from './authors.ts';

const grantInput = z.strictObject({ projectId: id, write: z.boolean(), hours: z.number().int().min(1).max(168) });
export const grantSchema = grantInput.extend({ id, expires: z.number().int(), tokenHash: hash });
type Grant = z.infer<typeof grantSchema>;
const envelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
// Keep advertised inputs, required access and the implementation together.
function tool<S extends z.ZodObject>(
  name: string,
  description: string,
  access: 'read' | 'propose' | 'write',
  schema: S,
  execute: (projects: Projects, projectId: string, args: z.output<S>, author: Ident) => unknown,
  resourceUri?: string,
) {
  return {
    name,
    access,
    descriptor: {
      name,
      description,
      annotations: { readOnlyHint: access === 'read' },
      inputSchema: z.toJSONSchema(schema, { io: 'input' }),
      _meta: { ui: resourceUri ? { resourceUri, visibility: ['model', 'app'] } : { visibility: ['model'] } },
    },
    call: (projects: Projects, projectId: string, raw: unknown, author: Ident) =>
      execute(projects, projectId, schema.parse(raw), author),
  };
}

const empty = z.strictObject({});
const proposalId = z.strictObject({ proposalId: id });
const tools = [
  tool('read_project', 'Read this project and its branch heads.', 'read', empty, (projects, projectId) => {
    const { id, title, template, branches } = projects.read(projectId);
    return { id, title, template, branches };
  }),
  tool(
    'read_scene',
    'Read the game source, assets and exact revision.',
    'read',
    z.strictObject({ branch: id.default('main') }),
    (projects, projectId, args) => head(projects.read(projectId), args.branch),
    sceneResource.uri,
  ),
  tool('list_revisions', 'List revision metadata.', 'read', empty, (projects, projectId) =>
    projects.read(projectId).revisions.map(({ id, parent, restoredFrom, label, date, author }) => ({
      id,
      parent,
      restoredFrom,
      label,
      date,
      author,
    })),
  ),
  tool(
    'read_file',
    "Read one of the game's files by its path: index.html or a file beside it, from a branch head or a revision. " +
      'UTF-8 text comes back as text, anything else as base64.',
    'read',
    readFileInput,
    readGameFile,
  ),
  tool(
    'write_files',
    "Stage a revision that writes or removes the game's files by path, each written as text or base64; " +
      'the other files stay as they are. Read zirbel://guide/files first.',
    'propose',
    writeFilesInput,
    stageFiles,
  ),
  tool(
    'propose',
    'Stage a revision. Use writeGame with a complete HTML document to implement any game or edit; a game with files ' +
      'beside its index.html changes through write_files.',
    'propose',
    z.strictObject({ proposal: proposalInput }),
    (projects, projectId, { proposal }, author) => {
      const additions = proposal.operations.filter((op) => op.op === 'addAsset');
      if (additions.length) {
        const approved = projects.knownAssets(projectId);
        for (const { asset } of additions) {
          if (
            !approved.some(
              (known) =>
                known.hash === asset.hash &&
                known.media === asset.media &&
                known.author === asset.author &&
                known.license === asset.license &&
                known.source === asset.source &&
                known.credit === asset.credit,
            )
          )
            throw new ZirbelError(403, 'Import the asset and its attribution into this project first.');
        }
      }
      return projects.submit(projectId, proposal, false, author);
    },
  ),
  tool(
    'preview_proposal',
    'Read the candidate scene for a staged proposal.',
    'read',
    proposalId,
    (projects, projectId, args) => projects.preview(projectId, args.proposalId),
  ),
  tool('apply_proposal', 'Apply a staged proposal as one revision.', 'write', proposalId, (projects, projectId, args) =>
    projects.commit(projectId, args.proposalId),
  ),
];

// What tools/list advertises, with the access each tool needs. Other hosts
// read this from contracts/mcp-tools.json.
export const toolDescriptors = tools.map(({ access, descriptor }) => ({ access, descriptor }));

/** The scene document, when a URI names it. */
const sceneText = (uri: unknown) => (uri === sceneResource.uri ? sceneDocument : undefined);

export class Mcp {
  private readonly projects: Projects;
  /** Each guide's text by its URI (readGuides). */
  private readonly guides: ReadonlyMap<string, string>;

  constructor(projects: Projects, guides: ReadonlyMap<string, string>) {
    this.projects = projects;
    this.guides = guides;
  }
  private get directory() {
    return join(this.projects.root, 'grants');
  }
  private file(id: string) {
    return join(this.directory, safeId(id) + '.json');
  }

  create(raw: unknown) {
    const params = grantInput.parse(raw);
    this.projects.read(params.projectId);
    const token = secret();
    const grant: Grant = {
      ...params,
      id: newId(),
      expires: Date.now() + params.hours * 3_600_000,
      tokenHash: digest(token),
    };
    atomicWrite(this.file(grant.id), JSON.stringify(grant));
    return { id: grant.id, token: grant.id + '.' + token, expires: grant.expires, write: grant.write };
  }

  revoke(projectId: string, id: string) {
    if (grantSchema.parse(readData(this.file(id))).projectId !== projectId)
      throw new ZirbelError(404, 'Grant does not exist.');
    rmSync(this.file(id));
  }

  list(projectId: string) {
    return readdirSync(this.directory)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        const { tokenHash: _tokenHash, ...metadata } = grantSchema.parse(readData(join(this.directory, file)));
        return metadata;
      })
      .filter((grant) => grant.projectId === projectId);
  }

  verify(header: string | undefined) {
    const match = /^Bearer ([0-9a-f-]{36})\.([a-zA-Z0-9_-]{32})$/.exec(header ?? '');
    if (match?.[1] && match[2]) {
      try {
        const grant = grantSchema.parse(readData(this.file(match[1])));
        if (
          grant.id === match[1] &&
          grant.expires > Date.now() &&
          timingSafeEqual(Buffer.from(digest(match[2]), 'hex'), Buffer.from(grant.tokenHash, 'hex')) &&
          this.projects.has(grant.projectId)
        )
          return grant;
      } catch {
        /* Expired, revoked or malformed credentials receive the same response. */
      }
    }
    throw new ZirbelError(401, 'A current project grant is required.');
  }

  handle(raw: unknown, credential: string | undefined): object | undefined {
    const grant = this.verify(credential);
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    const { method, params, id: requestId } = parsed.data;
    if (requestId === undefined) return;
    const response = { jsonrpc: '2.0', id: requestId };
    if (method === 'initialize') {
      const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      const requested = params?.protocolVersion;
      return {
        ...response,
        result: {
          protocolVersion: typeof requested === 'string' && supported.includes(requested) ? requested : supported[0],
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'zirbel', version: '0.1.0' },
          instructions: grant.write ? instructions.write : instructions.propose,
        },
      };
    }
    if (method === 'ping') return { ...response, result: {} };
    if (method === 'resources/list') return { ...response, result: { resources: [...guideResources, sceneResource] } };
    if (method === 'resources/read') {
      const uri = params?.uri;
      const guide = guideResources.find((item) => item.uri === uri);
      const text = guide ? this.guides.get(guide.uri) : sceneText(uri);
      if (text === undefined) return { ...response, error: { code: -32002, message: 'Resource not found.' } };
      const { mimeType } = guide ?? sceneResource;
      return { ...response, result: { contents: [{ uri, mimeType, text }] } };
    }
    if (method === 'tools/list') {
      const available = tools.filter((entry) => grant.write || entry.access !== 'write');
      return { ...response, result: { tools: available.map((entry) => entry.descriptor) } };
    }
    if (method === 'tools/call') {
      try {
        const entry = tools.find(({ name }) => name === params?.name);
        if (!entry) throw new ZirbelError(404, 'Unknown tool.');
        if (entry.access === 'write' && !grant.write)
          throw new ZirbelError(403, 'Applying a proposal requires a write grant.');
        const result = entry.call(this.projects, grant.projectId, params?.arguments ?? {}, grantAuthor(grant.id));
        return { ...response, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
      } catch (error) {
        const text =
          error instanceof ZirbelError || error instanceof z.ZodError ? error.message : 'Project operation failed.';
        return { ...response, result: { isError: true, content: [{ type: 'text', text }] } };
      }
    }
    return { ...response, error: { code: -32601, message: 'Method not found' } };
  }
}

export async function stdioMcp(endpoint: string, token: string) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('Use HTTPS or loopback HTTP for the MCP connection.');
  const incoming = createInterface({ input: process.stdin });
  for await (const line of incoming) {
    if (line.length > 512_000) continue;
    try {
      const request: unknown = JSON.parse(line);
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: line,
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 202) continue;
      if (!response.ok) {
        const parsed = envelope.safeParse(request);
        if (parsed.success && parsed.data.id !== undefined)
          process.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.data.id,
              error: { code: -32000, message: 'Zirbel returned HTTP ' + response.status },
            }) + '\n',
          );
      } else process.stdout.write(JSON.stringify(await response.json()) + '\n');
    } catch (error) {
      process.stderr.write('Zirbel MCP: ' + String(error) + '\n');
    }
  }
}
