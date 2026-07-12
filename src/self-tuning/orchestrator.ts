/**
 * LLM Self-Tuning — the closed-loop orchestrator (P2).
 *
 * One tuning iteration: propose → apply → validate → decide → learn.
 *
 *   1. PROPOSE  the next config (LLM tuner, or GP-BO fallback).
 *   2. APPLY    the change set onto the current config (in-memory here; the
 *               committing loop in run.ts persists it via the flag-writer).
 *   3. VALIDATE it with the INJECTED paired-bench validator — it runs the
 *               candidate config against the current config over the validation
 *               (and held-out) suites and returns the quality-scored comparison.
 *   4. DECIDE   accept iff the composite-QUALITY delta clears a hysteresis band,
 *               is statistically supported, and the held-out suite doesn't
 *               regress — the "conservative validation preventing regressions"
 *               rule, keyed to quality rather than raw correctness.
 *   5. LEARN    accepted configs advance the model's TuningProfile; the loop's
 *               observations feed the GP so the next proposal is better-informed.
 *
 * The validator is injected so the loop is unit-testable without a live model,
 * exactly like the self-harness orchestrator.
 */

import type { Comparison } from '../benchmarks/paired/report.js';
import { FlagChange, FlagConfig, applyChanges } from './flags.js';
import {
  TuningContext,
  TunerOptions,
  TuningProposal,
  proposeTuning,
} from './llm-tuner.js';
import type { Observation, SearchPhase } from './search-reducer.js';

/** The paired-bench result for a candidate config vs the current config. */
export interface TuningValidationOutcome {
  validation: Comparison;
  /** Held-out comparison; null when the held-out suite was skipped. */
  heldout: Comparison | null;
  /** Measured composite quality of the candidate arm (for the observation set). */
  candidateQuality: number;
}

/**
 * Runs a candidate config against the current config and returns the scored
 * comparison. The real implementation (run.ts) applies the candidate via the
 * flag-writer, runs the paired bench with quality scoring, and reverts; tests
 * inject a deterministic stub.
 */
export type TuningValidator = (
  candidate: FlagConfig,
  current: FlagConfig,
) => Promise<TuningValidationOutcome>;

export interface TuningDecisionOptions {
  /**
   * Minimum composite-quality improvement (points, 0-100) required to accept — a
   * hysteresis band that stops the config oscillating on noise (design §6). The
   * delta must ALSO be statistically significant. Default 2.
   */
  minQualityGain?: number;
  /** Tolerated held-out quality regression before rejecting. Default 2. */
  heldoutRegressionTolerance?: number;
}

export type TuningVerdict = 'accept' | 'reject';

export interface TuningDecision {
  verdict: TuningVerdict;
  reason: string;
  qualityDelta: number;
  heldoutQualityDelta: number | null;
}

/**
 * Accept a candidate iff its validation quality delta clears the hysteresis band
 * AND is significant AND the held-out suite shows no significant quality
 * regression. Falls back to the correctness delta when quality scores are
 * absent (a bench run without scoring).
 */
