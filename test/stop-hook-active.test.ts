/**
 * Regression guard for the fresh-install Stop-hook loop.
 *
 * On an empty / nothing-runnable project the Stop hook used to `exit 2` forever:
 *   1. it ignored Claude Code's `stop_hook_active` re-entrancy flag, and
 *   2. it ran `uap verify --strict --runtime-only`, and --strict turns
 *      "no runnable artifact" (a vacuous SKIP) into a hard RC-1 failure.
 * Exit 2 forces Claude Code to continue, so it looped until the client
 * force-overrode after ~9 blocks. See the fix in stop.sh.
 *
 * These tests run the hook HERMETICALLY against the tracked canonical source
 * (templates/hooks/stop.sh — the file fresh installs copy): a throwaway git
 * project with an uncommitted `.js` file (so CODE_CHANGED=true) and a STUB
 * `uap` on PATH whose `verify` behaviour we control. The old test ran the hook
 * in the repo root, where real `uap verify` passes regardless — so it could
 * never catch this bug.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The canonical, tracked source the installer copies (not the .claude symlink).
const HOOK = join(__dirname, '..', 'templates', 'hooks', 'stop.sh');
const tmpDirs: string[] = [];

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Write a stub `uap` into `bin`.
 *  - fixed mode: `verify --runtime-only` exits with `verifyRc` (models a
 *    detected runtime rung that passes/fails).
 *  - strictAware mode: models the REAL empty-project contract — `--strict`
 *    upgrades "no runnable artifact" to RC 1, non-strict returns RC 0 (SKIP).
 *    This makes the "nothing runnable" test fail if `--strict` is ever
 *    re-introduced into the hook (guards root-cause #2).
 */
function writeStubUap(bin: string, opts: { verifyRc: number; strictAware: boolean }): void {
  const body = opts.strictAware
    ? `#!/usr/bin/env bash
case "$*" in
  *"verify --help"*) exit 0 ;;
  *"--strict"*) echo "UNVERIFIED: no runnable artifact detected"; exit 1 ;;
  *"verify"*"--runtime-only"*) echo "SKIP: no runnable artifact detected"; exit 0 ;;
  *) exit 0 ;;
esac
`
    : `#!/usr/bin/env bash
case "$*" in
  *"verify --help"*) exit 0 ;;
  *"verify"*"--runtime-only"*) echo "stub verify (rc=${opts.verifyRc})"; exit ${opts.verifyRc} ;;
  *) exit 0 ;;
esac
`;
  writeFileSync(join(bin, 'uap'), body);
  chmodSync(join(bin, 'uap'), 0o755);
}

/** Run stop.sh in a fresh temp project; returns the hook's exit code. */
function runHook(opts: {
  input: string;
  verifyRc?: number;
  strictAware?: boolean;
  hasCode?: boolean;
  env?: Record<string, string>;
  dir?: string;
}): number {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'stophook-'));
  if (!opts.dir) tmpDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  // Uncommitted source → stop.sh sets CODE_CHANGED=true → runs the runtime gate.
  if (opts.hasCode !== false) writeFileSync(join(dir, 'foo.js'), 'console.log(1)\n');

  const bin = join(dir, '.bin');
  mkdirSync(bin, { recursive: true }); // exists on repeat runs against one project
  writeStubUap(bin, { verifyRc: opts.verifyRc ?? 0, strictAware: opts.strictAware ?? false });

  try {
    execFileSync('bash', [HOOK], {
      input: opts.input,
      cwd: dir,
      timeout: 25000,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_PROJECT_DIR: dir,
        ...(opts.env ?? {}),
      },
    });
    return 0;
  } catch (e) {
    const err = e as { status?: number };
    return typeof err.status === 'number' ? err.status : -1;
  }
}

describe('stop.sh — fresh-install loop regression', () => {
  it('the tracked hook source exists', () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  it('honors stop_hook_active: relents (exit 0) on re-entry even if verify would fail', () => {
    // The re-entrancy guard must short-circuit BEFORE the verify gate — so even
    // with a failing stub verify, an active continuation loop is allowed to stop.
    expect(runHook({ input: '{"stop_hook_active": true, "session_id": "t"}', verifyRc: 1 })).toBe(0);
  });

  it('handles whitespace variance in the stop_hook_active flag', () => {
    expect(runHook({ input: '{"stop_hook_active"   :   true}', verifyRc: 1 })).toBe(0);
  });

  it('does NOT block (exit 0) when there is nothing runnable — and stays --strict-free', () => {
    // strictAware stub returns RC 1 iff `--strict` is present. The hook (now
    // non-strict) gets RC 0 → exit 0. If someone re-adds `--strict`, the stub
    // returns 1 → the hook exits 2 → this test goes red. Guards root-cause #2.
    expect(runHook({ input: '{"stop_hook_active": false}', strictAware: true })).toBe(0);
  });

  it('STILL blocks (exit 2) on a genuine runtime failure (verify RC 1)', () => {
    // Safety property: dropping --strict must not weaken real-failure blocking.
    expect(runHook({ input: '{"stop_hook_active": false}', verifyRc: 1 })).toBe(2);
  });

  it('respects the UAP_VERIFY_ON_STOP=0 bypass', () => {
    expect(
      runHook({ input: '{"stop_hook_active": false}', verifyRc: 1, env: { UAP_VERIFY_ON_STOP: '0' } })
    ).toBe(0);
  });

  it('relents after UAP_STOP_BLOCK_LIMIT consecutive RC-1 blocks when the harness sends no stop_hook_active payload', () => {
    // Factory-style harnesses never set stop_hook_active, so the re-entrancy
    // guard cannot relent for them; without this bound a persistently-red
    // gate (observed: max-fidelity interaction fail-closed) loops forever.
    const dir = mkdtempSync(join(tmpdir(), 'stophook-seq-'));
    tmpDirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, 'foo.js'), 'console.log(1)\n');
    // UAP_LP_DISABLED: loop-protection's 5s dedup suppresses back-to-back
    // invocations; it is a separate relief, not the unit under test here.
    const opts = { input: '{"stop_hook_active": false}', verifyRc: 1, dir, env: { UAP_STOP_BLOCK_LIMIT: '3', UAP_LP_DISABLED: '1' } };
    expect(runHook(opts)).toBe(2);
    expect(runHook(opts)).toBe(2);
    expect(runHook(opts)).toBe(2);
    expect(runHook(opts)).toBe(0); // at the bound: allow the stop, verdict on record
  });

  it('a green verify resets the consecutive-block counter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stophook-reset-'));
    tmpDirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, 'foo.js'), 'console.log(1)\n');
    // UAP_LP_DISABLED on every run: the 5s dedup would suppress the rapid
    // sequence and mask the counter behavior under test.
    const env = { UAP_STOP_BLOCK_LIMIT: '2', UAP_LP_DISABLED: '1' };
    expect(runHook({ input: '{"stop_hook_active": false}', verifyRc: 1, dir, env })).toBe(2); // block 1
    expect(runHook({ input: '{"stop_hook_active": false}', verifyRc: 1, dir, env })).toBe(2); // block 2
    expect(runHook({ input: '{"stop_hook_active": false}', verifyRc: 1, dir, env })).toBe(0); // bound reached: relent
    expect(runHook({ input: '{"stop_hook_active": false}', verifyRc: 0, dir, env })).toBe(0); // green resets
    expect(runHook({ input: '{"stop_hook_active": false}', verifyRc: 1, dir, env })).toBe(2); // fresh budget
  });
});
