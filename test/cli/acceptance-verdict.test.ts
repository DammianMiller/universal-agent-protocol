import { describe, it, expect } from 'vitest';
import { resolveAcceptanceVerdict, decideGateStrategy, shouldSkipAcceptanceJudge, resolveEvaluatorPreset, selfGateFailureIsFatal } from '../../src/cli/deliver.js';
import type { AcceptanceResult } from '../../src/delivery/acceptance-judge.js';

function result(over: Partial<AcceptanceResult>): AcceptanceResult {
  return { passed: false, score: 0, criteria: [], ...over };
}

describe('resolveAcceptanceVerdict', () => {
  it('passes a genuine fully-met verdict in either mode', () => {
    const r = result({ passed: true, score: 1, criteria: [{ requirement: 'a', met: true, reason: '' }] });
    expect(resolveAcceptanceVerdict(r, true).passed).toBe(true);
    expect(resolveAcceptanceVerdict(r, false).passed).toBe(true);
  });

  it('PRIMARY: no-evidence (passed+parseError) FAILS and omits the misleading score', () => {
    // runAcceptanceGate fails open with passed:true, score:1 on an empty repo.
    const r = result({ passed: true, score: 1, parseError: 'no source evidence found' });
    const v = resolveAcceptanceVerdict(r, true);
    expect(v.passed).toBe(false);
    expect(v.feedback).toMatch(/inconclusive|implement/i);
    // score:1 must NOT pass through — it would saturate stagnation tracking.
    expect(v.score).toBeUndefined();
  });

  it('SECONDARY: no-evidence (passed+parseError) PASSES — fail open, real gates already gate', () => {
    const r = result({ passed: true, score: 1, parseError: 'unparseable judge verdict' });
    expect(resolveAcceptanceVerdict(r, false).passed).toBe(true);
  });

  it('both modes FAIL a genuine unmet verdict and surface the gaps', () => {
    const r = result({
      passed: false,
      score: 0.5,
      criteria: [
        { requirement: 'has boss', met: false, reason: 'no boss' },
        { requirement: 'has score', met: true, reason: 'ok' },
      ],
    });
    for (const primary of [true, false]) {
      const v = resolveAcceptanceVerdict(r, primary);
      expect(v.passed).toBe(false);
      expect(v.feedback).toMatch(/ACCEPTANCE GAPS/);
      expect(v.feedback).toMatch(/has boss/);
    }
  });

  it('passes through the criteria-met score for stagnation tracking', () => {
    const r = result({ passed: false, score: 0.66, criteria: [{ requirement: 'x', met: false, reason: 'y' }] });
    expect(resolveAcceptanceVerdict(r, true).score).toBe(0.66);
  });
});

describe('decideGateStrategy', () => {
  const A = true, S = true; // hasAcceptance / selfGateAllowed shorthands

  it('--acceptance + no gates → acceptance primary, no self-gate', () => {
    const d = decideGateStrategy({ hasAcceptance: A, noRealGates: true, forceSelfGate: false, selfGateAllowed: S });
    expect(d).toEqual({ acceptancePrimary: true, needsSelfGate: false, noGatesError: false });
  });

  it('--acceptance + --force-self-gate → self-gate wins (acceptance secondary)', () => {
    const d = decideGateStrategy({ hasAcceptance: A, noRealGates: true, forceSelfGate: true, selfGateAllowed: S });
    expect(d.acceptancePrimary).toBe(false);
    expect(d.needsSelfGate).toBe(true);
  });

  it('--acceptance + real gates → secondary (no primary, no self-gate, no error)', () => {
    const d = decideGateStrategy({ hasAcceptance: A, noRealGates: false, forceSelfGate: false, selfGateAllowed: S });
    expect(d).toEqual({ acceptancePrimary: false, needsSelfGate: false, noGatesError: false });
  });

  it('no acceptance + no gates → self-gate (the classic fallback)', () => {
    const d = decideGateStrategy({ hasAcceptance: false, noRealGates: true, forceSelfGate: false, selfGateAllowed: S });
    expect(d.needsSelfGate).toBe(true);
    expect(d.noGatesError).toBe(false);
  });

  it('no acceptance + no gates + --no-self-gate → hard error (nothing to gate on)', () => {
    const d = decideGateStrategy({ hasAcceptance: false, noRealGates: true, forceSelfGate: false, selfGateAllowed: false });
    expect(d.needsSelfGate).toBe(false);
    expect(d.noGatesError).toBe(true);
  });

  it('--acceptance + no gates + --no-self-gate → acceptance primary (still gated, no error)', () => {
    const d = decideGateStrategy({ hasAcceptance: A, noRealGates: true, forceSelfGate: false, selfGateAllowed: false });
    expect(d.acceptancePrimary).toBe(true);
    expect(d.noGatesError).toBe(false);
  });
});


