import { describe, it, expect } from 'vitest';
import { resolveAcceptanceVerdict, decideGateStrategy } from '../../src/cli/deliver.js';
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
