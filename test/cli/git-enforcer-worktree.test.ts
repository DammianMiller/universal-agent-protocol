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

// Hermetic env: when this suite runs inside a git hook (pre-push gates), git
// exports GIT_DIR/GIT_WORK_TREE/… which would redirect every spawned git call
// at the hook's repo instead of the temp repo. Strip them for all spawns.
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) {
    delete env[k];
  }
  return env;
}

function makeWorktreeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-wt-'));
  spawnSync('git', ['init', '-q', d], { env: cleanEnv() });
  spawnSync('git', ['-C', d, 'config', 'user.email', 't@t'], { env: cleanEnv() });
  spawnSync('git', ['-C', d, 'config', 'user.name', 't'], { env: cleanEnv() });
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
  spawnSync('git', ['-C', wtRoot, 'add', '-A'], { env: cleanEnv() });
}

function runIacParity(enfDir: string, wtRoot: string, command: string): number {
  return spawnSync(
    'python3',
    [join(enfDir, 'iac_parity.py'), '--operation', 'Bash', '--args', JSON.stringify({ command })],
    {
      // gate sets these; MAIN_ROOT (UAP_REPO_ROOT) intentionally differs from the working tree
      env: cleanEnv({ UAP_WORKTREE_ROOT: wtRoot, UAP_REPO_ROOT: '/nonexistent-main-root' }),
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

  it('still BLOCKS when invoked with hook-style GIT_DIR poisoning (regression)', () => {
    // Simulate running inside a git hook of a DIFFERENT repo: the enforcer
    // must strip git repo-context vars, or its git calls silently target the
    // hook's repo and the check no-ops (expected 2, got 0 — the pre-push bug).
    writeFileSync(join(wt, 'app.ts'), 'export const x = 1;\n');
    stageAll(wt);
    const status = spawnSync(
      'python3',
      [join(enf, 'iac_parity.py'), '--operation', 'Bash', '--args', JSON.stringify({ command: 'kubectl apply -f deploy.yaml' })],
      {
        env: cleanEnv({
          UAP_WORKTREE_ROOT: wt,
          UAP_REPO_ROOT: '/nonexistent-main-root',
          GIT_DIR: join(process.cwd(), '.git'),
        }),
        cwd: '/',
        encoding: 'utf8',
      }
    ).status ?? -1;
    expect(status).toBe(2);
  });
});
