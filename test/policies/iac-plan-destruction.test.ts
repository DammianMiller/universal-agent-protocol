/**
 * iac-plan-destruction-check enforcer tests
 *
 * Spawns the Python enforcer against a throwaway git repo and asserts the
 * allow (exit 0) / block (exit 2) contract.
 *
 * The regression under test: the gate parses the PR number out of a merge
 * command and inspects that PR's files to decide whether infra/terraform is
 * touched. It used to run `gh pr view <N>` with no repo selector, so a
 * cross-repo `gh pr merge <N> --repo owner/name` resolved the number against
 * the LOCAL checkout. That miss fell back to scanning the local working tree —
 * so an unrelated untracked terraform file blocked a merge that touched no
 * infrastructure at all, and a genuinely infra-touching PR in another repo was
 * waved through whenever the local tree happened to be clean.
 *
 * Each case is set up so it can only pass when the repo selector is forwarded:
 * the local-tree trap is armed ONLY where its absence would mask the bug.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENFORCER = join(
  process.cwd(),
  'src',
  'policies',
  'enforcers',
  'iac_plan_destruction_check.py'
);

/** Environment minus all GIT_* vars — see expert-review-required.test.ts. */
function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
}

/**
 * Reproduce the local-tree trap: an untracked *.tf inside an ALREADY-TRACKED
 * infra/terraform. The tracked parent matters — with nothing committed under
 * it, `git status --porcelain` collapses the lot to `?? infra/` and the
 * local-tree scan never sees a terraform path, which would make these cases
 * pass for the wrong reason.
 */
function armLocalTerraformTrap(repo: string): void {
  writeFileSync(join(repo, 'infra', 'terraform', 'unrelated.tf'), '# noise\n');
}

/**
 * A stub `gh` on PATH that answers `pr view` only when handed the expected
 * repo selector. That is what lets these tests observe whether the enforcer
 * forwarded `--repo`.
 */
function installGhStub(dir: string, script: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, 'gh');
  writeFileSync(gh, script);
  chmodSync(gh, 0o755);
  return bin;
}

/** gh stub: return `files` when the selector matches `repo`, else fail. */
function ghStubFor(repo: string, files: string): string {
  return `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "${repo}" ]; then echo "${files}"; exit 0; fi
done
echo "could not resolve to a PullRequest" >&2
exit 1
`;
}

/** Run the enforcer; returns its exit code (0 = allow, 2 = block). */
function runEnforcer(
  repo: string,
  command: string,
  env: Record<string, string> = {}
): number {
  const res = spawnSync(
    'python3',
    [ENFORCER, '--operation', 'Bash', '--args', JSON.stringify({ command })],
    { cwd: repo, env: cleanGitEnv({ UAP_REPO_ROOT: repo, ...env }) }
  );
  return res.status ?? -1;
}

describe('iac-plan-destruction-check enforcer', () => {
  let repo: string;
  let bin: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'uap-iac-gate-'));
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'README.md'), '# test\n');
    mkdirSync(join(repo, 'infra', 'terraform'), { recursive: true });
    writeFileSync(join(repo, 'infra', 'terraform', 'existing.tf'), '# tracked\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'init']);
    bin = '';
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function withGh(script: string): Record<string, string> {
    bin = installGhStub(repo, script);
    return { PATH: `${bin}:${process.env.PATH}` };
  }

  it('allows a cross-repo merge whose PR touches no terraform', () => {
    // Trap armed: without the selector the lookup misses, the gate falls back
    // to the local tree, finds unrelated.tf, and blocks a docs-only merge.
    armLocalTerraformTrap(repo);
    const env = withGh(ghStubFor('other/repo', 'docs/guide.md'));
    expect(runEnforcer(repo, 'gh pr merge 591 --repo other/repo --squash', env)).toBe(0);
  });

  it('blocks a cross-repo merge whose PR does touch terraform', () => {
    // Trap deliberately NOT armed: a block here can only come from the PR
    // lookup succeeding, which requires the selector to have been forwarded.
    const env = withGh(ghStubFor('other/repo', 'infra/terraform/main.tf'));
    expect(runEnforcer(repo, 'gh pr merge 591 --repo other/repo --squash', env)).toBe(2);
  });

  it('accepts the -R short flag', () => {
    const env = withGh(ghStubFor('acme/widgets', 'infra/terraform/vpc.tf'));
    expect(runEnforcer(repo, 'gh pr merge 7 -R acme/widgets --squash', env)).toBe(2);
  });

  it('reads the repo out of a gh api merge path', () => {
    const env = withGh(ghStubFor('acme/widgets', 'infra/terraform/vpc.tf'));
    expect(
      runEnforcer(repo, 'gh api repos/acme/widgets/pulls/2904/merge -X PUT', env)
    ).toBe(2);
  });

  it('leaves same-repo merges resolving against the local checkout', () => {
    // No selector in the command, so none should be passed through.
    const env = withGh(`#!/bin/sh
case "$*" in
  *--repo*) echo "unexpected --repo" >&2; exit 3 ;;
esac
echo "docs/guide.md"
`);
    expect(runEnforcer(repo, 'gh pr merge 2904 --squash', env)).toBe(0);
  });

  it('honours the ack env override', () => {
    expect(
      runEnforcer(repo, 'terraform apply -auto-approve', { UAP_IAC_PLAN_REVIEWED: '1' })
    ).toBe(0);
  });

  it('still blocks a bare terraform apply with no ack', () => {
    expect(runEnforcer(repo, 'terraform apply -auto-approve')).toBe(2);
  });
});
