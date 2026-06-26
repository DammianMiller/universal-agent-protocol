import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getModelSlotBudget,
  getMaxModelConcurrency,
  configuredSlots,
  probeSlots,
  inferenceBase,
  resetModelSlotCache,
  DEFAULT_SLOTS,
} from '../../src/utils/model-slots.js';
import { concurrentMap } from '../../src/utils/concurrency-pool.js';

const SLOT_ENVS = ['UAP_MODEL_SLOTS', 'UAP_MODEL_SLOT_HEADROOM', 'UAP_MODEL_ENDPOINT', 'UAP_INFERENCE_ENDPOINT'];

describe('model-slots budget', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of SLOT_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetModelSlotCache();
    dir = mkdtempSync(join(tmpdir(), 'uap-slots-'));
  });
  afterEach(() => {
    for (const k of SLOT_ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetModelSlotCache();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeConfig(modelConcurrency: Record<string, unknown>): void {
    writeFileSync(
      join(dir, '.uap.json'),
      JSON.stringify({ version: '1.0.0', project: { name: 't' }, modelConcurrency })
    );
  }

  it('env override wins and skips probing', async () => {
    process.env.UAP_MODEL_SLOTS = '6';
    const r = await getModelSlotBudget(dir, { probe: true });
    expect(r.source).toBe('env');
    expect(r.budget).toBe(6);
  });

  it('config slots used when no env', async () => {
    writeConfig({ slots: 3 });
    const r = await getModelSlotBudget(dir, { probe: false });
    expect(r.source).toBe('config');
    expect(r.budget).toBe(3);
    expect(configuredSlots(dir)).toBe(3);
  });

  it('applies headroom, floored at 1', async () => {
    process.env.UAP_MODEL_SLOTS = '4';
    process.env.UAP_MODEL_SLOT_HEADROOM = '1';
    expect((await getModelSlotBudget(dir, { probe: false })).budget).toBe(3);
    process.env.UAP_MODEL_SLOTS = '1';
    process.env.UAP_MODEL_SLOT_HEADROOM = '5';
    resetModelSlotCache();
    expect((await getModelSlotBudget(dir, { probe: false })).budget).toBe(1);
  });

  it('falls back to DEFAULT_SLOTS when nothing configured and probe disabled', async () => {
    const r = await getModelSlotBudget(dir, { probe: false });
    expect(r.source).toBe('default');
    expect(r.budget).toBe(DEFAULT_SLOTS);
  });

  it('probes the endpoint /slots when no override', async () => {
    process.env.UAP_INFERENCE_ENDPOINT = 'http://localhost:9999/v1';
    expect(inferenceBase(dir)).toBe('http://localhost:9999'); // /v1 stripped
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await getModelSlotBudget(dir, { probe: true, force: true });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:9999/slots', expect.anything());
    expect(r.source).toBe('probe');
    expect(r.budget).toBe(5);
  });

  it('probeSlots returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await probeSlots('http://x')).toBeNull();
  });

  it('getMaxModelConcurrency (sync) honors config and cached probe', () => {
    writeConfig({ slots: 3 });
    expect(getMaxModelConcurrency(dir)).toBe(3); // explicit config
  });

  it('concurrentMap mode "model" caps to the budget', async () => {
    process.env.UAP_MODEL_SLOTS = '2';
    resetModelSlotCache();
    let active = 0;
    let maxActive = 0;
    await concurrentMap(
      Array.from({ length: 8 }, (_, i) => i),
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
      { mode: 'model' }
    );
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
