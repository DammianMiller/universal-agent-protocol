import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { coordDbPath } from '../../src/coordination/board-inject.js';
import { withModelSlot } from '../../src/utils/model-slot-lease.js';

describe('model-slot lease (cross-process semaphore)', () => {
  let dir: string;
  let service: CoordinationService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-lease-'));
    mkdirSync(join(dir, 'agents', 'data', 'coordination'), { recursive: true });
    CoordinationDatabase.resetInstance();
    service = new CoordinationService({ dbPath: coordDbPath(dir) });
  });
  afterEach(() => {
    CoordinationDatabase.resetInstance();
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires up to the budget, then blocks, then frees on release', () => {
    const l1 = service.acquireModelSlot('a', 2);
    const l2 = service.acquireModelSlot('b', 2);
    const l3 = service.acquireModelSlot('c', 2);
    expect(l1).not.toBeNull();
    expect(l2).not.toBeNull();
    expect(l3).toBeNull(); // budget full
    expect(service.activeModelLeases()).toBe(2);
    service.releaseModelSlot(l1!);
    expect(service.activeModelLeases()).toBe(1);
    expect(service.acquireModelSlot('d', 2)).not.toBeNull();
  });

  it('reaps expired leases (crashed holders)', () => {
    service.acquireModelSlot('zombie', 2, -1); // already expired
    expect(service.activeModelLeases()).toBe(0); // not counted (expired)
    expect(service.reapModelLeases()).toBe(1); // and reaped
    expect(service.acquireModelSlot('fresh', 1)).not.toBeNull(); // budget 1 now free
  });

  it('withModelSlot holds for the duration then releases', async () => {
    let insideActive = -1;
    await withModelSlot(
      'holder',
      async () => {
        insideActive = service.activeModelLeases();
      },
      { service, budget: 2 }
    );
    expect(insideActive).toBe(1); // held during fn
    expect(service.activeModelLeases()).toBe(0); // released after
  });

  it('withModelSlot serializes calls when budget is 1 (no overlap)', async () => {
    let active = 0;
    let maxActive = 0;
    const run = () =>
      withModelSlot(
        'h',
        async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 25));
          active--;
        },
        { service, budget: 1, pollMs: 5 }
      );
    await Promise.all([run(), run(), run()]);
    expect(maxActive).toBe(1); // budget 1 → strictly serialized
  });
});
