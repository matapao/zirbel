// Where a page in the desktop app may go. The editor's window stays on the editor's origin. Playtests and games open in
// child windows on loopback player origins (the editor's own player listener, or the LAN listener's 127.0.0.1 link).
// Any other web address opens in the system browser, and every other scheme is refused.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** What a URL is to the app: the editor, a loopback player, a blank page a window is opened with, the web, or other. */
export type Place = 'editor' | 'player' | 'blank' | 'web' | 'other';

/** The editor's origin from the address its command line printed, if that is plain http on loopback with a port. */
export function editorOrigin(address: string): string | undefined {
  const url = URL.parse(address);
  if (!url || url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || !url.port || url.username || url.password)
    return undefined;
  return url.origin;
}

export function place(address: string, editor: string): Place {
  if (address === '' || address === 'about:blank') return 'blank';
  const url = URL.parse(address);
  if (!url) return 'other';
  if (url.origin === editor) return 'editor';
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return 'player';
  return url.protocol === 'http:' || url.protocol === 'https:' ? 'web' : 'other';
}

/** Whether a window may navigate there: the editor's own window only within the editor's origin, a child window also
 *  to a loopback player or a blank page. */
export function mayNavigate(where: Place, editorWindow: boolean): boolean {
  return where === 'editor' || (!editorWindow && (where === 'player' || where === 'blank'));
}

/** Whether window.open may open a child window there (with the same hardening as the editor's window). */
export function mayOpen(where: Place): boolean {
  return where === 'editor' || where === 'player' || where === 'blank';
}
