/**
 * `uap sandbox` CLI surface (bridge P4) — the commander-layer contract that
 * the pure-planner tests cannot see: verb dispatch (and its `--` escape),
 * the LOUD unknown---net refusal (a typo must not silently downgrade to
 * full network), grant verbs end-to-end, and the plan/audit handoff to
 * bwrap. bwrap is mocked so the surface is testable on any box and the
 * spawned argv is assertable. The ledger/audit are pinned to a tmp dir via
 * the env overrides (vitest workers cannot process.chdir).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, chmodSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const calls = vi.hoisted(() => ({ spawn: [] as Array<{ cmd: string; args: string[] }> }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn((cmd: string, args: readonly string[]) => {
      // hasBwrap() probes `bwrap --version`; the run path execs the plan.
      calls.spawn.push({ cmd, args: [...args] });
      return { status: 0, error: undefined };
    }),
  };
});

const { sandboxCommand, shouldDispatchGrantVerb } = await import('../../src/cli/sandbox.js');
const { grantAuthority } = await import('../../src/policies/sandbox-grants.js');

let dir: string;
let hole: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let prevArgv: string[];

const SENTINEL = Symbol('exit');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-sandbox-cli-'));
  hole = join(dir, 'hole');
  mkdirSync(hole);
  prevArgv = process.argv;
  process.argv = ['node', 'cli', 'sandbox'];
  // Pin the ledger and audit into the tmp dir: projectRoot stays cwd (the
  // worktree), but every store honors its env override (workers can't chdir).
  process.env.UAP_SANDBOX_GRANTS = join(dir, 'grants.json');
  process.env.UAP_SANDBOX_AUDIT = join(dir, 'audit.jsonl');
  // Pin the trust anchor too: without this, a seeded grant would write a
  // REAL anchor into the operator's state dir.
  process.env.UAP_SANDBOX_ANCHOR_DIR = join(dir, 'anchors');
  delete process.env.UAP_SANDBOX_OFF;
  delete process.env.UAP_SANDBOX_ALLOW;
  delete process.env.UAP_SANDBOX_NET;
  delete process.env.UAP_SANDBOX_GRANTS_OFF;
  delete process.env.UAP_SANDBOX_ACTIVE;
  delete process.env.UAP_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  calls.spawn = [];
  // Fresh spies per test (never restored mid-file: restoreAllMocks would
  // also strip the child_process mock's base implementation).
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw SENTINEL;
  }) as never);
  logSpy.mockClear();
  errSpy.mockClear();
  exitSpy.mockClear();
});

afterEach(() => {
  process.argv = prevArgv;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.UAP_SANDBOX_ANCHOR_DIR;
});

afterAll(() => {
  vi.restoreAllMocks();
});

const logLines = (): string[] => logSpy.mock.calls.map((c) => String(c[0]));
const errText = (): string => errSpy.mock.calls.map((c) => String(c[0])).join('\n');

/** Run sandboxCommand expecting a fail() exit: returns the exit code. */
async function runExpectExit(command: string[], options: Record<string, unknown>): Promise<number> {
  try {
    await sandboxCommand(command, options);
  } catch (e) {
    expect(e).toBe(SENTINEL);
    return (exitSpy.mock.calls[0]?.[0] as number) ?? -1;
  }
  throw new Error('expected sandboxCommand to exit, but it returned');
}

/** Run sandboxCommand expecting the final process.exit(spawnStatus). */
async function runToSpawn(command: string[], options: Record<string, unknown>): Promise<void> {
  try {
    await sandboxCommand(command, options);
  } catch {
    // The exit sentinel from process.exit(r.status) — expected.
  }
  expect(exitSpy).toHaveBeenCalled();
}

describe('verb dispatch and its -- escape', () => {
  it('dispatches grant verbs when there is no -- separator', () => {
    expect(shouldDispatchGrantVerb(['grant'])).toBe(true);
    expect(shouldDispatchGrantVerb(['grants'], ['node', 'cli', 'sandbox', 'grants'])).toBe(true);
    expect(shouldDispatchGrantVerb(['revoke', 'g1'], ['node', 'cli', 'sandbox', 'revoke', 'g1'])).toBe(true);
  });

  it('a -- separator escapes the intercept: the verb word is a COMMAND', () => {
    // `uap sandbox -- revoke ...` must run a binary named revoke, not the
    // ledger verb — an intercept that cannot be escaped would shadow
    // legitimate commands (P4 review finding).
    expect(shouldDispatchGrantVerb(['revoke', 'x'], ['node', 'cli', 'sandbox', '--', 'revoke', 'x'])).toBe(false);
  });

  it('non-verb and empty words are never dispatched', () => {
    expect(shouldDispatchGrantVerb(['echo'])).toBe(false);
    expect(shouldDispatchGrantVerb([])).toBe(false);
  });

  it('past --, a verb word reaches bwrap as the session command', async () => {
    process.argv = ['node', 'cli', 'sandbox', '--', 'revoke', 'x'];
    await runToSpawn(['revoke', 'x'], {});
    const run = calls.spawn.find((c) => c.cmd === 'bwrap' && !c.args.includes('--version'));
    expect(run).toBeDefined();
    expect(run!.args.slice(-2)).toEqual(['revoke', 'x']);
  });
});

