// The repository's files as a whole, the same check in every repository (`pnpm check:files`):
// - no hand-written file over 500 lines, comments and blank lines included: split it by responsibility. Generated and
//   vendored files (`linguist-generated`, `linguist-vendored` in .gitattributes), data kept by hand that is not code
//   (`data`: a catalog, a fixture) and binary files are left out;
// - README.md (100 lines at most) and AGENTS.md (200) are the repository's only Markdown, with
//   .github/SECURITY.md (20) for GitHub's Security tab and Scorecard. Markdown that is the product's
//   content or a test's data carries the `content` attribute in .gitattributes, with what reads it;
// - nothing a checkout or an agent leaves behind: editor and system files, merge leftovers, logs, `.env` files;
// - every suppression says why: `eslint-disable`/`oxlint-disable` with `-- <reason>`, `@ts-expect-error <reason>`
//   (never `@ts-ignore`), `nosemgrep: <rule> -- <reason>`; Go's `//nolint` is golangci-lint's (nolintlint).
// It reads what git tracks and what it would add (untracked, not ignored), so a file is caught before it is committed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LINE_LIMIT = 500;
const DOC_LIMITS = { 'README.md': 100, 'AGENTS.md': 200, '.github/SECURITY.md': 20 };
const LEFTOVERS = [
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/,
  /\.(orig|rej|swp|swo|log|tmp|bak)$/,
  /(^|\/)\.env(\.(?!example$)[^/]+)?$/,
  /(^|\/)(CLAUDE|CLAUDE\.local|GEMINI|COPILOT)\.md$/,
];
const SUPPRESSIONS = [
  { pattern: /@ts-ignore\b/, rule: 'use `@ts-expect-error <reason>` instead of `@ts-ignore`' },
  { pattern: /\b(eslint|oxlint)-disable(-next-line|-line)?\b(?![^\n]*--\s*\S)/, rule: 'say why: `-- <reason>`' },
  { pattern: /@ts-expect-error\s*(\*\/)?\s*$/, rule: 'say why: `@ts-expect-error <reason>`' },
  { pattern: /(\/\/|#)\s*nosemgrep\b(?![^\n]*--\s*\S)/, rule: 'say why: `nosemgrep: <rule> -- <reason>`' },
];
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  .split('\0')
  .filter(Boolean)
  .filter((file, index, all) => all.indexOf(file) === index);

/** Each file's attributes from .gitattributes, read once for all files. */
function attributes(names) {
  const set = new Map(files.map((file) => [file, new Set()]));
  const output = execFileSync('git', ['check-attr', '-z', '--stdin', ...names], {
    input: files.join('\0'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).split('\0');
  for (let i = 0; i + 2 < output.length; i += 3) {
    const [file, name, value] = [output[i], output[i + 1], output[i + 2]];
    if (value !== 'unspecified' && value !== 'unset' && value !== 'false') set.get(file)?.add(name);
  }
  return set;
}

const attrs = attributes(['linguist-generated', 'linguist-vendored', 'content', 'data']);
const problems = [];
let counted = 0;

for (const file of files) {
  const own = attrs.get(file) ?? new Set();
  if (LEFTOVERS.some((pattern) => pattern.test(file))) {
    problems.push(`${file}: left behind; remove it (or ignore it in .gitignore)`);
    continue;
  }
  if (/\.mdx?$/i.test(file) && !(file in DOC_LIMITS) && !own.has('content')) {
    problems.push(`${file}: only README.md, AGENTS.md and .github/SECURITY.md document the repository; fold it into one of them`);
  }
  if (own.has('linguist-generated') || own.has('linguist-vendored') || own.has('data')) continue;
  let text;
  try {
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary
    text = bytes.toString('utf8');
  } catch {
    continue; // deleted in the working tree
  }
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  counted++;
  const limit = DOC_LIMITS[file] ?? LINE_LIMIT;
  if (lines.length > limit) problems.push(`${file}: ${lines.length} lines, over ${limit}; split it by responsibility`);
  if (CODE.test(file) && !file.startsWith('scripts/check-files.mjs')) {
    lines.forEach((line, index) => {
      for (const { pattern, rule } of SUPPRESSIONS) {
        if (pattern.test(line)) problems.push(`${file}:${index + 1}: ${rule}`);
      }
    });
  }
}

if (problems.length) {
  console.error(`check:files found ${problems.length} problem(s):\n  ${problems.sort().join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log(`check:files: ${counted} hand-written files within their limits, and the repository's Markdown in order.`);
}
