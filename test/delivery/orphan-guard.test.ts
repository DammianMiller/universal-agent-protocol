/**
 * Owner-exit guard for detached deliver runs.
 *
 * Detaching is deliberate: a mission must outlive the agent's bash tool call.
 * What it must not outlive is the SESSION — orphaned runs held both model slots
 * for over an hour on 2026-07-29 while the operator had "nothing running".
 *
 * The two obvious detections are both wrong, and these tests pin why:
 *   - `ppid === 1` never fires: systemd --user is a child subreaper, so orphans
 *     re-parent to IT (observed ppid 11681), not to init.
 *   - "re-parented since start" fires on every detached run by construction,
 *     which would delete the feature.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveOwnerPid,
  readProcInfo,
  pidAlive,
  guardAgainstOwnerExit,
  OWNER_PID_ENV,
} from '../../src/delivery/orphan-guard.js';

let procRoot: string;
const saved: Record<string, string | undefined> = {};

/** Fake /proc/<pid>/stat in the real format, comm included. */
function writeProc(pid: number, comm: string, ppid: number) {
  mkdirSync(join(procRoot, String(pid)), { recursive: true });
  writeFileSync(join(procRoot, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 0 0 0 -1 0\n`);
}

beforeEach(() => {
  procRoot = mkdtempSync(join(tmpdir(), 'orphan-proc-'));
  for (const k of [OWNER_PID_ENV, 'UAP_ALLOW_ORPHAN']) saved[k] = process.env[k];
  delete process.env[OWNER_PID_ENV];
  delete process.env.UAP_ALLOW_ORPHAN;
});

afterEach(() => {
  try { rmSync(procRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveOwnerPid', () => {
  it('walks past the ephemeral shell to the agent client', () => {
    // The real shape: client → bash tool container → uap deliver. The immediate
    // parent is the container the detach exists to escape, so the guard must
    // NOT settle for it.
    writeProc(500, 'opencode', 400);
    writeProc(600, 'bash', 500);
    writeProc(700, 'node', 600);
    expect(resolveOwnerPid(700, { procRoot })).toBe(500);
  });

  it('returns undefined when no ancestor is an agent client', () => {
    // A deliver from a plain shell or CI has no session to outlive, so it gets
    // no guard at all rather than a guessed one.
    writeProc(500, 'sshd', 1);
    writeProc(600, 'bash', 500);
    expect(resolveOwnerPid(600, { procRoot })).toBeUndefined();
  });

  it('stops at the subreaper instead of mistaking it for an owner', () => {
    // systemd --user is what orphans actually re-parent to. It is not a session.
    writeProc(11681, 'systemd', 1);
    writeProc(900, 'node', 11681);
    expect(resolveOwnerPid(900, { procRoot })).toBeUndefined();
  });

  it('does not loop forever on a cyclic or deep chain', () => {
    writeProc(10, 'node', 11);
    writeProc(11, 'node', 10);
    expect(resolveOwnerPid(10, { procRoot, maxDepth: 5 })).toBeUndefined();
  });

  it('parses a comm containing spaces and parentheses', () => {
    // /proc stat comm is unquoted and may contain both; naive tokenising breaks.
    writeProc(42, 'my (weird) proc', 7);
    expect(readProcInfo(42, procRoot)).toEqual({ comm: 'my (weird) proc', ppid: 7 });
  });

  it('treats a vanished pid as absent rather than throwing', () => {
    expect(readProcInfo(999999, procRoot)).toBeNull();
  });
});

describe('pidAlive', () => {
  it('sees this process', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('does not see an unused pid', () => {
    expect(pidAlive(0x7ffffff0)).toBe(false);
  });
});

describe('guardAgainstOwnerExit', () => {
  it('fires once the owning session is gone', async () => {
    process.env[OWNER_PID_ENV] = '4242';
    let goneFor: number | undefined;
    const stop = guardAgainstOwnerExit({
      intervalMs: 10,
      isAlive: () => false,
      onOwnerGone: (pid) => { goneFor = pid; },
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(goneFor).toBe(4242);
  });

  it('stays quiet while the session is alive', async () => {
    process.env[OWNER_PID_ENV] = '4242';
    let fired = false;
    const stop = guardAgainstOwnerExit({
      intervalMs: 10,
      isAlive: () => true,
      onOwnerGone: () => { fired = true; },
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(fired).toBe(false);
  });

  it('is a no-op with no owner — an unguarded run must stay unguarded', async () => {
    let fired = false;
    const stop = guardAgainstOwnerExit({
      intervalMs: 10,
      isAlive: () => false,
      onOwnerGone: () => { fired = true; },
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(fired).toBe(false);
  });

  it('honours UAP_ALLOW_ORPHAN for deliberately detached runs', async () => {
    process.env[OWNER_PID_ENV] = '4242';
    process.env.UAP_ALLOW_ORPHAN = '1';
    let fired = false;
    const stop = guardAgainstOwnerExit({
      intervalMs: 10,
      isAlive: () => false,
      onOwnerGone: () => { fired = true; },
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(fired).toBe(false);
  });
});

describe('the guard records its reason where the follower reads', () => {
  it('END TO END: an orphaned run states the guard as its cause', () => {
    // A dead owner pid, a real recorder, a real exit - the exact live path.
    const guard = new URL('../../dist/delivery/orphan-guard.js', import.meta.url).pathname;
    const exitMod = new URL('../../dist/delivery/run-exit.js', import.meta.url).pathname;
    const stateMod = new URL('../../dist/delivery/run-state.js', import.meta.url).pathname;
    const dir = mkdtempSync(join(tmpdir(), 'uap-orphan-e2e-'));
    const runId = 'run-e2e-orphan';
    const script = `
      const { guardAgainstOwnerExit } = require(${JSON.stringify(guard)});
      const { installRunExitRecorder } = require(${JSON.stringify(exitMod)});
      const { saveRunState } = require(${JSON.stringify(stateMod)});
      saveRunState({ runId: ${JSON.stringify(runId)}, instruction:'x', presetId:'p',
        projectRoot: process.cwd(), status:'running', pid: process.pid, ppid: process.ppid,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      installRunExitRecorder(process.cwd(), ${JSON.stringify(runId)});
      process.env.UAP_DELIVER_OWNER_PID = '987654321';  // never alive
      guardAgainstOwnerExit({ intervalMs: 10 });
      setTimeout(() => {}, 5000);
    `;
    spawnSync('node', ['-e', script], { cwd: dir, encoding: 'utf-8', timeout: 20_000 });

    const raw = JSON.parse(
      readFileSync(join(dir, '.uap', 'deliver-runs', runId, 'state.json'), 'utf-8')
    );
    expect(raw.exit).toBeTruthy();
    expect(raw.exit.reason).toContain('orphan guard');
    expect(raw.exit.reason).toContain('987654321');
    // Still resumable: the guard stops the process, it does not fail the mission.
    expect(raw.status).toBe('running');
    rmSync(dir, { recursive: true, force: true });
  });
});
