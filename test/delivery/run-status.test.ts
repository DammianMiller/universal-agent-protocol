/**
 * finalRunStatus: the durable-status mapping for a finished delivery.
 *
 * The regression this pins: a cooperatively-stopped run must land
 * 'interrupted', with the stop threaded through from observation time. The
 * project-level STOP file is consumed the moment the stop latch observes it,
 * so a filesystem re-check at bookkeeping time returns false for exactly the
 * stopped runs — they landed 'failed' and followers relaunched checkpointed
 * work from scratch (2026-08-15, four stop/relaunch cycles in 30 minutes).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { clearProjectStop, finalRunStatus, projectStopFilePath } from '../../src/delivery/run-state.js';

describe('finalRunStatus', () => {
  it('success is delivered regardless of stop signals', () => {
    expect(finalRunStatus(true, false, false)).toBe('delivered');
    expect(finalRunStatus(true, true, false)).toBe('delivered');
    expect(finalRunStatus(true, false, true)).toBe('delivered');
    expect(finalRunStatus(true, true, true)).toBe('delivered');
  });

  it('a stop observed during the run maps to interrupted even after the STOP file is gone', () => {
    // stopFilePresent=false is the consumed-file case that used to land 'failed'.
    expect(finalRunStatus(false, true, false)).toBe('interrupted');
  });

  it('a per-run STOP file still present at bookkeeping maps to interrupted', () => {
    expect(finalRunStatus(false, false, true)).toBe('interrupted');
  });

  it('no success and no stop is a plain failure', () => {
    expect(finalRunStatus(false, false, false)).toBe('failed');
  });
});

describe('clearProjectStop', () => {
  it('consumes a lingering project-level STOP at launch and reports it', () => {
    // A STOP left behind by a previous run instant-stopped a resume at turn 0
    // (2026-08-15) — launch must sweep it before the stop latch can see it.
    const root = mkdtempSync(join(tmpdir(), 'uap-clear-stop-'));
    const p = projectStopFilePath(root);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, new Date().toISOString());
    expect(clearProjectStop(root)).toBe(true);
    expect(existsSync(p)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('is a quiet no-op when no STOP exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'uap-clear-stop-'));
    expect(clearProjectStop(root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('mtime-gated: a STOP written AFTER the launcher started is a live signal, not stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'uap-clear-stop-'));
    const p = projectStopFilePath(root);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'live operator stop');
    // Launcher "started" one minute in the future of the file — file is stale.
    expect(clearProjectStop(root, Date.now() + 60_000)).toBe(true);
    // Fresh file vs a launcher that started a minute AGO — file is live, kept.
    writeFileSync(p, 'live operator stop');
    expect(clearProjectStop(root, Date.now() - 60_000)).toBe(false);
    expect(existsSync(p)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
