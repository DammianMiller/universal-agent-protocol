/**
 * Verification provenance (S1) — enforces Principle 3: "the model cannot verify
 * itself." Deliver must never let the generator be the SOLE grader of its own
 * output. When no evaluator is configured and the operator has not explicitly
 * opted into self-judging, a cheap DISTINCT judge is chosen. Local/offline
 * generators cannot reach a distinct model, so they keep self-judging but are
 * flagged distinct=false (the honest, documented fallback).
 *
 * The selection logic is pure (`resolveJudgePlan`) so it is unit-testable in
 * isolation from the model call; deliver.ts wires the executor from the plan.
 */

export interface JudgePlan {
  /** Model id that will AUTHOR/JUDGE the acceptance gate. */
  judgeModelId: string;
  /** True when the judge differs from the generator (Generator≠Evaluator). */
  distinct: boolean;
  /** Why this judge was chosen — for logs/telemetry. */
  reason:
    | 'configured-evaluator'
    | 'self-judge-allowed'
    | 'escalation-judge'
    | 'auto-distinct-judge'
    | 'offline-local-no-distinct-judge';
}

/**
 * Decide who judges. PURE. Precedence:
 *  1. an explicitly-configured evaluator preset  → distinct
 *  2. operator opted into self-judge             → generator (distinct=false)
 *  3. configured escalation arm (distinct, known preset) → the escalation model
 *  4. cloud generator, distinct cheap judge avail → the distinct judge
 *  5. local/offline (no distinct reachable)       → generator (distinct=false)
 *
 * The escalation rung (3) is the quality-tier uplift arm: a local/offline
 * generator (the reference run: exec==judge, distinct=NO) gets the verified
 * stronger model as its acceptance critic via the existing UAP_ESCALATE_MODEL
 * seam — no new switch, and a stale/unknown preset id fails soft (falls
 * through), matching deliver's evaluator fail-soft doctrine.
 */
export function resolveJudgePlan(opts: {
  evaluatorPresetId: string | null;
  generatorId: string;
  generatorProvider?: string;
  allowSelfJudge: boolean;
  /** Configured escalation arm (flag > $UAP_ESCALATE_MODEL > .uap.json deliver.escalateModel). */
  escalateModelId?: string;
  /** Cheap distinct judge preferred when the generator is cloud. */
  distinctJudgeId?: string;
  /** Cheap distinct judge to use when the generator itself IS distinctJudgeId. */
  altJudgeId?: string;
  hasPreset: (id: string) => boolean;
}): JudgePlan {
  // A configured evaluator only counts as distinct if it is actually a
  // DIFFERENT model than the generator (CWE-345: don't assert distinctness we
  // haven't verified). If it collides, fall through to the escalation/auto/
  // offline logic.
  if (opts.evaluatorPresetId && opts.evaluatorPresetId !== opts.generatorId) {
    return { judgeModelId: opts.evaluatorPresetId, distinct: true, reason: 'configured-evaluator' };
  }
  if (opts.allowSelfJudge) {
    return { judgeModelId: opts.generatorId, distinct: false, reason: 'self-judge-allowed' };
  }
  // The escalation arm outranks the implicit cheap-judge default: setting it
  // is an explicit operator designation of the quality critic. It must be a
  // KNOWN preset (stale ids fail soft) and actually distinct from the generator.
  if (
    opts.escalateModelId &&
    opts.escalateModelId !== opts.generatorId &&
    opts.hasPreset(opts.escalateModelId)
  ) {
    return { judgeModelId: opts.escalateModelId, distinct: true, reason: 'escalation-judge' };
  }
  const cloud = opts.generatorProvider === 'anthropic' || opts.generatorProvider === 'openai';
  const preferred = opts.distinctJudgeId ?? 'haiku-4.5';
  const alt = opts.altJudgeId ?? 'sonnet-5';
  const distinctId = opts.generatorId === preferred ? alt : preferred;
  if (cloud && opts.hasPreset(distinctId)) {
    return { judgeModelId: distinctId, distinct: true, reason: 'auto-distinct-judge' };
  }
  return {
    judgeModelId: opts.generatorId,
    distinct: false,
    reason: 'offline-local-no-distinct-judge',
  };
}

/**
 * Fresh-critic enforcement for tier-relevant deliveries (quality-tier uplift
 * 0.3). A project that has derived quality tiers has digitized its bar; a
 * self-verifying generator against that bar is the exact failure the reference
 * run recorded (exec==judge, distinct=NO). PURE. `blocked` demands a distinct
 * critic before the run proceeds; the operator escapes deliberately via
 * UAP_DELIVER_ALLOW_SELF_JUDGE=1 (allowSelfJudge), which stays the explicit
 * opt-out everywhere.
 */
export function resolveCriticEnforcement(opts: {
  /** True when the project carries any derived quality tier (.uap/quality/tiers.json). */
  tierRelevant: boolean;
  distinct: boolean;
  allowSelfJudge: boolean;
  generatorId: string;
}): { blocked: boolean; message?: string } {
  if (!opts.tierRelevant || opts.distinct || opts.allowSelfJudge) return { blocked: false };
  return {
    blocked: true,
    message:
      `✗ fresh-critic contract violated: tier-relevant delivery, but the generator (${opts.generatorId}) would grade its own work. ` +
      'Wire a distinct critic: --escalate-model / $UAP_ESCALATE_MODEL / .uap.json deliver.escalateModel ' +
      '(e.g. the verified qwen38-27b arm), or opt out explicitly with UAP_DELIVER_ALLOW_SELF_JUDGE=1.',
  };
}

export interface VerificationProvenance {
  executorModel: string;
  judgeModel: string;
  distinct: boolean;
  /** Names of gates that ran fail-open this delivery (observability). */
  failOpenGates?: string[];
}

/** One-line provenance banner emitted at delivery end. */
export function formatVerificationProvenance(p: VerificationProvenance): string {
  const distinct = p.distinct ? 'yes' : 'NO(self-verify)';
  const fo = p.failOpenGates && p.failOpenGates.length ? ` failOpen=[${p.failOpenGates.join(',')}]` : '';
  return `verify: exec=${p.executorModel} judge=${p.judgeModel} distinct=${distinct}${fo}`;
}
