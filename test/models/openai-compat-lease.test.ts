import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OpenAICompatClient } from '../../src/models/openai-compat-client.js';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { resetModelSlotCache } from '../../src/utils/model-slots.js';

const MODEL = { id: 'test', apiModel: 'test-model', endpoint: 'http://localhost:9999/v1' } as never;

function okResponse(content = 'hi') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    text: async () => '',
  };
}
function errResponse(status: number) {
  return { ok: false, status, json: async () => ({}), text: async () => 'busy' };
}

describe('OpenAICompatClient model-slot compliance', () => {
  let dir: string;
  const savedEnv = process.env.UAP_MODEL_SLOTS;
  const savedDb = process.env.UAP_COORD_DB;

  beforeEach(() => {
    process.env.UAP_MODEL_SLOTS = '2';
    delete process.env.UAP_MODEL_LEASE;
    resetModelSlotCache();
    dir = mkdtempSync(join(tmpdir(), 'uap-client-'));
    process.env.UAP_COORD_DB = join(dir, 'coordination.db');
    CoordinationDatabase.resetInstance();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.UAP_MODEL_SLOTS;
    else process.env.UAP_MODEL_SLOTS = savedEnv;
    if (savedDb === undefined) delete process.env.UAP_COORD_DB;
    else process.env.UAP_COORD_DB = savedDb;
    CoordinationDatabase.resetInstance();
    resetModelSlotCache();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns content on 2xx (full functionality preserved through the lease)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('hello')));
    const r = await new OpenAICompatClient().complete(MODEL, 'hi');
    expect(r.content).toBe('hello');
  });

  it('records exhaustion on a 429 (adaptive limit backs off)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse(429)));
    const client = new OpenAICompatClient();
    await expect(client.complete(MODEL, 'hi')).rejects.toThrow(/429/);
    // The shared adaptive limit dropped below the budget of 2.
    const svc = new CoordinationService();
    expect(svc.getAdaptiveLimit(2)).toBeLessThan(2);
  });

  it('bounds concurrent calls to the slot budget (2)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return okResponse();
      })
    );
    const client = new OpenAICompatClient();
    await Promise.all(Array.from({ length: 6 }, () => client.complete(MODEL, 'hi')));
    expect(maxInFlight).toBeLessThanOrEqual(2); // never exceeds the budget
  });

  it('UAP_MODEL_LEASE=0 bypasses the lease but keeps functionality', async () => {
    process.env.UAP_MODEL_LEASE = '0';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('direct')));
    const r = await new OpenAICompatClient().complete(MODEL, 'hi');
    expect(r.content).toBe('direct');
  });
});
