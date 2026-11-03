/**
 * Declarative workflow types — the static layer over the blackboard
 * orchestrator.
 *
 * WHY THIS EXISTS. The orchestrator (src/delivery/task-orchestrator.ts)
 * executes a task DAG with fresh minimal contexts, bounded repair, and
 * resume-at-the-boundary — but the DAG it runs is MODEL-AUTHORED at runtime
 * (decompose.ts), so every mission re-plans itself and nothing is a durable,
 * inspectable, reusable asset. The measured alternative (Memdoor's
 * team-solve, GVS5H's method: five Qwen3.8-27B roles beating a frontier
 * single-call on LiveCodeBench Hard at 9.8 vs 8.0) is a workflow authored
 * ONCE as data — fixed role prompts, `requires:` edges, deterministic
 * command steps — pointed at whatever model is serving.
 *
 * This module is the file format: a `workflow.yaml` plus role-prompt files.
 * The runner (runner.ts) maps these steps onto `orchestrate()` unchanged, so
 * the graph semantics (dependency-triggered dispatch, skip cascade, minimal
 * repair, resume) are the validated delivery semantics, not a reimplementation.
 */

import { z } from 'zod';

/** Step kinds. Each maps to one execution seam in the runner. */
export const STEP_KINDS = ['agent', 'command', 'gate'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * File-system discipline for step ids: lowercase slug, no dots — a repair
 * chain namespaces links as `<id>.r0-…` (task-orchestrator.ts) and a dot in
 * the base id would blur that boundary in run-state.json.
 */
const STEP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const WorkflowStepSchema = z.object({
  id: z.string().regex(STEP_ID_RE, 'step id must be a lowercase slug (a-z, 0-9, -)'),
  kind: z.enum(STEP_KINDS),
  /** Human label for logs; defaults to the id. */
  title: z.string().min(1).optional(),
  /**
   * Per-step model pin — a ModelPresets id (e.g. `qwen38-27b`, the local
   * strata arm through the proxy). Absent = the workflow default, then the
   * CLI pin, then the local fleet default. Mirrors the decompose C2 per-leaf
   * model dial: the plan (here: the author) decides which rung each step pays.
   */
  model: z.string().min(1).optional(),
  /**
   * Path to the role-prompt file, relative to the workflow directory.
   * Agent steps take `prompt` XOR `goal` — a file keeps the workflow.yaml
   * reviewable while the role prompt stays a first-class artifact (the
   * Memdoor layout: one file per step).
   */
  prompt: z.string().min(1).optional(),
  /** Inline role prompt (alternative to `prompt:`). */
  goal: z.string().min(1).optional(),
  /** Run-directory files whose CONTENTS are inlined into the agent prompt. */
  reads: z.array(z.string().min(1)).optional(),
  /**
   * Run-directory files this step produces. The first entry receives the
   * agent reply (or the command's captured output); the rest are declared
   * for the graph's write-collision check. Overwrite semantics — the file
   * ledger is authoritative, chat is not.
   */
  writes: z.array(z.string().min(1)).optional(),
  /** DAG edges: step ids that must SUCCEED before this one runs. */
  requires: z.array(z.string().min(1)).optional(),
  /** Acceptance criteria lines — assembled into the agent prompt. */
  criteria: z.array(z.string().min(1)).optional(),
  /** command kind: shell line, run with cwd = the run directory. */
  command: z.string().min(1).optional(),
  /**
   * command kind: capture the output but never fail the run — Memdoor's
   * `test` step ("test-output.log (never fails the run)"). The verdict step
   * is simply a command WITHOUT this flag: a nonzero exit fails the run.
   */
  neverFails: z.boolean().optional(),
  /** command kind: kill the command after this many ms (default 120000). */
  timeoutMs: z.number().int().positive().optional(),
  /** gate kind: prompt shown when the run pauses for approval. */
  approvalPrompt: z.string().min(1).optional(),
  /**
   * gate kind: maximum ms to WAIT for `uap workflow approve` before
   * reporting the run as blocked (exit 2, resumable). 0 = never wait:
   * pause immediately. Default 0 — approval is an operator act, not
   * something a headless run should block a terminal on.
   */
  waitMs: z.number().int().nonnegative().optional(),
});

const WorkflowDefSchema = z.object({
  name: z.string().regex(STEP_ID_RE, 'workflow name must be a lowercase slug'),
  description: z.string().min(1).optional(),
  /**
   * Default model pin for steps that do not name one. The full resolution
   * order is step.model → defaultModel → CLI --model → the local fleet
   * default (see cli/workflow.ts) — the workflow names no model and stays
   * portable across whatever arm is serving.
   */
  defaultModel: z.string().min(1).optional(),
  /**
   * Max concurrent INDEPENDENT steps (clamped to [1,16] by the
   * orchestrator). Agent steps are stateless completions writing distinct
   * files, so >1 is safe for the steps that declare disjoint `writes`; the
   * loader rejects shared write targets across PARALLEL siblings.
   * Default 1 — one local rail serves one completion at a time.
   */
  parallel: z.number().int().min(1).max(16).optional(),
  /**
   * Bounded fresh re-execution of a failed step before its dependents are
   * blocked (orchestrator maxRepairsPerTask). Env hard-ceiling 5 applies.
   * Default: the orchestrator's (1).
   */
  maxRepairsPerStep: z.number().int().min(0).max(5).optional(),
  /** Assembled-prompt budget in chars (orchestrator contextBudgetChars). */
  contextBudgetChars: z.number().int().positive().optional(),
  steps: z.array(WorkflowStepSchema).min(1, 'a workflow needs at least one step'),
});

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;

/** The parsed + validated workflow, ready for the runner. */
export interface LoadedWorkflow {
  /** Absolute path of the workflow directory (workflow.yaml's dir). */
  dir: string;
  def: WorkflowDef;
  /**
   * Role-prompt text per agent step id, resolved from `prompt:` files at
   * load time — fail-closed: a missing prompt file is a load error, never a
   * silent empty role.
   */
  rolePrompts: Map<string, string>;
}

export const WORKFLOW_FILE = 'workflow.yaml';

/** Run lifecycle status, persisted to run-state.json after every change. */
export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed' | 'blocked';

/**
 * The persisted run state. `done` carries exactly what the orchestrator's
 * onProgress emits — id + summary (+ contract) — so a resume seeds
 * orchestrate.initialDone and finished work is never redone.
 */
export interface WorkflowRunState {
  runId: string;
  workflow: string;
  status: WorkflowRunStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  /** One-line mission text (orientation for every step context). */
  mission: string;
  /** Cumulative accepted steps (orchestrator onProgress payload). */
  done: Array<{ id: string; summary: string; contract?: string }>;
  /** Failed step ids from the last attempt (informational on resume). */
  failed: string[];
}

/** Exit-code contract — CI/cron can branch without parsing output. */
export const WORKFLOW_EXIT = {
  ok: 0,
  /** A step failed (and its repairs); dependents were skipped. */
  stepFailed: 1,
  /** The run paused at a gate awaiting approval — resumable. */
  blocked: 2,
  /** The workflow file itself is invalid — never retriable as-is. */
  invalid: 3,
} as const;

/** Narrow the raw parsed YAML into the typed def, with a flat error list. */
export function parseWorkflowDef(raw: unknown): WorkflowDef {
  const parsed = WorkflowDefSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid workflow definition:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
