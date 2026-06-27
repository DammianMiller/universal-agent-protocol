import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { coordDbPath } from '../../src/coordination/board-inject.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('adaptive backpressure (AIMD)', () => {
  let dir: string;
  let service: CoordinationService;
  const saved = process.env.UAP_BP_RECOVER_MS;

  beforeEach(() => {
    process.env.UAP_BP_RECOVER_MS = '100000'; // long by default; tests set per-case
    dir = mkdtempSync(join(tmpdir(), 'uap-bp-'));
    mkdirSync(join(dir, 'agents', 'data', 'coordination'), { recursive: true });
    CoordinationDatabase.resetInstance();
    service = new CoordinationService({ dbPath: coordDbPath(dir) });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.UAP_BP_RECOVER_MS;
    else process.env.UAP_BP_RECOVER_MS = saved;
    CoordinationDatabase.resetInstance();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts at the ceiling', () => {
    expect(service.getAdaptiveLimit(8)).toBe(8);
  });

  it('multiplicatively decreases on exhaustion, floored at 1', () => {
    expect(service.recordModelExhaustion(8)).toBe(4);
    expect(service.recordModelExhaustion(8)).toBe(2);
    expect(service.recordModelExhaustion(8)).toBe(1);
    expect(service.recordModelExhaustion(8)).toBe(1); // floor
    expect(service.getAdaptiveLimit(8)).toBe(1);
  });

  it('does not recover within the cooldown, then additively increases', async () => {
    // Cooldown is read per call, so flipping the env mid-test takes effect.
    process.env.UAP_BP_RECOVER_MS = '100000'; // effectively no recovery
    service.recordModelExhaustion(8); // → 4
    expect(service.recordModelSuccess(8)).toBe(4); // still in cooldown
    process.env.UAP_BP_RECOVER_MS = '1'; // ~immediate recovery
    await sleep(30); // comfortably past the 1ms cooldown
    expect(service.recordModelSuccess(8)).toBe(5); // +1
    expect(service.recordModelSuccess(8)).toBe(6);
  });

  it('never recovers above the ceiling', () => {
    expect(service.recordModelSuccess(3)).toBe(3); // already at ceiling
    expect(service.getAdaptiveLimit(3)).toBe(3);
  });

  it('clamps the limit when the ceiling drops (re-probed slot count)', () => {
    service.getAdaptiveLimit(8); // init at 8
    expect(service.getAdaptiveLimit(2)).toBe(2); // ceiling dropped → clamp
  });
});
