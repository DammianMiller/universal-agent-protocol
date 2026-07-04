/**
 * Delivery ↔ Task/Memory sync — every `uap deliver` run leaves a durable,
 * queryable trail: a task in the project's task DB (opened in_progress at run
 * start, closed on success, reopened-with-notes on failure) and a structured
 * `decision`/`lesson` short-term memory entry describing the outcome.
 *
 * This is how the memory/task system becomes the live "what is actually
 * happening / what actually happened" record instead of a stale import:
 * agents read `uap task ready` + `uap memory query` and see real deliveries.
 *
 * Everything here is fail-soft by contract: task/memory persistence must
 * never block or break a delivery.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import type { DeliveryResult } from './convergence-loop.js';

export interface DeliveryTaskHandle {
  id: string;
  /** Kept so completion reuses the same service/DB the open call bound to. */
  service: import('../tasks/service.js').TaskService;
}

function taskDbPath(projectRoot: string): string {
  return join(projectRoot, '.uap', 'tasks', 'tasks.db');
}

/** Only sync tasks for projects that already track tasks — never scaffold a
 * task DB into an arbitrary target repo as a side effect of a delivery. */
export function hasTaskDb(projectRoot: string): boolean {
  return existsSync(taskDbPath(projectRoot));
}

/**
 * TaskDatabase is a process-wide singleton keyed by the FIRST dbPath opened;
 * if some other DB is already bound in this process, writing "here" would
 * silently land in the wrong project. Verify the binding and skip sync when
 * it doesn't match. Fail-soft: verification errors mean "don't sync".
 */
async function taskDbBindsTo(projectRoot: string): Promise<boolean> {
  try {
    const { TaskDatabase } = await import('../tasks/database.js');
    const { realpathSync } = await import('fs');
    const db = TaskDatabase.getInstance(taskDbPath(projectRoot)).getDatabase();
    const list = db.pragma('database_list') as Array<{ name: string; file: string }>;
    const main = list.find((d) => d.name === 'main');
    if (!main?.file) return false;
    return realpathSync(main.file) === realpathSync(taskDbPath(projectRoot));
  } catch {
    return false;
  }
}

/**
 * Open (and claim) a task for this delivery run. Returns null when the
 * project has no task DB or anything fails.
 */
export async function openDeliveryTask(
  instruction: string,
  projectRoot: string,
  parentId?: string
): Promise<DeliveryTaskHandle | null> {
  if (!hasTaskDb(projectRoot)) return null;
  if (!(await taskDbBindsTo(projectRoot))) return null;
  try {
    const { TaskService } = await import('../tasks/service.js');
    const service = new TaskService({ dbPath: taskDbPath(projectRoot), agentId: 'uap-deliver' });
    const task = service.create({
      title: `deliver: ${instruction.slice(0, 100)}`,
      description: instruction.slice(0, 2000),
      type: 'task',
      labels: ['deliver'],
      parentId,
    });
    service.update(task.id, { status: 'in_progress', assignee: 'uap-deliver' });
    return { id: task.id, service };
  } catch {
    return null;
  }
}

/**
 * Re-bind to an existing mission task on --resume (instead of opening a
 * duplicate) and mark it active again. Returns null when the task or DB is
 * gone — callers fall back to leaving the trail incomplete rather than failing.
 */
export async function reopenDeliveryTask(
  taskId: string,
  projectRoot: string
): Promise<DeliveryTaskHandle | null> {
  if (!hasTaskDb(projectRoot)) return null;
  if (!(await taskDbBindsTo(projectRoot))) return null;
  try {
    const { TaskService } = await import('../tasks/service.js');
    const service = new TaskService({ dbPath: taskDbPath(projectRoot), agentId: 'uap-deliver' });
    const task = service.get(taskId);
    if (!task) return null;
    service.update(taskId, { status: 'in_progress', assignee: 'uap-deliver' });
    return { id: taskId, service };
  } catch {
    return null;
  }
}

/**
 * Record the run's outcome on its task: close as done on success; on failure
 * reopen (status 'open') with the failure context in notes so the work
 * surfaces in `uap task ready` instead of rotting as in_progress.
 */
export function completeDeliveryTask(
  handle: DeliveryTaskHandle | null,
  result: DeliveryResult
): void {
  if (!handle) return;
  try {
    if (result.success) {
      handle.service.close(
        handle.id,
        result.alreadyDelivered
          ? 'already delivered (baseline green)'
          : `delivered in ${result.turns} turn(s)`
      );
    } else {
      handle.service.update(handle.id, {
        status: 'open',
        notes: `deliver failed after ${result.turns} turn(s); best ${Math.round(result.bestScore * 100)}% of gates (turn ${result.bestTurn}). ${result.finalFeedback.slice(0, 500)}`,
      });
    }
  } catch {
    // task sync is best-effort
  }
}

function memoryDbPath(projectRoot: string): string {
  return join(projectRoot, 'agents', 'data', 'memory', 'short_term.db');
}

/**
 * Record a structured outcome memory (`decision` on success, `lesson` on
 * failure) so future sessions see what was actually built and how it went —
 * not just session-end heartbeats. Only writes when the project already has
 * a short-term memory DB (never scaffolds one into a target repo).
 */
export async function recordDeliveryOutcome(
  instruction: string,
  projectRoot: string,
  result: DeliveryResult,
  modelId: string
): Promise<void> {
  if (!existsSync(memoryDbPath(projectRoot))) return;
  try {
    const { SQLiteShortTermMemory } = await import('../memory/short-term/sqlite.js');
    const memory = new SQLiteShortTermMemory({ dbPath: memoryDbPath(projectRoot) });
    const type = result.success ? 'decision' : 'lesson';
    const verdict = result.success
      ? result.alreadyDelivered
        ? 'already delivered (baseline green)'
        : `delivered in ${result.turns} turn(s)`
      : `NOT delivered after ${result.turns} turn(s), best ${Math.round(result.bestScore * 100)}% of gates`;
    const content = `[deliver] ${verdict} — model ${modelId} — task: ${instruction.slice(0, 300)}`;
    await memory.store(type, content, result.success ? 6 : 7);
    await memory.close?.();
  } catch {
    // memory recording is best-effort
  }
}

/**
 * Publish a completed orchestrator task's verified interface to durable
 * short-term memory (P3/P4). Later tasks in the same DAG — and future fresh
 * sessions — retrieve this via the semantic memory query, so a dependent loads
 * "what already exists" from memory rather than re-reading source. Stored as a
 * `decision` so it surfaces as established context, never as untrusted model
 * output (only the harness-composed contract/summary is persisted). Fail-soft.
 */
export async function recordOrchestratorTaskOutcome(
  taskId: string,
  taskTitle: string,
  contractOrSummary: string,
  projectRoot: string
): Promise<void> {
  if (!existsSync(memoryDbPath(projectRoot))) return;
  try {
    const { SQLiteShortTermMemory } = await import('../memory/short-term/sqlite.js');
    const memory = new SQLiteShortTermMemory({ dbPath: memoryDbPath(projectRoot) });
    const content = `[orchestrator] task '${taskId}' (${taskTitle.slice(0, 80)}) built — interface: ${contractOrSummary.slice(0, 400)}`;
    await memory.store('decision', content, 6);
    await memory.close?.();
  } catch {
    // durable publish is best-effort; the in-run blackboard is authoritative
  }
}
