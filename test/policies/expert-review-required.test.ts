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

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
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
    { cwd: repo, env: { ...process.env, UAP_REPO_ROOT: repo, ...env } }
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

  it('allows the ship action once a review artifact exists for the branch', () => {
    mkdirSync(join(repo, '.uap', 'reviews'), { recursive: true });
    // slug = branch with '/' -> '-'
    writeFileSync(
      join(repo, '.uap', 'reviews', 'feature-x.json'),
      JSON.stringify({ verdict: 'approve', reviewers: ['code-quality-reviewer'] })
    );
    expect(runEnforcer(repo, 'git commit -m "done"')).toBe(0);
  });

  it('honors the UAP_NO_REVIEW override', () => {
    expect(runEnforcer(repo, 'git push', { UAP_NO_REVIEW: '1' })).toBe(0);
  });

  it('ignores non-ship commands', () => {
    expect(runEnforcer(repo, 'ls -la')).toBe(0);
  });
});
