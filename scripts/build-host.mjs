// Builds the native Go host with the player runtime from dist/web embedded.
// Run `pnpm build` first. Usage: node scripts/build-host.mjs [os/arch[/arm]]...
// Examples: linux/arm/7 (Raspberry Pi 2B), linux/arm64, darwin/arm64, windows/amd64.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const runtime = ['player.html', 'player.js', 'garden-3d.js', 'garden-3d.js.LEGAL.txt', 'player.css',
  'game-sdk.js', 'three.module.js', 'three-license.txt', 'zod-license.txt'];
const web = 'host/webfiles/web';
rmSync(web, { recursive: true, force: true });
mkdirSync(web + '/chunks', { recursive: true });
writeFileSync(web + '/.gitkeep', '');
for (const file of runtime) cpSync('dist/web/' + file, web + '/' + file);
for (const file of readdirSync('dist/web/chunks')) cpSync('dist/web/chunks/' + file, web + '/chunks/' + file);
// The editor UI, served by the Go host on its loopback editor port.
for (const file of ['index.html', 'workspace.js', 'workspace.css', 'favicon.svg']) cpSync('dist/web/' + file, web + '/' + file);
if (existsSync('dist/web/editor-chunks')) cpSync('dist/web/editor-chunks', web + '/editor-chunks', { recursive: true });

const targets = process.argv.slice(2);
for (const target of targets.length ? targets : ['']) {
  const [goos, goarch, goarm] = target.split('/');
  const env = { ...process.env, CGO_ENABLED: '0' };
  if (goos) Object.assign(env, { GOOS: goos, GOARCH: goarch });
  if (goarm) env.GOARM = goarm;
  // linux/arm/7 -> zirbel-host-linux-armv7, matching Docker's TARGETARCH + TARGETVARIANT.
  const name = 'zirbel-host' + (target ? '-' + goos + '-' + goarch + (goarm ? 'v' + goarm : '') : '') + (goos === 'windows' ? '.exe' : '');
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', 'host/bin/' + name, './host'], { env, stdio: 'inherit' });
  console.log('host/bin/' + name);
}
