// Go coverage across unit tests and the contract tests: the contract tests
// drive a coverage build of the host binary, so the server paths they exercise
// count too. Fails below the threshold. Run `pnpm build:host` first.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Measured at 69.4% when introduced; raise it as coverage grows.
const THRESHOLD = Number(process.env.GO_COVERAGE_MIN ?? 65);
const dir = mkdtempSync(join(tmpdir(), 'zirbel-gocover-'));
const binary = join(dir, 'zirbel-host' + (process.platform === 'win32' ? '.exe' : ''));
const data = join(dir, 'data');
mkdirSync(data);
try {
  const run = (command, args, env = {}) => execFileSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  run('go', ['build', '-cover', '-coverpkg=./...', '-o', binary, './host']);
  run('go', ['test', '-cover', '-coverpkg=./...', './...', '-args', '-test.gocoverdir=' + data]);
  run(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--test',
    'test/host.contract.test.ts', 'test/editor.contract.test.ts'], { ZIRBEL_GO_HOST: binary, GOCOVERDIR: data });
  const profile = join(dir, 'cover.txt');
  run('go', ['tool', 'covdata', 'textfmt', '-i=' + data, '-o=' + profile]);
  const summary = execFileSync('go', ['tool', 'cover', '-func=' + profile], { encoding: 'utf8' });
  const total = Number(/^total:.*?([\d.]+)%$/m.exec(summary)?.[1]);
  console.log('Go coverage (unit + contract tests): ' + total + '% (minimum ' + THRESHOLD + '%)');
  if (!(total >= THRESHOLD)) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
