/**
 * `uap deliver --resume` must not become a second writer.
 *
 * Live incident (2026-11-17): a timed-out deliver and a stale `--resume` of a
 * day-old run both rewrote the same artifact for hours, destroying newer work.
 * Two guards close that class:
 *
 *   1. RESUME TAKES THE LOCK — a resume launched while any live deliver holds
 *      `.uap/deliver.lock` must not start, exactly like a fresh run.
 *   2. STALENESS REFUSAL — a run whose last heartbeat is older than the window
 *      (default 24h) is refused, because its edit plan predates the current
 *      tree. `UAP_DELIVER_RESUME_STALE=1` (launch env) is the deliberate
 *      override; `UAP_DELIVER_RESUME_STALE_HOURS` tunes the window.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RESUME_STALE_DEFAULT_HOURS,
  resumeAgeHours,
  staleResumeRefusal,
} from '../../src/cli/deliver-resume-staleness.js';
import { acquireDeliverLock } from '../../src/cli/deliver.js';

const H = 3_600_000;

describe('resumeAgeHours', () => {
  it('measures from the updatedAt heartbeat', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    expect(resumeAgeHours({ updatedAt: '2026-11-17T10:00:00Z' }, now)).toBeCloseTo(2);
  });

  it('treats a missing or unparseable heartbeat as infinitely stale', () => {
    const now = new Date();
    expect(resumeAgeHours({}, now)).toBe(Number.POSITIVE_INFINITY);
    expect(resumeAgeHours({ updatedAt: 'not-a-date' }, now)).toBe(Number.POSITIVE_INFINITY);
  });

  it('never reports a negative age for future stamps (clock skew)', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    expect(resumeAgeHours({ updatedAt: '2026-11-17T13:00:00Z' }, now)).toBe(0);
  });
});

describe('staleResumeRefusal', () => {
  const baseEnv = { ...process.env } as NodeJS.ProcessEnv;
  beforeEach(() => {
    delete process.env.UAP_DELIVER_RESUME_STALE;
    delete process.env.UAP_DELIVER_RESUME_STALE_HOURS;
  });
  afterEach(() => {
    process.env = { ...baseEnv };
  });

  it('allows a fresh run (heartbeat inside the window)', () => {
    const now = new Date();
    const state = { runId: 'r1', updatedAt: new Date(now.getTime() - 2 * H).toISOString() };
    expect(staleResumeRefusal(state, {}, now)).toBeNull();
  });

  it('refuses a day-old run and names the run, age and window', () => {
    const now = new Date();
    const state = {
      runId: 'run-20261117T043904-b6c33f',
      updatedAt: new Date(now.getTime() - 26 * H).toISOString(),
    };
    const reason = staleResumeRefusal(state, {}, now);
    expect(reason).toContain('run-20261117T043904-b6c33f');
    expect(reason).toContain('26.0h');
    expect(reason).toContain(`${RESUME_STALE_DEFAULT_HOURS}h staleness window`);
    expect(reason).toContain('UAP_DELIVER_RESUME_STALE=1');
  });

  it('names the kill signal when the stale run died abnormally', () => {
    const now = new Date();
    const state = {
      runId: 'r2',
      updatedAt: new Date(now.getTime() - 30 * H).toISOString(),
      exit: { signal: 'SIGTERM', reason: 'killed by SIGTERM' },
    };
    const reason = staleResumeRefusal(state, {}, now);
    expect(reason).toContain('last exit SIGTERM');
  });

  it('the launch-env override admits a stale run deliberately', () => {
    const now = new Date();
    const state = { runId: 'r3', updatedAt: new Date(now.getTime() - 48 * H).toISOString() };
    expect(staleResumeRefusal(state, { UAP_DELIVER_RESUME_STALE: '1' }, now)).toBeNull();
  });

  it('UAP_DELIVER_RESUME_STALE_HOURS widens the window (0 disables it)', () => {
    const now = new Date();
    const state = { runId: 'r4', updatedAt: new Date(now.getTime() - 26 * H).toISOString() };
    expect(staleResumeRefusal(state, { UAP_DELIVER_RESUME_STALE_HOURS: '48' }, now)).toBeNull();
    expect(staleResumeRefusal(state, { UAP_DELIVER_RESUME_STALE_HOURS: '0' }, now)).toBeNull();
    // and narrows it
    expect(staleResumeRefusal(state, { UAP_DELIVER_RESUME_STALE_HOURS: '1' }, now)).not.toBeNull();
  });

  it('a non-numeric hours value falls back to the default window', () => {
    const now = new Date();
    const state = { runId: 'r5', updatedAt: new Date(now.getTime() - 26 * H).toISOString() };
    expect(staleResumeRefusal(state, { UAP_DELIVER_RESUME_STALE_HOURS: 'soon' }, now)).not.toBeNull();
  });

  it('an unparseable heartbeat is refused as unknown-age (never silently resumed)', () => {
    const now = new Date();
    const reason = staleResumeRefusal({ runId: 'r6' }, {}, now);
    expect(reason).toContain('unknown');
    expect(reason).not.toBeNull();
  });
});

describe('resume acquires the deliver lock (2026-11-17 orphan incident)', () => {
  let dir: string;
  let registry: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-resume-lock-'));
    registry = mkdtempSync(join(tmpdir(), 'uap-resume-registry-'));
    process.env.UAP_ACTIVE_RUNS_DIR = registry;
    delete process.env.UAP_DELIVER_NO_LOCK;
  });
  afterEach(() => {
    delete process.env.UAP_ACTIVE_RUNS_DIR;
    rmSync(registry, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('a live holder blocks acquireDeliverLock — the same call a resume now makes', () => {
    // A resume that finds a live deliver must refuse exactly like a fresh run;
    // the CLI path funnels both through acquireDeliverLock, so the contract to
    // pin is: live foreign holder => null (no second writer).
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'deliver.lock'), `${process.ppid}|${new Date().toISOString()}`);
    expect(acquireDeliverLock(dir)).toBeNull();
  });

  it('a dead holder is reclaimed, so a genuine interrupted resume still starts', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'deliver.lock'), `2147483646|old`);
    const release = acquireDeliverLock(dir);
    expect(release).toBeTypeOf('function');
    release!();
  });
});
