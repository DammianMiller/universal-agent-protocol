import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireDeliverLock, isDeliverHolderWedged, wedgeTimeoutS, updateDeliverHeartbeat, readDeliverHeartbeat } from '../../src/cli/deliver.js';

describe('acquireDeliverLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-deliver-lock-'));
    delete process.env.UAP_DELIVER_NO_LOCK;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires when free and writes this pid to .uap/deliver.lock', () => {
    const release = acquireDeliverLock(dir);
    expect(release).toBeTypeOf('function');
    const lock = join(dir, '.uap', 'deliver.lock');
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, 'utf8').split('|')[0]).toBe(String(process.pid));
    release!();
    expect(existsSync(lock)).toBe(false);
  });

  it('refuses (returns null) when a LIVE holder owns the lock', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    // A live pid that is not us: our own parent process is alive.
    writeFileSync(join(dir, '.uap', 'deliver.lock'), `${process.ppid}|2026-01-01T00:00:00Z`);
    expect(acquireDeliverLock(dir)).toBeNull();
  });

  it('reclaims a STALE lock (dead holder pid)', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    // pid 2^31-1 is not a running process
    writeFileSync(join(dir, '.uap', 'deliver.lock'), `2147483646|old`);
    const release = acquireDeliverLock(dir);
    expect(release).toBeTypeOf('function');
    expect(readFileSync(join(dir, '.uap', 'deliver.lock'), 'utf8').split('|')[0]).toBe(String(process.pid));
    release!();
  });

  it('UAP_DELIVER_NO_LOCK=1 bypasses the lock entirely', () => {
    process.env.UAP_DELIVER_NO_LOCK = '1';
    const release = acquireDeliverLock(dir);
    expect(release).toBeTypeOf('function');
    expect(existsSync(join(dir, '.uap', 'deliver.lock'))).toBe(false); // no lock written
  });

  it('a DIFFERENT live process holding the lock blocks a fresh acquire (the fan-out guard)', () => {
    // Real deliver runs are separate processes, so the holder pid differs from
    // ours. Simulate a concurrent run with a live foreign pid (our parent).
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'deliver.lock'), `${process.ppid}|now`);
    expect(acquireDeliverLock(dir)).toBeNull();
    expect(acquireDeliverLock(dir)).toBeNull(); // still blocked on retry
    // holder "finishes": clear the lock -> a fresh acquire succeeds
    rmSync(join(dir, '.uap', 'deliver.lock'));
    expect(acquireDeliverLock(dir)).toBeTypeOf('function');
  });
});

describe('deliver wedge reclaim (P0 reliability)', () => {
  let dir: string;
  const heartbeatAgo = (secondsAgo: number) => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'deliver.heartbeat'), String(Math.floor(Date.now() / 1000) - secondsAgo));
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-deliver-wedge-'));
    delete process.env.UAP_DELIVER_NO_LOCK;
    delete process.env.UAP_DELIVER_WEDGE_TIMEOUT;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.UAP_DELIVER_WEDGE_TIMEOUT;
  });

  it('wedgeTimeoutS honors UAP_DELIVER_WEDGE_TIMEOUT, else defaults to 1800', () => {
    expect(wedgeTimeoutS()).toBe(1800);
    process.env.UAP_DELIVER_WEDGE_TIMEOUT = '30';
    expect(wedgeTimeoutS()).toBe(30);
    process.env.UAP_DELIVER_WEDGE_TIMEOUT = 'not-a-number';
    expect(wedgeTimeoutS()).toBe(1800); // invalid -> default
  });

  it('updateDeliverHeartbeat round-trips through readDeliverHeartbeat, fresh => not wedged', () => {
    updateDeliverHeartbeat(dir); // the REAL writer (atomic temp+rename)
    const hb = readDeliverHeartbeat(dir);
    expect(hb).not.toBeNull();
    expect(hb as number).toBeGreaterThan(0);
    expect(Math.abs((hb as number) - Math.floor(Date.now() / 1000))).toBeLessThan(3);
    expect(isDeliverHolderWedged(dir)).toBe(false); // just stamped
  });

  it('readDeliverHeartbeat rejects an empty/torn file as null (not epoch 0)', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'deliver.heartbeat'), '');
    expect(readDeliverHeartbeat(dir)).toBeNull();
    expect(isDeliverHolderWedged(dir)).toBe(false); // torn read must NOT read as wedged
  });

  it('isDeliverHolderWedged: stale heartbeat -> true, fresh -> false, missing -> false', () => {
    expect(isDeliverHolderWedged(dir)).toBe(false); // no heartbeat yet
    heartbeatAgo(2000); // older than the 600s default
    expect(isDeliverHolderWedged(dir)).toBe(true);
    heartbeatAgo(5); // fresh
    expect(isDeliverHolderWedged(dir)).toBe(false);
  });

  it('RECLAIMS a live holder whose heartbeat is STALE (the wedge case)', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'deliver.lock'), `${process.ppid}|now`); // live foreign holder
    heartbeatAgo(2000); // but wedged
    const release = acquireDeliverLock(dir);
    expect(release).toBeTypeOf('function'); // reclaimed despite a live pid
    expect(readFileSync(join(dir, '.uap', 'deliver.lock'), 'utf8').split('|')[0]).toBe(String(process.pid));
    release!();
  });

  it('still DEFERS to a live holder with a FRESH heartbeat (no false reclaim)', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'deliver.lock'), `${process.ppid}|now`);
    heartbeatAgo(5); // healthy
    expect(acquireDeliverLock(dir)).toBeNull();
  });
});