describe('the --net contract (loud, never a silent downgrade)', () => {
  it("refuses an unknown --net (e.g. the documented-then-cut 'proxy') with exit 2", async () => {
    const code = await runExpectExit(['true'], { net: 'proxy' });
    expect(code).toBe(2);
    expect(errText()).toContain("unknown --net mode 'proxy'");
    // And nothing was launched: a typo must not fall through to shared.
    expect(calls.spawn.some((c) => c.cmd === 'bwrap' && !c.args.includes('--version'))).toBe(false);
  });

  it('a valid --net off plan reaches bwrap with the netns cut', async () => {
    await runToSpawn(['true'], { net: 'off' });
    const run = calls.spawn.find((c) => c.cmd === 'bwrap' && !c.args.includes('--version'));
    expect(run).toBeDefined();
    expect(run!.args).toContain('--unshare-net');
    // The audit records the boundary that actually engaged.
    const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('"netMode":"off"');
  });

  it("fails LOUD on a garbage UAP_SANDBOX_NET env value (never a silent downgrade to shared)", async () => {
    // 'OFF', '0ff' previously parsed as "not off" → shared — the exact
    // hole the boundary exists to close (P4 security review finding 4).
    for (const bad of ['OFF', '0ff', 'proxy']) {
      process.env.UAP_SANDBOX_NET = bad;
      const code = await runExpectExit(['true'], {});
      expect(code).toBe(2);
      expect(errText()).toContain(`unknown UAP_SANDBOX_NET value '${bad}'`);
      // Nothing launched under the typo'd mode.
      expect(calls.spawn.some((c) => c.cmd === 'bwrap' && !c.args.includes('--version'))).toBe(false);
      logSpy.mockClear();
      errSpy.mockClear();
      exitSpy.mockClear();
    }
    // Whitespace is a shell quirk, not a typo: 'off ' still means OFF.
    process.env.UAP_SANDBOX_NET = 'off ';
    await runToSpawn(['true'], {});
    expect(calls.spawn.some((c) => c.cmd === 'bwrap' && c.args.includes('--unshare-net'))).toBe(true);
  });
});

