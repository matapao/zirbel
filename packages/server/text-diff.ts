// A file change as lines removed and added, for a harness step or a permission request that carries the old and new
// text. The lines both versions share at the start and end are left out, so a small edit to a large file stays small.
const CONTEXT = 2;

export function textDiff(path: string, before: string | null | undefined, after: string) {
  const old = before ? before.split('\n') : [];
  const next = after.split('\n');
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  const from = Math.max(0, start - CONTEXT);
  const lines = [
    '--- ' + path,
    '+++ ' + path,
    '@@ line ' + (from + 1) + ' @@',
    ...old.slice(from, start).map((line) => ' ' + line),
    ...old.slice(start, old.length - end).map((line) => '-' + line),
    ...next.slice(start, next.length - end).map((line) => '+' + line),
    ...next.slice(next.length - end, next.length - end + CONTEXT).map((line) => ' ' + line),
  ];
  return lines.join('\n');
}
