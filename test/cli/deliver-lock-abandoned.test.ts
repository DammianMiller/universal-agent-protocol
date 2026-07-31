/**
 * A deliver lock must not outlive its holder forever.
 *
 * `acquireDeliverLock` deferred to any lock whose PID was alive. PIDs are
 * reused: this box runs pid_max=4194304 and the counter had reached 4142055
 * after twelve days of uptime — 98.7% of the way to wrapping, after which low
 * PIDs get reissued. A lock left behind by a dead deliver names a PID that some
 * unrelated process eventually owns, `pidAlive` then returns true, and with no
 * heartbeat `isDeliverHolderWedged` returns false. Every later deliver in that
 * project defers forever with "a deliver run is already in progress", and
 * nothing recovers it — the wedge path needs a heartbeat the dead holder never
 * wrote.
 *
 * Found with a real eleven-day-old lock (pid 998109) still sitting in the repo.
 *
 * The rule: a real holder stamps a heartbeat the instant it takes the lock, so
 * "no heartbeat at all AND older than the wedge timeout" cannot be a live run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireDeliverLock,
  isDeliverLockAbandoned,
  isDeliverHolderWedged,
  DEFAULT_WEDGE_TIMEOUT_S,
} from '../../src/cli/deliver.js';

let proj: string;

const nowS = () => Math.floor(Date.now() / 1000);
const lockPath = () => join(proj, '.uap', 'deliver.lock');

/** Write a lock as if `pid` took it `agoS` seconds ago. */
function writeLock(pid: number, agoS: number): void {
  const iso = new Date((nowS() - agoS) * 1000).toISOString();
  writeFileSync(lockPath(), `${pid}|${iso}`);
}

function writeHeartbeat(agoS: number): void {
  writeFileSync(join(proj, '.uap', 'deliver.heartbeat'), String(nowS() - agoS));
}

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'uap-lock-'));
  mkdirSync(join(proj, '.uap'), { recursive: true });
});
afterEach(() => rmSync(proj, { recursive: true, force: true }));

describe('isDeliverLockAbandoned', () => {
  it('is true for an old lock whose holder never stamped a heartbeat', () => {
    writeLock(998109, DEFAULT_WEDGE_TIMEOUT_S + 60);
    expect(isDeliverLockAbandoned(proj)).toBe(true);
  });

  it('is false while a heartbeat exists, however old the lock', () => {
    // That case belongs to the wedge path, which can tell progress from stall.
    writeLock(998109, DEFAULT_WEDGE_TIMEOUT_S * 100);
    writeHeartbeat(5);
    expect(isDeliverLockAbandoned(proj)).toBe(false);
  });

  it('is false for a fresh lock — the startup window before the first stamp', () => {
    // Reclaiming here would pull the lock out from under a run that is starting.
    writeLock(998109, 5);
    expect(isDeliverLockAbandoned(proj)).toBe(false);
  });

  it('is false when there is no lock at all', () => {
    expect(isDeliverLockAbandoned(proj)).toBe(false);
  });

  it('reads the timestamp from the lock CONTENT, not the file mtime', () => {
    // mtime is reset by a copy, a restore, or a stray touch; the embedded
    // timestamp travels with the content.
    writeLock(998109, DEFAULT_WEDGE_TIMEOUT_S + 60);
    const justTouched = new Date();
    utimesSync(lockPath(), justTouched, justTouched);
    expect(isDeliverLockAbandoned(proj)).toBe(true);
  });

  it('treats a future-dated lock as not abandoned', () => {
    // Clock skew must not read as ancient; nowS - writtenS goes negative.
    writeLock(998109, -3600);
    expect(isDeliverLockAbandoned(proj)).toBe(false);
  });

  it('falls back to mtime when the embedded timestamp is unparseable', () => {
    writeFileSync(lockPath(), '998109|not-a-date');
    const old = new Date(Date.now() - (DEFAULT_WEDGE_TIMEOUT_S + 60) * 1000);
    utimesSync(lockPath(), old, old);
    expect(isDeliverLockAbandoned(proj)).toBe(true);
  });
});

describe('acquireDeliverLock', () => {
  it('RECLAIMS an abandoned lock even when the PID is alive (reuse)', () => {
    // process.pid is certainly alive and is not us-the-holder from the lock's
    // point of view — exactly the shape of a recycled PID.
    writeLock(process.ppid || 1, DEFAULT_WEDGE_TIMEOUT_S + 60);
    const release = acquireDeliverLock(proj);
    expect(release).not.toBeNull();
    release?.();
  });

  it('still defers to a live holder that is heartbeating', () => {
    // The whole point of the lock: two concurrent deliver runs for one project
    // decompose the same epics and burn GPU in parallel. This must not regress.
    writeLock(process.ppid || 1, 10);
    writeHeartbeat(1);
    expect(acquireDeliverLock(proj)).toBeNull();
  });

  it('still defers to a live holder with an old lock but a fresh heartbeat', () => {
    // A legitimately long run: hours old, still reporting progress.
    writeLock(process.ppid || 1, DEFAULT_WEDGE_TIMEOUT_S * 5);
    writeHeartbeat(3);
    expect(isDeliverHolderWedged(proj)).toBe(false);
    expect(acquireDeliverLock(proj)).toBeNull();
  });

  it('reclaims a dead holder, as before', () => {
    writeLock(0x7ffffff0, 10); // implausible pid, not alive
    const release = acquireDeliverLock(proj);
    expect(release).not.toBeNull();
    release?.();
  });

  it('stamps a heartbeat on acquisition, so the new holder is never abandoned', () => {
    // This is what makes the rule safe: the absence of a heartbeat really does
    // mean nobody live is holding it.
    writeLock(process.ppid || 1, DEFAULT_WEDGE_TIMEOUT_S + 60);
    const release = acquireDeliverLock(proj);
    expect(release).not.toBeNull();
    expect(existsSync(join(proj, '.uap', 'deliver.heartbeat'))).toBe(true);
    expect(isDeliverLockAbandoned(proj)).toBe(false);
    release?.();
  });
});
