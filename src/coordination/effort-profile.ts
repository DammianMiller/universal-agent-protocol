/**
 * Effort-dial orchestration profiles (S4).
 *
 * One profile per complexity tier decides how much machinery a task gets:
 * whether to decompose into a graph, whether to run explicit plan/review phases
 * and with how many reviewers, self-gate strictness, the turn budget, and how
 * far escalation may reach. Trivial/low tiers get near-zero overhead (no plan,
 * no review panel, no decompose); high/critical get the full treatment. This is
 * the single knob that makes "simple tasks carry little overhead, complex tasks
 * escalate accordingly" concrete — consumed by the orchestrator, the decompose
 * gate, and deliver's aid selection.
 */

import type { Tier } from '../models/complexity.js';

/** How far model escalation may reach for this tier. */
export type EscalationScope = 'fallback' | 'execute' | 'plan+execute' | 'all' | 'all+fallback';

/** Self-gate rigor: skip authoring entirely, author leniently, or full-strict. */
export type SelfGateMode = 'skip' | 'lenient' | 'strict';

export interface EffortProfile {
  tier: Tier;
  /** Allow graph decomposition into parallel/dependent nodes. */
  decompose: boolean;
  /** Run an explicit plan phase before executing. */
  plan: boolean;
  /** Run a review phase at all. */
  review: boolean;
  /** Review fan-out: 0 = none, 1 = single reviewer, ≥3 = panel. */
  reviewers: number;
  /** Run the GEPA reflect phase (S6) on stagnation. */
  reflect: boolean;
  /** Self-gate authoring rigor. */
  selfGate: SelfGateMode;
  /** Convergence turn budget. */
  maxTurns: number;
  /** How far per-phase escalation may reach. */
  escalationScope: EscalationScope;
}

const PROFILES: Record<Tier, EffortProfile> = {
  trivial: {
    tier: 'trivial',
    decompose: false,
    plan: false,
    review: false,
    reviewers: 0,
    reflect: false,
    selfGate: 'lenient',
    maxTurns: 2,
    escalationScope: 'fallback',
  },
  low: {
    tier: 'low',
    decompose: false,
    plan: false,
    review: true,
    reviewers: 1,
    reflect: false,
    selfGate: 'strict',
    maxTurns: 3,
    escalationScope: 'execute',
  },
  medium: {
    tier: 'medium',
    decompose: false,
    plan: true,
    review: true,
    reviewers: 1,
    reflect: false,
    selfGate: 'strict',
    maxTurns: 5,
    escalationScope: 'plan+execute',
  },
  high: {
    tier: 'high',
    decompose: true,
    plan: true,
    review: true,
    reviewers: 3,
    reflect: true,
    selfGate: 'strict',
    maxTurns: 10,
    escalationScope: 'all',
  },
  critical: {
    tier: 'critical',
    decompose: true,
    plan: true,
    review: true,
    reviewers: 3,
    reflect: true,
    selfGate: 'strict',
    maxTurns: 20,
    escalationScope: 'all+fallback',
  },
};

/** The effort profile for a complexity tier. Pure, total (every tier mapped). */
export function profileForTier(tier: Tier): EffortProfile {
  return PROFILES[tier];
}
