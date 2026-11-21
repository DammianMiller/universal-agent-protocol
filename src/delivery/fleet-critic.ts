/**
 * Fleet-critic routing (U-C) — blueprint + critic passes go to the fleet's
 * MEASURED strongest reasoning arm while the local arm builds.
 *
 * Why: a strong literal executor can pass every spec-derived gate while a
 * narrow reading of the task sets the bar (the same model blueprints, builds,
 * and grades itself). The recorded deliver outcomes already measure, per arm,
 * how often each model actually delivers and how much of the gates it clears.
 * When no explicit routing is configured (env / .uap.json / escalate-model),
 * that telemetry — not a hardcoded model name — picks the arm that authors the
 * blueprint and critiques the turns.
 *
 * Safety contract:
 *   - ONLY zero-cost (free/local) preset arms are ever auto-selected — an
 *     auto-route must never move spend to a paid API model. Paid arms stay
 *     reachable only through explicit operator routing.
 *   - Minimum sample size and a minimum edge over the ACTIVE arm (or a high
 *     absolute bar when the active arm is unproven) — a 2-run lucky arm does
 *     not take over blueprinting.
 *   - Descriptive selection, clearly logged: the deliver banner states the
 *     chosen arm, its measured rate, and the run count behind it.
 */

import { collectDeliverOutcomes, type DeliverOutcomeAggregate } from '../memory/outcome-aggregation.js';
import { loadUapConfig } from '../utils/config-loader.js';
import { ModelPresets } from '../models/types.js';

export interface FleetCriticOptions {
  /** `--no-fleet-critic` / UAP_FLEET_CRITIC=0. */
  disabled?: boolean;
  /** Minimum recorded runs for a candidate arm (default 5). */
  minRuns?: number;
  /** Minimum delivered-rate edge over the active arm (default 0.15 = 15pp). */
  deliveredEdge?: number;
  /** When the active arm has no track record, a candidate must clear this
   *  absolute delivered rate (default 0.75) — "proven strong", not a coin flip. */
  unprovenBar?: number;
}

export interface FleetCriticDecision {
  /** Chosen arm preset id; absent when no arm qualifies. */
  arm?: string;
  /** Always reported — the measured evidence or why no arm was chosen. */
  reason: string;
}

/** A free arm: a KNOWN preset with zero cost in both directions. */
function isFreeArmPreset(modelId: string): boolean {
  const preset = ModelPresets[modelId];
  if (!preset) return false;
  return preset.costPer1MInput === 0 && preset.costPer1MOutput === 0;
}

function deliveredRate(agg: DeliverOutcomeAggregate): number {
  return agg.runs > 0 ? agg.delivered / agg.runs : 0;
}

/**
 * Pure selection: the strongest zero-cost arm with a sufficient track record
 * that clearly beats the active arm. Returns the winning aggregate or null.
 * Descriptive only — the caller owns logging and routing.
 */
export function pickStrongestReasoningArm(
  aggregates: DeliverOutcomeAggregate[],
  activeModelId: string,
  opts: Pick<FleetCriticOptions, 'minRuns' | 'deliveredEdge' | 'unprovenBar'> = {}
): DeliverOutcomeAggregate | null {
  const { minRuns = 5, deliveredEdge = 0.15, unprovenBar = 0.75 } = opts;
  const candidates = aggregates.filter(
    (a) => a.model !== activeModelId && a.runs >= minRuns && isFreeArmPreset(a.model)
  );
  if (candidates.length === 0) return null;

  // Strongest first: delivered rate, then mean best-gates, then fewer turns.
  const strongest = [...candidates].sort(
    (a, b) =>
      deliveredRate(b) - deliveredRate(a) ||
      (b.bestGatesMean ?? -1) - (a.bestGatesMean ?? -1) ||
      a.turnsMean - b.turnsMean
  )[0];

  const active = aggregates.find((a) => a.model === activeModelId);
  const activeProven = Boolean(active && active.runs >= minRuns);
  if (!activeProven) {
    // No track record for the active arm: only a PROVEN-strong candidate takes over.
    return deliveredRate(strongest) >= unprovenBar ? strongest : null;
  }
  return deliveredRate(strongest) - deliveredRate(active!) >= deliveredEdge ? strongest : null;
}

/**
 * Resolve the fleet-critic decision for a deliver run. Never throws — an
 * unavailable telemetry substrate keeps today's local-fresh-context behavior.
 */
export async function applyFleetCriticRouting(
  projectRoot: string,
  activeModelId: string,
  opts: FleetCriticOptions = {}
): Promise<FleetCriticDecision> {
  if (opts.disabled) {
    return { reason: 'disabled (--no-fleet-critic / UAP_FLEET_CRITIC=0) — blueprint+critic keep explicit routing or local-fresh-context' };
  }
  try {
    const dataset = collectDeliverOutcomes(projectRoot, loadUapConfig(projectRoot));
    const strongest = pickStrongestReasoningArm(dataset.aggregates, activeModelId, opts);
    if (!strongest) {
      return {
        reason: `no stronger free arm measured across ${dataset.aggregates.length} tracked arm(s) — local-fresh-context kept`,
      };
    }
    const active = dataset.aggregates.find((a) => a.model === activeModelId);
    const activeRate = active && active.runs > 0 ? Math.round((active.delivered / active.runs) * 100) : null;
    const pct = Math.round(deliveredRate(strongest) * 100);
    return {
      arm: strongest.model,
      reason: `delivered ${pct}% over ${strongest.runs} runs${
        activeRate !== null ? ` vs active ${activeRate}%` : ' (active arm unproven)'
      }, best-gates mean ${strongest.bestGatesMean !== null ? Math.round(strongest.bestGatesMean) : 'n/a'}%`,
    };
  } catch {
    return { reason: 'outcome telemetry unavailable — local-fresh-context kept' };
  }
}
