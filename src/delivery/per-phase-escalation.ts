/**
 * Per-phase escalation — hybrid policy (S5).
 *
 * Generalizes the single global escalate-model (repair-escalation.ts's
 * resolveEscalateModelId) into a per-(tier, phase) escalation ladder that
 * composes S3's per-phase model chains:
 *   - rungs 0..n-1 walk the FIXED chain for the (tier, phase) — deterministic,
 *     testable (e.g. execute: qwen → sonnet → opus);
 *   - once the chain is exhausted, the FINAL rung defers to a CAPABILITY-driven
 *     pick (the adaptive ceiling) — the "hybrid" the design selected.
 *
 * Pure and injectable: the capability pick is a parameter so the real
 * unified-router selector can be wired in without changing this contract. Each
 * phase escalates on its OWN ladder, so a stalled execute phase advances the
 * execute chain without disturbing the review/plan phases (Generator≠Evaluator
 * is preserved because review/execute chains are independent).
 */

import { resolvePhaseChain, type RoutingPreset, type Phase, type TaskComplexity } from '../models/types.js';

export type EscalationPolicy = 'fixed' | 'capability';

export interface EscalationStep {
  /** The model id to run this rung on. */
  model: string;
  /** Whether this rung came from the fixed chain or the capability ceiling. */
  policy: EscalationPolicy;
  /** The (clamped) rung index that produced this step. */
  rung: number;
  /** True once the fixed chain is exhausted (capability fallback engaged). */
  exhausted: boolean;
}

/** Default capability ceiling: the preset's fallback role, else the last model
 * in the preset's model list, else the executor role. */
export function defaultCapabilityPick(preset: RoutingPreset): string {
  return preset.roles.fallback ?? preset.models[preset.models.length - 1] ?? preset.roles.executor;
}

/**
 * Resolve the model for an escalation rung of a (tier, phase). Hybrid policy:
 * fixed chain first, capability-driven ceiling once exhausted. PURE.
 */
export function resolveEscalation(opts: {
  preset: RoutingPreset;
  complexity?: TaskComplexity;
  phase: Phase;
  /** 0-based escalation rung (0 = primary, 1 = first escalation, …). */
  rung: number;
  /** Injectable capability picker for the final rung; defaults to the ceiling. */
  capabilityPick?: (preset: RoutingPreset) => string;
}): EscalationStep {
  const chain = resolvePhaseChain(opts.preset, { complexity: opts.complexity, phase: opts.phase });
  const rung = Math.max(0, Math.floor(opts.rung));
  if (chain.length > 0 && rung < chain.length) {
    return { model: chain[rung], policy: 'fixed', rung, exhausted: false };
  }
  const pick = opts.capabilityPick ?? defaultCapabilityPick;
  return { model: pick(opts.preset), policy: 'capability', rung, exhausted: true };
}

/**
 * Whether a phase is allowed to escalate under an effort scope. `execute` is
 * always allowed; `plan` only under plan+/all scopes; `review`/`reflect` only
 * under `all`/`all+fallback`; `fallback` only under `all+fallback`.
 */
export function phaseMayEscalate(
  phase: Phase,
  scope: 'fallback' | 'execute' | 'plan+execute' | 'all' | 'all+fallback'
): boolean {
  switch (phase) {
    case 'execute':
      return scope !== 'fallback';
    case 'plan':
      return scope === 'plan+execute' || scope === 'all' || scope === 'all+fallback';
    case 'review':
    case 'reflect':
      return scope === 'all' || scope === 'all+fallback';
    case 'fallback':
      return scope === 'all+fallback' || scope === 'fallback';
    default:
      return false;
  }
}
