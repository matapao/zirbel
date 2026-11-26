// `pnpm github:settings`: this repository's settings on GitHub, the same in every repository, as the owner runs it
// with their own `gh` sign-in (an admin of the repository). It changes nothing unless given --apply:
//   pnpm github:settings           what differs from the standard, and nothing else
//   pnpm github:settings --apply   sets what differs
// The standard, for a public repository (a private one gets the parts GitHub offers it without Code Security):
// - main: changes only through a pull request with one approval (the latest push approved, stale approvals dismissed,
//   every conversation resolved), the Checks and Security workflows green on an up-to-date branch, CodeQL's results
//   with no high or critical alert, linear history, and no force push or deletion. The owner may merge a pull request
//   without the approval (bypass for pull requests only), never push to main directly;
// - release tags (v*): never moved or deleted; releases immutable once published;
// - secret scanning with push protection, Dependabot alerts and security updates, private vulnerability reporting;
// - squash or rebase merges only, the branch deleted once merged, auto-merge off.
import { execFileSync } from 'node:child_process';

const apply = process.argv.includes('--apply');
const gh = (args, input) =>
  execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
const api = (path, method = 'GET', body) => {
  const out = gh(['api', '-X', method, path, ...(body ? ['--input', '-'] : [])], body && JSON.stringify(body));
  return out.trim() ? JSON.parse(out) : {};
};
const tryApi = (...args) => {
  try {
    return api(...args);
  } catch {
    return undefined;
  }
};

const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
const info = api(`repos/${repo}`);
const isPublic = info.visibility === 'public';
const diffs = [];
const want = (label, ok, fix) => {
  if (ok) return;
  diffs.push(label);
  if (apply) fix();
};

// Merging, and what GitHub scans.
want(
  'squash or rebase merges only, branch deleted once merged, auto-merge off',
  !info.allow_merge_commit && info.allow_squash_merge && info.allow_rebase_merge && info.delete_branch_on_merge &&
    !info.allow_auto_merge,
  () =>
    api(`repos/${repo}`, 'PATCH', {
      allow_merge_commit: false,
      allow_squash_merge: true,
      allow_rebase_merge: true,
      delete_branch_on_merge: true,
      allow_auto_merge: false,
      squash_merge_commit_title: 'PR_TITLE',
      squash_merge_commit_message: 'PR_BODY',
    }),
);
if (isPublic) {
  const sa = info.security_and_analysis ?? {};
  const on = (key) => sa[key]?.status === 'enabled';
  want(
    'secret scanning, push protection and validity checks on',
    on('secret_scanning') && on('secret_scanning_push_protection') && on('secret_scanning_validity_checks'),
    () =>
      api(`repos/${repo}`, 'PATCH', {
        security_and_analysis: {
          secret_scanning: { status: 'enabled' },
          secret_scanning_push_protection: { status: 'enabled' },
          secret_scanning_validity_checks: { status: 'enabled' },
          secret_scanning_non_provider_patterns: { status: 'enabled' },
        },
      }),
  );
  want(
    'private vulnerability reporting on',
    tryApi(`repos/${repo}/private-vulnerability-reporting`)?.enabled === true,
    () => api(`repos/${repo}/private-vulnerability-reporting`, 'PUT'),
  );
  want(
    'CodeQL by its workflow (.github/workflows/codeql.yml), not default setup',
    tryApi(`repos/${repo}/code-scanning/default-setup`)?.state !== 'configured',
    () => api(`repos/${repo}/code-scanning/default-setup`, 'PATCH', { state: 'not-configured' }),
  );
}
want('Dependabot alerts on', tryApi(`repos/${repo}/vulnerability-alerts`) !== undefined, () =>
  api(`repos/${repo}/vulnerability-alerts`, 'PUT'),
);
want(
  'Dependabot security updates on',
  info.security_and_analysis?.dependabot_security_updates?.status === 'enabled',
  () => api(`repos/${repo}/automated-security-fixes`, 'PUT'),
);
want('releases immutable once published', tryApi(`repos/${repo}/immutable-releases`)?.enabled === true, () =>
  api(`repos/${repo}/immutable-releases`, 'PUT'),
);

// Rulesets: main, and the release tags.
const ADMIN = 5; // the repository admin role
const rulesets = {
  main: {
    name: 'main',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: ADMIN, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_linear_history' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: true,
          require_code_owner_review: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['squash', 'rebase'],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: 'Checks' }, { context: 'Security' }],
        },
      },
      ...(isPublic
        ? [
            {
              type: 'code_scanning',
              parameters: {
                code_scanning_tools: [
                  { tool: 'CodeQL', security_alerts_threshold: 'high_or_higher', alerts_threshold: 'errors' },
                ],
              },
            },
          ]
        : []),
    ],
  },
  'release tags': {
    name: 'release tags',
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    bypass_actors: [],
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }],
  },
};
const existing = tryApi(`repos/${repo}/rulesets?includes_parents=false`) ?? [];
for (const [name, body] of Object.entries(rulesets)) {
  const found = existing.find((r) => r.name === name || r.name.startsWith(`${name}:`));
  const current = found && api(`repos/${repo}/rulesets/${found.id}`);
  const same =
    current &&
    current.enforcement === body.enforcement &&
    JSON.stringify(current.rules.map((r) => r.type).sort()) === JSON.stringify(body.rules.map((r) => r.type).sort()) &&
    JSON.stringify(current.bypass_actors ?? []) === JSON.stringify(body.bypass_actors);
  want(`ruleset "${name}" as the standard says`, same, () =>
    found ? api(`repos/${repo}/rulesets/${found.id}`, 'PUT', body) : api(`repos/${repo}/rulesets`, 'POST', body),
  );
}

if (!diffs.length) console.log(`${repo}: every setting as the standard says.`);
else {
  console.log(`${repo}: ${apply ? 'set' : 'differs'}:\n  ${diffs.join('\n  ')}`);
  if (!apply) console.log('Run `pnpm github:settings --apply` to set them.');
}
