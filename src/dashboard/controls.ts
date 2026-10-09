/**
 * Dashboard control handlers — the WRITE surface behind the dashboard's
 * mutation-token gate (see server.ts `mutationAuthorized`). Each handler wraps
 * an existing importable service so the dashboard can start/stop/delete UAP
 * lifecycle objects (tasks, epics/ledger, orchestrator, deliver runs, agents).
 * Handlers throw Error with a clear message on bad input; server.ts maps that
 * to a 400/500 JSON response.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { TaskService } from '../tasks/service.js';
import type { CreateTaskInput, UpdateTaskInput, TaskType, TaskStatus, TaskPriority } from '../tasks/types.js';
import { initLedger, markItem, clearLedger } from '../delivery/completion-ledger.js';
import type { LedgerStatus, NewItem } from '../delivery/completion-ledger.js';
import { modifyUapConfig } from '../utils/config-loader.js';
import { CoordinationService } from '../coordination/service.js';
import { listRuns, loadRunState, requestStop, saveRunState, isValidRunId } from '../delivery/run-state.js';
import type { DeliverRunState } from '../delivery/run-state.js';
import { emitTaskEvent, emitAgentEvent, emitDeployEvent, emitSystemEvent } from './event-stream.js';

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
  emitTaskEvent('task_created', `Task created: ${title}`, 'info', task.id);
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
  emitTaskEvent('task_updated', `Task updated: ${id}`, 'info', id);
  return { id };
}
export function handleTaskClose(id: string, body: Body): { id: string; status: string } {
  const task = taskSvc().close(id, body.reason ? String(body.reason) : undefined);
  if (!task) throw new Error('task not found');
  emitTaskEvent('task_closed', `Task closed: ${task.title}`, 'success', id);
  return { id, status: 'done' };
}
export function handleTaskDelete(id: string): { id: string; deleted: boolean } {
  const ok = taskSvc().delete(id);
  if (!ok) throw new Error('task not found');
  emitTaskEvent('task_deleted', `Task deleted: ${id}`, 'warn', id);
  return { id, deleted: true };
}
export function handleTaskClaim(id: string, body: Body): { id: string; claimed: boolean } {
  const agentId = String(body.agentId ?? 'dashboard');
  const branch = String(body.worktreeBranch ?? '');
  const claimed = taskSvc().tryClaim(id, agentId, branch);
  if (claimed) emitTaskEvent('task_claimed', `Task ${id} claimed by ${agentId}`, 'info', id);
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
  emitTaskEvent('ledger_item_status', `Ledger item ${id} → ${status}`, status === 'failed' ? 'warn' : 'info', id);
  return { id, status };
}
export function handleLedgerReset(cwd: string): { reset: boolean } {
  clearLedger(cwd);
  emitTaskEvent('ledger_reset', 'Completion ledger cleared', 'warn');
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
  emitTaskEvent('ledger_init', `Ledger initialized: ${mission} (${led.items.length} items)`, 'success', led.mission);
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
  emitSystemEvent('orchestrator_toggle', `Orchestrator set to ${state}`, 'info', state);
  return { state };
}

// ── Agents ──
export function handleAgentDeregister(id: string): { id: string; deregistered: boolean } {
  const svc = new CoordinationService();
  svc.deregister(id);
  emitAgentEvent('agent_deregistered', `Agent deregistered: ${id}`, 'warn', id);
  return { id, deregistered: true };
}
export function handleAgentCleanStale(): { cleaned: number } {
  const svc = new CoordinationService();
  const cleaned = svc.cleanupStaleAgents();
  if (cleaned > 0) emitAgentEvent('agents_cleaned', `${cleaned} stale agent(s) cleaned`, 'info');
  return { cleaned };
}

// ── Deliver runs ──
/**
 * Resolve the `uap` executable for spawning deliver runs.
 *
 * The old `spawn('uap', …)` trusted PATH — under systemd (uap-dashboard.service)
 * PATH often lacks the npm global bin, and the launch silently died with
 * ENOENT (dash audit: PATH hazard). Resolution order:
 *   1. UAP_BIN env override (operator/debug).
 *   2. This module's own install: <root>/dist/bin/cli.js run with the SAME
 *      node binary that runs the dashboard (no PATH, no shell).
 *   3. Bare 'uap' as the last resort (interactive PATH).
 */
function resolveUapBin(): { cmd: string; preArgs: string[] } {
  if (process.env.UAP_BIN) return { cmd: process.env.UAP_BIN, preArgs: [] };
  try {
    // ESM: this file is <root>/dist/dashboard/controls.js
    const selfUrl = import.meta.url;
    if (selfUrl.startsWith('file:')) {
      const here = fileURLToPath(selfUrl);
      const cli = join(dirname(here), '..', 'bin', 'cli.js');
      if (existsSync(cli)) return { cmd: process.execPath, preArgs: [cli] };
    }
  } catch {
    /* fall through to PATH */
  }
  return { cmd: 'uap', preArgs: [] };
}

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
  const { cmd, preArgs } = resolveUapBin();
  const args = [...preArgs, 'deliver', instruction, '--json'];
  if (body.model) args.push('--model', String(body.model));
  if (body.maxTurns) args.push('--max-turns', String(Math.max(1, Math.round(Number(body.maxTurns)) || 5)));
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  emitDeployEvent('deliver_launch', `Deliver run launched (pid ${child.pid ?? '?'}): ${instruction.slice(0, 80)}`, 'info', String(child.pid ?? ''));
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
  emitDeployEvent('deliver_cancel', `Deliver run ${runId} cancel requested${interrupted ? ' (orphaned → interrupted)' : ''}`, 'warn', runId);
  return { runId, cancelRequested: true, interrupted };
}
export function handleDeliverResume(cwd: string, runId: string): { runId: string; resumed: boolean; pid?: number } {
  if (!isValidRunId(runId)) throw new Error('invalid runId');
  const { cmd, preArgs } = resolveUapBin();
  const child = spawn(cmd, [...preArgs, 'deliver', '--resume', runId, '--json'], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  emitDeployEvent('deliver_resume', `Deliver run ${runId} resumed (pid ${child.pid ?? '?'})`, 'info', runId);
  return { runId, resumed: true, pid: child.pid };
}