describe('shouldSkipAcceptanceJudge (B2 tiered acceptance)', () => {
  it('skips the per-turn judge for a simple task when not acceptance-primary', () => {
    expect(
      shouldSkipAcceptanceJudge({ acceptanceEnabled: true, complexity: 'simple', acceptancePrimary: false })
    ).toBe(true);
  });

  it('does NOT skip when acceptance is the only gate (acceptancePrimary)', () => {
    expect(
      shouldSkipAcceptanceJudge({ acceptanceEnabled: true, complexity: 'simple', acceptancePrimary: true })
    ).toBe(false);
  });

  it('does NOT skip for moderate/complex tasks', () => {
    expect(
      shouldSkipAcceptanceJudge({ acceptanceEnabled: true, complexity: 'moderate', acceptancePrimary: false })
    ).toBe(false);
    expect(
      shouldSkipAcceptanceJudge({ acceptanceEnabled: true, complexity: 'complex', acceptancePrimary: false })
    ).toBe(false);
  });

  it('does NOT skip when acceptance is disabled', () => {
    expect(
      shouldSkipAcceptanceJudge({ acceptanceEnabled: false, complexity: 'simple', acceptancePrimary: false })
    ).toBe(false);
  });
});


describe('resolveEvaluatorPreset (generator≠evaluator)', () => {
  it('returns null when no evaluator configured (single-model default)', () => {
    expect(resolveEvaluatorPreset({ generatorPreset: 'qwen35-a3b' })).toBeNull();
  });

  it('returns null when evaluator equals the generator', () => {
    expect(
      resolveEvaluatorPreset({ evaluatorModel: 'qwen35-a3b', generatorPreset: 'qwen35-a3b' })
    ).toBeNull();
  });

  it('returns the evaluator preset when it differs (flag)', () => {
    expect(
      resolveEvaluatorPreset({ evaluatorModel: 'opus', generatorPreset: 'qwen35-a3b' })
    ).toBe('opus');
  });

  it('honors the env evaluator when no flag', () => {
    expect(
      resolveEvaluatorPreset({ generatorPreset: 'qwen35-a3b', envEvaluator: 'opus' })
    ).toBe('opus');
  });

  it('flag wins over env', () => {
    expect(
      resolveEvaluatorPreset({ evaluatorModel: 'sonnet', generatorPreset: 'qwen35-a3b', envEvaluator: 'opus' })
    ).toBe('sonnet');
  });
});

describe('decideGateStrategy — anti-vacuous floor (P0, 2026-07-13)', () => {
  it('engages the self-gate when every required project gate is already green', () => {
    const d = decideGateStrategy({
      hasAcceptance: false,
      noRealGates: false,
      forceSelfGate: false,
      selfGateAllowed: true,
      baselineAllGreen: true,
    });
    expect(d.needsSelfGate).toBe(true);
    expect(d.acceptancePrimary).toBe(false);
    expect(d.noGatesError).toBe(false);
  });

  it('does not engage while a required gate can still fail at baseline', () => {
    const d = decideGateStrategy({
      hasAcceptance: false,
      noRealGates: false,
      forceSelfGate: false,
      selfGateAllowed: true,
      baselineAllGreen: false,
    });
    expect(d.needsSelfGate).toBe(false);
  });

  it('respects --no-self-gate even on a green baseline (real gates exist, so no no-gates error)', () => {
    const d = decideGateStrategy({
      hasAcceptance: false,
      noRealGates: false,
      forceSelfGate: false,
      selfGateAllowed: false,
      baselineAllGreen: true,
    });
    expect(d.needsSelfGate).toBe(false);
    expect(d.noGatesError).toBe(false);
  });

  it('acceptance-primary still wins on a no-gates repo (the floor is about green gates, not absent ones)', () => {
    const d = decideGateStrategy({
      hasAcceptance: true,
      noRealGates: true,
      forceSelfGate: false,
      selfGateAllowed: true,
      baselineAllGreen: false,
    });
    expect(d.acceptancePrimary).toBe(true);
    expect(d.needsSelfGate).toBe(false);
  });
});

describe('selfGateFailureIsFatal (no run without a convergence target)', () => {
  it('is fatal when acceptance is off — nothing else would judge the run', () => {
    expect(selfGateFailureIsFatal({ acceptanceEnabled: false, judgeSkipped: false })).toBe(true);
  });

  it('is NOT fatal when a judge will actually run', () => {
    expect(selfGateFailureIsFatal({ acceptanceEnabled: true, judgeSkipped: false })).toBe(false);
  });

  it('is fatal when acceptance is ON but the judge is SKIPPED for a simple task', () => {
    // The trap: `--acceptance` being set does not mean a gate object gets built.
    // shouldSkipAcceptanceJudge suppresses it for simple tasks, so the run would
    // proceed with no self-gate rung AND no judge — and a repo whose gates were
    // already green is then "delivered" having written nothing.
    expect(selfGateFailureIsFatal({ acceptanceEnabled: true, judgeSkipped: true })).toBe(true);
  });

  it('max fidelity is not a substitute (it is not an input at all)', () => {
    // The vision review lives INSIDE the acceptance gate; if that gate was never
    // built there is nothing for it to block. It also fails open on five separate
    // conditions, so it can never be treated as a standing blocker.
    expect(selfGateFailureIsFatal({ acceptanceEnabled: false, judgeSkipped: true })).toBe(true);
  });
});
