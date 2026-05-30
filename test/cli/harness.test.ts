/**
 * uap harness — exit-code mapping
 *
 * A signal-terminated `halo` run returns status=null + signal=<name>; the CLI
 * must not coalesce that to a successful exit (0), or CI/automation gating on
 * the exit code silently treats killed runs as successful.
 */

import { describe, it, expect } from 'vitest';
import { spawnExitCode } from '../../src/cli/harness.js';

describe('spawnExitCode', () => {
  it('returns the status when the process exited normally', () => {
    expect(spawnExitCode(0, null)).toBe(0);
    expect(spawnExitCode(2, null)).toBe(2);
  });

  it('maps a signal-kill to 128 + signal number instead of success', () => {
    expect(spawnExitCode(null, 'SIGTERM')).toBe(128 + 15);
    expect(spawnExitCode(null, 'SIGKILL')).toBe(128 + 9);
    expect(spawnExitCode(null, 'SIGINT')).toBe(128 + 2);
  });

  it('never coalesces a signal-kill to 0', () => {
    expect(spawnExitCode(null, 'SIGTERM')).not.toBe(0);
  });

  it('falls back to 1 when neither status nor signal is available', () => {
    expect(spawnExitCode(null, null)).toBe(1);
  });
});
