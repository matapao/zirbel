import type { Release } from '../sdk/contracts.ts';

// This response is navigable directly as well as embedded, so its HTTP sandbox
// must enforce the same opaque origin as the player's iframe attribute.
export function gamePage(release: Release, runtime: string, ancestors: string) {
  const assets = Object.fromEntries(release.manifest.assets.map((asset) =>
    [asset.id, 'data:' + asset.media + ';base64,' + release.assets[asset.hash]]));
  const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
  const policy = [
    'sandbox allow-scripts', "default-src 'none'",
    "script-src 'unsafe-inline' " + runtime + 'game-sdk.js ' + runtime + 'three.module.js',
    "style-src 'unsafe-inline'", 'img-src data: blob:', 'media-src data: blob:', 'font-src data:',
    "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'",
    'frame-ancestors ' + ancestors,
  ].join('; ');
  const bootstrap = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<script type="importmap">' + json({ imports: { three: runtime + 'three.module.js' } }) + '</script>' +
    '<script type="application/json" id="zirbel-assets"' + (release.game?.registerObjects === false ? ' data-registration="off"' : '') + '>' + json(assets) + '</script>' +
    '<script crossorigin="anonymous" src="' + runtime + 'game-sdk.js"></script>';
  const source = release.game!.html.replace(/^\s*<!doctype\s+html\s*>/i, '');
  return { policy, html: '<!doctype html>' + bootstrap + source };
}
