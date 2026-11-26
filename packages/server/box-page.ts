// The small pages a box serves at its door, /pair and /edit: their form, their headers, and the redirect after one.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZirbelError } from '../core/projects.ts';

export function redirect(response: ServerResponse, location: string) {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

/** A page's form, of up to 1024 characters; what names the form in its errors ("pairing", "edit"). */
export async function formBody(request: IncomingMessage, what: string) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded')
    throw new ZirbelError(415, 'Send the ' + what + ' form.');
  let text = '';
  for await (const chunk of request) {
    text += (chunk as Buffer).toString('utf8');
    if (text.length > 1024) throw new ZirbelError(413, 'The ' + what + ' form is too long.');
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export const escape = (text: string) => text.replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');

export function sendPage(response: ServerResponse, status: number, html: string) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    // A form posted under no-referrer carries the origin "null": this page's own forms carry its origin.
    'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(html);
}
