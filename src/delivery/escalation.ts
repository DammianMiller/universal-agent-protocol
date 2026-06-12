/**
 * Escalation Controller (Phase 5)
 *
 * An onIteration handler that watches for stagnation and climbs an escalation
 * ladder: when the best gate score stops improving for N consecutive turns,
 * advance to the next tier. Tiers escalate cost progressively — widen
 * exploration, enable the critic, raise the turn budget, and finally switch to
 * a stronger model — so cheap strategies are exhausted before expensive ones.
 *
 * The controller is pure policy: it inspects IterationRecords and returns
 * directives. The loop owns all mutation. This keeps escalation testable in
 * isolation and swappable without touching the loop.
 */

import type { IterationRecord, IterationDirective, LoopExecutor } from './convergence-loop.js';

export interface EscalationTier {
  /** Label surfaced in directive notes and logs */
  label: string;
  /** Widen best-of-N exploration to this many candidates */
  setCandidates?: number;
  /** Turn the structured critic on */
  enableCritic?: boolean;
  /** Raise the absolute turn budget */
  raiseMaxTurns?: number;
  /** Escalate to a stronger model */
  switchExecutor?: LoopExecutor;
}

export interface EscalationConfig {
  tiers: EscalationTier[];
  /**
   * Consecutive non-improving turns that trigger advancing one tier
   * (default 2). A turn "improves" if its score exceeds the best seen so far.
   */
  stagnationTurns?: number;
  /** Minimum score delta to count as improvement (default 0.01) */
  improvementEpsilon?: number;
  /** Called whenever a tier is applied (telemetry/logging) */
  onEscalate?: (tier: EscalationTier, turn: number) => void;
}

export interface EscalationController {
  onIteration: (record: IterationRecord) => IterationDirective;
  /** Index of the next tier to apply (for inspection/tests) */
  tierIndex(): number;
}

const DEFAULT_STAGNATION_TURNS = 2;
const DEFAULT_EPSILON = 0.01;

export interface DefaultLadderOptions {
  /** Candidates to widen exploration to on the first escalation (default 3) */
  candidates?: number;
  /** Current turn budget; the model-switch tier raises it by +2 */
  maxTurns?: number;
  /** A stronger model executor; when present, adds a final model-switch tier */
  escalateExecutor?: LoopExecutor;
  /** Display name for the stronger model (for the tier label) */
  escalateModelName?: string;
}

/**
 * The canonical escalation ladder: exhaust cheap strategies before expensive
 * ones — widen exploration, then enable the critic, then (if configured)
 * switch to a stronger model with a couple extra turns. Library-owned so
 * non-CLI callers get the same policy.
 */
export function defaultEscalationLadder(options: DefaultLadderOptions = {}): EscalationTier[] {
  const candidates = Math.max(3, options.candidates ?? 3);
  const tiers: EscalationTier[] = [
    { label: `widen exploration (${candidates} candidates)`, setCandidates: candidates },
    { label: 'enable critic', enableCritic: true },
  ];
  if (options.escalateExecutor) {
    tiers.push({
      label: `escalate model → ${options.escalateModelName ?? 'stronger model'}`,
      switchExecutor: options.escalateExecutor,
      raiseMaxTurns: (options.maxTurns ?? 5) + 2,
    });
  }
  return tiers;
}

/**
 * Build a stagnation-driven escalation controller. Returns an `onIteration`
 * suitable for ConvergenceConfig, plus a `tierIndex` accessor for tests.
 */
export function createEscalationController(config: EscalationConfig): EscalationController {
  const stagnationTurns = config.stagnationTurns ?? DEFAULT_STAGNATION_TURNS;
  const epsilon = config.improvementEpsilon ?? DEFAULT_EPSILON;

  let bestScore = -1;
  let stagnant = 0;
  let nextTier = 0;

  return {
    tierIndex: () => nextTier,
    onIteration: (record: IterationRecord): IterationDirective => {
      // A passing turn ends the loop regardless; nothing to escalate.
      if (record.passed) return {};

      if (record.score > bestScore + epsilon) {
        bestScore = record.score;
        stagnant = 0;
        return {};
      }

      // No meaningful improvement this turn.
      stagnant += 1;
      // Record the high-water mark even without clearing epsilon, so later
      // tiers measure improvement against the true best.
      if (record.score > bestScore) bestScore = record.score;

      if (stagnant < stagnationTurns) return {};

      // Stagnated — advance a tier if any remain.
      if (nextTier >= config.tiers.length) {
        return {}; // ladder exhausted; let the loop run out its budget
      }
      const tier = config.tiers[nextTier];
      nextTier += 1;
      stagnant = 0; // give the new tier a fresh window to prove itself
      config.onEscalate?.(tier, record.turn);

      return {
        setCandidates: tier.setCandidates,
        enableCritic: tier.enableCritic,
        raiseMaxTurns: tier.raiseMaxTurns,
        switchExecutor: tier.switchExecutor,
        note: `escalate → ${tier.label}`,
      };
    },
  };
}
