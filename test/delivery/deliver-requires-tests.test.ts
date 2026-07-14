/**
 * The gate that decides DONE must be the one that enforces "tests actually ran".
 *
 * `uap verify` already refused a zero-test crate at max fidelity — but DELIVER's
 * own convergence loop never passed `requireTestsRan`, so a mission could still
 * report "✓ Delivered — all required gates pass" on a crate with no tests at all.
 * That is exactly what happened live: a Rust crate was delivered whose entire
 * test result was `0 passed; 0 failed`.
 *
 * Enforcing it only in verify left the real door open. These pin the ladder
 * contract that deliver now relies on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runLadder, type GateRung } from '../../src/delivery/verifier-ladder.js';

// A fake "test runner" whose output we control: exits 0, reports zero tests.
const zeroTestRung = (dir: string): GateRung => ({
  id: 'cargo-test',
  name: 'Tests (cargo test --workspace)',
  command: 'bash',
  args: ['-c', 'echo "test result: ok. 0 passed; 0 failed; 0 ignored"; exit 0'],
  required: true,
  timeoutMs: 10_000,
});

const realTestRung = (): GateRung => ({
  id: 'cargo-test',
  name: 'Tests (cargo test --workspace)',
  command: 'bash',
  args: ['-c', 'echo "test result: ok. 7 passed; 0 failed"; exit 0'],
  required: true,
  timeoutMs: 10_000,
});

describe('deliver gate: zero tests must not satisfy the test rung', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-dlvt-')); writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="x"\n'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('exit 0 with ZERO tests FAILS when requireTestsRan is set (max fidelity)', () => {
    const r = runLadder([zeroTestRung(dir)], dir, { requireTestsRan: true });
    expect(r.passed).toBe(false);
    expect(r.results[0].zeroTests).toBe(true);
  });

  it('a suite that ACTUALLY ran tests still passes', () => {
    const r = runLadder([realTestRung()], dir, { requireTestsRan: true });
    expect(r.passed).toBe(true);
    expect(r.results[0].zeroTests).toBeFalsy();
  });

  it('below max fidelity it is reported but does NOT block (unchanged default)', () => {
    const r = runLadder([zeroTestRung(dir)], dir, {});
    expect(r.passed).toBe(true);          // still a pass...
    expect(r.results[0].zeroTests).toBe(true); // ...but flagged, so it can be surfaced
  });
});
