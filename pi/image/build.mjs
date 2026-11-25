// Builds a Zirbel box's image from Raspberry Pi OS Lite as Raspberry Pi publishes it, checked against its published
// hashes: what the box runs (chroot-base.sh), then the editor and its setup service (chroot-app.sh). Two targets:
// - arm64 (the default), for the Pis that run 64-bit Raspberry Pi OS: Pi 3, 4, 400, 5 and Zero 2 W. The Node editor
//   and the harnesses; the editor turns harnesses on by default where there is memory for them.
// - armhf, for the Pi 2 B: the Go host, as an editor and MCP server for people's own agents, since neither Node 24
//   nor the harnesses are made for 32-bit ARM.
// It runs on an arm64 computer with Docker, where an arm64 image's programs run natively in a container and an armhf
// image's through Docker's emulation. Build the repository first (pnpm build).
//   node pi/image/build.mjs --out DIR --country XX --ssh-key FILE [--target arm64|armhf] [--base IMAGE]
//                           [--rebuild-base] [--base-only]
// DIR keeps the downloaded OS, zirbel-base-TARGET.img (the slow stage, reused) and zirbel-TARGET.img, the image to
// write to a card.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { stageEditor } from '../../desktop/scripts/stage.mjs';

const OS_LIST = 'https://downloads.raspberrypi.com/os_list_imagingutility_v4.json';
/** Each target's image in Raspberry Pi's list: its name there, and a device it must be listed for. */
const TARGETS = {
  arm64: { name: 'Raspberry Pi OS Lite (64-bit)', device: 'pi5-64bit' },
  armhf: { name: 'Raspberry Pi OS Lite (32-bit)', device: 'pi2-32bit' },
};
const SIZE = '8G';
const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '../..');

const { values } = parseArgs({ options: {
  out: { type: 'string' }, country: { type: 'string' }, 'ssh-key': { type: 'string' }, base: { type: 'string' },
  'rebuild-base': { type: 'boolean', default: false }, 'base-only': { type: 'boolean', default: false },
  target: { type: 'string', default: 'arm64' },
} });
const target = TARGETS[values.target];
if (!values.out || !/^[A-Z]{2}$/.test(values.country ?? '') || !values['ssh-key'] || !target)
  throw new Error('Usage: build.mjs --out DIR --country XX --ssh-key FILE [--target arm64|armhf] [--base IMAGE] [--rebuild-base] [--base-only]');
const out = path.resolve(values.out);
const key = path.resolve(values['ssh-key']);
if (!/^(ssh-ed25519|ecdsa-sha2-\S+|ssh-rsa) \S+/.test(fs.readFileSync(key, 'utf8'))) throw new Error('--ssh-key must be a public key.');
fs.mkdirSync(out, { recursive: true });

const sha256 = (file) => {
  const hash = createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(8 * 1024 * 1024);
  try { for (let read; (read = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read)); }
  finally { fs.closeSync(handle); }
  return hash.digest('hex');
};

/** The target's Raspberry Pi OS Lite, as Raspberry Pi's own list names it, downloaded once and checked twice: the
 *  download against the SHA-256 published beside it, the image against the list's. */
async function osImage() {
  if (values.base) return path.resolve(values.base);
  const list = await (await fetch(OS_LIST)).json();
  const walk = (items) => items.flatMap((item) => item.subitems ? walk(item.subitems) : [item]);
  const os = walk(list.os_list).find((item) => item.name === target.name && item.devices?.includes(target.device));
  if (!os || !/^https:\/\/downloads\.raspberrypi\.com\/.+\.img\.xz$/.test(os.url)) throw new Error(`${target.name} is not in Raspberry Pi's list.`);
  const image = path.join(out, path.basename(os.url, '.xz'));
  if (fs.existsSync(image) && sha256(image) === os.extract_sha256) return image;
  const archive = image + '.xz';
  const published = (await (await fetch(os.url + '.sha256')).text()).split(/\s/)[0];
  console.log(`Downloading ${path.basename(os.url)} (${os.release_date})`);
  const response = await fetch(os.url);
  if (!response.ok) throw new Error(`The download failed: HTTP ${response.status}.`);
  await fs.promises.writeFile(archive, response.body);
  if (sha256(archive) !== published) throw new Error('The download does not match its published SHA-256.');
  execFileSync('xz', ['--decompress', '--keep', '--force', archive], { stdio: 'inherit' });
  if (sha256(image) !== os.extract_sha256) throw new Error("The image does not match Raspberry Pi's list.");
  fs.rmSync(archive);
  return image;
}

/** One stage in a privileged arm64 container, on a copy of the image (a clone, where the file system has them). */
function stage(from, to, name, args, mounts = {}) {
  fs.rmSync(to, { force: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
  const volumes = Object.entries({ [out]: '/out', [HERE]: '/build', [key]: '/key.pub', ...mounts })
    .flatMap(([source, target]) => ['-v', `${source}:${target}:${target === '/out' ? 'rw' : 'ro'}`]);
  execFileSync('docker', ['run', '--rm', '--privileged', '--platform', 'linux/arm64', ...volumes, 'debian:trixie',
    'bash', '/build/provision.sh', '/out/' + path.basename(to), SIZE, name, ...args], { stdio: 'inherit' });
}

const base = path.join(out, `zirbel-base-${values.target}.img`);
if (values['rebuild-base'] || !fs.existsSync(base)) {
  const building = base + '.building';
  stage(await osImage(), building, 'base', [values.country, '/tmp/zirbel-build/key.pub']);
  fs.renameSync(building, base);
}
if (values['base-only']) process.exit(0);

// The box's program: on arm64 the Node editor staged for Linux arm64; on armhf the Go host built for 32-bit ARM.
const app = {};
if (values.target === 'arm64') {
  const editor = path.join(out, 'editor');
  fs.rmSync(editor, { recursive: true, force: true });
  stageEditor(editor, REPO, { os: 'linux', cpu: 'arm64' });
  app[editor] = '/editor';
} else {
  execFileSync(process.execPath, ['scripts/build-host.mjs', 'linux/arm/7'], { cwd: REPO, stdio: 'inherit' });
  app[path.join(REPO, 'host', 'bin', 'zirbel-host-linux-armv7')] = '/zirbel-host';
}
const setup = path.join(REPO, 'pi', 'setup');
if (fs.existsSync(setup)) app[setup] = '/setup';
const image = path.join(out, `zirbel-${values.target}.img`);
stage(base, image, 'app', [values.country], app);
console.log(`Ready: ${image}`);
