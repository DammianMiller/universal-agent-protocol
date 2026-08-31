/**
 * F3 (deliver-hardening 2026-07-13): operator overrides via a signed FILE.
 *
 * Defect 12: the escape hatches (UAP_DELIVER_BYPASS, UAP_WORKDIR_ALLOW,
 * UAP_SELF_PROTECT_OFF) were env-only, and env does not reliably reach hook
 * subprocesses in every harness — so the sanctioned override paths were
 * effectively unreachable mid-session. The hook now honors
 * `.uap/operator-overrides.json`, verified before any field applies:
 * regular file (no symlink), owned by ROOT, not group/world-writable, and
 * expiresAt in the future. Root ownership is the load-bearing check
 * (security review, 2026-07-13): the agent runs as the user's uid, so any
 * user-owned file is agent-mintable — a uid==euid check is vacuous and an
 * interpreter-mediated write (`python3 -c 'open(...)'`) walks past the
 * self-protect text scan. Only an out-of-band operator (sudo) can plant one.
 * Verified fields map onto the SAME env vars enforcers already honor, and
 * only when unset — an explicit env still wins.
 *
 * Tests that need a TRUSTED (root-owned) file are gated on getuid()===0 —
 * a non-root test run cannot create one by construction, which is itself the
 * property under test (see the "user-owned file is refused" case).
 *
 * Fixture: a repo whose policy DB routes every op to a spy enforcer that
 * BLOCKS unless it sees UAP_DELIVER_BYPASS=1 — the file's deliverBypass field
 * must flip the verdict, and every verification failure must leave the block
 * standing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'fs';
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
  delete env.UAP_DELIVER_BYPASS;
  delete env.UAP_WORKDIR_ALLOW;
  delete env.UAP_SELF_PROTECT_OFF;
  // Extra applies AFTER the scrub so a test can deliberately set a scrubbed var.
  return { ...env, ...extra };
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanEnv() });
}

function makeRepo(marker: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'uap-f3-'));
  git(repo, ['init', '-b', 'main']);
  mkdirSync(join(repo, 'agents', 'data', 'memory'), { recursive: true });
  mkdirSync(join(repo, '.policy-tools'), { recursive: true });
  mkdirSync(join(repo, '.uap'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });

  const db = join(repo, 'agents', 'data', 'memory', 'policies.db');
  const sql =
    'CREATE TABLE policies(id TEXT, name TEXT, isActive INT, priority INT);' +
    'CREATE TABLE executable_tools(policyId TEXT, toolName TEXT);' +
    "INSERT INTO policies VALUES('p1','bypass-required',1,50);" +
    "INSERT INTO executable_tools VALUES('p1','spy');";
  const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sqlite3 setup failed: ' + r.stderr);

  writeFileSync(
    join(repo, '.policy-tools', 'p1_spy.py'),
    [
      'import json, os',
      'with open(os.environ["SPY_MARKER"], "w") as fh:',
      '    json.dump({',
      '        "bypass": os.environ.get("UAP_DELIVER_BYPASS"),',
      '        "allow": os.environ.get("UAP_WORKDIR_ALLOW"),',
      '    }, fh)',
      'ok = os.environ.get("UAP_DELIVER_BYPASS") == "1"',
      'print(json.dumps({"allowed": ok, "reason": "operator bypass required"}))',
      '',
    ].join('\n')
  );
  return repo;
}

function writeOverride(repo: string, body: object, mode = 0o600): void {
  const p = join(repo, '.uap', 'operator-overrides.json');
  writeFileSync(p, JSON.stringify(body));
  chmodSync(p, mode);
}

function runGate(repo: string, marker: string, env: Record<string, string> = {}): { status: number; stderr: string } {
  const r = spawnSync('bash', [GATE], {
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(repo, 'src', 'x.ts'), content: 'x' },
      cwd: repo,
    }),
    cwd: repo,
    encoding: 'utf8',
    env: cleanEnv({ SPY_MARKER: marker, UAP_DELIVER_FASTPATH: 'off', ...env }),
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? '' };
}

const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2020-01-01T00:00:00Z';
// Root-owned files can only be created by root — which is exactly the trust
// property under test, so the trusted-file cases are root-only by design.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

describe('operator-overrides.json (F3)', () => {
  let repo: string;
  let marker: string;

  beforeEach(() => {
    marker = join(mkdtempSync(join(tmpdir(), 'uap-f3-mark-')), 'spy.json');
    repo = makeRepo(marker);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(join(marker, '..'), { recursive: true, force: true });
  });

  it('no file → the policy blocks (baseline)', () => {
    expect(runGate(repo, marker).status).toBe(BLOCK);
  });

  it('a USER-owned override is refused — the agent runs as the user', () => {
    // THE security property (review block, 2026-07-13): every check a
    // user-owned file can satisfy is a check the agent can satisfy, so the
    // only ownership with teeth is root. This is the case that must hold on
    // every machine, root or not — the tests below it need sudo to even
    // construct their fixtures.
    writeOverride(repo, { deliverBypass: true, expiresAt: FUTURE });
    const r = runGate(repo, marker);
    expect(r.status, 'a same-uid override is agent-mintable and must be inert').toBe(BLOCK);
    if (!IS_ROOT) expect(r.stderr).toMatch(/not root-owned/);
  });

  it.runIf(IS_ROOT)('a valid root-owned deliverBypass override reaches the enforcer as UAP_DELIVER_BYPASS=1', () => {
    writeOverride(repo, { deliverBypass: true, expiresAt: FUTURE });
    const r = runGate(repo, marker);
    expect(r.status, 'the signed file must work where env cannot reach').toBe(ALLOW);
    expect(JSON.parse(readFileSync(marker, 'utf8')).bypass).toBe('1');
  });

  it.runIf(IS_ROOT)('workdirAllow maps to a colon-joined UAP_WORKDIR_ALLOW', () => {
    writeOverride(repo, { deliverBypass: true, workdirAllow: ['extras/x', '/opt/y'], expiresAt: FUTURE });
    expect(runGate(repo, marker).status).toBe(ALLOW);
    expect(JSON.parse(readFileSync(marker, 'utf8')).allow).toBe('extras/x:/opt/y');
  });

  it.runIf(IS_ROOT)('rejects a newline-carrying workdirAllow value (export-loop injection)', () => {
    // "x\nUAP_SELF_PROTECT_OFF=1" would inject a second KEY=VALUE line into the
    // hook's export loop, escalating a workdir grant into a self-protect kill.
    writeOverride(repo, { workdirAllow: ['x\nUAP_SELF_PROTECT_OFF=1'], expiresAt: FUTURE });
    const r = runGate(repo, marker);
    expect(r.status).toBe(BLOCK);
    expect(r.stderr).toMatch(/newline\/colon/);
  });

  it.runIf(IS_ROOT)('rejects a group/world-writable file (and says so on stderr)', () => {
    writeOverride(repo, { deliverBypass: true, expiresAt: FUTURE }, 0o666);
    const r = runGate(repo, marker);
    expect(r.status, 'a tamperable override must be inert').toBe(BLOCK);
    expect(r.stderr).toMatch(/operator-overrides\.json IGNORED/);
  });

  it.runIf(IS_ROOT)('rejects an expired override — overrides cannot rot open', () => {
    writeOverride(repo, { deliverBypass: true, expiresAt: PAST });
    expect(runGate(repo, marker).status).toBe(BLOCK);
  });

  it.runIf(IS_ROOT)('rejects an override with no expiresAt', () => {
    writeOverride(repo, { deliverBypass: true });
    expect(runGate(repo, marker).status).toBe(BLOCK);
  });

  it.runIf(IS_ROOT)('rejects a symlinked override', () => {
    const real = join(repo, '.uap', 'real-override.json');
    writeFileSync(real, JSON.stringify({ deliverBypass: true, expiresAt: FUTURE }));
    chmodSync(real, 0o600);
    symlinkSync(real, join(repo, '.uap', 'operator-overrides.json'));
    expect(runGate(repo, marker).status).toBe(BLOCK);
  });

  it.runIf(IS_ROOT)('an explicit env var still wins over the file', () => {
    writeOverride(repo, { deliverBypass: true, expiresAt: FUTURE });
    const r = runGate(repo, marker, { UAP_DELIVER_BYPASS: '0' });
    expect(JSON.parse(readFileSync(marker, 'utf8')).bypass, 'the file must not overwrite a set env').toBe('0');
    expect(r.status).toBe(BLOCK);
  });

  it.runIf(IS_ROOT)('rejects malformed JSON', () => {
    const p = join(repo, '.uap', 'operator-overrides.json');
    writeFileSync(p, '{not json');
    chmodSync(p, 0o600);
    expect(runGate(repo, marker).status).toBe(BLOCK);
  });
});
