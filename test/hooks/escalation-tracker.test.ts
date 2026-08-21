/**
 * escalation_tracker.py — the evidence store behind the `escalate` delivery
 * mode. Fed by the verify hooks (exit codes) and by build/test shell output
 * (text only, on opencode). Its one job: tell "iterating" from "two red gates
 * in a row" without ever inventing evidence from ambiguous output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TRACKER = join(process.cwd(), 'templates', 'hooks', 'escalation_tracker.py');
let root: string;

function track(...argv: string[]): string {
  const r = spawnSync('python3', [TRACKER, ...argv], { env: { ...process.env, UAP_MAIN_ROOT: root }, encoding: 'utf8' });
  return (r.stdout + r.stderr).trim();
}
function state(): { failures: number; edits_since_green: Record<string, number>; last_failure: { source: string; detail: string } | null } {
  return JSON.parse(readFileSync(join(root, '.uap', 'escalation-state.json'), 'utf8'));
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'uap-tracker-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('escalation_tracker', () => {
  it('counts consecutive failures and a pass resets everything', () => {
    track('fail', '--source', 'verify', '--detail', 'error[E0425]: cannot find value `x`');
    track('edit', '--file', 'src/a.rs');
    track('fail', '--source', 'stop', '--detail', 'error[E0425]: cannot find value `x`');
    let s = state();
    expect(s.failures).toBe(2);
    expect(s.last_failure?.source).toBe('stop');
    expect(s.edits_since_green['src/a.rs']).toBe(1);
    track('pass', '--source', 'verify', '--detail', 'ignored but accepted');
    s = state();
    expect(s.failures).toBe(0);
    expect(s.edits_since_green).toEqual({});
    expect(s.last_failure).toBeNull();
  });

  it('a failure with a NEW signature restarts the streak — moving the problem is progress, not a wall', () => {
    track('fail', '--detail', 'error[E0425]: cannot find value `x` in src/a.rs:10');
    track('fail', '--detail', "thread 'hash::tests::t' (2611998) panicked at src/hash.rs:130:26:\nattempt to multiply with overflow");
    expect(state().failures).toBe(1); // different problem -> streak restarts
    track('fail', '--detail', "thread 'hash::tests::t' (2612777) panicked at src/hash.rs:130:26:\nattempt to multiply with overflow");
    expect(state().failures).toBe(2); // same wall (thread id differs, signature does not)
    track('fail', '--detail', 'test result: FAILED. 1 passed; 1 failed');
    expect(state().failures).toBe(1);
  });

  it('classifies build/test shell output and records only what it can prove', () => {
    expect(track('classify-bash', '--command', 'ls -la', '--output', 'error: nope')).toBe('none');
    expect(existsSync(join(root, '.uap', 'escalation-state.json'))).toBe(false);
    expect(track('classify-bash', '--command', 'cargo test', '--output', 'test result: FAILED. 3 passed; 1 failed')).toBe('fail');
    expect(state().failures).toBe(1);
    expect(track('classify-bash', '--command', 'cargo build', '--output', '')).toBe('none'); // silence is not evidence
    expect(state().failures).toBe(1);
    expect(track('classify-bash', '--command', 'npx vitest run', '--output', 'Tests  12 passed (12)\n 0 failed')).toBe('pass');
    expect(state().failures).toBe(0);
    // a test NAMED "failed" that passes is green, not red
    expect(track('classify-bash', '--command', 'pytest -v', '--output', 'test_failed_login PASSED\n5 passed in 0.3s')).toBe('pass');
    expect(track('classify-bash', '--command', 'go test ./...', '--output', '--- PASS: TestFailedAuth\nok  pkg 0.1s')).toBe('pass');
    expect(track('classify-bash', '--command', 'pytest', '--output', '3 passed, 2 failed in 1s')).toBe('fail');
    expect(state().failures).toBe(1);
    // an explicit exit code beats the markers
    expect(track('classify-bash', '--command', 'npm test', '--output', 'whatever', '--exit-code', '1')).toBe('fail');
    expect(track('classify-bash', '--command', 'npm test', '--output', 'FAILED?', '--exit-code', '0')).toBe('pass');
  });

  it('accepts a detail/output that begins with "-" (a cut build log) instead of dropping it as an option', () => {
    track('fail', '--source', 'stop', '--detail', '--> src/a.rs:3:5\nerror[E0425]');
    expect(state().failures).toBe(1);
    expect(state().last_failure?.detail).toContain('E0425');
    expect(track('classify-bash', '--command', 'cargo test', '--output', '---- tests::x stdout ----\ntest result: FAILED')).toBe('fail');
  });

  it('reads the detail from stdin with "-" so long build logs need no shell quoting', () => {
    const r = spawnSync('python3', [TRACKER, 'fail', '--source', 'bash', '--detail', '-'], {
      env: { ...process.env, UAP_MAIN_ROOT: root }, input: 'x'.repeat(5000) + 'TAIL', encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const d = state().last_failure?.detail ?? '';
    expect(d.endsWith('TAIL')).toBe(true);
    expect(d.length).toBeLessThanOrEqual(1200);
  });
});
