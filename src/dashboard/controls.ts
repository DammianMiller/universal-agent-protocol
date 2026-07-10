/**
 * Dashboard control handlers — the WRITE surface behind the dashboard's
 * mutation-token gate (see server.ts `mutationAuthorized`). Each handler wraps
 * an existing importable service so the dashboard can start/stop/delete UAP
 * lifecycle objects (tasks, epics/ledger, orchestrator, deliver runs, agents).
 * Handlers throw Error with a clear message on bad input; server.ts maps that
 * to a 400/500 JSON response.
 */

import { spawn } from 'child_process';
import { TaskService } from '../tasks/service.js';
import type { CreateTaskInput, UpdateTaskInput, TaskType, TaskStatus, TaskPriority } from '../tasks/types.js';
import { initLedger, markItem, clearLedger } from '../delivery/completion-ledger.js';
import type { LedgerStatus, NewItem } from '../delivery/completion-ledger.js';
import { modifyUapConfig } from '../utils/config-loader.js';
import { CoordinationService } from '../coordination/service.js';
import { listRuns, loadRunState, requestStop, saveRunState, isValidRunId } from '../delivery/run-state.js';
import type { DeliverRunState } from '../delivery/run-state.js';

type Body = Record<string, unknown>;

// ── Tasks ──
function taskSvc(): TaskService {
  return new TaskService();
}
export function handleTaskCreate(body: Body): { id: string } {
  const title = String(body.title ?? '').trim();
  if (!title) throw new Error('title is required');
  const input: CreateTaskInput = { title };
  if (body.type) input.type = String(body.type) as TaskType;
  if (body.priority != null && body.priority !== '') input.priority = clampPriority(body.priority);
  if (body.assignee) input.assignee = String(body.assignee);
  if (body.parentId) input.parentId = String(body.parentId);
  const task = taskSvc().create(input);
  return { id: task.id };
}
export function handleTaskUpdate(id: string, body: Body): { id: string } {
  const input: UpdateTaskInput = {};
  if (body.status) input.status = String(body.status) as TaskStatus;
  if (body.assignee !== undefined) input.assignee = String(body.assignee);
  if (body.priority !== undefined && body.priority !== '') input.priority = clampPriority(body.priority);
  if (body.title) input.title = String(body.title);
  const task = taskSvc().update(id, input);
  if (!task) throw new Error('task not found');
  return { id };
}
export function handleTaskClose(id: string, body: Body): { id: string; status: string } {
  const task = taskSvc().close(id, body.reason ? String(body.reason) : undefined);
  if (!task) throw new Error('task not found');
  return { id, status: 'done' };
}
export function handleTaskDelete(id: string): { id: string; deleted: boolean } {
  const ok = taskSvc().delete(id);
  if (!ok) throw new Error('task not found');
  return { id, deleted: true };
}
export function handleTaskClaim(id: string, body: Body): { id: string; claimed: boolean } {
  const agentId = String(body.agentId ?? 'dashboard');
  const branch = String(body.worktreeBranch ?? '');
  const claimed = taskSvc().tryClaim(id, agentId, branch);
  return { id, claimed };
}
function clampPriority(v: unknown): TaskPriority {
  const n = Math.round(Number(v));
  return (Number.isFinite(n) ? Math.min(4, Math.max(0, n)) : 2) as TaskPriority;
}

// ── Epics / completion ledger ──
const LEDGER_STATUSES: LedgerStatus[] = ['pending', 'in_progress', 'done', 'failed'];
export function handleLedgerItem(cwd: string, id: string, body: Body): { id: string; status: string } {
  const status = String(body.status ?? '') as LedgerStatus;
  if (!LEDGER_STATUSES.includes(status)) throw new Error(`invalid status; must be one of ${LEDGER_STATUSES.join(', ')}`);
  const ok = markItem(cwd, id, status);
  if (!ok) throw new Error('ledger item not found');
  return { id, status };
}
export function handleLedgerReset(cwd: string): { reset: boolean } {
  clearLedger(cwd);
  return { reset: true };
}
export function handleLedgerInit(cwd: string, body: Body): { mission: string; items: number } {
  const mission = String(body.mission ?? '').trim();
  if (!mission) throw new Error('mission is required');
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items: NewItem[] = rawItems
    .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
    .map((it) => ({ id: String(it.id), title: String(it.title ?? it.id) }));
  const led = initLedger(cwd, mission, items);
  return { mission: led.mission, items: led.items.length };
}

// ── Orchestrator toggle ──
export function handleOrchestratorToggle(cwd: string, body: Body): { state: string } {
  const state = String(body.state ?? '').toLowerCase();
  if (state !== 'on' && state !== 'off' && state !== 'auto') throw new Error('state must be on | off | auto');
  modifyUapConfig(cwd, (cfg) => {
    const deliver = { ...((cfg.deliver as Record<string, unknown>) ?? {}) };
    if (state === 'auto') delete deliver.orchestrate;
    else deliver.orchestrate = state;
    return { ...cfg, deliver };
  });
  return { state };
}

// ── Agents ──
export function handleAgentDeregister(id: string): { id: string; deregistered: boolean } {
  const svc = new CoordinationService();
  svc.deregister(id);
  return { id, deregistered: true };
}
export function handleAgentCleanStale(): { cleaned: number } {
  const svc = new CoordinationService();
  return { cleaned: svc.cleanupStaleAgents() };
}

// ── Deliver runs ──
export function listDeliverRuns(cwd: string): DeliverRunState[] {
  try {
    return listRuns(cwd);
  } catch {
    return [];
  }
}
export function handleDeliverLaunch(cwd: string, body: Body): { launched: boolean; pid?: number } {
  const instruction = String(body.instruction ?? '').trim();
  if (!instruction) throw new Error('instruction is required');
  const args = ['deliver', instruction, '--json'];
  if (body.model) args.push('--model', String(body.model));
  if (body.maxTurns) args.push('--max-turns', String(Math.max(1, Math.round(Number(body.maxTurns)) || 5)));
  const child = spawn('uap', args, { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  return { launched: true, pid: child.pid };
}
export function handleDeliverCancel(cwd: string, runId: string): { runId: string; cancelRequested: boolean; interrupted: boolean } {
  if (!isValidRunId(runId)) throw new Error('invalid runId');
  requestStop(cwd, runId);
  const st = loadRunState(cwd, runId);
  // Is the owning process still alive? kill(pid, 0) throws ESRCH when it is gone.
  let alive = false;
  if (st && st.pid) {
    try {
      process.kill(st.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      // A live run: SIGTERM it and let its loop observe the stop-file and mark
      // the run interrupted on its own terms (checkpoint-safe).
      try {
        process.kill(st.pid, 'SIGTERM');
      } catch {
        /* raced to exit */
      }
    }
  }
  // Orphaned run (process gone, or a pre-pid run with no recorded pid): nothing
  // will ever observe the cooperative stop-file, so flip the durable state to
  // interrupted directly — otherwise a dead 'running' run lingers forever.
  let interrupted = false;
  if (!alive && st && st.status === 'running') {
    saveRunState({ ...st, status: 'interrupted' });
    interrupted = true;
  }
  return { runId, cancelRequested: true, interrupted };
}
export function handleDeliverResume(cwd: string, runId: string): { runId: string; resumed: boolean; pid?: number } {
  if (!isValidRunId(runId)) throw new Error('invalid runId');
  const child = spawn('uap', ['deliver', '--resume', runId, '--json'], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  return { runId, resumed: true, pid: child.pid };
}
