/**
 * expert-review-required must resolve the branch from the WORKING TREE the ship
 * op runs in (the worktree), not the main checkout. Regression for the bug where
 * every worktree commit/push demanded a review for the main checkout's branch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'expert_review_required.py');
const dirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return (r.stdout || '').trim();
}

/** A throwaway git repo with one commit on `branch`, touching a policy file so
 * the change is NOT low-risk (which would skip review). */
function repo(branch: string): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-rev-'));
  dirs.push(d);
  git(d, 'init', '-q');
  git(d, 'config', 'user.email', 't@t');
  git(d, 'config', 'user.name', 't');
  git(d, 'checkout', '-q', '-b', branch);
  mkdirSync(join(d, 'src', 'policies'), { recursive: true });
  writeFileSync(join(d, 'src', 'policies', 'x.py'), '# policy\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runPush(repoRoot: string, worktreeRoot: string): { allowed: boolean; reason: string } {
  const r = spawnSync(
    'python3',
    [ENFORCER, '--operation', 'Bash', '--args', JSON.stringify({ command: 'git push origin HEAD' })],
    { env: { ...process.env, UAP_REPO_ROOT: repoRoot, UAP_WORKTREE_ROOT: worktreeRoot, UAP_NO_REVIEW: '' }, encoding: 'utf8' }
  );
  let parsed: { allowed?: boolean; reason?: string } = {};
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    /* leave empty */
  }
  return { allowed: parsed.allowed ?? true, reason: parsed.reason ?? '' };
}

describe('expert-review-required worktree branch resolution', () => {
  it('demands a review for the WORKTREE branch, not the main-checkout branch', () => {
    const main = repo('main-branch');
    const worktree = repo('feature-branch');
    const res = runPush(main, worktree);
    expect(res.allowed).toBe(false);
    // The artifact path must name the worktree's branch, never the main one.
    expect(res.reason).toContain('feature-branch.json');
    expect(res.reason).not.toContain('main-branch');
  });

  it('passes when a review artifact exists for the WORKTREE branch + HEAD', () => {
    const main = repo('main-branch');
    const worktree = repo('feature-branch');
    const head = git(worktree, 'rev-parse', 'HEAD');
    mkdirSync(join(worktree, '.uap', 'reviews'), { recursive: true });
    writeFileSync(
      join(worktree, '.uap', 'reviews', 'feature-branch.json'),
      JSON.stringify({ head, branch: 'feature-branch', verdict: 'approve', reviewers: ['code', 'security', 'arch'] })
    );
    const res = runPush(main, worktree);
    expect(res.allowed).toBe(true);
  });
});
