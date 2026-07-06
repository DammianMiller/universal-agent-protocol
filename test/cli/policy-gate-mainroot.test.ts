/**
 * Policy gate — main-root resolution (works correctly from inside a worktree)
 *
 * Finding #2: uap-policy-gate.sh resolved policies.db + enforcers against the
 * per-worktree checkout root. policies.db lives ONLY in the main checkout, so the
 * gate found no DB when a tool ran from inside a worktree and silently skipped ALL
 * policy enforcement. A naive fix (just finding the DB) would then run enforcers
 * with repo_root pointing at the worktree — making worktree-required mis-resolve a
 * legitimate worktree edit as a root edit and FALSE-BLOCK it.
 *
 * The fix anchors DB + enforcer paths to MAIN_ROOT and exports UAP_REPO_ROOT=MAIN_ROOT
 * so path-relative enforcers reason about the project root that *contains* the
 * worktrees. These tests run the gate end-to-end from a worktree cwd using the real
 * worktree_required enforcer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = process.cwd();
const GATE_SRC = join(REPO, 'templates', 'hooks', 'uap-policy-gate.sh');
const POLICY_TOOLS = join(REPO, '.policy-tools');
const WT_ENFORCER_SRC = join(
  POLICY_TOOLS,
  readdirSync(POLICY_TOOLS).find((f) => f.endsWith('_worktree_required.py'))!
);
const COMMON_SRC = join(POLICY_TOOLS, '_common.py');

function makeProject(): string {
  const proj = mkdtempSync(join(tmpdir(), 'uap-pgate-'));
  // A worktree is unsatisfiable without git, so the enforcer fails open on a
  // non-git project (avoids a create-worktree deadlock loop). Give the fixture a
  // .git so the worktree guard actually engages and can be exercised here.
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(join(proj, 'agents', 'data', 'memory'), { recursive: true });
  mkdirSync(join(proj, '.policy-tools'), { recursive: true });
  mkdirSync(join(proj, '.factory', 'hooks'), { recursive: true });
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, '.worktrees', 'wt', '.factory', 'hooks'), { recursive: true });
  mkdirSync(join(proj, '.worktrees', 'wt', 'src'), { recursive: true });

  const db = join(proj, 'agents', 'data', 'memory', 'policies.db');
  const sql =
    'CREATE TABLE policies(id TEXT, name TEXT, isActive INT);' +
    'CREATE TABLE executable_tools(policyId TEXT, toolName TEXT);' +
    "INSERT INTO policies VALUES('p1','worktree-required',1);" +
    "INSERT INTO executable_tools VALUES('p1','wt');";
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sqlite3 setup failed: ' + r.stderr);

  // Deploy the REAL enforcer (+ its _common helper) as p1_wt.py
  copyFileSync(WT_ENFORCER_SRC, join(proj, '.policy-tools', 'p1_wt.py'));
  copyFileSync(COMMON_SRC, join(proj, '.policy-tools', '_common.py'));
  copyFileSync(GATE_SRC, join(proj, '.factory', 'hooks', 'uap-policy-gate.sh'));
  copyFileSync(GATE_SRC, join(proj, '.worktrees', 'wt', '.factory', 'hooks', 'uap-policy-gate.sh'));
  return proj;
}

function runGate(cwd: string, payload: object): number {
  const hook = join(cwd, '.factory', 'hooks', 'uap-policy-gate.sh');
  return spawnSync('bash', [hook], { input: JSON.stringify(payload), cwd, encoding: 'utf8' }).status ?? -1;
}

describe('policy gate: correct enforcement from inside a worktree', () => {
  let proj: string;
  beforeEach(() => { proj = makeProject(); });
  afterEach(() => rmSync(proj, { recursive: true, force: true }));

  it('does NOT false-block a legitimate worktree edit run from a worktree cwd', () => {
    const wt = join(proj, '.worktrees', 'wt');
    // Before the fix this returned 2 (worktree_required resolved repo_root to the
    // worktree, so the edit looked like a root edit).
    expect(runGate(wt, { tool_name: 'Write', tool_input: { file_path: join(wt, 'src', 'x.ts') } })).toBe(0);
  });

  it('ENFORCES a root-dir edit from a worktree cwd (was silently skipped: no DB)', () => {
    const wt = join(proj, '.worktrees', 'wt');
    expect(runGate(wt, { tool_name: 'Write', tool_input: { file_path: join(proj, 'src', 'x.ts') } })).toBe(2);
  });

  it('allows non-edit operations', () => {
    const wt = join(proj, '.worktrees', 'wt');
    expect(runGate(wt, { tool_name: 'Bash', tool_input: { command: 'echo hi' } })).toBe(0);
  });
});
