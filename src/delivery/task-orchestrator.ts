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
  /**
   * Tasks ACCEPTED by an INTERRUPTED run (resume at the task boundary):
   * seeded into the done set AND the blackboard (dependents read their
   * summaries/contracts exactly as if they ran this session) — skipped,
   * never redone.
   */
  initialDone?: Array<{ id: string; summary: string; contract?: string }>;
  /**
   * Called with the cumulative accepted-task outcomes after each success —
   * the caller persists them so an interrupted orchestrated mission can
   * resume at the task boundary. Includes repair-chain link ids (harmless
   * extra blackboard seeds on resume). Fail-soft.
   */
  onProgress?: (completed: Array<{ id: string; summary: string; contract?: string }>) => void;
  /**
   * Called with the FRESH tasks whenever adaptive re-planning (P5) grows the
   * graph — the caller persists them so a resume rebuilds the grown DAG, not
   * just the original plan (an accepted discovering task never re-emits its
   * NEW_TASKS, so unpersisted discoveries would silently vanish). Fail-soft.
   */
  onPlanChange?: (freshTasks: OrchestratorTask[]) => void;
  /**
   * Minimal node repair (ATG): extra fresh attempts for a FAILED task before
   * its dependents are blocked. Each repair attempt re-executes ONLY the
   * failed node, with the failure summary fed into its minimal context — the
   * validated rest of the graph stays frozen. Default: UAP_ORCH_TASK_REPAIRS
   * env (fallback 1, env hard-ceiling 5 — a full executor rerun per attempt
   * must not be unboundable from the environment). 0 restores fail-fast.
   */
  maxRepairsPerTask?: number;
  /**
   * Re-plan repair (ATG minimal-subgraph repair): after retries are exhausted,
   * re-plan the failed node as a replacement chain executed in place. The
   * chain is interface-preserving — its first task inherits the failed node's
   * deps, and when the whole chain succeeds the ORIGINAL task id is credited
   * on the blackboard, so dependents unblock without any graph rewrite.
   * Return null/[] to decline. Fail-soft: a throw declines.
   */
  repairTask?: (
    task: OrchestratorTask,
    lastFailure: TaskOutcome,
    attempts: number
  ) => Promise<OrchestratorTask[] | null>;
  /**
   * Dependency-aware parallel dispatch: max independent READY tasks running
   * concurrently (wave-barrier scheduling: each wave completes before the
   * next dispatches — simple and deterministic over maximal utilization).
   * Default 1 = sequential, the historical behavior. DELIBERATELY config-only,
   * no env override: >1 requires a runTask that tolerates concurrent
   * execution. deliver's production runTask satisfies that since PR #516
   * (worktree isolation + per-task judge state via orchestrated-mission.ts);
   * env stays excluded because parallelism must remain an explicit
   * per-project decision, not something one exported variable flips for
   * every run on a machine. Clamped to [1, 16].
   */
  concurrency?: number;
}

export interface OrchestratorResult {
  success: boolean;
  /** Succeeded ids — includes synthetic repair-chain link ids (`x.r0-…`)
   * alongside the credited original id when a repair chain ran. */
  completed: string[];
  failed: string[];
  /** Aggregate turns across all executed tasks (incl. retries and repairs). */
  turns: number;
  /** Full attempt trail: a repaired task appears MULTIPLE times (failed
   * attempt(s), chain links, then the credited success under its original
   * id). Consumers wanting "the" outcome for an id must take the LAST entry. */
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
  opts: { designLines?: string[]; budgetChars?: number; lastFailure?: string } = {}
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

  // Minimal repair: the retry sees WHAT failed last time, not a fresh-amnesia
  // rerun — the one new piece of information a repair attempt has.
  if (opts.lastFailure && opts.lastFailure.trim()) {
    sections.push('');
    sections.push(`PREVIOUS ATTEMPT FAILED — fix this: ${opts.lastFailure.trim().slice(0, 400)}`);
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

function envInt(name: string, fallback: number, max: number): number {
  const rawStr = process.env[name];
  if (!rawStr || !rawStr.trim()) return fallback; // empty string = unset, not 0
  const raw = Number(rawStr);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), max) : fallback;
}

/**
 * P1 — execute the task DAG on a blackboard. Dependency-aware: a task runs
 * only after every dependency has SUCCEEDED; independent READY tasks dispatch
 * in parallel up to `concurrency` (default 1 — the historical sequential
 * behavior). A task that fails gets ATG-style MINIMAL REPAIR before its
 * dependents are blocked: bounded fresh re-execution of just that node with
 * the failure fed back (`maxRepairsPerTask`), then an optional re-planned
 * replacement chain (`repairTask`) credited under the original id — the
 * validated rest of the graph stays frozen throughout. Only when repair is
 * exhausted are dependents reported as skipped rather than run against
 * incomplete state. Fail-soft on publish.
 */
