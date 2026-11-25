// The per-user account folder: harness sign-ins and the threads' working folders, never in the project data folder.
import { lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** A folder only this user may use, made if it is missing; one that isn't private and theirs is refused. */
export function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077))))
    throw new Error('Zirbel account storage must be a private directory owned by this user.');
}

export function accountDirectory() {
  const home = homedir();
  const config = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') :
    process.platform === 'win32' ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local') :
    process.env.XDG_CONFIG_HOME || join(home, '.config');
  const directory = process.env.ZIRBEL_ACCOUNT_DIR || join(config, 'Zirbel');
  if (!isAbsolute(directory)) throw new Error('Zirbel account storage requires an absolute path.');
  return directory;
}
