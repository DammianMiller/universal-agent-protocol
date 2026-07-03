/**
 * Durable Delivery Runs — persist convergence-loop state across process
 * boundaries so very long missions survive interruption (crash, timeout,
 * operator stop) and resume exactly where they left off.
 *
 * One directory per run under `<projectRoot>/.uap/deliver-runs/<runId>/` with
 * a single `state.json`: run metadata + the loop's last LoopCheckpoint (and,
 * for decomposed runs, the phase plan + cursor). Writes are atomic
 * (tmp + rename) and fail-soft — persistence must never break a run.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { LoopCheckpoint } from './convergence-loop.js';
import type { DeliveryPhase } from './decompose.js';

export type DeliverRunStatus = 'running' | 'delivered' | 'failed' | 'interrupted';

export interface DeliverRunState {
  runId: string;
  instruction: string;
  presetId: string;
  projectRoot: string;
  status: DeliverRunStatus;
  createdAt: string;
  updatedAt: string;
  /** Loop state after the last completed turn (absent before turn 1). */
  checkpoint?: LoopCheckpoint;
  /** Decomposed missions: the phase plan and the index of the phase in flight. */
  phases?: DeliveryPhase[];
  phaseIndex?: number;
  /** One-line summaries of completed phases (harness-owned, injected into later phases). */
  phaseSummaries?: string[];
  /** Task-DB id opened for this mission, so --resume reuses it instead of duplicating. */
  taskId?: string;
}

export function deliverRunsDir(projectRoot: string): string {
  return join(projectRoot, '.uap', 'deliver-runs');
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `run-${stamp}-${randomBytes(3).toString('hex')}`;
}

/** Run ids are path components; refuse anything that is not a plain slug. */
export function isValidRunId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && !id.includes('..');
}

/** Persist run state atomically. Fail-soft: returns false on any error. */
export function saveRunState(state: DeliverRunState): boolean {
  try {
    const dir = join(deliverRunsDir(state.projectRoot), state.runId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'state.json');
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

const VALID_STATUSES = new Set<DeliverRunStatus>(['running', 'delivered', 'failed', 'interrupted']);
const MAX_INSTRUCTION_CHARS = 8000;
const MAX_PHASES = 5;
const MAX_SUMMARY_CHARS = 300;

/**
 * Read + SANITIZE a persisted run state. The state file lives inside the
 * target project tree, i.e. on the untrusted side of the boundary (a generator
 * model or repo content could seed one), so nothing loaded here is trusted:
 * the runId is forced back to the validated directory name (a planted
 * traversal runId would otherwise steer every later save), text fields are
 * length-clamped, phases re-validated against the planner's own limits, and
 * unknown statuses rejected.
 */
function readState(projectRoot: string, runId: string): DeliverRunState | null {
  try {
    const path = join(deliverRunsDir(projectRoot), runId, 'state.json');
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as DeliverRunState;
    if (!parsed || typeof parsed.instruction !== 'string' || !parsed.instruction.trim()) {
      return null;
    }
    if (!VALID_STATUSES.has(parsed.status)) return null;
    // The directory name is the validated identity; never trust the embedded id.
    parsed.runId = runId;
    parsed.projectRoot = projectRoot;
    parsed.instruction = parsed.instruction.slice(0, MAX_INSTRUCTION_CHARS);
    if (typeof parsed.updatedAt !== 'string' || Number.isNaN(Date.parse(parsed.updatedAt))) {
      parsed.updatedAt = new Date(0).toISOString(); // sorts last for 'latest'
    }
    if (parsed.phases !== undefined) {
      if (!Array.isArray(parsed.phases)) return null;
      const phases: DeliveryPhase[] = [];
      for (const ph of parsed.phases.slice(0, MAX_PHASES)) {
        if (typeof ph !== 'object' || ph === null) return null;
        const { id, title, goal } = ph as { id?: unknown; title?: unknown; goal?: unknown };
        if (typeof id !== 'string' || typeof title !== 'string' || typeof goal !== 'string') return null;
        if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) return null;
        phases.push({ id, title: title.slice(0, 120), goal: goal.slice(0, 600) });
      }
      parsed.phases = phases;
    }
    if (parsed.phaseSummaries !== undefined) {
      if (!Array.isArray(parsed.phaseSummaries)) return null;
      parsed.phaseSummaries = parsed.phaseSummaries
        .slice(0, MAX_PHASES * 2)
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.slice(0, MAX_SUMMARY_CHARS));
    }
    if (parsed.taskId !== undefined && (typeof parsed.taskId !== 'string' || !/^uap-[0-9a-f]{8}$/.test(parsed.taskId))) {
      delete parsed.taskId;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load a run for resumption. `'latest'` resolves to the most recently updated
 * non-delivered run (an interrupted process leaves status 'running' behind —
 * that IS the resumable state). Returns null when nothing resumable exists.
 */
export function loadRunState(projectRoot: string, runId: string): DeliverRunState | null {
  if (runId !== 'latest') {
    if (!isValidRunId(runId)) return null;
    return readState(projectRoot, runId);
  }
  const dir = deliverRunsDir(projectRoot);
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: DeliverRunState | null = null;
  for (const id of entries) {
    if (!isValidRunId(id)) continue;
    const state = readState(projectRoot, id);
    if (!state || state.status === 'delivered') continue;
    if (!best || state.updatedAt > best.updatedAt) best = state;
  }
  return best;
}
