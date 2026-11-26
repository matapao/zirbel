// `pnpm check:go`: every static check of every Go module here (each folder with a go.mod), the same script in every
// repository, with pinned tool versions. The tools run through `go run tool@version`, so they never become
// dependencies of a module. The tests are `pnpm test`'s (go test -race -shuffle=on). --live also runs govulncheck,
// which reads the vulnerability database as it is now: the Security workflow runs it daily and before a release.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ---- This repository's settings: the only lines that differ between repositories. ----
// Modules that may use only Go's standard library: check:go fails on any module dependency.
const STDLIB_ONLY = true;
// What nilaway reports that is left out, by module and file, each with why: nilaway takes no comment that excuses one.
const NILAWAY_EXCLUDE = {
  // 'module/dir': ['file.go'], with why
};
// ---- End of this repository's settings. ----

const tools = {
  golangci: 'github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0', // staticcheck, gosec, errcheck, modernize…
  deadcode: 'golang.org/x/tools/cmd/deadcode@v0.53.0', // whole-program unreachable functions
  nilaway: 'go.uber.org/nilaway/cmd/nilaway@v0.0.0-20261123170355-271eb36a4349', // nil-panic flows
  govulncheck: 'golang.org/x/vuln/cmd/govulncheck@v1.10.0', // known vulnerabilities in code that is reached
};

const live = process.argv.includes('--live');
const modules = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*go.mod'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file.endsWith('go.mod'))
  .map((file) => dirname(file));

let failed = 0;
function run(label, cwd, command, args, { failOnOutput = false } = {}) {
  process.stdout.write(`· ${label} (${cwd})\n`);
  try {
    const output = execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (failOnOutput && output.trim()) {
      process.stdout.write(output);
      failed++;
    } else if (output.trim()) process.stdout.write(output.trim().replace(/^/gm, '  ') + '\n');
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    failed++;
  }
}

for (const dir of modules) {
  const module = /^module\s+(\S+)/m.exec(readFileSync(`${dir}/go.mod`, 'utf8'))?.[1] ?? dir;
  run('gofmt', dir, 'gofmt', ['-l', '.'], { failOnOutput: true });
  run('go mod tidy', dir, 'go', ['mod', 'tidy', '-diff']);
  run('go mod verify', dir, 'go', ['mod', 'verify']);
  if (STDLIB_ONLY) {
    run('stdlib only', dir, 'go', ['list', '-m', '-f', '{{if not .Main}}{{.Path}}{{end}}', 'all'], {
      failOnOutput: true,
    });
  }
  run('go vet', dir, 'go', ['vet', './...']);
  run('golangci-lint', dir, 'go', ['run', tools.golangci, 'run', './...']);
  run('deadcode', dir, 'go', ['run', tools.deadcode, '-test', './...'], { failOnOutput: true });
  const excluded = (NILAWAY_EXCLUDE[dir] ?? []).map((file) => resolve(dir, file));
  const exclude = excluded.length ? [`-exclude-errors-in-files=${excluded.join(',')}`] : [];
  run('nilaway', dir, 'go', ['run', tools.nilaway, `-include-pkgs=${module}`, ...exclude, './...']);
  if (live) run('govulncheck', dir, 'go', ['run', tools.govulncheck, './...']);
}
if (!live) process.stdout.write('· govulncheck: with --live (it reads the vulnerability database as it is now)\n');
if (!modules.length) process.stdout.write('· no Go module here\n');
if (failed) {
  console.error(`check:go: ${failed} check(s) failed`);
  process.exitCode = 1;
}
