// No hand-written file over 500 lines. Generated and data files are exempt.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LIMIT = 500;
const exempt = [/^contracts\/.*\.schema\.json$/, /^contracts\/mcp-/, /^examples\//, /(^|\/)pnpm-lock\.yaml$/, /^go\.sum$/];
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter((file) => file && !exempt.some((pattern) => pattern.test(file)));
const long = files.flatMap((file) => {
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n').length - 1; } catch { return []; }
  return lines > LIMIT ? [file + ': ' + lines + ' lines'] : [];
});
if (long.length) {
  console.error('Files over ' + LIMIT + ' lines (split them by responsibility):\n  ' + long.join('\n  '));
  process.exitCode = 1;
}
