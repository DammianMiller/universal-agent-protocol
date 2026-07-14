/**
 * "There were no tests" must never read as "the tests passed".
 *
 * The ladder decides on EXIT CODE alone, so a suite with zero tests is
 * indistinguishable from one that passed: `cargo test` on a crate with no tests
 * exits 0. A live mission delivered a Rust crate whose entire test result was
 * `0 passed; 0 failed` — compiled, gated, "delivered", and never tested at all.
 *
 * Passing because there is nothing to run is not evidence of anything.
 */
import { describe, it, expect } from 'vitest';
import { testsActuallyRan } from '../../src/delivery/verifier-ladder.js';

describe('testsActuallyRan — did the suite actually exercise anything?', () => {
  it('RUST: the exact live output — zero tests is NOT a pass', () => {
    expect(testsActuallyRan('cargo-test', 'test result: ok. 0 passed; 0 failed; 0 ignored')).toBe(false);
  });

  it('RUST: a workspace counts as tested if ANY binary ran tests', () => {
    const out = 'test result: ok. 0 passed; 0 failed\ntest result: ok. 12 passed; 0 failed';
    expect(testsActuallyRan('cargo-test', out)).toBe(true);
  });

  it('RUST: a failing suite obviously ran tests', () => {
    expect(testsActuallyRan('cargo-test', 'test result: FAILED. 3 passed; 2 failed')).toBe(true);
  });

  it('PYTEST: "no tests ran" / "collected 0 items"', () => {
    expect(testsActuallyRan('pytest', 'no tests ran in 0.01s')).toBe(false);
    expect(testsActuallyRan('pytest', 'collected 0 items')).toBe(false);
    expect(testsActuallyRan('pytest', '5 passed in 0.2s')).toBe(true);
  });

  it('GO: every package "[no test files]" means nothing ran', () => {
    expect(testsActuallyRan('go-test', '?   example/pkg  [no test files]')).toBe(false);
    expect(testsActuallyRan('go-test', 'ok   example/pkg  0.01s')).toBe(true);
  });

  it('JS: "no test files found"', () => {
    expect(testsActuallyRan('test', 'No test files found, exiting with code 0')).toBe(false);
    expect(testsActuallyRan('test', 'Tests  14 passed (14)')).toBe(true);
  });

  it('CTEST / DOTNET', () => {
    expect(testsActuallyRan('ctest', 'No tests were found!!!')).toBe(false);
    expect(testsActuallyRan('dotnet-test', 'Passed: 0, Failed: 0')).toBe(false);
    expect(testsActuallyRan('dotnet-test', 'Passed: 7, Failed: 0')).toBe(true);
  });

  it('returns NULL for a runner it cannot read — never block on a guess', () => {
    expect(testsActuallyRan('build', 'compiled fine')).toBeNull();
    expect(testsActuallyRan('cargo-test', 'some unrelated output')).toBeNull();
  });
});
