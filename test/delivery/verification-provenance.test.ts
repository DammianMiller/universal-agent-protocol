import { describe, it, expect } from 'vitest';
import {
  resolveJudgePlan,
  resolveCriticEnforcement,
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

  it('Q3: uses a preset-supplied distinctJudgeId (review-chain model) as the judge', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: null,
      generatorId: 'qwen36-a3b',
      generatorProvider: 'anthropic', // cloud path so the distinct judge is selected
      allowSelfJudge: false,
      distinctJudgeId: 'sonnet-5', // e.g. adaptive-tiered's review-phase model
      hasPreset,
    });
    expect(p.distinct).toBe(true);
    expect(p.reason).toBe('auto-distinct-judge');
    expect(p.judgeModelId).toBe('sonnet-5');
  });

  it('Q3: swaps to altJudgeId when the review model collides with the generator', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: null,
      generatorId: 'sonnet-5',
      generatorProvider: 'anthropic',
      allowSelfJudge: false,
      distinctJudgeId: 'sonnet-5', // collides with the generator
      altJudgeId: 'opus-4.8',
      hasPreset,
    });
    expect(p.judgeModelId).toBe('opus-4.8'); // fell to the alt
    expect(p.judgeModelId).not.toBe('sonnet-5');
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

  // Quality-tier uplift 0.3: the escalation arm as the fresh critic for
  // generators that would otherwise self-verify (the reference run's
  // exec==judge, distinct=NO on the local fleet).
  it('0.3: gives a LOCAL generator the escalation arm as a distinct judge', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: null,
      generatorId: 'qwen38-flash-next',
      generatorProvider: 'custom', // local, 127.0.0.1
      allowSelfJudge: false,
      escalateModelId: 'qwen38-27b',
      hasPreset: (id) => ['qwen38-27b', 'haiku-4.5'].includes(id),
    });
    expect(p.judgeModelId).toBe('qwen38-27b');
    expect(p.distinct).toBe(true);
    expect(p.reason).toBe('escalation-judge');
  });

  it('0.3: escalation outranks the implicit cheap-judge default (explicit operator designation)', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: null,
      generatorId: 'opus-4.8',
      generatorProvider: 'anthropic',
      allowSelfJudge: false,
      escalateModelId: 'qwen38-27b',
      hasPreset: (id) => ['qwen38-27b', 'haiku-4.5', 'sonnet-5'].includes(id),
    });
    expect(p.reason).toBe('escalation-judge');
    expect(p.judgeModelId).toBe('qwen38-27b');
  });

  it('0.3: a stale/unknown escalation preset fails soft to the offline fallback', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: null,
      generatorId: 'qwen38-flash-next',
      generatorProvider: 'custom',
      allowSelfJudge: false,
      escalateModelId: 'qwen99-turbo', // not a known preset
      hasPreset: (id) => ['haiku-4.5'].includes(id),
    });
    expect(p.distinct).toBe(false);
    expect(p.reason).toBe('offline-local-no-distinct-judge');
  });

  it('0.3: escalation that collides with the generator never fakes distinctness', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: null,
      generatorId: 'qwen38-27b',
      generatorProvider: 'custom',
      allowSelfJudge: false,
      escalateModelId: 'qwen38-27b', // same model — not a critic
      hasPreset: (id) => ['qwen38-27b'].includes(id),
    });
    expect(p.distinct).toBe(false);
    expect(p.judgeModelId).toBe('qwen38-27b');
    expect(p.reason).toBe('offline-local-no-distinct-judge');
  });

  it('0.3: a configured evaluator still outranks the escalation arm', () => {
    const p = resolveJudgePlan({
      evaluatorPresetId: 'opus-4.8',
      generatorId: 'qwen38-27b',
      generatorProvider: 'custom',
      allowSelfJudge: false,
      escalateModelId: 'sonnet-5',
      hasPreset: () => true,
    });
    expect(p.reason).toBe('configured-evaluator');
  });
});

describe('resolveCriticEnforcement (0.3 fresh-critic contract)', () => {
  it('blocks a tier-relevant self-verifying run with the fix in the message', () => {
    const r = resolveCriticEnforcement({
      tierRelevant: true,
      distinct: false,
      allowSelfJudge: false,
      generatorId: 'qwen38-flash-next',
    });
    expect(r.blocked).toBe(true);
    expect(r.message).toContain('UAP_ESCALATE_MODEL');
    expect(r.message).toContain('UAP_DELIVER_ALLOW_SELF_JUDGE=1');
  });

  it('allows the run when the judge is distinct', () => {
    expect(resolveCriticEnforcement({ tierRelevant: true, distinct: true, allowSelfJudge: false, generatorId: 'x' }).blocked).toBe(false);
  });

  it('allows the run when the operator explicitly opted into self-judge', () => {
    expect(resolveCriticEnforcement({ tierRelevant: true, distinct: false, allowSelfJudge: true, generatorId: 'x' }).blocked).toBe(false);
  });

  it('never blocks projects without derived tiers (additive default)', () => {
    expect(resolveCriticEnforcement({ tierRelevant: false, distinct: false, allowSelfJudge: false, generatorId: 'x' }).blocked).toBe(false);
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
