// An editor that a program started for itself ends when that program goes away, even when it was killed and could
// say nothing: the IPC channel it was started with closes, or, with ZIRBEL_EXIT_WITH_STDIN=1, its stdin ends.
import { stopOnSignal } from './hosting.ts';

export function exitWithParent(stop: () => Promise<void>) {
  let ending = false;
  const end = () => {
    if (ending) return;
    ending = true;
    void stopOnSignal(stop).finally(() => process.exit());
  };
  if (process.channel) {
    // The channel alone never keeps the editor running.
    process.channel.unref();
    process.once('disconnect', end);
  }
  if (process.env.ZIRBEL_EXIT_WITH_STDIN === '1') {
    process.stdin.on('data', () => {});
    process.stdin.once('end', end);
    process.stdin.once('close', end);
  }
}
