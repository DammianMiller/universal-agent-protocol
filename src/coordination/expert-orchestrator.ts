/**
 * Expert Orchestrator
 *
 * Picks an ordered sequence of expert droids for a given task, using the
 * existing CapabilityRouter for the primary match plus a canonical lifecycle
 * sequence (plan → architect → implement → review → release) to layer
 * appropriate experts at each phase.
 *
 * Persists per-droid success rates by reusing the AdaptivePatternStore
 * abstraction so the chain composition improves over time.
 */

import type { Task } from '../tasks/types.js';
import { CapabilityRouter, type RoutingResult } from './capability-router.js';

export type ChainPhase =
  | 'plan' // requirements clarification, ADRs, test strategy
  | 'design' // contract / API design, architecture review
  | 'implement' // language / domain experts
  | 'review' // parallel review fan-out
  | 'release'; // versioning, deploy, observability

export interface ChainStep {
  phase: ChainPhase;
  droid: string;
  rationale: string;
  /** Parallel-safe with other steps in the same phase. */
  parallel: boolean;
  /** Estimated success rate from adaptive metrics; null if not enough data. */
  successRate: number | null;
}

export interface ChainPlan {
  task: string;
  capability: RoutingResult;
  steps: ChainStep[];
  /** Capability-router confidence for the primary match (0–1). */
  confidence: number;
}

interface OrchestratorOptions {
  /** Override the canonical phase sequence (mainly for tests). */
  phases?: ChainPhase[];
  /** Custom CapabilityRouter (mainly for tests). */
  router?: CapabilityRouter;
  /** Adaptive-success lookup. Returns null when there is no history. */
  successRateFor?: (droid: string) => number | null;
}

const DEFAULT_PHASES: ChainPhase[] = ['plan', 'design', 'implement', 'review', 'release'];

/**
 * Per-phase canonical droids. The orchestrator picks from these in addition
 * to whatever the CapabilityRouter recommends based on task content.
 */
const PHASE_ROSTER: Record<ChainPhase, { droids: string[]; parallel: boolean }> = {
  plan: { droids: ['product-strategist', 'test-strategist'], parallel: true },
  design: { droids: ['architect-reviewer', 'api-designer'], parallel: true },
  // implement phase gets its droids exclusively from the capability router,
  // because language/domain choice depends on the actual files touched.
  implement: { droids: [], parallel: false },
  review: {
    droids: [
      'code-quality-reviewer',
      'security-code-reviewer',
      'performance-reviewer',
      'documentation-accuracy-reviewer',
      'test-coverage-reviewer',
    ],
    parallel: true,
  },
  release: { droids: ['release-manager'], parallel: false },
};

/**
 * Decides which roster droids are *relevant* given the capability router's
 * matched capabilities. Avoids fanning out experts that have no business
 * with this task (e.g., no api-designer if no API surface changed).
 */
function isRelevantForCapability(droid: string, matched: string[]): boolean {
  // Always-relevant defaults — these run regardless of capability match.
  const alwaysOn = new Set(['code-quality-reviewer', 'release-manager']);
  if (alwaysOn.has(droid)) return true;

  const map: Record<string, string[]> = {
    'product-strategist': ['product'],
    'test-strategist': ['testing', 'test-strategy'],
    'architect-reviewer': ['architecture'],
    'api-designer': ['api-design'],
    'security-code-reviewer': ['security'],
    'performance-reviewer': ['performance'],
    'documentation-accuracy-reviewer': ['documentation'],
    'test-coverage-reviewer': ['testing'],
  };

  const relevantCapabilities = map[droid];
  if (!relevantCapabilities) return true;
  return relevantCapabilities.some((c) => matched.includes(c));
}

/**
 * Orchestrator entry point. Stateless — instantiating is cheap; persistence
 * for adaptive metrics is delegated to the injected `successRateFor`.
 */
export class ExpertOrchestrator {
  private readonly router: CapabilityRouter;
  private readonly phases: ChainPhase[];
  private readonly successRateFor: (droid: string) => number | null;

  constructor(options: OrchestratorOptions = {}) {
    this.router = options.router ?? new CapabilityRouter();
    this.phases = options.phases ?? DEFAULT_PHASES;
    this.successRateFor = options.successRateFor ?? (() => null);
  }

  /**
   * Build a recommended chain for the given task. Task content drives the
   * capability match; the phase roster fills out the lifecycle layers.
   */
  plan(task: Task, affectedFiles?: string[]): ChainPlan {
    const capability = this.router.routeTask(task, affectedFiles);
    const matched = capability.matchedCapabilities;
    const steps: ChainStep[] = [];

    for (const phase of this.phases) {
      if (phase === 'implement') {
        // Pull from capability router's recommendations
        for (const droid of capability.recommendedDroids) {
          steps.push({
            phase,
            droid,
            rationale: `Capability match: ${capability.reasoning}`.slice(0, 240),
            parallel: false,
            successRate: this.successRateFor(droid),
          });
        }
        continue;
      }

      const roster = PHASE_ROSTER[phase];
      for (const droid of roster.droids) {
        if (!isRelevantForCapability(droid, matched)) continue;
        steps.push({
          phase,
          droid,
          rationale: `${phase} roster (matched ${matched.join(', ') || 'baseline'})`,
          parallel: roster.parallel,
          successRate: this.successRateFor(droid),
        });
      }
    }

    return {
      task: task.title ?? task.description ?? '',
      capability,
      steps,
      confidence: capability.confidence,
    };
  }
}

/**
 * Convenience for callers that have a free-form task description rather than
 * a full `Task`. Wraps the string in a minimal Task shape.
 */
export function planFromDescription(
  description: string,
  orchestrator?: ExpertOrchestrator,
  affectedFiles?: string[]
): ChainPlan {
  const orch = orchestrator ?? new ExpertOrchestrator();
  const now = new Date().toISOString();
  const task: Task = {
    id: 'adhoc',
    title: description.slice(0, 80) || 'adhoc',
    description,
    type: 'task',
    status: 'open',
    priority: 2,
    labels: [],
    createdAt: now,
    updatedAt: now,
  };
  return orch.plan(task, affectedFiles);
}
