/**
 * expert-review-required enforcer tests
 *
 * Spawns the Python enforcer against a throwaway git repo and asserts the
 * allow (exit 0) / block (exit 2) contract: ship actions are blocked until a
 * review artifact exists for the branch and covers HEAD.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENFORCER = join(
  process.cwd(),
  'src',
  'policies',
  'enforcers',
  'expert_review_required.py'
);

/**
 * A copy of the environment with all GIT_* variables stripped. Git hooks (e.g.
 * pre-push, which runs this suite) export GIT_DIR / GIT_WORK_TREE /
 * GIT_INDEX_FILE; if those leak into the nested `git init` below it operates on
 * the wrong repo and fails (status 128). Run the throwaway-repo git ops and the
 * enforcer in a clean git environment.
 */
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

describe('expert-review-required enforcer', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'uap-review-gate-'));
    git(repo, ['init', '-q']);
    git(repo, ['checkout', '-q', '-b', 'feature/x']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('blocks git commit when no review artifact exists', () => {
    expect(runEnforcer(repo, 'git commit -m "wip"')).toBe(2);
  });

  /** Branch `feature/x` → injective slug `feature%2Fx`. */
  function writeReview(data: Record<string, unknown>): void {
    mkdirSync(join(repo, '.uap', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.uap', 'reviews', 'feature%2Fx.json'), JSON.stringify(data));
  }

  it('allows the ship action once a review artifact exists for the branch', () => {
    writeReview({ verdict: 'approve', reviewers: ['code-quality-reviewer'] });
    expect(runEnforcer(repo, 'git commit -m "done"')).toBe(0);
  });

  it('blocks git merge without a review artifact', () => {
    expect(runEnforcer(repo, 'git merge origin/master')).toBe(2);
  });

  it('does not collide distinct refs onto one slug (feature/x vs feature-x)', () => {
    // A review written for the sibling ref `feature-x` must NOT satisfy `feature/x`.
    mkdirSync(join(repo, '.uap', 'reviews'), { recursive: true });
    writeFileSync(
      join(repo, '.uap', 'reviews', 'feature-x.json'),
      JSON.stringify({ verdict: 'approve' })
    );
    expect(runEnforcer(repo, 'git commit -m x')).toBe(2);
  });

  it('rejects an artifact that records a different branch', () => {
    writeReview({ verdict: 'approve', branch: 'feature/other' });
    expect(runEnforcer(repo, 'git commit -m x')).toBe(2);
  });

  it('does not block read-only commands containing the word "merge"', () => {
    // bug_001 regression guard: bare "merge"/"signoff" tokens must not trip the gate.
    expect(runEnforcer(repo, 'git diff --merge-base origin/master HEAD')).toBe(0);
    expect(runEnforcer(repo, 'rg merge src/')).toBe(0);
    expect(runEnforcer(repo, 'cat docs/merge-strategy.md')).toBe(0);
  });

  it('honors the UAP_NO_REVIEW override', () => {
    expect(runEnforcer(repo, 'git push', { UAP_NO_REVIEW: '1' })).toBe(0);
  });

  it('honors an inline UAP_NO_REVIEW=1 prefix (the hook strips the env)', () => {
    // The policy-gate hook runs in the harness env, so an EXPORTED override
    // never reaches a hook-spawned enforcer; the inline assignment on the ship
    // command is the only form that can. A non-1 value or look-alike var must
    // NOT bypass.
    expect(runEnforcer(repo, 'UAP_NO_REVIEW=1 git push')).toBe(0);
    expect(runEnforcer(repo, 'UAP_NO_REVIEW=0 git push')).toBe(2);
    expect(runEnforcer(repo, 'UAP_NO_REVIEWS=1 git push')).toBe(2);
    // Anchored to a LEADING assignment: an incidental mention inside a quoted
    // arg / commit message must NOT bypass review.
    expect(runEnforcer(repo, 'git commit -m "note: never set UAP_NO_REVIEW=1"')).toBe(2);
    // But a preceding unrelated env assignment is still a valid leading run.
    expect(runEnforcer(repo, 'FOO=bar UAP_NO_REVIEW=1 git push')).toBe(0);
  });

  it('ignores non-ship commands', () => {
    expect(runEnforcer(repo, 'ls -la')).toBe(0);
  });
});

describe('expert-review-required: risk-scope + file waiver', () => {
  let repo: string;

  /** A repo with a `master` base commit and a `feature/x` branch we add to. */
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'uap-review-scope-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t.dev']);
    git(repo, ['config', 'user.name', 't']);
    git(repo, ['checkout', '-q', '-b', 'master']);
    writeFileSync(join(repo, 'README.md'), '# base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    git(repo, ['checkout', '-q', '-b', 'feature/x']);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function add(path: string, content = 'x'): void {
    const full = join(repo, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `add ${path}`]);
  }

  it('ALLOWS gh pr merge for a frontend-only diff (no review artifact)', () => {
    add('src/components/Button.tsx', 'export const B = () => null;');
    add('src/styles/app.css', '.b{color:var(--x);}');
    add('docs/guide.md', '# guide');
    expect(runEnforcer(repo, 'gh pr merge 12 --merge --admin')).toBe(0);
  });

  it('STILL BLOCKS when the diff touches IaC (.tf)', () => {
    add('src/components/Button.tsx', 'export const B = () => null;');
    add('infra/terraform/main.tf', 'resource "null_resource" "x" {}');
    expect(runEnforcer(repo, 'gh pr merge 12 --merge')).toBe(2);
  });

  it('STILL BLOCKS for a CI workflow change (low-risk ext, high-risk path)', () => {
    add('.github/workflows/deploy.yml', 'on: push');
    expect(runEnforcer(repo, 'gh pr merge 12 --merge')).toBe(2);
  });

  it('STILL BLOCKS for substantive backend src changes', () => {
    add('src/server/handler.ts', 'export function h(){return 1;}');
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('file waiver (policies/waivers/*expert-review*.md) bypasses without env vars', () => {
    add('src/server/handler.ts', 'export function h(){return 2;}');
    expect(runEnforcer(repo, 'gh pr merge 12 --merge')).toBe(2);
    add('policies/waivers/2026-frontend-expert-review.md', '# waiver');
    expect(runEnforcer(repo, 'gh pr merge 12 --merge')).toBe(0);
  });

  it('.uap/reviews/WAIVER marker also bypasses', () => {
    add('src/server/handler.ts', 'export function h(){return 3;}');
    add('.uap/reviews/WAIVER', 'frontend sprint');
    expect(runEnforcer(repo, 'git push')).toBe(0);
  });
});
