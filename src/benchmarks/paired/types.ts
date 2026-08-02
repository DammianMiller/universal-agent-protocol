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
   * task is resolved. This is the deterministic ground-truth scorer (HIDDEN —
   * the agent never sees it).
   */
  verifyCmd: z.string(),
  /**
   * Optional VISIBLE in-repo gate command (e.g. `node test.js`) that a
   * gate-enforcing agent runs to self-verify and iterate. Distinct from
   * verifyCmd: this is what the UAP gate loop optimizes against; verifyCmd
   * (a superset) remains the authoritative ground truth. Used by the raw
   * single-shot-vs-gate-loop adapter to isolate gate value.
   */
  gateCmd: z.string().optional(),
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
  /** Bare first attempt; UAP surface only engages after a gate failure. */
  lazy?: boolean;
}

export function makeBaselineCondition(): Condition {
  return { label: 'baseline', components: new Set() };
}

export function makeFullCondition(): Condition {
  return { label: 'uap-full', components: new Set(UAP_COMPONENTS) };
}

/**
 * Lazy-UAP: attempt the task BARE first (no scaffold in the prompt); engage
 * the UAP surface + gate iteration only if the bare attempt fails the gate.
 * Measures whether "UAP on failure only" keeps the correctness win while
 * eliminating scaffold-induced regressions and first-shot overhead.
 */
export function makeLazyCondition(): Condition {
  return { label: 'uap-lazy', components: new Set(UAP_COMPONENTS), lazy: true };
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
// Quality score — the multi-dimensional quality signal (LLM Self-Tuning P0)
// ============================================================================

/**
 * The quality dimensions scored for a single run. Correctness/quality/planning
 * are judged (an LLM grades spec vs output); efficiency/toolReliability are
 * derived deterministically from the metric vector. Together they replace the
 * pass/fail binary with a signal the tuner can optimize toward Opus-level output.
 * See docs/design/LLM_SELF_TUNING_ANALYSIS.md §3.3.1.
 */
export const QUALITY_DIMENSIONS = [
  'correctness', // behavioral correctness vs the task spec (0-100)
  'quality', // output quality relative to a reference / best-practice (0-100)
  'efficiency', // tokens-per-correct-answer, normalized to 0-100 (higher = leaner)
  'toolReliability', // fraction of tool calls that were well-formed/productive (0-100)
  'planning', // multi-turn planning coherence (0-100)
] as const;
export type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

/**
 * Default composite weights (sum to 1). Correctness dominates; quality is the
 * next lever; efficiency + tool reliability are secondary. Callers may override
 * per model/task via `compositeQuality`.
 */
export const DEFAULT_QUALITY_WEIGHTS: Readonly<Record<QualityDimension, number>> = {
  correctness: 0.4,
  quality: 0.3,
  efficiency: 0.15,
  toolReliability: 0.15,
  planning: 0.0,
};

export const QualityScoreSchema = z.object({
  correctness: z.number().min(0).max(100),
  quality: z.number().min(0).max(100),
  efficiency: z.number().min(0).max(100),
  toolReliability: z.number().min(0).max(100),
  planning: z.number().min(0).max(100),
  /** Weighted composite (0-100); recomputed from the dimensions on write. */
  composite: z.number().min(0).max(100),
  /** How this score was produced: 'judge' (LLM), 'heuristic' (metrics-only), or 'hybrid'. */
  source: z.enum(['judge', 'heuristic', 'hybrid']).default('heuristic'),
  /** Optional one-line judge rationale (audit trail). */
  rationale: z.string().optional(),
});

export type QualityScore = z.infer<typeof QualityScoreSchema>;

/**
 * Compute the weighted composite (0-100) from the five dimensions. Weights are
 * renormalized over the dimensions actually supplied so a partial score (e.g.
 * planning omitted) is not silently deflated.
 */
export function compositeQuality(
  dims: Record<QualityDimension, number>,
  weights: Partial<Record<QualityDimension, number>> = DEFAULT_QUALITY_WEIGHTS,
): number {
  let wsum = 0;
  let acc = 0;
  for (const d of QUALITY_DIMENSIONS) {
    const w = weights[d] ?? 0;
    if (w <= 0) continue;
    const v = Number.isFinite(dims[d]) ? Math.max(0, Math.min(100, dims[d])) : 0;
    acc += w * v;
    wsum += w;
  }
  return wsum > 0 ? acc / wsum : 0;
}

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
  /**
   * Optional multi-dimensional quality score (LLM Self-Tuning P0). Present only
   * when the run was scored; the paired report surfaces its composite delta
   * alongside correctness so the tuner has a signal beyond pass/fail.
   */
  qualityScore?: QualityScore;
  /** Per-turn attribution from the adapter, when it produced one. */
  turnTrace?: TurnTrace[];
  /** Why the agent loop stopped. */
  stopReason?: StopReason;
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
  /**
   * Per-turn trace, so wasted work is ATTRIBUTABLE after the fact.
   *
   * The raw adapter already built a human log of this and threw it away at the
   * runner boundary, which is why "47% of cells burned the full turn budget and
   * solved nothing" could be seen in aggregate but not explained.
   */
  turnTrace?: TurnTrace[];
  /** Why the agent loop stopped — the field that makes futility measurable. */
  stopReason?: StopReason;
}

export interface TurnTrace {
  turn: number;
  /** Files the model actually wrote this turn. */
  files: number;
  /** Did the gate pass after this turn? Null when no gate ran. */
  gateOk: boolean | null;
}

export type StopReason =
  /** Gate passed. */
  | 'solved'
  /** Ran out of the iteration budget without passing. */
  | 'budget'
  /** The gate produced byte-identical output on consecutive turns. */
  | 'no-progress'
  /** The completion errored. */
  | 'error'
  /** Single-shot condition — no gate loop. */
  | 'single-shot';

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
