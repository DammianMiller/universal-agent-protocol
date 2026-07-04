/**
 * Stop hook must honor Claude Code's `stop_hook_active` flag. When we are
 * already inside a Stop-hook continuation loop, the hook must NEVER block again
 * (exit 0), otherwise repeated `exit 2` blocks make the client force-override
 * after ~9 consecutive blocks. Regression guard for that wedge.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const HOOK = join(__dirname, '..', '.claude', 'hooks', 'stop.sh');

function runHook(input: string): number {
  try {
    execFileSync('bash', [HOOK], { input, timeout: 25000, stdio: ['pipe', 'ignore', 'ignore'] });
    return 0;
  } catch (e) {
    const err = e as { status?: number };
    return typeof err.status === 'number' ? err.status : -1;
  }
}

describe('stop.sh stop_hook_active guard', () => {
  it('the hook script exists', () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  it('allows stop immediately (exit 0) when stop_hook_active is true', () => {
    expect(runHook('{"stop_hook_active": true, "session_id": "t"}')).toBe(0);
  });

  it('also handles whitespace variance in the flag', () => {
    expect(runHook('{"stop_hook_active"   :   true}')).toBe(0);
  });
});
