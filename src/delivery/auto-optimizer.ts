/**
 * Auto-Optimizer — dynamic convergence-aid activation
 *
 * Makes `uap deliver` self-optimizing: every instruction is classified for
 * complexity and the convergence aids (exploration, critic, practices,
 * escalation, ideation, HALO, coordination) are enabled to match — no flags
 * required. Trivial requests keep the cheap single-shot loop; non-trivial
 * requests always get the aids that improve outcomes.
 *
 * The classifier is the dependency-free utils scorer with thresholds owned
 * HERE: this mapping gates a cost cliff (moderate ≈ 4-5× model calls per
 * turn once judge/critic are counted), so retuning the memory system's
 * retrieval thresholds must never silently change delivery's bill.
 */

import {
  measureQueryComplexity,
  type ComplexityThresholds,
  type QueryComplexity,
} from '../utils/query-complexity.js';

export type DeliveryComplexity = QueryComplexity;

/** Delivery-owned cost-tier boundaries (see module doc). */
export const DELIVERY_COMPLEXITY_THRESHOLDS: ComplexityThresholds = {
  moderate: 1,
  complex: 2,
  // Delivery takes the r4 right-sizing bet: one-file single-step missions run
  // the plain single-shot loop no matter how precisely they are specified.
  scopeCap: true,
};

export interface AutoPlan {
  complexity: DeliveryComplexity;
  /** Best-of-N exploration size; undefined keeps single-candidate turns */
  candidates?: number;
  critic: boolean;
  practices: boolean;
  escalate: boolean;
  ideate: boolean;
  halo: boolean;
  coordinate: boolean;
  /** LLM acceptance judge: verify spec behavioral completeness after gates pass */
  acceptance: boolean;
  /** Run the integration tier locally (after the fast tier passes) */
  integration: boolean;
  /** Run a local dev deploy+smoke tier locally */
  deployDev: boolean;
  /**
   * Watch CI after local-green and re-converge on failure. NOTE: even when
   * auto mode recommends it, the commit/push boundary stays OPT-IN — the
   * caller must pass --watch-ci/--until-deployed for an actual push (mirrors
   * the rule that deploy is never silently auto-triggered).
   */
  watchCi: boolean;
  /** Human-readable summary of what auto mode enabled */
  summary: string;
}

/**
 * Map instruction complexity to a convergence-aid plan.
 *
 *  - simple   → plain single-shot loop (aids would only add cost)
 *  - moderate → exploration ×3 + critic + practices + ideation + acceptance
 *               judge + HALO + coordination
 *  - complex  → the full stack (= --optimize): exploration ×4, critic,
 *               practices, escalation, ideation, acceptance judge, HALO,
 *               coordination
 *
 * The classifier is injectable for tests and future model-based upgrades.
 */
export function planAutoOptimization(
  instruction: string,
  classify: (query: string) => DeliveryComplexity = (q) =>
    measureQueryComplexity(q, DELIVERY_COMPLEXITY_THRESHOLDS)
): AutoPlan {
  const complexity = classify(instruction);

  if (complexity === 'simple') {
    return {
      complexity,
      critic: false,
      practices: false,
      escalate: false,
      ideate: false,
      halo: false,
      coordinate: false,
      acceptance: false,
      integration: false,
      deployDev: false,
      watchCi: false,
      summary: 'simple task → single-shot loop',
    };
  }

  if (complexity === 'moderate') {
    return {
      complexity,
      candidates: 3,
      critic: true,
      practices: true,
      escalate: false,
      // Ideation is cheap (one seed-generation call) and pays off whenever
      // exploration is on — divergent seeds beat the four static defaults.
      ideate: true,
      halo: true,
      coordinate: true,
      acceptance: true,
      integration: true,
      deployDev: false,
      watchCi: false,
      summary:
        'moderate task → exploration ×3, critic, practices, ideation, acceptance judge, integration tier, HALO, coordination',
    };
  }

  return {
    complexity,
    candidates: 4,
    critic: true,
    practices: true,
    escalate: true,
    ideate: true,
    halo: true,
    coordinate: true,
    acceptance: true,
    integration: true,
    deployDev: true,
    watchCi: true,
    summary:
      'complex task → exploration ×4, critic, practices, escalation, ideation, acceptance judge, integration + deploy-dev tiers, watch-ci (push stays opt-in), HALO, coordination',
  };
}
