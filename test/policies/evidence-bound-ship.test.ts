/**
 * evidence-bound-ship enforcer tests (uplift 1.4).
 *
 * Spawns the Python enforcer against a throwaway git repo and asserts the
 * allow (exit 0) / block (exit 2) contract: ship actions are blocked unless
 * `.uap/evidence/<head-sha>.json` exists, is well-formed, is bound to the
 * CURRENT HEAD, is fresher than the staleness window, and records at least one
 * genuinely passing gate.
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
  'evidence_bound_ship.py'
);

/**
 * A copy of the environment with all inherited GIT_* variables stripped — a
 * host git hook exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE, which would
 * silently redirect the fixture repo. Explicit `extra` GIT_* keys (e.g.
 * committer dates for the staleness cases) are merged AFTER the strip so they
 * survive on purpose.
 */
function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return Object.assign(env, extra);
}

function git(repo: string, args: string[], extra: Record<string, string> = {}): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv(extra) });
}

function headSha(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf-8',
    env: cleanGitEnv(),
  }).trim();
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

function validEvidence(sha: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    candidateSha: sha,
    recordedAt: new Date().toISOString(),
    gates: [
      {
        name: 'test',
        command: 'npm test',
        exitCode: 0,
        outputTail: '5 passed',
        at: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function writeEvidence(repo: string, sha: string, data: Record<string, unknown>): void {
  mkdirSync(join(repo, '.uap', 'evidence'), { recursive: true });
  writeFileSync(join(repo, '.uap', 'evidence', `${sha}.json`), JSON.stringify(data));
}

describe('evidence-bound-ship enforcer', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'uap-evidence-gate-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t.dev']);
    git(repo, ['config', 'user.name', 't']);
    git(repo, ['checkout', '-q', '-b', 'feature/x']);
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('blocks a ship action when no evidence artifact exists', () => {
    expect(runEnforcer(repo, 'git commit -m "wip"')).toBe(2);
    expect(runEnforcer(repo, 'git push')).toBe(2);
    expect(runEnforcer(repo, 'gh pr create --fill')).toBe(2);
  });

  it('blocks on a malformed (non-JSON) artifact', () => {
    mkdirSync(join(repo, '.uap', 'evidence'), { recursive: true });
    writeFileSync(join(repo, '.uap', 'evidence', `${headSha(repo)}.json`), '{not json');
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('blocks on an oversized artifact (>512KB) without parsing it', () => {
    // A deliver-written artifact is a few KB; a near-megabyte file named like
    // one is a payload, not evidence. The read is capped BEFORE JSON parsing.
    mkdirSync(join(repo, '.uap', 'evidence'), { recursive: true });
    const pad = '"' + 'x'.repeat(600 * 1024) + '"';
    writeFileSync(join(repo, '.uap', 'evidence', `${headSha(repo)}.json`), `{"version":1,"pad":${pad}}`);
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('blocks on an unsupported schema version', () => {
    writeEvidence(repo, headSha(repo), validEvidence(headSha(repo), { version: 2 }));
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('blocks when the artifact is bound to a DIFFERENT commit (forged/stale)', () => {
    const oldSha = headSha(repo);
    writeFileSync(join(repo, 'g.txt'), 'y\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'second']);
    expect(headSha(repo)).not.toBe(oldSha);
    // Evidence exists, named for the CURRENT head, but proving the OLD one.
    writeEvidence(repo, headSha(repo), validEvidence(oldSha));
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('blocks stale evidence (recordedAt older than the 24h window) — and ONLY staleness fires', () => {
    // The commit itself is made 72h in the past, so a 48h-old recordedAt
    // POSTDATES the commit: the backdating check cannot fire, and this test
    // pins the staleness check alone (a 48h-old stamp on a FRESH commit blocks
    // either way — a surviving-mutant trap the old version of this test fell
    // into). cleanGitEnv strips inherited GIT_* but merges `extra` after, so
    // the explicit committer/author dates below survive on purpose.
    const seventyTwoHoursAgo = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    writeFileSync(join(repo, 'old.txt'), 'old\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'old commit'], {
      GIT_AUTHOR_DATE: seventyTwoHoursAgo,
      GIT_COMMITTER_DATE: seventyTwoHoursAgo,
    });
    const stale = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    writeEvidence(repo, headSha(repo), validEvidence(headSha(repo), { recordedAt: stale }));
    // 48h old, default 24h window -> BLOCK on staleness specifically.
    expect(runEnforcer(repo, 'git push')).toBe(2);
    // Same artifact inside a 72h window -> ALLOWED, proving the block above
    // was staleness and not some other check.
    expect(runEnforcer(repo, 'git push', { UAP_EVIDENCE_MAX_AGE_HOURS: '72' })).toBe(0);
  });

  it('blocks FUTURE-dated evidence (recordedAt beyond the 5-minute skew)', () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    writeEvidence(repo, headSha(repo), validEvidence(headSha(repo), { recordedAt: future }));
    expect(runEnforcer(repo, 'git push')).toBe(2);
    // Within the skew allowance a slightly-ahead clock is tolerated.
    const slightSkew = new Date(Date.now() + 60 * 1000).toISOString();
    writeEvidence(repo, headSha(repo), validEvidence(headSha(repo), { recordedAt: slightSkew }));
    expect(runEnforcer(repo, 'git push')).toBe(0);
  });

  it('blocks backdated evidence (recordedAt before the commit exists)', () => {
    const beforeCommit = new Date(Date.now() - 3600 * 1000).toISOString();
    writeEvidence(repo, headSha(repo), validEvidence(headSha(repo), { recordedAt: beforeCommit }));
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('blocks an artifact with no genuinely passing gate (empty/forged)', () => {
    writeEvidence(repo, headSha(repo), validEvidence(headSha(repo), { gates: [] }));
    expect(runEnforcer(repo, 'git push')).toBe(2);
    writeEvidence(
      repo,
      headSha(repo),
      validEvidence(headSha(repo), {
        gates: [{ name: 'test', command: 'npm test', exitCode: 1, at: new Date().toISOString() }],
      })
    );
    expect(runEnforcer(repo, 'git push')).toBe(2);
    // A passing exit code without a command/timestamp is not evidence either.
    writeEvidence(
      repo,
      headSha(repo),
      validEvidence(headSha(repo), { gates: [{ name: 'test', exitCode: 0 }] })
    );
    expect(runEnforcer(repo, 'git push')).toBe(2);
  });

  it('allows the ship action with a valid, current, well-formed artifact', () => {
    writeEvidence(repo, headSha(repo), validEvidence(headSha(repo)));
    expect(runEnforcer(repo, 'git push')).toBe(0);
    expect(runEnforcer(repo, 'git commit -m "next"')).toBe(0);
  });

  it('honors the UAP_EVIDENCE_GATE_OFF operator override', () => {
    expect(runEnforcer(repo, 'git push', { UAP_EVIDENCE_GATE_OFF: '1' })).toBe(0);
  });

  it('does NOT honor an inline UAP_EVIDENCE_GATE_OFF=1 — it would be self-grantable', () => {
    // Same reasoning as UAP_NO_REVIEW: the agent composes its own command
    // strings, so an inline override is one it grants itself.
    expect(runEnforcer(repo, 'UAP_EVIDENCE_GATE_OFF=1 git push')).toBe(2);
  });

  it('ignores non-ship commands', () => {
    expect(runEnforcer(repo, 'ls -la')).toBe(0);
    expect(runEnforcer(repo, 'echo "git push"')).toBe(0);
    expect(runEnforcer(repo, 'git status')).toBe(0);
  });

  it('fails open outside a git repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'uap-evidence-plain-'));
    try {
      expect(runEnforcer(plain, 'git push')).toBe(0);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('fails CLOSED on an unborn branch (no commit => no evidence can exist)', () => {
    const unborn = mkdtempSync(join(tmpdir(), 'uap-evidence-unborn-'));
    try {
      git(unborn, ['init', '-q']);
      expect(runEnforcer(unborn, 'git commit -m "first"')).toBe(2);
    } finally {
      rmSync(unborn, { recursive: true, force: true });
    }
  });
});
