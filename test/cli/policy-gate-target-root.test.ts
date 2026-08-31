/**
 * F4 (deliver-hardening 2026-07-13): the policy gate anchors MAIN_ROOT on the
 * operation's TARGET file, not the hook's cwd.
 *
 * Before the fix, CHECKOUT_ROOT was derived only from a leading `cd` in a Bash
 * command or the payload's cwd — Edit/Write `file_path` was never consulted.
 * A cross-repo write was therefore judged by the SOURCE repo's posture: the
 * target repo's policies.db was never opened (its policies silently skipped)
 * and compliance state landed in the wrong `.uap`. Regression test (6) from
 * the plan: "cross-repo write meets the TARGET repo's policy state."
 *
 * These tests run the real gate end-to-end with two real git repos:
 *   - source: the agent's cwd — deliberately NO policies.db (fail-open there)
 *   - target: holds a policies.db whose spy enforcer BLOCKS and records the
 *     env it was handed (UAP_STATE_DIR / UAP_REPO_ROOT must be target-anchored)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const GATE = join(process.cwd(), 'templates', 'hooks', 'uap-policy-gate.sh');
const BLOCK = 2;
const ALLOW = 0;

function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  delete env.UAP_STATE_DIR;
  delete env.UAP_REPO_ROOT;
  delete env.UAP_WORKTREE_ROOT;
  return env;
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
}

/** A git repo with NO policies.db: the gate fails open here. */
function makeSourceRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'uap-f4-src-'));
  git(repo, ['init', '-b', 'main']);
  return repo;
}

/**
 * A git repo whose policy DB routes every op to a spy enforcer that records
 * the state env it received and then BLOCKS — proof the target repo's policy
 * actually ran (and with the target repo's state paths).
 */
function makeTargetRepo(marker: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'uap-f4-tgt-'));
  git(repo, ['init', '-b', 'main']);
  mkdirSync(join(repo, 'agents', 'data', 'memory'), { recursive: true });
  mkdirSync(join(repo, '.policy-tools'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });

  const db = join(repo, 'agents', 'data', 'memory', 'policies.db');
  const sql =
    'CREATE TABLE policies(id TEXT, name TEXT, isActive INT, priority INT);' +
    'CREATE TABLE executable_tools(policyId TEXT, toolName TEXT);' +
    "INSERT INTO policies VALUES('p1','target-only-block',1,50);" +
    "INSERT INTO executable_tools VALUES('p1','spy');";
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sqlite3 setup failed: ' + r.stderr);

  writeFileSync(
    join(repo, '.policy-tools', 'p1_spy.py'),
    [
      'import json, os',
      'with open(os.environ["SPY_MARKER"], "w") as fh:',
      '    json.dump({',
      '        "state": os.environ.get("UAP_STATE_DIR"),',
      '        "root": os.environ.get("UAP_REPO_ROOT"),',
      '        "worktree": os.environ.get("UAP_WORKTREE_ROOT"),',
      '    }, fh)',
      'print(json.dumps({"allowed": False, "reason": "target repo policy says no"}))',
      '',
    ].join('\n')
  );
  return repo;
}

function runGate(
  cwd: string,
  payload: object,
  env: Record<string, string> = {}
): { status: number; stderr: string } {
  const r = spawnSync('bash', [GATE], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(env),
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? '' };
}

describe('policy gate: target-path anchoring (F4)', () => {
  let source: string;
  let target: string;
  let marker: string;

  beforeEach(() => {
    source = makeSourceRepo();
    marker = join(mkdtempSync(join(tmpdir(), 'uap-f4-mark-')), 'spy.json');
    target = makeTargetRepo(marker);
  });

  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(join(marker, '..'), { recursive: true, force: true });
  });

  const writeIntoTarget = () =>
    runGate(
      source,
      { tool_name: 'Write', tool_input: { file_path: join(target, 'src', 'x.ts') }, cwd: source },
      { SPY_MARKER: marker }
    );

  it("a cross-repo write meets the TARGET repo's policy (blocked by it)", () => {
    const r = writeIntoTarget();
    // Before F4 the gate anchored on `source` (the cwd), found no policies.db,
    // and exited 0 without the target repo's policy ever running.
    expect(r.status, 'the target repo policy must judge the write').toBe(BLOCK);
    expect(r.stderr).toMatch(/target repo policy says no/);
  });

  it('hands the enforcer the TARGET repo state paths', () => {
    writeIntoTarget();
    expect(existsSync(marker), 'spy enforcer must have run').toBe(true);
    const seen = JSON.parse(readFileSync(marker, 'utf8'));
    expect(seen.root).toBe(target);
    expect(seen.worktree).toBe(target);
    expect(seen.state, 'enforcer state must anchor to the target repo .uap').toBe(
      join(target, '.uap')
    );
  });

  it('path-less ops still anchor on cwd (source repo fails open)', () => {
    const r = runGate(
      source,
      { tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: source },
      { SPY_MARKER: marker }
    );
    expect(r.status).toBe(ALLOW);
    expect(existsSync(marker), "the target repo's enforcer must NOT run for a path-less op").toBe(
      false
    );
  });

  it('a relative file_path resolves against the payload cwd', () => {
    const r = runGate(
      target,
      { tool_name: 'Edit', tool_input: { file_path: 'src/x.ts', old_string: 'a', new_string: 'b' }, cwd: target },
      // A 2-char edit is "trivial" and would exit via the fast-path before the
      // enforcer loop; anchoring is what is under test here, not triviality.
      { SPY_MARKER: marker, UAP_DELIVER_FASTPATH: 'off' }
    );
    expect(r.status, 'relative target path must still meet the target policy').toBe(BLOCK);
  });
});
