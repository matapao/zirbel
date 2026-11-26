import { checkedControls } from '../sdk/controls.ts';
import type { Release } from '../sdk/contracts.ts';

// three.js's addons, served from the host's own build beside three.module.js (runtime-files.ts).
export const THREE_ADDONS = 'three/addons/';

// This response is navigable directly as well as embedded, so its HTTP sandbox
// must enforce the same opaque origin as the player's iframe attribute.
// base is the document's own address (/game/<room>/<key>/): a game imported as a built folder loads its files from
// beside it, and only those. Every game gets the same policy: WebAssembly, workers and loaders reading data: and blob:
// URLs, and no other origin anywhere. A game with its own netcode (net-v2) also imports the spaces kernel's modules
// from its host (/.skalet/net.js, /.skalet/spaces.js), and may reach its socket, /.skalet/spaces, though it joins the
// space its player page shares with it and holds no credential of its own; one that names an adapter (one of its files,
// so base allows it) loads it as a module after its own document, which is otherwise as it is.
export function gamePage(release: Release, runtime: string, ancestors: string, base: string) {
  const assets = Object.fromEntries(release.manifest.assets.map((asset) =>
    [asset.id, 'data:' + asset.media + ';base64,' + release.assets[asset.hash]]));
  const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
  const addons = runtime + THREE_ADDONS;
  const net = release.manifest.simulation === 'net-v2';
  const host = net ? new URL(base).origin : '';
  const policy = [
    'sandbox allow-scripts allow-pointer-lock', "default-src 'none'",
    "script-src 'unsafe-inline' 'wasm-unsafe-eval' " + base + ' ' + runtime + 'game-sdk.js ' + runtime + 'three.module.js ' + addons +
      (net ? ' ' + host + '/.skalet/net.js ' + host + '/.skalet/spaces.js' : ''),
    "style-src 'unsafe-inline' " + base, 'img-src data: blob: ' + base, 'media-src data: blob: ' + base, 'font-src data: ' + base,
    // Loaders turn embedded data into blob: and data: URLs and read them back, and fetch the decoders
    // the addons ship with (Draco, Basis); none of it reaches the network.
    'connect-src ' + base + ' ' + addons + ' data: blob:' + (net ? ' ' + host.replace(/^http/, 'ws') + '/.skalet/spaces' : ''),
    'worker-src ' + base + ' blob:',
    "frame-src 'none'", "form-action 'none'", "base-uri 'none'",
    'frame-ancestors ' + ancestors,
  ].join('; ');
  const imports = { three: runtime + 'three.module.js', [THREE_ADDONS]: addons };
  // The keys its zirbel.json gives gamepad inputs, which game-sdk presses for a game that reads only the keyboard, and its
  // places' names and colours: in the order the Go host writes them.
  const controls = checkedControls(release.game?.controls);
  const keys = controls ? '<script type="application/json" id="zirbel-controls">' + json(controls) + '</script>' : '';
  const bootstrap = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<script type="importmap">' + json({ imports }) + '</script>' +
    '<script type="application/json" id="zirbel-assets"' + (release.game?.registerObjects === false ? ' data-registration="off"' : '') + '>' + json(assets) + '</script>' +
    keys + '<script crossorigin="anonymous" src="' + runtime + 'game-sdk.js"></script>';
  const source = release.game!.html.replace(/^\s*<!doctype\s+html\s*>/i, '');
  const adapter = net && release.game!.adapter ? '<script type="module" src="' + base + release.game!.adapter + '"></script>' : '';
  return { policy, html: '<!doctype html>' + bootstrap + source + adapter };
}
