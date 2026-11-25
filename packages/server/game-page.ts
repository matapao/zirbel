import type { Release } from '../sdk/contracts.ts';

// three.js's addons, served from the host's own build beside three.module.js (runtime-files.ts).
export const THREE_ADDONS = 'three/addons/';

// This response is navigable directly as well as embedded, so its HTTP sandbox
// must enforce the same opaque origin as the player's iframe attribute.
// base is the document's own address (/game/<room>/<key>/): a game imported as a built folder
// loads its files from beside it, and only those. Every game gets the same policy: WebAssembly,
// workers and loaders reading data: and blob: URLs, and no other origin anywhere.
export function gamePage(release: Release, runtime: string, ancestors: string, base: string) {
  const assets = Object.fromEntries(release.manifest.assets.map((asset) =>
    [asset.id, 'data:' + asset.media + ';base64,' + release.assets[asset.hash]]));
  const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
  const addons = runtime + THREE_ADDONS;
  const policy = [
    'sandbox allow-scripts', "default-src 'none'",
    "script-src 'unsafe-inline' 'wasm-unsafe-eval' " + base + ' ' + runtime + 'game-sdk.js ' + runtime + 'three.module.js ' + addons,
    "style-src 'unsafe-inline' " + base, 'img-src data: blob: ' + base, 'media-src data: blob: ' + base, 'font-src data: ' + base,
    // Loaders turn embedded data into blob: and data: URLs and read them back, and fetch the decoders
    // the addons ship with (Draco, Basis); none of it reaches the network.
    'connect-src ' + base + ' ' + addons + ' data: blob:', 'worker-src ' + base + ' blob:',
    "frame-src 'none'", "form-action 'none'", "base-uri 'none'",
    'frame-ancestors ' + ancestors,
  ].join('; ');
  const imports = { three: runtime + 'three.module.js', [THREE_ADDONS]: addons };
  const bootstrap = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<script type="importmap">' + json({ imports }) + '</script>' +
    '<script type="application/json" id="zirbel-assets"' + (release.game?.registerObjects === false ? ' data-registration="off"' : '') + '>' + json(assets) + '</script>' +
    '<script crossorigin="anonymous" src="' + runtime + 'game-sdk.js"></script>';
  const source = release.game!.html.replace(/^\s*<!doctype\s+html\s*>/i, '');
  return { policy, html: '<!doctype html>' + bootstrap + source };
}
