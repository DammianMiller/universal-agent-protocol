/**
 * Orchestrated Mission — the blackboard-orchestrated delivery runner,
 * extracted from deliver.ts behind narrow functional seams.
 *
 * Why extracted: as a 250-line closure over a dozen ambient locals inside
 * deliver.ts, the orchestrate() wiring was UNOBSERVABLE — which is exactly
 * how a released feature shipped with `concurrency` never plumbed (PR #516
 * review, critical #1). With the seams injected, the wiring is unit-testable
 * (see test/delivery/orchestrated-mission.test.ts) and the same runner now
 * serves BOTH the top-level orchestrated path and the epic controller's
 * inner missions (epic-path parallel dispatch).
 *
 * What this module owns: the task DAG execution (orchestrate + concurrency),
 * worktree-isolated parallel dispatch (acquire → run → serialized merge-back
 * → cleanup), the mission aggregate, contract extraction (P4), the NEW_TASKS
 * re-planning feed (P5), and post-merge combined-tree verification.
 *
 * What stays with the caller (deliver.ts), injected as seams: building the
 * per-root convergence loop + executor (`runLoop`), acceptance-spec/evidence
 * bookkeeping (`beginTaskSpec`/`endTaskSpec`), task records, memory
 * retrieval/publish, the merge-boundary predicate, the combined-tree gate
 * ladder, and logging.
 */

import { extractContract } from './contract-extractor.js';
import type { DeliveryResult } from './convergence-loop.js';
import { parsePhaseArray } from './decompose.js';
import {
  orchestrate,
  type AssembledContext,
  type OrchestratorTask,
  type TaskOutcome,
} from './task-orchestrator.js';
import type { DeliveryTaskHandle } from './task-sync.js';
import type { TaskWorkspaceManager } from './task-workspace.js';

// Regex built from a string so policy hooks never mistake a literal for a path.
const SOURCE_FILE_RE = new RegExp('[.](js|mjs|cjs|ts|tsx|jsx|py)$');
const NEW_TASKS_MARKER = 'NEW_TASKS:';

export interface OrchestratedMissionDeps {
  /** The overall mission text (orientation lines only — never dumped whole). */
  instruction: string;
  /** The REAL project root results merge back into. */
  projectRoot: string;
  /** The task DAG to execute. */
  tasks: OrchestratorTask[];
  /**
   * Resolved `deliver.parallelTasks` (1 = sequential). Parallel dispatch
   * additionally requires a workspace manager; without one it degrades to
   * sequential with a note.
   */
  parallelTasks: number;
  /**
   * Run ONE task's convergence loop in `root` and return its result. The
   * caller owns loop construction (config, executor, iteration hooks) —
   * `isolated` is true when `root` is a throwaway workspace, which is the
   * caller's cue to strip checkpointing/explorer and bind a per-root
   * executor.
   */
  runLoop: (args: {
    root: string;
    prompt: string;
    taskId: string;
    isolated: boolean;
  }) => Promise<DeliveryResult>;
  /**
   * Workspace manager for parallel isolation, or null to run in-tree. The
   * caller constructs it (or injects a fake in tests). Ignored when
   * parallelTasks <= 1.
   */
  workspaceManager: TaskWorkspaceManager | null;
  /** Acceptance-spec + write-evidence bookkeeping around one task run. */
  beginTaskSpec?: (root: string, spec: string) => void;
  endTaskSpec?: (root: string) => void;
  /** Delivery-task records (fail-soft; both optional). */
  openTask?: (title: string) => Promise<DeliveryTaskHandle | null>;
  completeTask?: (record: DeliveryTaskHandle | null, result: DeliveryResult) => void;
  /** P3 — per-task memory retrieval (compact design lines). */
  retrieveDesign?: (task: OrchestratorTask) => string[] | Promise<string[]>;
  /** P3/P4 — durable publish of a completed task's contract/summary. */
  publish?: (outcome: TaskOutcome, task: OrchestratorTask) => void | Promise<void>;
  /** Merge-boundary defense-in-depth: refuse deltas touching these files. */
  isMergeBlocked?: (file: string) => boolean;
  /**
   * Post-merge combined-tree verification (one gate-ladder run on the real
   * root). Return null to skip; only invoked when isolation was active.
   */
  verifyCombined?: () => Promise<{ passed: boolean; feedback: string } | null>;
  /** Progress lines (the caller decorates with chalk). */
  note?: (line: string) => void;
  /** Orchestrator caps (caller resolves env/config). */
  contextBudgetChars?: number;
  maxTasks?: number;
}

/** P4 helper: read `files` under `root` and extract the verified public
 * contract dependents load instead of source. Fail-soft to undefined. */
