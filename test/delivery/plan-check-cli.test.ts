/**
 * plan-check's direct CLI entry (`--mode dry-run --plan-id <id>`).
 *
 * These tests pin the contract as it actually is, including the part that is
 * easy to misread: the dry-run is a STRUCTURAL STUB. A plan id beginning with
 * 'valid' exits 0; everything else exits 1. Nothing is parsed and no model is
 * called, so exit 0 here is not evidence that a plan is sound. The assertions
 * below say so explicitly, so that anyone tempted to wire this to a gate sees
 * what the exit code does and does not mean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __runPlanCheckCli } from '../../src/delivery/plan-check.js';

/** Run the CLI, capturing stdout and the process.exit code instead of exiting. */
function invoke(...cliArgs: string[]): { code: number | undefined; out: string } {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(' '));
  });
  // process.exit is typed as `never`; throw a sentinel so control leaves the
  // CLI at exactly the point the real process would have terminated.
  const sentinel = new Error('__exit__');
  let code: number | undefined;
  const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw sentinel;
  }) as never);

  try {
    __runPlanCheckCli(['node', 'plan-check.js', ...cliArgs]);
  } catch (err) {
    if (err !== sentinel) throw err;
  } finally {
    log.mockRestore();
    exit.mockRestore();
  }
  return { code, out: lines.join('\n') };
}

describe('plan-check CLI dry-run', () => {
  let originalArgv: string[];
  beforeEach(() => {
    originalArgv = process.argv;
  });
  afterEach(() => {
    process.argv = originalArgv;
  });

  it('exits 0 and reports completion for a valid-prefixed plan id', () => {
    const { code, out } = invoke('--mode', 'dry-run', '--plan-id', 'valid-123');
    expect(code).toBe(0);
    expect(out).toContain('valid-123');
    expect(out).toContain('completed');
    // The contract this exit code actually carries — structural only.
    expect(out).toContain('no phases executed');
  });

  it('exits 1 for any other plan id — the check is a prefix test, not validation', () => {
    for (const id of ['broken-plan', 'Valid-uppercase', 'invalid', 'plan-valid']) {
      const { code, out } = invoke('--mode', 'dry-run', '--plan-id', id);
      expect(code, `${id} should fail`).toBe(1);
      expect(out).toContain(id);
    }
  });

  it('exits 1 when --plan-id is missing', () => {
    const { code, out } = invoke('--mode', 'dry-run');
    expect(code).toBe(1);
    expect(out).toContain('Missing --plan-id');
  });

  it('defaults to dry-run mode when --mode is omitted', () => {
    const { code } = invoke('--plan-id', 'valid-abc');
    expect(code).toBe(0);
  });

  it('rejects any mode other than dry-run rather than silently dry-running', () => {
    const { code, out } = invoke('--mode', 'execute', '--plan-id', 'valid-abc');
    expect(code).toBe(1);
    expect(out).toContain('execute');
    expect(out).toContain('unsupported mode');
  });

  it('importing the module does not run the CLI', () => {
    // The isDirectRun guard keys off argv[1]. Under vitest that is the test
    // runner, not plan-check.js, so importing this module (as this file does)
    // must be side-effect free. If the guard regressed, importing plan-check
    // would have exited the worker before any test ran.
    expect(process.exitCode ?? 0).toBe(0);
  });
});
