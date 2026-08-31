/**
 * F1 (deliver-hardening 2026-07-13): the gate hook honors degrade-on-dead-path
 * from the liveness cache — and ONLY there.
 *
 * A blocking policy whose compliant path is dead is a catch-22 (defect 10).
 * The liveness cache marks a policy `degradable` only when the policy opted in
 * (degradeOnDeadPath) AND every failure is outside agent-writable surfaces.
 * The hook consults that flag at block time: degradable → loud advisory;
 * anything else → the block stands, because a dead path an AGENT could have
 * caused is a sabotage signal, not a reason to relax.
 *
 * The cache itself is trusted only under the same terms as
 * operator-overrides.json (security review, 2026-07-13): ROOT-owned (a
 * user-owned cache is agent-mintable — one printf would turn any blocking
 * policy advisory), not group/world-writable, no symlink, and FRESH
 * (checkedAt < 24h). `uap policy liveness` still writes a user-owned cache
 * for status display; the gate never degrades on it. The trusted-cache cases
 * below are therefore root-only — a non-root run cannot mint one, which is
 * itself the property under test.
 *
 * Fixture: a repo whose policy DB routes ops to a blocking spy enforcer named
 * "Delivery Enforcement" (Title Case on purpose — the DB stores display names;
 * the cache is keyed by slug and the hook must slugify to match).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const GATE = join(process.cwd(), 'templates', 'hooks', 'uap-policy-gate.sh');
const BLOCK = 2;
const ALLOW = 0;

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  delete env.UAP_STATE_DIR;
  delete env.UAP_REPO_ROOT;
  delete env.UAP_SELF_PROTECT_OFF;
  return { ...env, ...extra };
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanEnv() });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'uap-f1-'));
  git(repo, ['init', '-b', 'main']);
  mkdirSync(join(repo, 'agents', 'data', 'memory'), { recursive: true });
  mkdirSync(join(repo, '.policy-tools'), { recursive: true });
  mkdirSync(join(repo, '.uap'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });

  const db = join(repo, 'agents', 'data', 'memory', 'policies.db');
  const sql =
    'CREATE TABLE policies(id TEXT, name TEXT, isActive INT, priority INT);' +
    'CREATE TABLE executable_tools(policyId TEXT, toolName TEXT);' +
    // Title Case display name: the cache is slug-keyed; the hook must slugify.
    "INSERT INTO policies VALUES('p1','Delivery Enforcement',1,50);" +
    "INSERT INTO executable_tools VALUES('p1','spy');";
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sqlite3 setup failed: ' + r.stderr);

  writeFileSync(
    join(repo, '.policy-tools', 'p1_spy.py'),
    'import json\nprint(json.dumps({"allowed": False, "reason": "route through deliver"}))\n'
  );
  return repo;
}

function writeCache(repo: string, entry: object): void {
  writeFileSync(
    join(repo, '.uap', 'policy-liveness.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), policies: { 'delivery-enforcement': entry } })
  );
}

function runGate(repo: string): { status: number; stderr: string } {
  const r = spawnSync('bash', [GATE], {
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(repo, 'src', 'x.ts'), content: 'x' },
      cwd: repo,
    }),
    cwd: repo,
    encoding: 'utf8',
    env: cleanEnv({ UAP_DELIVER_FASTPATH: 'off' }),
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? '' };
}

// A trusted (root-owned) cache can only be created by root — the very
// property under test — so the degrade-path cases are root-only.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const DEGRADABLE_ENTRY = {
  healthy: false,
  degradeOnDeadPath: true,
  degradable: true,
  failures: [{ kind: 'command', target: 'git', surface: 'external', detail: 'git not on PATH' }],
};

describe('gate degrade-on-dead-path (F1)', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('no cache → the block stands (default posture)', () => {
    expect(runGate(repo).status).toBe(BLOCK);
  });

  it('healthy cache entry → the block stands', () => {
    writeCache(repo, { healthy: true, degradeOnDeadPath: true, degradable: false, failures: [] });
    expect(runGate(repo).status).toBe(BLOCK);
  });

  it('unhealthy but NOT degradable → the block stands (sabotage guard)', () => {
    // The shape an agent-caused breakage produces: unhealthy, opt-in set, but
    // a failure on an agent-writable surface → degradable false.
    writeCache(repo, {
      healthy: false,
      degradeOnDeadPath: true,
      degradable: false,
      failures: [{ kind: 'skill', target: 'review', surface: 'agent-writable', detail: 'skill gone' }],
    });
    expect(runGate(repo).status).toBe(BLOCK);
  });

  it('a USER-owned degradable cache is IGNORED — one printf must not downgrade a policy', () => {
    // The security-review forgery: the agent runs as the user, so a
    // user-owned cache claiming degradable:true is self-serve sabotage. Only
    // a root-owned cache (operator-refreshed) may downgrade.
    writeCache(repo, DEGRADABLE_ENTRY);
    const r = runGate(repo);
    if (!IS_ROOT) {
      expect(r.status, 'a same-uid cache is agent-mintable and must be inert').toBe(BLOCK);
    }
  });

  it.runIf(IS_ROOT)('unhealthy + degradable in a ROOT-owned cache → loud advisory, op allowed', () => {
    writeCache(repo, DEGRADABLE_ENTRY);
    const r = runGate(repo);
    expect(r.status, 'a dead external compliant path downgrades to advisory').toBe(ALLOW);
    expect(r.stderr).toMatch(/ADVISORY \(degraded\)/);
    expect(r.stderr).toMatch(/Delivery Enforcement/);
  });

  it.runIf(IS_ROOT)('a STALE root-owned cache (>24h) is ignored — fixes silently re-tighten', () => {
    writeFileSync(
      join(repo, '.uap', 'policy-liveness.json'),
      JSON.stringify({
        checkedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
        policies: { 'delivery-enforcement': DEGRADABLE_ENTRY },
      })
    );
    expect(runGate(repo).status).toBe(BLOCK);
  });

  it('a garbage cache file fails safe: the block stands', () => {
    writeFileSync(join(repo, '.uap', 'policy-liveness.json'), '{garbage');
    expect(runGate(repo).status).toBe(BLOCK);
  });
});
