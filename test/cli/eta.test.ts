/**
 * S1b · `uap eta` (bridge P5) — the operator surface over the EWMA
 * estimator. Pins the honesty contract: the sample count, the spread, and
 * the failure rate always travel with the number; thin keys are NAMED, not
 * silently missing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { etaCommand, renderEtaLine } from '../../src/cli/eta.js';
import { ModelAnalytics } from '../../src/models/analytics.js';
import { ewmaEstimate, type EtaSample } from '../../src/delivery/eta-estimate.js';

const dirs: string[] = [];
function tmpDb(): string {
  const d = join(tmpdir(), `uap-eta-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return join(d, 'analytics.db');
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(db: string, model: string, n: number, ms = 30_000, failures = 0): void {
  const rec = new ModelAnalytics(db);
  for (let i = 0; i < n; i++) {
    rec.recordOutcome({
      modelId: model,
      taskType: 'orchestrated',
      complexity: 'medium',
      success: i < n - failures, // the LAST `failures` attempts fail (chronologically newest)
      durationMs: ms + i * 100,
      turns: 4,
      tokensUsed: { input: 100, output: 200 },
      cost: 0.001,
    });
  }
  rec.close();
}

async function run(opts: Record<string, unknown>): Promise<string> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void logs.push(String(m)));
  await etaCommand(opts as never);
  return logs.join('\n');
}

describe('renderEtaLine — the honesty fields', () => {
  const s = (durationMs: number, success = true): EtaSample => ({
    durationMs,
    success,
    turns: 3,
    timestamp: '2026-10-11T00:00:00.000Z',
  });

  it('always shows the sample count, spread, and EWMA half-life', () => {
    const est = ewmaEstimate([s(1000), s(2000), s(3000), s(4000), s(5000), s(6000)])!;
    const line = renderEtaLine({ modelId: 'm', taskType: 'orchestrated', complexity: 'medium' }, est);
    expect(line).toContain('n=6/6 attempts');
    expect(line).toContain('spread 1s–6s');
    expect(line).toContain('half-life 10');
  });

  it('carries the failure caveat when attempts fail', () => {
    const est = ewmaEstimate([s(1000), s(1000), s(1000), s(9000, false), s(9000, false), s(9000, false)])!;
    const line = renderEtaLine({ modelId: 'm', taskType: 'orchestrated', complexity: 'medium' }, est);
    expect(line).toContain('50% of attempts fail');
    expect(line).toContain('2.0x wall time');
  });

  it('marks thin estimates instead of hiding them', () => {
    const est = ewmaEstimate([s(1000), s(2000), s(3000)])!;
    expect(renderEtaLine({ modelId: 'm', taskType: 'orchestrated', complexity: 'medium' }, est)).toContain(
      '[thin data]'
    );
  });
});

describe('uap eta — one key', () => {
  it('guides, never guesses, when there is no history for the key', async () => {
    const db = tmpDb();
    seed(db, 'other-model', 6);
    const out = await run({ db });
    expect(out).toContain('No estimate for');
    expect(out).toContain('fewer than 3 successful attempts');
    expect(out).toContain('uap eta --all');
  });

  it('prints the estimate with the newest sample timestamp', async () => {
    const db = tmpDb();
    seed(db, 'eta-model', 6, 30_000);
    const out = await run({ db, model: 'eta-model' });
    expect(out).toContain('Measured pace');
    expect(out).toContain('~30s per successful task');
    expect(out).toContain('newest sample:');
  });

  it('--json emits the key and the full estimate object', async () => {
    const db = tmpDb();
    seed(db, 'eta-model', 6, 30_000);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void logs.push(String(m)));
    await etaCommand({ db, model: 'eta-model', json: true });
    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed.key).toEqual({ modelId: 'eta-model', taskType: 'orchestrated', complexity: 'medium' });
    expect(parsed.estimate.samples).toBe(6);
    expect(parsed.estimate.confidence).toBe('solid');
  });

  it('refuses garbage --half-life / --limit loudly (never NaN math)', async () => {
    const errs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void errs.push(String(m)));
    await etaCommand({ db: tmpDb(), halfLife: 'abc' });
    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('--half-life must be a positive integer');
    errs.length = 0;
    await etaCommand({ db: tmpDb(), limit: 'NaN' });
    expect(errs.join('\n')).toContain('--limit must be a positive integer');
  });
});

describe('uap eta --all — the enumeration', () => {
  it('lists every key: solid estimates AND too-thin keys by name', async () => {
    const db = tmpDb();
    seed(db, 'solid-model', 6, 30_000);
    seed(db, 'thin-model', 2, 10_000); // 2 attempts: below the gate
    const out = await run({ db, all: true });
    expect(out).toContain('solid-model');
    expect(out).toContain('thin-model');
    expect(out).toContain('too few successful attempts to estimate');
  });

  it('names nothing when the store is empty (guidance, not silence)', async () => {
    const out = await run({ db: tmpDb(), all: true });
    expect(out).toContain('No recorded attempts yet');
  });

  it('is fail-soft on a broken store: guidance, not a crash', async () => {
    const dir = join(tmpdir(), `uap-eta-broken-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const out = await run({ db: join(dir, 'not-a-db'), all: true }); // a directory: SQLite cannot open it
    expect(out).toContain('No recorded attempts yet');
  });

  it('--all --json stays PURE JSON on an empty store (machine consumers first)', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void logs.push(String(m)));
    await etaCommand({ db: tmpDb(), all: true, json: true });
    const parsed = JSON.parse(logs.join('\n')); // guidance text would break this
    expect(parsed).toEqual({ keys: [], estimates: [], truncated: false });
  });

  it('names truncation when the store holds more keys than the 50-key cap', async () => {
    const db = tmpDb();
    for (let i = 0; i < 51; i++) seed(db, `model-${i}`, 3); // 51 keys: one past the cap
    const out = await run({ db, all: true });
    expect(out).toContain('model-0');
    expect(out).toContain('more keys beyond the first 50');
  });
});
