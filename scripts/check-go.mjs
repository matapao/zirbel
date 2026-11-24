// Every Go check, with pinned tool versions. The tools run through `go run`,
// so they never become dependencies of the module (which is stdlib-only).
// --live also runs govulncheck, which reads the vulnerability database as it is
// now: the Security workflow runs it daily and before a release, never as a gate.
import { execFileSync } from 'node:child_process';

const tools = {
  golangci: 'github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0', // staticcheck, gosec, errcheck, unused, nilerr…
  deadcode: 'golang.org/x/tools/cmd/deadcode@v0.53.0', // whole-program unreachable functions
  nilaway: 'go.uber.org/nilaway/cmd/nilaway@v0.0.0-20261123170355-271eb36a4349', // nil-panic flows
  govulncheck: 'golang.org/x/vuln/cmd/govulncheck@v1.10.0', // known vulnerabilities in code that is reached
};

const live = process.argv.includes('--live');
const run = (label, command, args, { failOnOutput = false } = {}) => {
  process.stdout.write('· ' + label + '\n');
  const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (failOnOutput && output.trim()) {
    process.stdout.write(output);
    throw new Error(label + ' reported problems');
  }
  if (!failOnOutput && output.trim()) process.stdout.write(output.trim().replace(/^/gm, '  ') + '\n');
};

run('gofmt', 'gofmt', ['-l', '.'], { failOnOutput: true });
run('go mod tidy', 'go', ['mod', 'tidy', '-diff']);
run('go mod verify', 'go', ['mod', 'verify']);
run('stdlib only', 'go', ['list', '-m', '-f', '{{if not .Main}}{{.Path}}{{end}}', 'all'], { failOnOutput: true });
run('go vet', 'go', ['vet', './...']);
run('golangci-lint', 'go', ['run', tools.golangci, 'run', './...']);
run('deadcode', 'go', ['run', tools.deadcode, '-test', './...'], { failOnOutput: true });
run('nilaway', 'go', ['run', tools.nilaway, '-include-pkgs=zirbel', './...']);
if (live) run('govulncheck', 'go', ['run', tools.govulncheck, './...']);
else process.stdout.write('· govulncheck: with --live (it reads the vulnerability database as it is now)\n');
run('go test -race', 'go', ['test', '-race', '-shuffle=on', '-cover', './...']);
