/**
 * S1b · handsfree status ETA line (bridge P5) — the remaining-work wall clock
 * for the ledger, scaled by the model's own attempts-per-success. Pins the
 * gate (no estimate → no line) and the thin caveat.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handsfreeEtaLine } from '../../src/cli/handsfree.js';
import { ModelAnalytics } from '../../src/models/analytics.js';

const dirs: string[] = [];
function tmpDb(): string {
  const d = join(tmpdir(), `uap-hf-eta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return join(d, 'analytics.db');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(db: string, model: string, n: number): void {
  const rec = new ModelAnalytics(db);
  for (let i = 0; i < n; i++) {
    rec.recordOutcome({
      modelId: model,
      taskType: 'orchestrated',
      complexity: 'medium',
      success: true,
      durationMs: 60_000,
      turns: 4,
      tokensUsed: { input: 100, output: 200 },
      cost: 0.001,
    });
  }
  rec.close();
}

describe('handsfreeEtaLine — the remaining-work wall clock', () => {
  it('scales remaining items by the model\'s measured pace (attempts/success included)', () => {
    const db = tmpDb();
    seed(db, 'hf-model', 6);
    const line = handsfreeEtaLine('hf-model', 4, db)!;
    expect(line).not.toBeNull();
    expect(line).toContain('eta:');
    expect(line).toContain('~4.0 min'); // 4 items × 1.0 attempts/success × ~60s
    expect(line).toContain('n=6/6');
  });

  it('is null without an estimate — thin data must not guess at the ledger', () => {
    expect(handsfreeEtaLine('hf-model', 4, tmpDb())).toBeNull();
  });

  it('is null when there is nothing remaining', () => {
    const db = tmpDb();
    seed(db, 'hf-model', 6);
    expect(handsfreeEtaLine('hf-model', 0, db)).toBeNull();
  });

  it('marks thin estimates with the caveat, not silence', () => {
    const db = tmpDb();
    seed(db, 'hf-model', 3); // thin: 3-5 successes
    const line = handsfreeEtaLine('hf-model', 2, db)!;
    expect(line).toContain('(thin data)');
  });
});