export function decideTuning(
  validation: Comparison,
  heldout: Comparison | null,
  opts: TuningDecisionOptions = {},
): TuningDecision {
  const minGain = opts.minQualityGain ?? 2;
  const tol = opts.heldoutRegressionTolerance ?? 2;

  const q = validation.quality;
  const useQuality = !!q;
  const vDelta = useQuality ? q!.meanDelta : validation.correctness.delta.meanDelta;
  const vSig = useQuality ? q!.significant : validation.correctness.delta.significant;
  const hDelta = useQuality
    ? heldout?.quality?.meanDelta ?? null
    : heldout?.correctness.delta.meanDelta ?? null;
  const scaleMinGain = useQuality ? minGain : minGain / 100; // correctness is 0..1

  if (!(vDelta > scaleMinGain && vSig)) {
    return {
      verdict: 'reject',
      reason: `no ${useQuality ? 'quality' : 'correctness'} lift past hysteresis (Δ=${vDelta.toFixed(3)}, sig=${vSig}, need>${scaleMinGain})`,
      qualityDelta: vDelta,
      heldoutQualityDelta: hDelta,
    };
  }

  const heldoutRegression = useQuality
    ? heldout?.quality && heldout.quality.significant && heldout.quality.meanDelta < -tol
    : heldout?.correctness.delta.significant && heldout.correctness.delta.meanDelta < -(tol / 100);
  if (heldoutRegression) {
    return {
      verdict: 'reject',
      reason: `held-out regression (Δ=${(hDelta as number).toFixed(3)}, significant) despite validation lift`,
      qualityDelta: vDelta,
      heldoutQualityDelta: hDelta,
    };
  }

  return {
    verdict: 'accept',
    reason: `validation lift Δ=${vDelta.toFixed(3)} (sig=${vSig})` +
      (hDelta != null ? `, held-out clean (Δ=${hDelta.toFixed(3)})` : `, held-out not run`),
    qualityDelta: vDelta,
    heldoutQualityDelta: hDelta,
  };
}

export interface TuningIterationOptions {
  ctx: TuningContext;
  validate: TuningValidator;
  tuner?: TunerOptions;
  decision?: TuningDecisionOptions;
  phase?: SearchPhase;
  log?: (msg: string) => void;
}

export interface TuningIterationResult {
  proposal: TuningProposal;
  /** The config that would be adopted if accepted. */
  candidateConfig: FlagConfig;
  decision: TuningDecision | null;
  accepted: boolean;
  /** New best config after this iteration (candidate if accepted, else current). */
  config: FlagConfig;
  /** Observation appended for the GP (the candidate's measured quality). */
  observation: Observation | null;
  outcome: 'accepted' | 'rejected' | 'plateau' | 'error';
  error?: string;
}

/** Run ONE tuning iteration (propose → validate → decide). Never throws. */
export async function runTuningIteration(opts: TuningIterationOptions): Promise<TuningIterationResult> {
  const log = opts.log ?? (() => {});
  const tunerOpts: TunerOptions = { ...opts.tuner, phase: opts.phase ?? opts.tuner?.phase };

  const proposal = await proposeTuning(opts.ctx, tunerOpts);
  log(`proposed ${proposal.changes.length} change(s) via ${proposal.source}: ${proposal.rationale.slice(0, 120)}`);

  if (proposal.changes.length === 0) {
    return {
      proposal,
      candidateConfig: opts.ctx.currentConfig,
      decision: null,
      accepted: false,
      config: opts.ctx.currentConfig,
      observation: null,
      outcome: 'plateau',
    };
  }

  const candidateConfig = applyChanges(opts.ctx.currentConfig, proposal.changes);

  let decision: TuningDecision;
  let candidateQuality = NaN;
  try {
    const res = await opts.validate(candidateConfig, opts.ctx.currentConfig);
    candidateQuality = res.candidateQuality;
    decision = decideTuning(res.validation, res.heldout, opts.decision);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`  -> ERROR during validation: ${msg}`);
    return {
      proposal,
      candidateConfig,
      decision: null,
      accepted: false,
      config: opts.ctx.currentConfig,
      observation: null,
      outcome: 'error',
      error: msg,
    };
  }

  const accepted = decision.verdict === 'accept';
  log(`  -> ${decision.verdict.toUpperCase()}: ${decision.reason}`);

  const observation: Observation | null = Number.isFinite(candidateQuality)
    ? { config: candidateConfig, quality: candidateQuality }
    : null;

  return {
    proposal,
    candidateConfig,
    decision,
    accepted,
    config: accepted ? candidateConfig : opts.ctx.currentConfig,
    observation,
    outcome: accepted ? 'accepted' : 'rejected',
  };
}

/** Convert an accepted proposal's changes into a compact one-line audit string. */
export function describeChanges(changes: FlagChange[]): string {
  return changes.map((c) => `${c.key}: ${c.from} -> ${c.to}`).join(', ');
}
