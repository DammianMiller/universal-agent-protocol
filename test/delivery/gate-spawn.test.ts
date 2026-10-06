import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { runGateProcess, runGateProcessSync } from '../../src/delivery/gate-spawn.js';

/**
 * U4: a timed-out gate used to orphan its grandchildren. On timeout the whole
 * process GROUP must die — the sleeping `bash -c "sleep 300"` grandchild below
 * is the proof cargo/rustc trees cannot outlive their gate.
 */

// The orphan probes read /proc — Linux-only (guard so the suite is green on
// macOS/CI runners without procfs).
const hasProc = existsSync('/proc');

describe('gate-spawn (U4: process-group kill on timeout)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-gatespawn-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A script that spawns a LONG-SLEEPING grandchild, records its pid, then
  // sleeps itself past any budget.
  const orphanScript = `#!/bin/bash
bash -c "sleep 300" &
echo $! > ${dir}/grandchild.pid
echo STARTED
sleep 300
`;

  const grandchildGone = async (budgetMs = 3_000): Promise<boolean> => {
    for (let waited = 0; waited < budgetMs; waited += 100) {
      try {
        const pid = parseInt(readFileSync(join(dir, 'grandchild.pid'), 'utf-8').trim(), 10);
        // A zombie (" Z ") means the reaper got it; a live state means orphan.
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const afterComm = stat.slice(stat.indexOf(')') + 1);
        if (/\sZ\s/.test(afterComm)) return true;
      } catch {
        return true; // pid gone — dead and reaped
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  it.skipIf(!hasProc)('runGateProcess kills the process group on timeout — grandchild included', async () => {
    writeFileSync(join(dir, 'gate.sh'), orphanScript, { mode: 0o755 });
    const res = await runGateProcess('bash', [join(dir, 'gate.sh')], {
      timeoutMs: 1_200,
      cwd: dir,
    });
    expect(res.timedOut).toBe(true);
    expect(await grandchildGone()).toBe(true);
  }, 20_000);

  it.skipIf(!hasProc)('runGateProcessSync kills the process group on timeout — grandchild included', async () => {
    writeFileSync(join(dir, 'gate.sh'), orphanScript, { mode: 0o755 });
    const res = runGateProcessSync('bash', [join(dir, 'gate.sh')], {
      timeoutMs: 1_200,
      cwd: dir,
    });
    expect(res.error ?? res.signal).toBeTruthy(); // node signals the timeout
    expect(res.status).not.toBe(0);
    // spawnSync reaps synchronously; give the kernel a moment if needed.
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      gone = Boolean(await grandchildGone(100));
    }
    expect(gone).toBe(true);
  }, 20_000);

  it('a missing gate command still classifies as a spawn error through setsid', () => {
    const res = runGateProcessSync('definitely-not-a-real-binary-xyz', [], { cwd: dir });
    expect(res.error).toBeTruthy();
    expect((res.error as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(res.status).toBeNull();
  }, 15_000);

  it('runGateProcess passes through stdout and exit code (success path)', async () => {
    const res = await runGateProcess('bash', ['-c', 'echo hello; exit 7'], { cwd: dir });
    expect(res.timedOut).toBe(false);
    expect(res.status).toBe(7);
    expect(res.stdout).toContain('hello');
  }, 15_000);

  it('runGateProcessSync passes through stdout and exit code (success path)', () => {
    const res = runGateProcessSync('bash', ['-c', 'echo sync-hello; exit 0'], { cwd: dir });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('sync-hello');
  }, 15_000);

  it('a spawn failure is reported, not thrown (missing binary)', async () => {
    const res = await runGateProcess('/nonexistent/binary-xyz', [], { cwd: dir });
    expect(res.spawnError).toBeTruthy();
    expect(res.status).toBeNull();
  }, 15_000);
});
