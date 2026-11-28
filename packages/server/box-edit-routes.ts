// A game's editors on a box (box mode, --box): the /edit page, where a device on the box's network redeems a game's
// edit code under a name and goes on to edit that game, and the owners' API for the code and the people editing it
// (/api/projects/<id>/edit-code and /api/projects/<id>/editors). The codes and sessions are box-editors.ts's.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { safeId, ZirbelError, type Projects } from '../core/projects.ts';
import { checkOrigin, failure, reply } from './http.ts';
import { EDITOR_COOKIE, editCode, editorName, ONE_GAME } from './box-editors.ts';
import { escape, formBody, redirect, sendPage } from './box-page.ts';
import { boxName, type Access, type BoxContext } from './box-routes.ts';

const editForm = z.strictObject({ code: z.string().max(40), name: editorName });
export const OWNS = 'This device owns the box and edits every game already. Use another device to edit with a code.';

/** The edit page: a code and a name. A device that owns the box, the box itself or a paired device, has no need of
 *  one, and a device holds one kind of session only. */
export async function editRoute(
  box: BoxContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  address: string,
  local: boolean,
) {
  if (request.method === 'GET') {
    page(response, 200, editCode(url.searchParams.get('code') ?? '') ?? '', '');
    return;
  }
  if (request.method !== 'POST') throw new ZirbelError(405, 'Open the edit page.');
  checkOrigin(request, true);
  // As typed, for the page again.
  let typed = { code: '', name: '' };
  try {
    const sent = await formBody(request, 'edit');
    const form = editForm.parse(sent);
    typed = { code: sent.code ?? '', name: sent.name ?? '' };
    const { cookie } = request.headers;
    if (local || box.pairing.session(cookie)) throw new ZirbelError(409, OWNS);
    // The session this device held as an editor, of this game or another, ends.
    const { token } = box.editors.redeem(form.code, form.name, address, cookie);
    response.setHeader(
      'set-cookie',
      EDITOR_COOKIE + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000',
    );
    redirect(response, '/');
  } catch (error) {
    const { status, message } = failure(error);
    page(response, status, editCode(typed.code) ?? '', typed.name, message);
  }
}

// The same page, character for character, in both hosts.
function page(response: ServerResponse, status: number, code: string, name: string, error?: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Edit a game on Zirbel</title><style>body{font:16px system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.2rem;color:#1d2b24}
h1{font-size:1.5rem}label{display:block;margin-top:1rem}input,button{font:inherit;padding:.6rem .8rem;border-radius:.5rem;border:1px solid #8a9a90}
input{width:100%;box-sizing:border-box}#code{letter-spacing:.15em;text-transform:uppercase}button{margin-top:.8rem;background:#274336;color:#fff;border:0}
.error{color:#a3271f}</style></head><body><h1>Edit a game on this Zirbel</h1>
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}<form method="post">
<label for="code">Edit code, from the box's owner</label>
<input id="code" name="code" autocomplete="off" autocapitalize="characters" placeholder="XXX-XXX" value="${escape(code)}" required>
<label for="name">Your name, as the owner sees this device</label>
<input id="name" name="name" autocomplete="nickname" maxlength="24" value="${escape(name)}" required>
<button>Start editing</button></form></body></html>`;
  sendPage(response, status, html);
}

/** A game's edit link, on the address other devices use (the box's name while it has none), at the editor's port. */
function editLink(box: BoxContext, host: string, plain: string) {
  const port = box.port();
  return 'http://' + (box.sharedHost(host) ?? boxName()) + (port === 80 ? '' : ':' + port) + '/edit?code=' + plain;
}

/** A game's code and the people editing it, for its owners: /api/projects/<id>/edit-code[/stop] and
 *  /api/projects/<id>/editors[/<editor>]. Says whether it answered the request. */
export async function editorsRequest(
  box: BoxContext,
  projects: Projects,
  request: IncomingMessage,
  response: ServerResponse,
  access: Access,
  url: URL,
  route: { pathID?: string | undefined; action?: string | undefined; tail?: string | undefined },
) {
  const { pathID, action, tail } = route;
  const method = request.method;
  const known =
    action === 'edit-code'
      ? method === 'POST' && (!tail || tail === 'stop')
      : action === 'editors' && method === (tail ? 'DELETE' : 'GET');
  if (!pathID || !known) return false;
  if (access.editor) throw new ZirbelError(403, ONE_GAME);
  if (method !== 'GET') checkOrigin(request, !access.local);
  const game = projects.read(safeId(pathID)).id;
  if (action === 'edit-code' && !tail) {
    const { code, plain, expiresAt } = box.editors.createCode(game);
    const link = editLink(box, url.hostname, plain);
    reply(response, { code, link, expiresAt, qr: await box.qr(link) }, 201);
  } else if (action === 'edit-code') {
    box.editors.stopCode(game);
    reply(response, {});
  } else if (tail) {
    box.editors.remove(game, safeId(tail));
    reply(response, {});
  } else {
    const code = box.editors.code(game);
    reply(response, {
      code: code ? { code: code.code, link: editLink(box, url.hostname, code.plain), expiresAt: code.expiresAt } : null,
      editors: box.editors.list(game),
    });
  }
  return true;
}