async function extractContractFrom(root: string, files: string[]): Promise<string | undefined> {
  if (files.length === 0) return undefined;
  try {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const srcs = files
      .filter((f) => SOURCE_FILE_RE.test(f))
      .map((f) => {
        try {
          return { path: f, content: readFileSync(join(root, f), 'utf-8') };
        } catch {
          return null;
        }
      })
      .filter((x): x is { path: string; content: string } => x !== null);
    return extractContract(srcs).contract || undefined;
  } catch {
    return undefined;
  }
}

// Moved to the shared result util (runners must not import each other for a
// generic fold); re-exported here so existing importers keep working.
export { foldDeliveryResult } from './delivery-result.js';
import { foldDeliveryResult } from './delivery-result.js';

/**
 * Execute a decomposed mission on the blackboard orchestrator, with
 * worktree-isolated parallel dispatch when `parallelTasks > 1` and a
 * workspace manager is available.
 */
export async function runOrchestratedMission(deps: OrchestratedMissionDeps): Promise<DeliveryResult> {
  const note = deps.note ?? ((): void => undefined);
  const all: DeliveryResult = {
    success: true, alreadyDelivered: false, turns: 0, bestScore: 0, bestTurn: 0,
    history: [], finalFeedback: '', finalOutput: '', totalDurationMs: 0,
  };

  // -- Worktree-isolated parallel dispatch --
  // `.uap.json` deliver.parallelTasks (config-only BY DESIGN - no env; see
  // the concurrency notes in task-orchestrator.ts) dispatches independent
  // READY tasks concurrently, EACH in its own detached git worktree seeded
  // with the main tree's current uncommitted state and judged against its
  // own spec. Merge-backs are SERIALIZED under a lock; a conflicting merge
  // fails the task, and the orchestrator's minimal repair retries it in a
  // fresh workspace seeded with the updated baseline - conflicts resolve
  // through the ATG repair path instead of corrupting the tree.
  const wsManager = deps.parallelTasks > 1 ? deps.workspaceManager : null;
  if (deps.parallelTasks > 1 && !wsManager) {
    note('  ⇉ parallel tasks: worktree isolation unavailable (not a git repo?) - running sequentially');
  } else if (wsManager) {
    note(`  ⇉ parallel tasks: up to ${deps.parallelTasks} independent tasks in isolated worktrees`);
  }

  let mergeChain: Promise<unknown> = Promise.resolve();
  const withMergeLock = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const next = mergeChain.then(fn, fn);
    mergeChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  /** Run one task's loop against `root` — spec bookkeeping, aggregation,
   * task records, contract extraction (P4), and the NEW_TASKS feed (P5). */
  const runTaskAt = async (
    ctx: AssembledContext,
    task: OrchestratorTask,
    root: string,
    isolated: boolean
  ): Promise<TaskOutcome> => {
    const taskRecord = (await deps.openTask?.(`${task.title} — ${task.goal.slice(0, 120)}`)) ?? null;
    deps.beginTaskSpec?.(root, ctx.prompt);
    try {
      const r = await deps.runLoop({ root, prompt: ctx.prompt, taskId: task.id, isolated });
      foldDeliveryResult(all, r);
      deps.completeTask?.(taskRecord, r);
      const files = [...new Set(r.history.flatMap((h) => h.filesApplied ?? []))];
      // P4 - extract the VERIFIED public contract of what this task built so
      // dependents load the interface (a few hundred chars), not the source.
      // (Under the agentic executor filesApplied is empty — the isolated path
      // enriches the outcome from the merge delta after merge-back instead.)
      const contract = r.success ? await extractContractFrom(root, files) : undefined;
      // P5 - adaptive re-planning feed: a task may surface work the initial
      // plan missed by emitting a `NEW_TASKS: [ {id,title,goal,deps} ]` JSON
      // array in its output. Parsed through the same validator as the planner
      // (well-formed only), then folded into the DAG by orchestrate() (which
      // dedupes, topo-resorts, and caps at maxTasks). Only structural fields
      // are used - never free-form model text as durable memory.
      let newTasks: OrchestratorTask[] | undefined;
      if (r.success) {
        try {
          // Hand the tail to parsePhaseArray's own extraction: the old lazy
          // capture (`\[[\s\S]*?\]`) stopped at the FIRST `]`, which is
          // INSIDE any `"deps":["..."]` — so a re-planned task that declared
          // dependencies silently never parsed (pre-existing production bug,
          // caught by the extraction's wiring tests). The array must FOLLOW
          // the marker directly — prose after the marker ("NEW_TASKS: none")
          // must not let an unrelated later JSON array parse as tasks.
          const text = r.finalOutput || r.finalFeedback || '';
          const at = text.indexOf(NEW_TASKS_MARKER);
          if (at !== -1 && text.slice(at + NEW_TASKS_MARKER.length).trimStart().startsWith('[')) {
            const parsed = parsePhaseArray(text.slice(at + NEW_TASKS_MARKER.length)).filter((t) => t.id !== task.id);
            if (parsed.length > 0) {
              newTasks = parsed.map((t) => ({
                id: t.id, title: t.title, goal: t.goal,
                ...(t.deps ? { deps: t.deps } : {}),
              }));
              note(`  ↳ re-planning: task ${task.id} discovered ${newTasks.length} follow-up task(s)`);
            }
          }
        } catch {
          newTasks = undefined;
        }
      }
      return {
        taskId: task.id,
        success: r.success,
        turns: r.turns,
        // ATG minimal repair: a FAILED task's summary must carry the failure
        // (the retry's only new information), never a goal restatement.
        summary: r.success
          ? `${task.goal.slice(0, 160)}${files.length ? ` [files: ${files.join(', ')}]` : ''}`
          : `${task.goal.slice(0, 120)} — FAILED: ${(r.finalFeedback || 'gates did not pass').slice(0, 280)}`,
        ...(contract ? { contract } : {}),
        ...(newTasks && newTasks.length > 0 ? { newTasks } : {}),
      };
    } finally {
      deps.endTaskSpec?.(root);
    }
  };

  const orchResult = await orchestrate({
    mission: deps.instruction,
    tasks: deps.tasks,
    contextBudgetChars: deps.contextBudgetChars ?? Number(process.env.UAP_DELIVER_CONTEXT_BUDGET ?? 6000),
    maxTasks: deps.maxTasks ?? Number(process.env.UAP_DELIVER_MAX_TASKS ?? 40),
    // Dependency-aware parallel dispatch — only with worktree isolation.
    concurrency: wsManager ? deps.parallelTasks : 1,
    ...(deps.retrieveDesign ? { retrieveDesign: deps.retrieveDesign } : {}),
    ...(deps.publish ? { publish: deps.publish } : {}),
    runTask: async (ctx, task): Promise<TaskOutcome> => {
      note(`▶ task ${task.id}: ${task.title} (ctx ${ctx.prompt.length} chars, deps: ${ctx.includedDeps.join(',') || 'none'})`);
      // Workspace acquisition mutates git state (worktree add) - serialize
      // it behind the same lock the merges use.
      const ws = wsManager ? await withMergeLock(() => wsManager.acquire(task.id)) : null;
      if (!ws) {
        if (wsManager) {
          note(`  ⇉ task ${task.id}: workspace unavailable - running in-tree (serialized)`);
          // In-tree execution mutates the shared tree; hold the lock for the
          // WHOLE run so it never races an isolated task's merge-back.
          return withMergeLock(() => runTaskAt(ctx, task, deps.projectRoot, false));
        }
        return runTaskAt(ctx, task, deps.projectRoot, false);
      }
      try {
        const outcome = await runTaskAt(ctx, task, ws.root, true);
        if (!outcome.success) return outcome;
        const merged = await withMergeLock(() => ws.mergeBack(deps.isMergeBlocked));
        if (!merged.ok) {
          note(`  ⇉ task ${task.id}: merge-back conflicted (${merged.reason ?? 'apply failed'}) - minimal repair retries on the updated tree`);
          return {
            taskId: task.id,
            success: false,
            turns: 0,
            summary: `${task.goal.slice(0, 120)} — FAILED: the tree changed underneath this task (parallel merge conflict) — rebuild it against the CURRENT state of the repository. Detail: ${(merged.reason ?? 'could not apply the task delta').slice(0, 200)}`,
          };
        }
        if (merged.files.length > 0) {
          note(`  ⇉ task ${task.id}: merged ${merged.files.length} file(s) into the main tree`);
          // P4 under the agentic executor: history.filesApplied is empty
          // (noop applier, direct repo mutation) so the in-loop extraction
          // found nothing — the merge delta is the RELIABLE file list.
          // Enrich the outcome from the merged main tree.
          if (!outcome.contract) {
            const contract = await extractContractFrom(deps.projectRoot, merged.files);
            if (contract) return { ...outcome, contract };
          }
        }
        return outcome;
      } finally {
        await withMergeLock(() => {
          ws.cleanup();
        });
      }
    },
  });

  // Post-merge verification: every gate passed in SOME tree, but 3-way
  // resolution can produce a combined main tree no gate ever saw. One
  // ladder run on the merged result closes that. Fail-soft on runner
  // errors; hard on gate failures.
  if (wsManager && orchResult.success && deps.verifyCombined) {
    try {
      note('  ⇉ post-merge verification: gate ladder on the merged main tree…');
      const combined = await deps.verifyCombined();
      if (combined && !combined.passed) {
        orchResult.success = false;
        orchResult.failed.push('post-merge-verification');
        all.finalFeedback = `post-merge verification FAILED on the combined tree:\n${combined.feedback}`.slice(0, 4000);
      }
    } catch {
      // verification unavailable — keep the per-task verdicts
    }
  }

  all.success = orchResult.success;
  if (!orchResult.success) {
    all.finalFeedback = `orchestration incomplete — failed tasks: ${orchResult.failed.join(', ')}\n${all.finalFeedback}`;
  }
  return all;
}