describe('consent cannot come from inside the sandbox (P4 security review finding 1)', () => {
  it('refuses grant and revoke when UAP_SANDBOX_ACTIVE=1 — the agent must not self-consent', async () => {
    process.env.UAP_SANDBOX_ACTIVE = '1';
    const g = await runExpectExit(['grant', hole], { session: 's-cli', reason: 'self-consent attempt' });
    expect(g).toBe(2);
    expect(errText()).toContain('refusing to grant/revoke from inside a sandbox');
    const r = await runExpectExit(['revoke', 'sbg-anything'], {});
    expect(r).toBe(2);
    expect(errText()).toContain('refusing to grant/revoke from inside a sandbox');
    // And no authority was written despite the refusals.
    expect(existsSync(join(dir, 'grants.json'))).toBe(false);
  });

  it('still allows LISTING grants from inside a sandbox (read-only, the agent sees what it was granted)', async () => {
    process.env.UAP_SANDBOX_ACTIVE = '1';
    await sandboxCommand(['grants'], { session: 's-cli', json: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logLines().at(-1)).toBe('[]');
  });
  it('stamps the grants listing with the anchor verdict (ADR 0011): red banner for humans, stderr-only for --json', async () => {
    // Seed + ANCHOR via the policy (a recorded consent operation).
    const g = grantAuthority(process.cwd(), { sessionId: 's-cli', paths: [hole], reason: 'seed consent' });
    if (!g.ok) throw new Error(g.error);
    // Tamper: something with checkout write reach rewrites the ledger
    // without going through grant/revoke.
    const rows = JSON.parse(readFileSync(join(dir, 'grants.json'), 'utf-8')) as Record<string, unknown>[];
    rows[0].reason = 'rewritten by an unrecorded writer';
    writeFileSync(join(dir, 'grants.json'), JSON.stringify(rows));
    // Human path: the banner is red and on stdout, rows still listed.
    await sandboxCommand(['grants'], {});
    expect(logLines().join('\n')).toMatch(/INTEGRITY MISMATCH/);
    expect(logLines().join('\n')).toMatch(/seed consent|rewritten/); // rows are shown, stamped unverified
    // --json: the data stays pure on stdout; the alarm rides stderr.
    logSpy.mockClear();
    errSpy.mockClear();
    await sandboxCommand(['grants'], { json: true });
    expect(logLines().at(-1)).toBe(JSON.stringify(rows, null, 2));
    expect(logLines().join('\n')).not.toMatch(/INTEGRITY/);
    expect(errText()).toMatch(/INTEGRITY MISMATCH/);
  });

  it('ro-binds the ledger and audit into every sandbox plan so a sandboxed agent cannot plant rows', async () => {
    // Finding 1's second half: the consent store lives inside the writable
    // hole, so the namespace must mount it read-only (a bind-mounted file
    // cannot be unlinked or replaced inside the ns).
    await runToSpawn(['true'], {});
    const run = calls.spawn.find((c) => c.cmd === 'bwrap' && !c.args.includes('--version'));
    expect(run).toBeDefined();
    const ledger = process.env.UAP_SANDBOX_GRANTS!;
    const audit = process.env.UAP_SANDBOX_AUDIT!;
    expect(run!.args).toContain('--ro-bind');
    expect(run!.args).toEqual(expect.arrayContaining(['--ro-bind', '/dev/null', ledger]));
    expect(run!.args).toEqual(expect.arrayContaining(['--ro-bind', '/dev/null', audit]));
  });

  it('ro-binds a REAL ledger file (not /dev/null) once the operator has granted', async () => {
    const r = grantAuthority(dir, { sessionId: 's-real', paths: [hole], reason: 'ro-bind probe' });
    expect(r.ok).toBe(true);
    await runToSpawn(['true'], { session: 's-real' });
    const run = calls.spawn.find((c) => c.cmd === 'bwrap' && !c.args.includes('--version'));
    expect(run!.args).toEqual(
      expect.arrayContaining(['--ro-bind', join(dir, 'grants.json'), join(dir, 'grants.json')]),
    );
  });
});

describe('grant verbs end-to-end (commander-style options object)', () => {
  it('grant → grants --json → revoke round-trip on the real ledger', async () => {
    await sandboxCommand(['grant', hole], { session: 's-cli', reason: 'cli surface test' });
    expect(logLines().some((l) => l.includes('✓ grant'))).toBe(true);
    const ledger = JSON.parse(readFileSync(join(dir, 'grants.json'), 'utf-8')) as Array<{
      sessionId: string;
    }>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].sessionId).toBe('s-cli');

    await sandboxCommand(['grants'], { session: 's-cli', json: true });
    // The --json output is the LAST console.log call and is pure JSON.
    const listed = JSON.parse(logLines().at(-1)!) as Array<{ id: string }>;
    expect(listed).toHaveLength(1);

    await sandboxCommand(['revoke', listed[0].id], {});
    expect(logLines().some((l) => l.includes(`✓ revoked ${listed[0].id}`))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'grants.json'), 'utf-8'))).toHaveLength(0);
  });

  it('revoke of an unknown id refuses loud (exit 2), not a quiet no-op', async () => {
    const code = await runExpectExit(['revoke', 'nope'], {});
    expect(code).toBe(2);
    expect(errText()).toContain("could not revoke 'nope'");
  });

  it('revoke returns false on persist failure — the refusal must not read as success', async () => {
    // Grant with a writable ledger, then make the ledger DIRECTORY unwritable
    // so the removal cannot persist: the grant stays ACTIVE, so the CLI must
    // exit nonzero and say so (a false '✓ revoked' here would be the trust
    // boundary lying).
    process.env.UAP_SANDBOX_GRANTS = join(dir, 'g', 'grants.json');
    mkdirSync(join(dir, 'g'));
    const r = grantAuthority(dir, { sessionId: 's2', paths: [hole], reason: 'persist-fail probe' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    chmodSync(join(dir, 'g'), 0o555);
    try {
      const code = await runExpectExit(['revoke', r.grant.id], {});
      expect(code).toBe(2);
      expect(errText()).toContain('could not revoke');
      // And the ledger still holds the grant — it was never revoked.
      expect(
        (JSON.parse(readFileSync(join(dir, 'g', 'grants.json'), 'utf-8')) as Array<{ id: string }>).some(
          (g) => g.id === r.grant.id,
        ),
      ).toBe(true);
    } finally {
      chmodSync(join(dir, 'g'), 0o755);
    }
  });
});

describe('run-path guards', () => {
  it('refuses to run unsandboxed when bwrap is missing (exit 127)', async () => {
    // Make the hasBwrap() probe report a miss (mockImplementationOnce wins
    // over the base mock for exactly the next call).
    const { spawnSync } = await import('child_process');
    (spawnSync as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({ status: 127 }));
    const code = await runExpectExit(['true'], {});
    expect(code).toBe(127);
    expect(errText()).toContain('bwrap (bubblewrap) not found');
  });

  it('no command → usage that names the -- separator', async () => {
    const code = await runExpectExit([], {});
    expect(code).toBe(2);
    expect(errText()).toContain('no command given');
    expect(errText()).toContain('Usage: uap sandbox');
  });
});
