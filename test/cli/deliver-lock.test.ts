import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireDeliverLock } from '../../src/cli/deliver.js';

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
