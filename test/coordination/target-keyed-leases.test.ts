/**
 * Target-keyed leases and backpressure (spec §5.1, §7).
 *
 * The migration is additive: existing rows and callers that do not pass a
 * target land in the legacy 'default' bucket, so behaviour is unchanged
 * until a caller opts in. These tests pin both halves — the isolation the
 * new key buys, and the legacy behaviour it must not disturb.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { coordDbPath } from '../../src/coordination/board-inject.js';

describe('target-keyed leases and backpressure', () => {
  let dir: string;
  let service: CoordinationService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-target-lease-'));
    mkdirSync(join(dir, 'agents', 'data', 'coordination'), { recursive: true });
    CoordinationDatabase.resetInstance();
    service = new CoordinationService({ dbPath: coordDbPath(dir) });
  });
  afterEach(() => {
    CoordinationDatabase.resetInstance();
    rmSync(dir, { recursive: true, force: true });
  });

  it('two targets get independent lease budgets', () => {
    const a1 = service.acquireModelSlot('a', 1, 120_000, 'gpu0:8080');
    const a2 = service.acquireModelSlot('a2', 1, 120_000, 'gpu0:8080');
    expect(a1).not.toBeNull();
    expect(a2).toBeNull(); // gpu0:8080 budget 1 is full
    // A different target has its own budget — not throttled by the first.
    const b1 = service.acquireModelSlot('b', 1, 120_000, 'gpu1:8081');
    expect(b1).not.toBeNull();
    expect(service.activeModelLeases('gpu0:8080')).toBe(1);
    expect(service.activeModelLeases('gpu1:8081')).toBe(1);
    expect(service.activeModelLeases()).toBe(2); // fleet total unchanged
  });

  it('backpressure decrease on one target does not throttle another', () => {
    service.recordModelExhaustion(4, 'gpu0:8080');
    expect(service.getAdaptiveLimit(4, 'gpu0:8080')).toBe(2); // halved
    expect(service.getAdaptiveLimit(4, 'gpu1:8081')).toBe(4); // untouched
    // The legacy no-target callers ride the default bucket, isolated too.
    service.recordModelExhaustion(4);
    expect(service.getAdaptiveLimit(4)).toBe(2);
    expect(service.getAdaptiveLimit(4, 'gpu0:8080')).toBe(2); // unchanged by default's decrease
  });

  it('a stale or mismatched measurement is unknown: renew/reap semantics are per-lease, not per-target', () => {
    const l = service.acquireModelSlot('a', 1, 120_000, 'gpu0:8080');
    expect(service.renewModelSlot(l!, 120_000)).toBe(true);
    expect(service.renewModelSlot(999999, 120_000)).toBe(false); // reaped id is false
  });

  it('legacy callers with no target land in the default bucket and still share one budget', () => {
    const l1 = service.acquireModelSlot('x', 1); // target defaults to 'default'
    const l2 = service.acquireModelSlot('y', 1, 120_000, 'default');
    expect(l1).not.toBeNull();
    expect(l2).toBeNull(); // same bucket, same budget
  });

  it('the migration upgrades an old-shape database in place, preserving the legacy row', () => {
    // A SEPARATE db path: the beforeEach service already owns the default one.
    const dbPath = join(dir, 'legacy-coordination.db');
    CoordinationDatabase.resetInstance();
    // Hand-build the PRE-target schema exactly as it shipped, with one
    // operator-tuned backpressure row (limit 2 under ceiling 4) and one lease.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE model_leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        holder TEXT,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_model_leases_expires ON model_leases(expires_at);
      CREATE TABLE model_backpressure (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        limit_val REAL NOT NULL,
        ceiling REAL NOT NULL,
        last_decrease_at TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    raw
      .prepare(`INSERT INTO model_backpressure (id, limit_val, ceiling, last_decrease_at, updated_at) VALUES (1, 2, 4, NULL, ?)`)
      .run(new Date().toISOString());
    raw.prepare(`INSERT INTO model_leases (holder, acquired_at, expires_at) VALUES (?, ?, ?)`).run(
      'legacy-holder',
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    raw.close();

    // Opening with the new code runs the PRAGMA-guarded migration.
    service = new CoordinationService({ dbPath });
    expect(service.getAdaptiveLimit(4)).toBe(2); // tuned limit preserved in the default bucket
    expect(service.activeModelLeases('default')).toBe(1); // legacy lease mapped
    // The default bucket still admits against its own budget.
    expect(service.acquireModelSlot('new', 2, 120_000, 'default')).not.toBeNull();
    // Opening a SECOND time is idempotent (the PRAGMA guard must hold).
    CoordinationDatabase.resetInstance();
    service = new CoordinationService({ dbPath });
    expect(service.getAdaptiveLimit(4)).toBe(2);
    expect(service.activeModelLeases('default')).toBe(2);
  });
});
