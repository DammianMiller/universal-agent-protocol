/**
 * git-diff enforcers run against the working tree (UAP_WORKTREE_ROOT)
 *
 * Limitation fixed: test-gate/schema-diff/iac-parity ran `git` with cwd =
 * repo_root() = MAIN_ROOT. In this bare-repo layout MAIN_ROOT is bare, so git
 * failed and the enforcers no-op'd (never actually checked anything). They now
 * use worktree_root() (UAP_WORKTREE_ROOT, set by the gate to the current
 * checkout) so git runs against the real working tree.
 *
 * Uses the real iac_parity enforcer against a throwaway git repo standing in for
 * a worktree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENF_DIR = join(process.cwd(), 'src', 'policies', 'enforcers');

function makeWorktreeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-wt-'));
  spawnSync('git', ['init', '-q', d]);
  spawnSync('git', ['-C', d, 'config', 'user.email', 't@t']);
  spawnSync('git', ['-C', d, 'config', 'user.name', 't']);
  return d;
}

function makeEnforcerDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-enf-'));
  copyFileSync(join(ENF_DIR, 'iac_parity.py'), join(d, 'iac_parity.py'));
  copyFileSync(join(ENF_DIR, '_common.py'), join(d, '_common.py'));
  return d;
}

function stageAll(wtRoot: string): void {
  // git status --porcelain collapses untracked directories to "?? dir/"; staging
  // surfaces full paths, matching how tracked IaC files appear in real diffs.
  spawnSync('git', ['-C', wtRoot, 'add', '-A']);
}

function runIacParity(enfDir: string, wtRoot: string, command: string): number {
  return spawnSync(
    'python3',
    [join(enfDir, 'iac_parity.py'), '--operation', 'Bash', '--args', JSON.stringify({ command })],
    {
      // gate sets these; MAIN_ROOT (UAP_REPO_ROOT) intentionally differs from the working tree
      env: { ...process.env, UAP_WORKTREE_ROOT: wtRoot, UAP_REPO_ROOT: '/nonexistent-main-root' },
      cwd: '/', // prove resolution comes from the env var, not cwd
      encoding: 'utf8',
    }
  ).status ?? -1;
}

describe('git-diff enforcers target the working tree', () => {
  let wt: string;
  let enf: string;
  beforeEach(() => { wt = makeWorktreeRepo(); enf = makeEnforcerDir(); });
  afterEach(() => { rmSync(wt, { recursive: true, force: true }); rmSync(enf, { recursive: true, force: true }); });

  it('BLOCKS a live-state mutation when the worktree has no matching IaC diff', () => {
    // a non-IaC change present in the working tree
    writeFileSync(join(wt, 'app.ts'), 'export const x = 1;\n');
    stageAll(wt);
    expect(runIacParity(enf, wt, 'kubectl apply -f deploy.yaml')).toBe(2);
  });

  it('ALLOWS the mutation when a matching IaC diff is present in the worktree', () => {
    mkdirSync(join(wt, 'infra', 'terraform'), { recursive: true });
    writeFileSync(join(wt, 'infra', 'terraform', 'main.tf'), 'resource "x" "y" {}\n');
    stageAll(wt);
    expect(runIacParity(enf, wt, 'kubectl apply -f deploy.yaml')).toBe(0);
  });

  it('ALLOWS non-mutating commands regardless of tree state', () => {
    writeFileSync(join(wt, 'app.ts'), 'export const x = 1;\n');
    expect(runIacParity(enf, wt, 'kubectl get pods')).toBe(0);
  });
});
