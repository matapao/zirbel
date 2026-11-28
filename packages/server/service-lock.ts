import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const owner = z.object({
  pid: z.number().int().positive(),
  port: z.number().int(),
  boot: z.uuid(),
  editor: z.boolean(),
});
type Owner = z.infer<typeof owner>;

// A claim cut short by a crash or power loss is unreadable; treat it as stale
// rather than locking the directory until someone deletes it by hand.
const INVALID = { pid: 0, port: 0, boot: 'invalid', editor: false } satisfies Owner;
// A process killed during recovery leaves its recovery file behind.
const RECOVERY_TIMEOUT = 30_000;

function readOwner(file: string): Owner | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    return owner.parse(JSON.parse(text));
  } catch {
    return INVALID;
  }
}

export function claimDirectory(root: string, self: Owner) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, 'service.json');
  const temp = join(root, 'service-' + self.boot + '.tmp');
  writeFileSync(temp, JSON.stringify(self), { mode: 0o600, flag: 'wx', flush: true });
  try {
    while (true) {
      try {
        linkSync(temp, file);
        return {
          owner: true as const,
          file,
          release: () => {
            if (readOwner(file)?.boot === self.boot) rmSync(file);
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const current = readOwner(file);
      if (!current) continue;
      // A claim with our own PID but another boot is stale: containers always
      // run as PID 1 and a reboot can reuse a PID, so a live check would lie.
      if (current !== INVALID && current.pid !== process.pid)
        try {
          process.kill(current.pid, 0);
          return { owner: false as const, ...current };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      // Two restarts can see the same dead PID. Serialize removal and recheck
      // the boot ID so the slower restart cannot unlink the new owner's claim.
      const recovery = join(root, 'recover-' + current.boot + '.json');
      try {
        linkSync(temp, recovery);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() - statSync(recovery).mtimeMs > RECOVERY_TIMEOUT) {
          rmSync(recovery, { force: true });
          continue;
        }
        throw new Error('Another process is recovering the project directory. Retry after recovery completes.');
      }
      try {
        if (readOwner(file)?.boot === current.boot) rmSync(file);
      } finally {
        rmSync(recovery, { force: true });
      }
    }
  } finally {
    rmSync(temp, { force: true });
  }
}
