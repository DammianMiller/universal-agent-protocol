/**
 * A model must not be the only thing grading its own output.
 *
 * On a project with no objective gates, deliver makes the LLM acceptance judge
 * the convergence target and SKIPS the self-authored gate. That is sound when
 * the judge is a different model. It is not verification at all when the judge
 * IS the generator — and on a local/offline setup that is the normal case:
 *
 *   ⚖ acceptance: LLM judge is the convergence target (self-gate skipped)
 *   ⚠ verify: no distinct judge reachable — generator grades its own output
 *
 * Observed live 2026-08-13 on a fresh scaffold. The harness prints both lines
 * in the same run: it KNOWS it is self-grading, and does nothing differently.
 *
 * So when the judge collapses onto the generator, author the self-gate as well.
 * A runnable script is objective in a way a self-judgement can never be, and it
 * costs one authoring call. An operator who has explicitly allowed self-judging
 * (`allowSelfJudge`) is taken at their word and gets no extra gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { needsGateDespiteAcceptance } from '../../src/cli/deliver.js';

describe('a self-grading judge is not a convergence target', () => {
  it('authors the self-gate when the judge collapses onto the generator', () => {
    expect(
      needsGateDespiteAcceptance({
        acceptancePrimary: true,
        judgeDistinct: false,
        allowSelfJudge: false,
        selfGateAllowed: true,
      })
    ).toBe(true);
  });

  it('does not when the judge is a different model', () => {
    expect(
      needsGateDespiteAcceptance({
        acceptancePrimary: true,
        judgeDistinct: true,
        allowSelfJudge: false,
        selfGateAllowed: true,
      })
    ).toBe(false);
  });

  it('respects an operator who explicitly allowed self-judging', () => {
    expect(
      needsGateDespiteAcceptance({
        acceptancePrimary: true,
        judgeDistinct: false,
        allowSelfJudge: true,
        selfGateAllowed: true,
      })
    ).toBe(false);
  });

  it('respects --no-self-gate', () => {
    expect(
      needsGateDespiteAcceptance({
        acceptancePrimary: true,
        judgeDistinct: false,
        allowSelfJudge: false,
        selfGateAllowed: false,
      })
    ).toBe(false);
  });

  it('says nothing about runs where acceptance was never primary', () => {
    // Those already author a self-gate through the normal path; this rule must
    // not double-fire or claim responsibility for them.
    expect(
      needsGateDespiteAcceptance({
        acceptancePrimary: false,
        judgeDistinct: false,
        allowSelfJudge: false,
        selfGateAllowed: true,
      })
    ).toBe(false);
  });

  it('requires ALL four conditions — no single one is sufficient', () => {
    const base = {
      acceptancePrimary: true,
      judgeDistinct: false,
      allowSelfJudge: false,
      selfGateAllowed: true,
    };
    expect(needsGateDespiteAcceptance(base)).toBe(true);
    for (const k of Object.keys(base) as Array<keyof typeof base>) {
      const flipped = { ...base, [k]: !base[k] };
      expect(needsGateDespiteAcceptance(flipped), `flipping ${k} must change the answer`).toBe(false);
    }
  });
});

describe('the authoring site honours it', () => {
  it('deliver.ts gates self-gate authoring on this rule, not on needsSelfGate alone', () => {
    // A source check: the condition sits inside runDeliver, which takes a whole
    // delivery to invoke. Regression guard against a future refactor.
    const src = readFileSync(new URL('../../src/cli/deliver.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/if\s*\(\s*needsSelfGate\s*\|\|\s*selfJudgingNeedsGate\s*\)/);
    expect(src, 'and computes it from the judge plan').toMatch(/needsGateDespiteAcceptance\(/);
  });
});
