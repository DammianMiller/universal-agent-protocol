/**
 * Self-Harness — the accept/reject decision gate (Stage 3 outcome).
 *
 * Implements the paper's "conservative validation preventing regressions": a Mod
 * is accepted only if it shows a positive, statistically-supported correctness
 * lift on the validation suite AND does not significantly regress a disjoint
 * held-out suite (catching overfitting), within a cost budget. Operates on the
 * existing paired-bench `Comparison` (correctness delta + McNemar + metric
 * deltas), so the statistics are exactly those `uap bench paired` already ships.
 */

import type { Comparison } from '../benchmarks/paired/report.js';

export interface DecisionOptions {
  /**
   * Max tolerated mean correctness regression on the held-out suite before a Mod
   * is rejected even if it helped validation. Default 0 = no regression allowed
   * within noise (a *significant* negative held-out delta rejects).
   */
  heldoutRegressionTolerance?: number;
  /**
   * Held-out baseline rate at or below which no regression is detectable
   * (nothing left to break). Default 0.02.
   */
  heldoutFloor?: number;
  /**
   * Max tolerated increase in mean tokens (treatment-baseline) on validation.
   * `null` disables the cost gate. Default null.
   */
  maxTokenDelta?: number | null;
}

export type DecisionVerdict = 'accept' | 'reject';

export interface Decision {
  verdict: DecisionVerdict;
  /** Human-readable rationale (logged into the profile history). */
  reason: string;
  /** The validation correctness delta that drove the call. */
  validationDelta: number;
  heldoutDelta: number | null;
}

/**
 * Decide whether to accept a candidate Mod given its validation `Comparison`
 * (treatment = with-Mod vs baseline = current harness) and an optional held-out
 * `Comparison`. A null `heldout` means held-out was not run (accept on
 * validation alone — used only for cheap inner-loop screening, never for commit).
 */
export function decideAccept(
  validation: Comparison,
  heldout: Comparison | null,
  opts: DecisionOptions = {},
): Decision {
  const tol = opts.heldoutRegressionTolerance ?? 0;
  const maxTok = opts.maxTokenDelta ?? null;

  const vDelta = validation.correctness.delta.meanDelta;
  const vSig = validation.correctness.delta.significant; // CI excludes 0
  const vNet = validation.correctness.mcnemar.netGain;
  const hDelta = heldout ? heldout.correctness.delta.meanDelta : null;

  // 1) Validation must show a real lift: a significant positive delta OR a
  //    positive McNemar net gain (CI-excludes-0 is the stronger signal; McNemar
  //    catches small-n discordant-pair wins the bootstrap CI may not resolve).
  const liftShown = (vDelta > 0 && vSig) || vNet > 0;
  if (!liftShown) {
    return {
      verdict: 'reject',
      reason: `no validation lift (Δ=${vDelta.toFixed(3)}, sig=${vSig}, mcnemar_net=${vNet})`,
      validationDelta: vDelta,
      heldoutDelta: hDelta,
    };
  }

  // 2) Cost gate (optional): reject if tokens blew up significantly on validation.
  if (maxTok != null) {
    const tokDelta = validation.metrics.tokens;
    if (tokDelta && tokDelta.significant && tokDelta.meanDelta > maxTok) {
      return {
        verdict: 'reject',
        reason: `cost blow-up: +${tokDelta.meanDelta.toFixed(0)} tokens > budget ${maxTok}`,
        validationDelta: vDelta,
        heldoutDelta: hDelta,
      };
    }
  }

  // 3) Held-out regression gate: reject if held-out shows a SIGNIFICANT negative
  //    delta beyond tolerance (a non-significant dip is noise and allowed).
  if (heldout) {
    const hd = heldout.correctness.delta;

    // 3a) The held-out arm must have been ABLE to see a regression, or "no
    //     regression" is unexamined rather than clean — and this is the one
    //     place a machine acts on that distinction unsupervised.
    //
    //     The test is the BASELINE rate, not discordance. A regression is
    //     baseline-passes -> treatment-fails, so it is undetectable exactly when
    //     the baseline already failed everything. Note a held-out at the CEILING
    //     is fine: a regression there would have shown up as treatment failures,
    //     so zero discordance is real evidence.
    if (heldout.correctness.baselineRate <= (opts.heldoutFloor ?? 0.02)) {
      return {
        verdict: 'reject',
        reason:
          `held-out could not detect a regression (baseline solved ` +
          `${(heldout.correctness.baselineRate * 100).toFixed(0)}% of ${hd.n} cells) — nothing was ` +
          'left to break, so "no regression" is unearned. Use a held-out suite the baseline can pass.',
        validationDelta: vDelta,
        heldoutDelta: hDelta,
      };
    }

    if (hd.significant && hd.meanDelta < -tol) {
      return {
        verdict: 'reject',
        reason: `held-out regression (Δ=${hd.meanDelta.toFixed(3)}, significant) despite validation lift`,
        validationDelta: vDelta,
        heldoutDelta: hDelta,
      };
    }
  }

  return {
    verdict: 'accept',
    reason: `validation lift Δ=${vDelta.toFixed(3)} (sig=${vSig}, mcnemar_net=${vNet})` +
      (heldout ? `, held-out clean (Δ=${(hDelta as number).toFixed(3)})` : `, held-out not run`),
    validationDelta: vDelta,
    heldoutDelta: hDelta,
  };
}