export async function orchestrate(config: OrchestratorConfig): Promise<OrchestratorResult> {
  const maxTasks = config.maxTasks ?? DEFAULT_MAX_TASKS;
  const budget = config.contextBudgetChars;
  const concurrency = Math.min(Math.max(1, config.concurrency ?? 1), 16);
  const maxRepairs = Math.max(0, config.maxRepairsPerTask ?? envInt('UAP_ORCH_TASK_REPAIRS', 1, 5));

  // Pending is kept topo-ordered; P5 re-planning appends discovered subtasks
  // and re-sorts. `scheduled` counts every task ever admitted (initial +
  // re-planned + repair chains) against the maxTasks runaway guard.
  let pending = topoOrder(config.tasks as DeliveryPhase[]) as OrchestratorTask[];
  const known = new Set(pending.map((t) => t.id));
  let scheduled = pending.length;
  const blackboard = new Map<string, TaskOutcome>();
  const done = new Set<string>();
  const failed = new Set<string>();
  const outcomes: TaskOutcome[] = [];
  let turns = 0;

  // Resume at the task boundary: accepted tasks from an interrupted run seed
  // done + blackboard, then leave the pending list with a skip outcome —
  // dependents unblock with real dep summaries, and finished work is never
  // redone (a redo would produce zero diff, which the anti-no-op rail
  // correctly refuses to accept).
  for (const prior of config.initialDone ?? []) {
    if (done.has(prior.id)) continue;
    done.add(prior.id);
    // Seed `known` too: repair-chain/collision logic checks it, and a seeded
    // non-plan id (a prior run's repair link) must never be silently reused.
    known.add(prior.id);
    blackboard.set(prior.id, {
      taskId: prior.id,
      success: true,
      turns: 0,
      summary: prior.summary,
      ...(prior.contract ? { contract: prior.contract } : {}),
    });
  }
  if (done.size > 0) {
    pending = pending.filter((t) => {
      if (!done.has(t.id)) return true;
      const outcome: TaskOutcome = {
        taskId: t.id,
        success: true,
        turns: 0,
        summary: 'accepted by the interrupted run — skipped on resume',
      };
      outcomes.push(outcome);
      config.onTask?.(t, outcome);
      return false;
    });
  }

  const runOne = async (task: OrchestratorTask, lastFailure?: string): Promise<TaskOutcome> => {
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
      ...(lastFailure ? { lastFailure } : {}),
    });
    // A throwing runTask becomes a failed outcome, never an abandoned graph:
    // under parallel dispatch one rejection must not orphan in-flight siblings.
    let outcome: TaskOutcome;
    try {
      outcome = await config.runTask(ctx, task);
    } catch (err) {
      outcome = {
        taskId: task.id,
        success: false,
        summary: `task execution error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        turns: 0,
      };
    }
    turns += outcome.turns;
    outcomes.push(outcome);
    return outcome;
  };

  const recordSuccess = async (id: string, task: OrchestratorTask, outcome: TaskOutcome): Promise<void> => {
    done.add(id);
    blackboard.set(id, outcome);
    try {
      // Persist cumulative resume progress (id + what dependents need).
      config.onProgress?.(
        [...done].map((d) => {
          const o = blackboard.get(d);
          return { id: d, summary: o?.summary ?? '', ...(o?.contract ? { contract: o.contract } : {}) };
        })
      );
    } catch {
      // resume-state persistence is best-effort
    }
    try {
      await config.publish?.(outcome, task);
    } catch {
      // publishing to durable memory is best-effort
    }
  };

  const markSkipped = (task: OrchestratorTask, blockedBy: string[]): void => {
    const outcome: TaskOutcome = {
      taskId: task.id,
      success: false,
      summary: `skipped — unmet dependency: ${blockedBy.join(', ')}`,
      turns: 0,
    };
    failed.add(task.id);
    outcomes.push(outcome);
    config.onTask?.(task, outcome);
  };

  /**
   * Re-plan repair: execute the replacement chain in place. Interface
   * preserving — the first link inherits the failed node's deps, links chain
   * sequentially, and full-chain success credits the ORIGINAL task id on the
   * blackboard so dependents unblock unchanged. Returns the credited outcome,
   * or null when the repair was declined or the chain broke.
   */
  const runRepairChain = async (task: OrchestratorTask, lastFailure: TaskOutcome, attempts: number): Promise<TaskOutcome | null> => {
    if (!config.repairTask) return null;
    let plan: OrchestratorTask[] | null = null;
    try {
      plan = await config.repairTask(task, lastFailure, attempts);
    } catch {
      plan = null; // fail-soft: an unplannable repair keeps the failure
    }
    if (!plan || plan.length === 0 || scheduled + plan.length > maxTasks) return null;
    let prevId: string | undefined;
    let last: TaskOutcome | null = null;
    for (let i = 0; i < plan.length; i++) {
      // Namespace chain links under the failed node. The 64-char cut can eat
      // the differentiator for very long task ids, so collisions against
      // anything ever known get a numeric suffix instead of silently
      // overwriting a blackboard entry.
      let subId = `${task.id}.r${i}-${plan[i].id}`.slice(0, 64);
      for (let bump = 2; known.has(subId); bump++) subId = `${subId.slice(0, 60)}~${bump}`;
      const sub: OrchestratorTask = {
        ...plan[i],
        id: subId,
        deps: i === 0 ? [...(task.deps ?? [])] : [prevId!],
      };
      known.add(sub.id);
      scheduled++;
      // Chain links run to plan; their own newTasks are DELIBERATELY dropped —
      // a repair must converge the failed node, not grow the graph.
      const outcome = await runOne(sub, i === 0 ? lastFailure.summary : undefined);
      config.onTask?.(sub, outcome);
      if (!outcome.success) {
        failed.add(sub.id);
        return null;
      }
      await recordSuccess(sub.id, sub, outcome);
      prevId = sub.id;
      last = outcome;
    }
    if (!last) return null;
    const credited: TaskOutcome = {
      taskId: task.id,
      success: true,
      summary: `repaired via ${plan.length} replacement task(s): ${last.summary}`.slice(0, 400),
      turns: 0,
      ...(last.contract ? { contract: last.contract } : {}),
    };
    outcomes.push(credited);
    await recordSuccess(task.id, task, credited);
    return credited;
  };

  /** Full failure handling for one task: retries → re-plan chain → fail. */
  const settleTask = async (task: OrchestratorTask, first: TaskOutcome): Promise<TaskOutcome> => {
    let final = first;
    let attempts = 1;
    // Minimal repair 1 — bounded re-execution of JUST this node, failure fed back.
    while (!final.success && attempts <= maxRepairs) {
      final = await runOne(task, final.summary);
      attempts++;
    }
    // Minimal repair 2 — re-planned replacement chain, original id credited.
    if (!final.success) {
      const credited = await runRepairChain(task, final, attempts);
      if (credited) final = credited;
    }
    if (final.success) {
      // Repair-chain success already recorded itself under the original id.
      if (!done.has(task.id)) await recordSuccess(task.id, task, final);
      // P5 — adaptive re-planning: fold discovered subtasks into the graph.
      const fresh = (final.newTasks ?? []).filter((t) => !known.has(t.id));
      if (fresh.length > 0 && scheduled + fresh.length <= maxTasks) {
        for (const t of fresh) known.add(t.id);
        scheduled += fresh.length;
        const merged = pending.concat(fresh);
        const sorted = topoOrder(merged as DeliveryPhase[]) as OrchestratorTask[];
        // topoOrder cleans deps against ONLY the passed array — which would
        // silently drop edges to already-done (harmless) and already-FAILED
        // (dangerous: dependents would run on a broken base) tasks. Restore
        // each task's true deps, filtered against everything ever known.
        const byId = new Map(merged.map((t) => [t.id, t]));
        pending = sorted.map((s) => {
          const orig = byId.get(s.id)!;
          const deps = (orig.deps ?? []).filter((d) => known.has(d) && d !== s.id);
          return { ...orig, deps };
        });
        try {
          config.onPlanChange?.(fresh);
        } catch {
          // resume-state persistence is best-effort
        }
      }
    } else {
      failed.add(task.id);
    }
    config.onTask?.(task, final);
    return final;
  };

  while (pending.length > 0) {
    // Skip cascade: drop every task whose dependency already failed — never
    // build against a broken base. Loops because each skip can cascade.
    let cascading = true;
    while (cascading) {
      cascading = false;
      for (let i = 0; i < pending.length; i++) {
        const blockedBy = (pending[i].deps ?? []).filter((d) => failed.has(d));
        if (blockedBy.length > 0) {
          markSkipped(pending[i], blockedBy);
          pending.splice(i, 1);
          i--;
          cascading = true;
        }
      }
    }
    if (pending.length === 0) break;

    // Ready set: every dependency has SUCCEEDED. Nothing ready with work
    // still pending means an unsatisfiable remainder (cycle degraded by
    // topoOrder) — skip it rather than wedge.
    const ready = pending.filter((t) => (t.deps ?? []).every((d) => done.has(d)));
    if (ready.length === 0) {
      for (const t of pending) markSkipped(t, (t.deps ?? []).filter((d) => !done.has(d)));
      pending = [];
      break;
    }

    // Dependency-aware dispatch: up to `concurrency` independent ready tasks
    // run at once (they are mutually independent by construction — none can
    // depend on another still-pending task). Settlement (repair, re-planning,
    // bookkeeping) is sequential for deterministic graph state.
    const wave = ready.slice(0, concurrency);
    const waveIds = new Set(wave.map((t) => t.id));
    pending = pending.filter((t) => !waveIds.has(t.id));
    const results = await Promise.all(wave.map(async (t) => ({ task: t, outcome: await runOne(t) })));
    for (const { task, outcome } of results) {
      await settleTask(task, outcome);
    }
  }

  return {
    success: failed.size === 0,
    completed: [...done],
    failed: [...failed],
    turns,
    outcomes,
  };
}
