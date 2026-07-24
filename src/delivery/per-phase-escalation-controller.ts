/**
 * Per-phase escalation controller (integration of S5 into the loop).
 *
 * A stagnation-driven `onIteration` hook that walks the EXECUTE phase's
 * escalation chain (S5 `resolveEscalation`) rung by rung, then the capability
 * ceiling — superseding the single global `escalateModel` with the full
 * per-(tier, phase) ladder. The single-executor convergence loop can only host
 * the execute-phase ladder; plan/review/reflect ladders belong at the
 * orchestrator layer (they run distinct executors). This controller composes via
 * `composeIterationHooks`, so no loop-core change is needed — it just emits
 * `switchExecutor` directives, exactly like the existing escalation controller.
 */

import type { IterationRecord, IterationDirective, LoopExecutor } from './convergence-loop.js';
import { resolveEscalation, phaseMayEscalate } from './per-phase-escalation.js';
import type { RoutingPreset, TaskComplexity } from '../models/types.js';
import type { EscalationScope } from '../coordination/effort-profile.js';

const DEFAULT_STAGNATION_TURNS = 2;
const DEFAULT_EPSILON = 0.01;

export interface PerPhaseEscalationConfig {
  preset: RoutingPreset;
  complexity?: TaskComplexity;
  /** Effort scope gating whether the execute phase may escalate at all. */
  scope: EscalationScope;
  /** Bind a resolved model id to a LoopExecutor (provided by the CLI). */
  bindExecutor: (modelId: string) => LoopExecutor;
  stagnationTurns?: number;
  improvementEpsilon?: number;
  onEscalate?: (info: { rung: number; model: string; policy: 'fixed' | 'capability' }) => void;
}

export interface PerPhaseEscalationController {
  onIteration: (record: IterationRecord) => IterationDirective;
  /** Current execute-phase rung (0 = primary, ≥1 = escalated). For tests. */
  rung: () => number;
}

export function createPerPhaseEscalationController(
  cfg: PerPhaseEscalationConfig
): PerPhaseEscalationController {
  const stagnationTurns = cfg.stagnationTurns ?? DEFAULT_STAGNATION_TURNS;
  const epsilon = cfg.improvementEpsilon ?? DEFAULT_EPSILON;

  let bestScore = -1;
  let stagnant = 0;
  let rung = 0; // 0 = the primary model already running; escalate from rung 1
  let ceilingReached = false;

  return {
    rung: () => rung,
    onIteration: (record: IterationRecord): IterationDirective => {
      if (record.passed) return {};
      if (!phaseMayEscalate('execute', cfg.scope)) return {};
      // Don't let infra flakiness (an executor error / never-verified turn,
      // both score 0) count toward stagnation and walk the ladder to the
      // ceiling — mirror the loop's own `inconclusive` guard.
      if (record.executorError || record.gateResults.length === 0) return {};
      // Once at the capability ceiling there is nothing stronger to switch to;
      // stop re-binding the same model every stagnation window.
      if (ceilingReached) return {};

      if (record.score > bestScore + epsilon) {
        bestScore = record.score;
        stagnant = 0;
        return {};
      }

      stagnant += 1;
      if (record.score > bestScore) bestScore = record.score;
      if (stagnant < stagnationTurns) return {};

      // Stagnated — advance one execute rung along the chain / to the ceiling.
      rung += 1;
      stagnant = 0;
      const step = resolveEscalation({
        preset: cfg.preset,
        complexity: cfg.complexity,
        phase: 'execute',
        rung,
      });
      if (step.exhausted) ceilingReached = true;
      cfg.onEscalate?.({ rung, model: step.model, policy: step.policy });
      return {
        switchExecutor: cfg.bindExecutor(step.model),
        note: `per-phase escalate execute → ${step.model} (rung ${rung}, ${step.policy})`,
      };
    },
  };
}
