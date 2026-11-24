// Packs the desktop app with electron-builder, for macOS on this Mac's architecture. --dir makes a local bundle for
// testing (out/mac-arm64/Zirbel.app, or out/mac/ on Intel), signed ad hoc. Without --dir it makes a zip and a dmg,
// which need a Developer ID Application identity and notarization credentials.
// The bundle holds the app's main process (in app.asar) and, in Resources/editor, the repository's built dist/ with the
// packages the server loads at runtime (stage.mjs). Build first: pnpm build in the repository, then here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { stageEditor } from './stage.mjs';

const dir = process.argv.includes('--dir');
const DESKTOP = path.join(import.meta.dirname, '..');
const REPO = path.join(DESKTOP, '..');
const out = path.join(DESKTOP, 'out');
const stage = path.join(out, 'stage');
const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require('electron-builder');

if (process.platform !== 'darwin') throw new Error('The desktop app is packed on a Mac for now.');
for (const file of ['dist/server.mjs', 'dist/web/index.html'])
  if (!fs.existsSync(path.join(REPO, file)))
    throw new Error(`${file} is missing: run pnpm build in the repository first.`);
if (!fs.existsSync(path.join(DESKTOP, 'dist', 'src', 'main.js')))
  throw new Error('The app is not built: run pnpm build here first.');

let identity = null; // a --dir bundle is signed ad hoc below
if (!dir) {
  if (!process.env.APPLE_KEYCHAIN_PROFILE && !process.env.APPLE_ID && !process.env.APPLE_API_KEY)
    throw new Error('A release needs notarization credentials. Use --dir for a local test bundle.');
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  identity = /([A-F0-9]{40}) "Developer ID Application: /.exec(identities)?.[1] ?? null;
  if (!identity) throw new Error('A release needs a Developer ID Application signing identity.');
}

fs.rmSync(out, { recursive: true, force: true });
const cpu = process.arch === 'arm64' ? 'arm64' : 'x64';
stageEditor(path.join(stage, 'editor'), REPO, { os: 'darwin', cpu });

// The icon: the editor's own (public/favicon.svg), drawn on 824 of 1024 pixels as a Mac's app icons are.
const resources = path.join(stage, 'build');
fs.mkdirSync(resources);
const svg = fs
  .readFileSync(path.join(REPO, 'public', 'favicon.svg'), 'utf8')
  .replace('viewBox="0 0 64 64"', 'viewBox="-7.77 -7.77 79.54 79.54"');
const [svgFile, pngFile] = ['icon.svg', 'icon.png'].map((name) => path.join(resources, name));
fs.writeFileSync(svgFile, svg);
execFileSync('sips', ['-s', 'format', 'png', '-z', '1024', '1024', svgFile, '--out', pngFile], { stdio: 'ignore' });

const electronDir = path.dirname(require.resolve('electron/package.json'));
const config = {
  appId: 'local.zirbel.app',
  productName: 'Zirbel',
  directories: { output: out, buildResources: resources },
  files: ['dist/src/**/*', 'package.json'],
  extraResources: [
    // From the stage folder with a filter, so that the editor's node_modules come along.
    { from: stage, to: '.', filter: ['editor/**/*'] },
    { from: path.join(REPO, 'LICENSE'), to: 'LICENSE.txt' },
    // Electron's and Chromium's, which a copied Electron distribution keeps beside its app.
    { from: path.join(electronDir, 'dist', 'LICENSE'), to: 'LICENSE.electron.txt' },
    { from: path.join(electronDir, 'dist', 'LICENSES.chromium.html'), to: 'LICENSES.chromium.html' },
  ],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  electronVersion: require('electron/package.json').version,
  electronDist: path.join(electronDir, 'dist'),
  mac: { category: 'public.app-category.developer-tools', type: 'distribution', identity, notarize: !dir },
  publish: null,
};
const targets = Platform.MAC.createTarget(dir ? ['dir'] : ['zip', 'dmg'], cpu === 'arm64' ? Arch.arm64 : Arch.x64);
await build({ projectDir: DESKTOP, targets, config, publish: 'never' });

const bundle = path.join(out, cpu === 'arm64' ? 'mac-arm64' : 'mac', 'Zirbel.app');
// Electron's own default app, which a copied Electron distribution keeps: the bundle runs its app.asar only.
fs.rmSync(path.join(bundle, 'Contents', 'Resources', 'default_app.asar'), { force: true });
if (dir) execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
const size = execFileSync('du', ['-sh', bundle], { encoding: 'utf8' }).split('\t')[0];
console.log(`built: ${path.relative(process.cwd(), bundle)} (${size})`);
