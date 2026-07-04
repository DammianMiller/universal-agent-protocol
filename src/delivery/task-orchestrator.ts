/**
 * Blackboard Task Orchestrator (P1) + Minimal Context Assembler (P2)
 *
 * The mechanism that lets a small-context model multi-step through a large
 * build: instead of one convergence loop holding the WHOLE design in context,
 * the orchestrator executes a task DAG where each leaf task runs in a FRESH,
 * MINIMAL context assembled from externalized state — its own goal, its
 * acceptance criteria, and ONLY the recorded outputs of its direct
 * dependencies (not the full mission, not every prior summary).
 *
 * State lives on a "blackboard" (completed task outcomes), not in the prompt.
 * A task that finishes writes a compact summary (P1) — and later its verified
 * interface contract (P4) — back to the blackboard, so a dependent task loads
 * a few hundred tokens of "what already exists" rather than re-reading source.
 *
 * This module is executor-agnostic: it takes a `runTask` callback that turns
 * an assembled prompt into a pass/fail outcome (production wires the
 * ConvergenceLoop; tests inject a deterministic stub). That keeps the graph
 * logic unit-testable without a model.
 */

import type { DeliveryPhase } from './decompose.js';
import { topoOrder } from './decompose.js';

/** A leaf task on the blackboard. Extends the decompose phase shape. */
export interface OrchestratorTask extends DeliveryPhase {
  /** Files this task is expected to create/modify (scopes the fresh context). */
  files?: string[];
  /** Acceptance criteria for this task specifically (spec slice). */
  criteria?: string[];
}

/** What a completed task publishes to the blackboard for its dependents. */
export interface TaskOutcome {
  taskId: string;
  success: boolean;
  /** One-line, harness-composed: what this task produced (dependents read this). */
  summary: string;
  /** Turns spent, for reporting. */
  turns: number;
  /** Verified interface/contract this task exposes (P4). */
  contract?: string;
  /**
   * Adaptive re-planning (P5): a task that discovers the plan is incomplete can
   * emit new subtasks into the graph. They are appended (bounded by a total
   * cap) and executed once their deps are met. IDs must be unique vs existing.
   */
  newTasks?: OrchestratorTask[];
}

/** Assembled minimal context for one task — the P2 payoff. */
export interface AssembledContext {
  taskId: string;
  prompt: string;
  /** The dependency ids whose outputs were included (for logging/audit). */
  includedDeps: string[];
}

export interface OrchestratorConfig {
  /** The overall objective — included as a SHORT orienting line only, never
   * the full spec dump (the whole point is not to load it all). */
  mission: string;
  tasks: OrchestratorTask[];
  /**
   * Execute one task from its assembled context. Returns the outcome. The
   * production impl runs a ConvergenceLoop scoped to this task; a test injects
   * a deterministic function.
   */
  runTask: (ctx: AssembledContext, task: OrchestratorTask) => Promise<TaskOutcome>;
  /**
   * Publish a completed task's outcome to durable memory (P3/P4). Optional;
   * fail-soft. The in-run blackboard is always maintained regardless.
   */
  publish?: (outcome: TaskOutcome, task: OrchestratorTask) => void | Promise<void>;
  /** Max chars of a dependency summary to inline (keeps context minimal). */
  maxDepSummaryChars?: number;
  /**
   * Context governor (P6): hard cap on the assembled prompt size. When the
   * minimal context still exceeds this, dependency sections are trimmed
   * (furthest deps first) to fit — the invariant "small model sees a small
   * context" is enforced, not merely intended. Chars, default 6000.
   */
  contextBudgetChars?: number;
  /**
   * Design store (P3): optional retrieval of relevant persisted design
   * decisions for a task (objective/architecture/constraints), so the model
   * reconstructs "what am I building and why" from a small query instead of a
   * full-mission prompt. Returns compact lines; fail-soft.
   */
  retrieveDesign?: (task: OrchestratorTask) => string[] | Promise<string[]>;
  /** Absolute cap on total tasks (re-planning guard). Default 40. */
  maxTasks?: number;
  /** Progress hook. */
  onTask?: (task: OrchestratorTask, outcome: TaskOutcome) => void;
}

