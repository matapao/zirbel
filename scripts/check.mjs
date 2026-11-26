// `pnpm check`: the one gate, the same in every repository, for people, coding agents and CI alike. It runs each of
// these package.json scripts the repository has, in this order, every one even after one fails, and ends with a list of
// what passed and what failed. Everything it runs gives the same answer for the same code: nothing reads the network
// (the live security checks are `pnpm check:security --live`'s), the clock or the order tests run in.
// --coverage runs `test:coverage` (the tests with their coverage floors) in place of `test`: CI's Checks job does.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const STEPS = ['typecheck', 'lint', 'format:check', 'check:files', 'check:go', 'check:py', 'test'];
const { scripts = {} } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const coverage = process.argv.includes('--coverage');
const steps = STEPS.map((step) => (step === 'test' && coverage && scripts['test:coverage'] ? 'test:coverage' : step));
// pnpm 12 is a program of its own (npm_execpath names it); an earlier pnpm is a script for this Node to run.
const exec = process.env.npm_execpath;
const pnpm = (args) => {
  if (exec && !/\.[cm]?js$/.test(exec)) return spawnSync(exec, args, { stdio: 'inherit' });
  return exec
    ? spawnSync(process.execPath, [exec, ...args], { stdio: 'inherit' })
    : spawnSync('pnpm', args, { stdio: 'inherit' });
};

const results = [];
for (const step of steps.filter((name) => scripts[name])) {
  console.log(`\n== pnpm ${step}`);
  const started = performance.now();
  const { status } = pnpm(['run', step]);
  results.push({ step, ok: status === 0, seconds: ((performance.now() - started) / 1000).toFixed(1) });
}

console.log('\n== pnpm check');
for (const { step, ok, seconds } of results) console.log(`${ok ? 'pass' : 'FAIL'}  ${step} (${seconds} s)`);
const failed = results.filter(({ ok }) => !ok).map(({ step }) => step);
if (failed.length) {
  console.error(`\nFailed: ${failed.join(', ')}. Fix them and run \`pnpm check\` again.`);
  process.exitCode = 1;
}
