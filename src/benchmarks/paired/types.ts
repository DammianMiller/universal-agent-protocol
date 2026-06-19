/**
 * Paired UAP Benchmark Harness — Shared Types
 *
 * Design goal (from the eval-methodology research): measure a *scaffold* layer
 * (UAP) by holding the base model + base agent constant and toggling UAP on/off
 * over the SAME task suite and seeds. The unit of measurement is not a single
 * accuracy number but a *vector* of paired metrics (correctness, tokens, cost,
 * turns, tool-calls, latency), reported with confidence intervals on the paired
 * delta. See ./stats.ts for the statistics and ./report.ts for the framing.
 *
 * This file is the dependency-free core: pure type/Zod definitions reused by the
 * adapter, runner, ablation, and report modules.
 */

import { z } from 'zod';

// ============================================================================
// Task suite
// ============================================================================

/**
 * A single real-gate benchmark task. Each task is a self-contained git fixture
 * with a failing state and a deterministic `verify` command that is the ground
 * truth: exit 0 => the agent resolved the task. No LLM judge.
 */
export const TaskSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Natural-language instruction handed verbatim to the agent under test. */
  instruction: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  /** Free-form tags for slicing results (e.g. 'bugfix', 'feature', 'refactor'). */
  tags: z.array(z.string()).default([]),
  /**
   * Path (relative to the task directory) to the repo fixture that gets copied
   * into an isolated scratch dir for each run. Defaults to 'repo'.
   */
  repoDir: z.string().default('repo'),
  /**
   * Shell command (run inside the scratch repo) that returns exit 0 iff the
   * task is resolved. This is the deterministic ground-truth scorer.
   */
  verifyCmd: z.string(),
  /** Optional setup command run once after the repo is copied, before the agent. */
  setupCmd: z.string().optional(),
  /** Seconds before the verify command is killed and treated as failure. */
  verifyTimeoutSec: z.number().default(120),
  /** Seconds before the agent run is killed and treated as failure. */
  agentTimeoutSec: z.number().default(600),
});

export type TaskSpec = z.infer<typeof TaskSpecSchema>;

// ============================================================================
// Conditions & UAP components
// ============================================================================

/**
 * The toggleable UAP components, used by the ablation harness. Turning all of
 * them off is equivalent to the bare-agent baseline; turning all on is full UAP.
 */
export const UAP_COMPONENTS = [
  'gates', // completion gates (build/test/lint convergence)
  'worktree', // worktree isolation
  'memory', // persistent semantic memory injection
  'experts', // expert routing
  'skills', // skill matching
  'patterns', // pattern router
] as const;

export type UapComponent = (typeof UAP_COMPONENTS)[number];

/**
 * A condition is one arm of the experiment: which UAP components are active.
 * `baseline` = all off; `full` = all on; ablations turn exactly one off.
 */
export interface Condition {
  /** Stable label used in reports, e.g. 'baseline', 'uap-full', 'no-gates'. */
  label: string;
  /** Components enabled for this arm. */
  components: ReadonlySet<UapComponent>;
}

export function makeBaselineCondition(): Condition {
  return { label: 'baseline', components: new Set() };
}

export function makeFullCondition(): Condition {
  return { label: 'uap-full', components: new Set(UAP_COMPONENTS) };
}

/** True when this condition is the bare-agent baseline (no UAP at all). */
export function isBaseline(c: Condition): boolean {
  return c.components.size === 0;
}

// ============================================================================
// Metric vector — captured per single run
// ============================================================================

export const MetricVectorSchema = z.object({
  /** Ground truth: did the verify command pass. */
  correct: z.boolean(),
  /** Total tokens (prompt + completion) consumed by the agent, if known. */
  tokens: z.number().nullable(),
  /** Estimated USD cost, if a price could be applied. */
  costUsd: z.number().nullable(),
  /** Agent loop iterations / turns, if reported. */
  turns: z.number().nullable(),
  /** Tool calls made by the agent, if reported. */
  toolCalls: z.number().nullable(),
  /** Wall-clock latency of the agent run in milliseconds. */
  latencyMs: z.number(),
  /** Whether the agent produced a well-formed edit (format compliance), if known. */
  wellFormed: z.boolean().nullable(),
  /** Non-fatal note or error message captured during the run. */
  error: z.string().nullable(),
});

export type MetricVector = z.infer<typeof MetricVectorSchema>;

/** The continuous (numeric) metric keys eligible for paired-delta analysis. */
export const CONTINUOUS_METRICS = [
  'tokens',
  'costUsd',
  'turns',
  'toolCalls',
  'latencyMs',
] as const;
export type ContinuousMetric = (typeof CONTINUOUS_METRICS)[number];

// ============================================================================
// Run records
// ============================================================================

/** One execution of one task under one condition at one seed/epoch. */
export interface RunRecord {
  taskId: string;
  condition: string; // Condition.label
  /** Seed/epoch index — same value pairs runs across conditions for analysis. */
  seed: number;
  metrics: MetricVector;
  /** Adapter that produced this run (e.g. 'mock', 'opencode', 'claude'). */
  adapter: string;
  /** Model identifier the adapter ran against. */
  model: string;
}

// ============================================================================
// Adapter contract
// ============================================================================

/**
 * Result returned by an AgentAdapter for a single run, before the verify
 * command is applied. `correct` is filled in by the runner from the verify
 * command, so adapters return everything *except* correctness.
 */
export interface AgentRunResult {
  tokens: number | null;
  costUsd: number | null;
  turns: number | null;
  toolCalls: number | null;
  wellFormed: boolean | null;
  error: string | null;
  /** Raw stdout/log for debugging and post-hoc audit (HAL-style log inspection). */
  rawLog?: string;
}

export interface AgentRunContext {
  task: TaskSpec;
  condition: Condition;
  /** Absolute path to the isolated scratch repo the agent should operate on. */
  workdir: string;
  seed: number;
  model: string;
}

export interface AgentAdapter {
  /** Stable adapter id used in reports. */
  readonly id: string;
  /** Drive the agent over `ctx.workdir`. Must not throw on agent failure — */
  /** capture it in `error` and return. May throw only on harness misconfig.  */
  run(ctx: AgentRunContext): Promise<AgentRunResult>;
}

// ============================================================================
// Runner config
// ============================================================================

export interface RunnerConfig {
  tasks: TaskSpec[];
  conditions: Condition[];
  adapter: AgentAdapter;
  model: string;
  /** Number of paired seeds/epochs per (task, condition). Research: >=5. */
  epochs: number;
  /** Max concurrent runs. */
  concurrency: number;
  /** Directory for scratch repos + artifacts. */
  workRoot: string;
  /** Optional progress callback. */
  onProgress?: (done: number, total: number, label: string) => void;
}