export interface OrchestratorResult {
  success: boolean;
  completed: string[];
  failed: string[];
  /** Aggregate turns across all executed tasks. */
  turns: number;
  outcomes: TaskOutcome[];
}

const DEFAULT_DEP_SUMMARY_CHARS = 240;
/** A short mission line — orientation, not the full spec. */
const MISSION_SNIPPET_CHARS = 300;
const DEFAULT_CONTEXT_BUDGET_CHARS = 6000;
const DEFAULT_MAX_TASKS = 40;

/**
 * P6 — enforce the context budget: if the assembled prompt exceeds `budget`,
 * drop whole dependency lines from the END (furthest/least-recent deps) until
 * it fits, appending a note about what was elided. Pure + unit-tested; the
 * governor turns "minimal context" into a hard invariant.
 */
export function governContext(prompt: string, depLineCount: number, budget: number): { prompt: string; droppedDeps: number } {
  if (prompt.length <= budget) return { prompt, droppedDeps: 0 };
  const lines = prompt.split('\n');
  // dependency lines are the "- <id>: ..." entries under ALREADY BUILT.
  let dropped = 0;
  for (let i = lines.length - 1; i >= 0 && lines.join('\n').length > budget && dropped < depLineCount; i--) {
    if (/^- [^:]+: /.test(lines[i])) {
      lines.splice(i, 1);
      dropped++;
    }
  }
  let out = lines.join('\n');
  if (dropped > 0) out += `\n(context governor: elided ${dropped} lower-priority dependency summary(ies) to fit the ${budget}-char budget)`;
  // Last resort: hard truncate if still over (e.g. a single huge goal).
  if (out.length > budget) out = out.slice(0, budget) + '\n…(truncated to context budget)…';
  return { prompt: out, droppedDeps: dropped };
}

/**
 * P2 — assemble one task's MINIMAL context: a short mission line, the task's
 * own goal + criteria + declared files, and ONLY the summaries/contracts of
 * its DIRECT dependencies (pulled from the blackboard). Pure and unit-tested;
 * this is the function that keeps a small model's window optimal.
 */
export function assembleTaskContext(
  task: OrchestratorTask,
  mission: string,
  blackboard: Map<string, TaskOutcome>,
  maxDepSummaryChars = DEFAULT_DEP_SUMMARY_CHARS,
  opts: { designLines?: string[]; budgetChars?: number } = {}
): AssembledContext {
  const sections: string[] = [];
  // Orientation only — a snippet, never the whole mission.
  sections.push(`OBJECTIVE (context, one line): ${mission.slice(0, MISSION_SNIPPET_CHARS)}`);
  sections.push('');
  sections.push(`YOUR TASK — ${task.title}:`);
  sections.push(task.goal);

  if (task.files && task.files.length > 0) {
    sections.push('');
    sections.push(`Files for THIS task: ${task.files.join(', ')} (edit only these).`);
  }
  if (task.criteria && task.criteria.length > 0) {
    sections.push('');
    sections.push('This task is done when:');
    task.criteria.forEach((c, i) => sections.push(`  ${i + 1}. ${c}`));
  }

  // P3 — relevant persisted design decisions (objective/architecture): a
  // small retrieval, not the full spec dump.
  if (opts.designLines && opts.designLines.length > 0) {
    sections.push('');
    sections.push('DESIGN CONTEXT (established decisions — honor them):');
    opts.designLines.slice(0, 6).forEach((d) => sections.push(`- ${d}`));
  }

  // ONLY direct dependencies' outputs — the crux of minimal context. A task
  // that depends on 'store' loads store's contract/summary, not store's source
  // and not the other 12 tasks. Dependents read the interface, not the tree.
  const includedDeps: string[] = [];
  const deps = (task.deps ?? []).filter((d) => blackboard.has(d));
  if (deps.length > 0) {
    sections.push('');
    sections.push('ALREADY BUILT — build ON these, do not reimplement them:');
    for (const depId of deps) {
      const out = blackboard.get(depId)!;
      includedDeps.push(depId);
      const body = (out.contract ?? out.summary).slice(0, maxDepSummaryChars);
      sections.push(`- ${depId}: ${body}`);
    }
  }

  const raw = sections.join('\n');
  const governed = governContext(raw, includedDeps.length, opts.budgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS);
  return { taskId: task.id, prompt: governed.prompt, includedDeps };
}

