import { describe, it, expect } from 'vitest';
import {
  resolveJudgePlan,
  formatVerificationProvenance,
} from '../../src/delivery/verification-provenance.js';

// S1 — Principle 3: "the model cannot verify itself." resolveJudgePlan is the
// pure decision seam; these lock its precedence and the offline fallback.
const hasPreset = (id: string): boolean =>
  ['haiku-4.5', 'sonnet-5', 'opus-4.8'].includes(id);

describe('resolveJudgePlan', () => {
  it('uses a configured evaluator (distinct) when one is set', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: 'opus-4.8',
      generatorId: 'sonnet-5',
      generatorProvider: 'anthropic',
      allowSelfJudge: false,
      hasPreset,
    });
    expect(p).toEqual({ judgeModelId: 'opus-4.8', distinct: true, reason: 'configured-evaluator' });
  });

  it('keeps the generator (distinct=false) when self-judge is explicitly allowed', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: null,
      generatorId: 'opus-4.8',
      generatorProvider: 'anthropic',
      allowSelfJudge: true,
      hasPreset,
    });
    expect(p.distinct).toBe(false);
    expect(p.reason).toBe('self-judge-allowed');
    expect(p.judgeModelId).toBe('opus-4.8');
  });

  it('auto-selects a cheap DISTINCT cloud judge for a cloud generator with no evaluator', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: null,
      generatorId: 'opus-4.8',
      generatorProvider: 'anthropic',
      allowSelfJudge: false,
      hasPreset,
    });
    expect(p.distinct).toBe(true);
    expect(p.reason).toBe('auto-distinct-judge');
    expect(p.judgeModelId).toBe('haiku-4.5');
    // the judge must differ from the generator
    expect(p.judgeModelId).not.toBe('opus-4.8');
  });

  it('uses the alternate judge when the generator itself is the preferred judge', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: null,
      generatorId: 'haiku-4.5',
      generatorProvider: 'anthropic',
      allowSelfJudge: false,
      hasPreset,
    });
    expect(p.judgeModelId).toBe('sonnet-5');
    expect(p.distinct).toBe(true);
  });

  it('falls to the generator (distinct=false) for a LOCAL/offline generator', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: null,
      generatorId: 'qwen36-a3b',
      generatorProvider: 'custom', // local, 127.0.0.1 — no distinct cloud judge reachable
      allowSelfJudge: false,
      hasPreset,
    });
    expect(p.distinct).toBe(false);
    expect(p.reason).toBe('offline-local-no-distinct-judge');
    expect(p.judgeModelId).toBe('qwen36-a3b');
  });

  it('does not auto-select a judge preset that is unavailable', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: null,
      generatorId: 'opus-4.8',
      generatorProvider: 'anthropic',
      allowSelfJudge: false,
      hasPreset: () => false, // no presets reachable
    });
    expect(p.distinct).toBe(false);
    expect(p.reason).toBe('offline-local-no-distinct-judge');
  });
});

describe('formatVerificationProvenance', () => {
  it('marks a distinct judge as verified', () => {
    const line = formatVerificationProvenance({
      executorModel: 'opus-4.8',
      judgeModel: 'haiku-4.5',
      distinct: true,
    });
    expect(line).toBe('verify: exec=opus-4.8 judge=haiku-4.5 distinct=yes');
  });

  it('flags self-verification and lists fail-open gates', () => {
    const line = formatVerificationProvenance({
      executorModel: 'qwen36-a3b',
      judgeModel: 'qwen36-a3b',
      distinct: false,
      failOpenGates: ['acceptance'],
    });
    expect(line).toContain('distinct=NO(self-verify)');
    expect(line).toContain('failOpen=[acceptance]');
  });
});
