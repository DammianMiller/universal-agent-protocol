import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { withModelSlot } from '../../src/utils/model-slot-lease.js';

/**
 * The lease TTL exists to reap CRASHED holders — but a local-model decode
 * routinely outlives 120s, and a fixed expiry reaped LIVE holders mid-decode,
 * oversubscribing the single GPU exactly when it was busiest (review
 * 2026-08-13 F3, wt216). A working holder now heartbeats at ttl/3; a crashed
 * one stops renewing and still reaps at TTL.
 */

describe('model-slot lease heartbeat renewal', () => {
  let dir: string;
  let service: CoordinationService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-lease-hb-'));
    // Hermetic DB, twice over: the constructor takes {dbPath} (a bare string
    // silently falls through to the LIVE coordination DB), and getInstance is
    // a GLOBAL singleton that ignores later paths — without the reset, every
    // test in the process shares the first test's database.
    CoordinationDatabase.resetInstance();
    service = new CoordinationService({ dbPath: join(dir, 'coord.db') });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('renewModelSlot extends a live lease and reports a reaped one', () => {
    const id = service.acquireModelSlot('holder-a', 1, 50);
    expect(id).not.toBeNull();
    expect(service.renewModelSlot(id!, 60_000)).toBe(true);
    // Renewed well past the original 50ms TTL — still counted as active later.
    const activeSoon = service.activeModelLeases();
    expect(activeSoon).toBe(1);
    service.releaseModelSlot(id!);
    // A released (or reaped) lease cannot be renewed.
    expect(service.renewModelSlot(id!, 60_000)).toBe(false);
  });

  it('a holder running LONGER than the TTL keeps its slot via heartbeat', async () => {
    // ttl 3s (above the 1s renewal floor → heartbeat every 1s); fn runs 7s,
    // 2.3x the TTL — without renewal the lease would have been reaped twice.
    const result = await withModelSlot(
      'long-decode',
      async () => {
        await new Promise((r) => setTimeout(r, 7_000));
        // Mid-flight, the lease must still be alive — a second acquirer with
        // budget 1 must be REFUSED (no oversubscription).
        const stolen = service.acquireModelSlot('interloper', 1, 3_000);
        return { stolen };
      },
      { service, ttlMs: 3_000, timeoutMs: 2_000, cwd: dir }
    );
    expect(result.stolen).toBeNull();
    // After release the slot is free again.
    const after = service.acquireModelSlot('next', 1, 3_000);
    expect(after).not.toBeNull();
  }, 20_000);

  it('a CRASHED holder (no heartbeat) still reaps at TTL', async () => {
    const id = service.acquireModelSlot('crashed', 1, 80);
    expect(id).not.toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    // No renewal happened — the next acquirer reaps it and takes the slot.
    const next = service.acquireModelSlot('successor', 1, 80);
    expect(next).not.toBeNull();
  });
});