/**
 * P1 — execute the task DAG on a blackboard. Topologically ordered; a task
 * runs only after every dependency has SUCCEEDED. A failed task blocks its
 * dependents (their deps aren't all green) and they are reported as skipped/
 * failed rather than run against incomplete state. Fail-soft on publish.
 */
export async function orchestrate(config: OrchestratorConfig): Promise<OrchestratorResult> {
  const maxTasks = config.maxTasks ?? DEFAULT_MAX_TASKS;
  const budget = config.contextBudgetChars;
  // Mutable queue so P5 re-planning can append discovered subtasks; re-sorted
  // topologically each time the set grows.
  let queue = topoOrder(config.tasks as DeliveryPhase[]) as OrchestratorTask[];
  const known = new Set(queue.map((t) => t.id));
  const blackboard = new Map<string, TaskOutcome>();
  const done = new Set<string>();
  const failed = new Set<string>();
  const outcomes: TaskOutcome[] = [];
  let turns = 0;

  for (let qi = 0; qi < queue.length; qi++) {
    const task = queue[qi];
    const deps = task.deps ?? [];
    // Skip a task whose dependency failed — never build against a broken base.
    const blockedBy = deps.filter((d) => failed.has(d) || !done.has(d));
    if (blockedBy.length > 0) {
      const outcome: TaskOutcome = {
        taskId: task.id,
        success: false,
        summary: `skipped — unmet dependency: ${blockedBy.join(', ')}`,
        turns: 0,
      };
      failed.add(task.id);
      outcomes.push(outcome);
      config.onTask?.(task, outcome);
      continue;
    }

    let designLines: string[] = [];
    if (config.retrieveDesign) {
      try {
        designLines = await config.retrieveDesign(task);
      } catch {
        designLines = [];
      }
    }
    const ctx = assembleTaskContext(task, config.mission, blackboard, config.maxDepSummaryChars, {
      designLines,
      budgetChars: budget,
    });
    const outcome = await config.runTask(ctx, task);
    turns += outcome.turns;
    outcomes.push(outcome);
    if (outcome.success) {
      done.add(task.id);
      blackboard.set(task.id, outcome);
      try {
        await config.publish?.(outcome, task);
      } catch {
        // publishing to durable memory is best-effort
      }
      // P5 — adaptive re-planning: fold discovered subtasks into the queue.
      const fresh = (outcome.newTasks ?? []).filter((t) => !known.has(t.id));
      if (fresh.length > 0 && queue.length + fresh.length <= maxTasks) {
        for (const t of fresh) known.add(t.id);
        // Re-topo-sort the not-yet-run remainder plus the new tasks so deps hold.
        const remainder = queue.slice(qi + 1).concat(fresh);
        const resorted = topoOrder(remainder as DeliveryPhase[]) as OrchestratorTask[];
        queue = queue.slice(0, qi + 1).concat(resorted);
      }
    } else {
      failed.add(task.id);
    }
    config.onTask?.(task, outcome);
  }

  return {
    success: failed.size === 0,
    completed: [...done],
    failed: [...failed],
    turns,
    outcomes,
  };
}
