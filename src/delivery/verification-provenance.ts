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
    | 'auto-distinct-judge'
    | 'offline-local-no-distinct-judge';
}

/**
 * Decide who judges. PURE. Precedence:
 *  1. an explicitly-configured evaluator preset  → distinct
 *  2. operator opted into self-judge             → generator (distinct=false)
 *  3. cloud generator, distinct cheap judge avail → the distinct judge
 *  4. local/offline (no distinct reachable)       → generator (distinct=false)
 */
export function resolveJudgePlan(opts: {
  evaluatorPresetId: string | null;
  generatorId: string;
  generatorProvider?: string;
  allowSelfJudge: boolean;
  /** Cheap distinct judge preferred when the generator is cloud. */
  distinctJudgeId?: string;
  /** Cheap distinct judge to use when the generator itself IS distinctJudgeId. */
  altJudgeId?: string;
  hasPreset: (id: string) => boolean;
}): JudgePlan {
  if (opts.evaluatorPresetId) {
    return { judgeModelId: opts.evaluatorPresetId, distinct: true, reason: 'configured-evaluator' };
  }
  if (opts.allowSelfJudge) {
    return { judgeModelId: opts.generatorId, distinct: false, reason: 'self-judge-allowed' };
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
