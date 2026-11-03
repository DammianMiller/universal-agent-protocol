/**
 * Workflow runner — static steps onto the blackboard orchestrator.
 *
 * One runner, three step kinds, zero new graph semantics:
 *   agent   → a FRESH single completion (role prompt + direct-dependency
 *             summaries + inlined run-dir files), reply written to the
 *             step's first `writes` entry. The Memdoor ledger discipline:
 *             steps talk through FILES, never through chat.
 *   command → shell in the run dir; exit 0 = success, unless `neverFails`
 *             (the `test` step pattern: capture, don't fail). The verdict
 *             step is just a command without the flag.
 *   gate    → pause for `uap workflow approve`; unapproved = run BLOCKED
 *             (exit 2), resumable — a gate is an operator act, not a failure.
 *
 * Everything graph-shaped (dependency-triggered dispatch, skip cascade,
 * bounded repair of a failed step, resume-at-the-boundary via initialDone /
 * onProgress) is `orchestrate()` from task-orchestrator.ts, already
 * validated by its own test suite. This module owns only the step seams.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { basename, dirname, join, normalize } from 'path';
import { orchestrate, type OrchestratorTask, type TaskOutcome } from '../delivery/task-orchestrator.js';
import type { ModelClient } from '../models/executor.js';
import type { ModelConfig } from '../models/types.js';
import {
  WORKFLOW_EXIT,
  type LoadedWorkflow,
  type WorkflowRunState,
  type WorkflowStep,
} from './types.js';

/** Summary prefix marking an unapproved gate — blocked, NOT failed. */
export const GATE_BLOCKED_PREFIX = 'GATE: awaiting approval';

/** Per-file inline cap for `reads:`. Elided with a marker, never a surprise. */
const READ_FILE_CAP_CHARS = 16_000;
/** Total budget for all inlined reads across one step (chars). */
const READ_TOTAL_CAP_CHARS = 48_000;
/** Default command kill timer (ms). */
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
/** Gate approval poll interval (ms). */
const GATE_POLL_MS = 2_000;
const SPAWN_MAX_BUFFER = 8 * 1024 * 1024;

/** Names the runner owns inside the run directory. */
export const RUN_STATE_FILE = 'run-state.json';
export const GATES_DIR = '.gates';

export interface RunWorkflowOptions {
  loaded: LoadedWorkflow;
  /** Absolute run directory: the file ledger + run-state.json live here. */
  runDir: string;
  /** One-line objective, assembled into every step context (orientation only). */
  mission: string;
  /** Resolve a step pin (undefined = workflow/CLI/fleet default) to a ModelConfig. */
  resolveModel: (preset: string | undefined) => ModelConfig;
  /** Completion seam for agent steps — production: OpenAICompatClient. */
  client: ModelClient;
  /** Prior accepted steps — resume seeding (orchestrate initialDone). */
  initialDone?: Array<{ id: string; summary: string; contract?: string }>;
  /** Sampling temperature for agent steps (default 0.7). */
  temperature?: number;
  /** Concurrency override for independent steps (1..16; default: the
   * workflow's `parallel:`, else 1). The CLI's --parallel. */
  parallel?: number;
  /** Progress line sink (default: no-op). */
  log?: (line: string) => void;
}

export interface WorkflowRunResult {
  status: WorkflowRunState['status'];
  exitCode: number;
  completed: string[];
  failed: string[];
  /** Set when status === 'blocked'. */
  blockedStep?: string;
  turns: number;
}

export function runsDir(projectRoot: string): string {
  return join(projectRoot, '.uap', 'workflow-runs');
}

export function newRunId(workflow: string): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${workflow}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function runStatePath(runDir: string): string {
  return join(runDir, RUN_STATE_FILE);
}

/** Read persisted state; null when absent (a fresh run). Fail-soft on corrupt. */
export function readRunState(runDir: string): WorkflowRunState | null {
  const p = runStatePath(runDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as WorkflowRunState;
  } catch {
    return null;
  }
}

export function writeRunState(runDir: string, state: WorkflowRunState): void {
  mkdirSync(runDir, { recursive: true });
  // Atomic (tmp + rename): an interrupt mid-write must never corrupt the
  // resume state — stranding accepted work is exactly what resume exists to
  // prevent. A `.tmp` remnant from a hard kill is inert and never read.
  const finalPath = runStatePath(runDir);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmpPath, finalPath);
}

/** Guard the runner's own files: a step writing run-state.json or .gates/
 * would corrupt the machinery it runs under — including its own gate
 * approval. Normalizes `./`-prefixed spellings so the guard compares what
 * the filesystem will resolve, not what the author typed. */
export function assertNoReservedWrites(loaded: LoadedWorkflow): void {
  for (const s of loaded.def.steps) {
    for (const p of s.writes ?? []) {
      const norm = normalize(p);
      if (
        norm === RUN_STATE_FILE ||
        norm === GATES_DIR ||
        norm.startsWith(`${GATES_DIR}/`)
      ) {
        throw new Error(`step "${s.id}" writes reserved path "${p}"`);
      }
    }
  }
}

function inlineReads(runDir: string, step: WorkflowStep, log: (l: string) => void): string {
  if (!step.reads || step.reads.length === 0) return '';
  const sections: string[] = [];
  let total = 0;
  for (const p of step.reads) {
    const abs = join(runDir, p);
    if (!existsSync(abs)) {
      // Fail-closed: the role prompt expects this file; a missing one means
      // an upstream step lied about its writes (or the input was not copied).
      throw new Error(`step "${step.id}" reads "${p}" but it does not exist in the run directory`);
    }
    const full = readFileSync(abs, 'utf8');
    const capped =
      full.length > READ_FILE_CAP_CHARS
        ? full.slice(0, READ_FILE_CAP_CHARS) + `\n…(elided ${full.length - READ_FILE_CAP_CHARS} chars)`
        : full;
    if (total + capped.length > READ_TOTAL_CAP_CHARS) {
      log(`  ⚠ ${step.id}: reads budget exhausted before "${p}" — file omitted from the prompt`);
      break;
    }
    total += capped.length;
    sections.push(`--- ${p} ---\n${capped}`);
  }
  if (sections.length === 0) return '';
  return `\n\nINPUT FILES (from the run directory — these are the ground truth):\n\n${sections.join('\n\n')}`;
}

/** Async command execution: a command step must never block the event loop —
 * under parallel dispatch a synchronous spawn would freeze in-flight model
 * completions and gate polls for the command's whole runtime. Exit code,
 * start failure, and timeout are distinguished so the summary tells the
 * truth about which of the three happened. Output is bounded at
 * SPAWN_MAX_BUFFER (elided, never a crash). */
function spawnCommand(
  command: string,
  runDir: string,
  workflowDir: string,
  timeoutMs: number
): Promise<{ output: string; status: number | null; startError?: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: runDir,
      env: { ...process.env, UAP_WORKFLOW_DIR: workflowDir },
    });
    let output = '';
    const append = (chunk: Buffer | string): void => {
      if (output.length >= SPAWN_MAX_BUFFER) return;
      output += chunk.toString();
      if (output.length > SPAWN_MAX_BUFFER) {
        output = `${output.slice(0, SPAWN_MAX_BUFFER)}\n…(output elided at buffer bound)`;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let timedOut = false;
    let settled = false;
    const settle = (r: { output: string; status: number | null; startError?: string; timedOut: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate if the shell ignores TERM; the promise resolves on close.
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
    }, timeoutMs);
    child.on('error', (err) => settle({ output, status: null, startError: err.message, timedOut: false }));
    child.on('close', (code) => settle({ output, status: code, timedOut }));
  });
}

/** Execute the workflow. The run directory is the ledger; state persists
 * after every accepted step so an interrupt resumes at the step boundary. */
export async function runWorkflow(opts: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const { loaded, runDir, mission } = opts;
  assertNoReservedWrites(loaded);
  mkdirSync(runDir, { recursive: true });
  const log = opts.log ?? ((): void => undefined);
  const byId = new Map(loaded.def.steps.map((s) => [s.id, s]));
  // A fresh state, ALWAYS: done seeds come from opts.initialDone (the CLI's
  // resume path) and never from whatever run-state.json happens to sit in
  // the directory — a planted or stale state file must not be able to skip
  // steps on a fresh run (a planted `verify` would exit 0 unverified).
  const state: WorkflowRunState = {
    runId: basename(runDir),
    workflow: loaded.def.name,
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mission,
    done: opts.initialDone ? [...opts.initialDone] : [],
    failed: [],
  };
  state.updatedAt = new Date().toISOString();
  writeRunState(runDir, state);

  const tasks: OrchestratorTask[] = loaded.def.steps.map((s) => {
    const goal =
      s.kind === 'agent'
        ? (loaded.rolePrompts.get(s.id) ?? s.goal ?? '')
        : s.kind === 'command'
          ? `Run: ${s.command}`
          : (s.approvalPrompt ?? `Approve step "${s.id}" to continue.`);
    return {
      id: s.id,
      title: s.title ?? s.id,
      goal,
      deps: s.requires ?? [],
      // Deliberately NO `files`: the assembler's "edit only these" line is
      // deliver phrasing — a workflow step's role prompt already names the
      // file it produces, and the reply lands in writes[0] verbatim.
      criteria: s.criteria,
      model: s.model,
    };
  });

  // Preflight the pin ladder once: the loader validated FILE pins at load
  // (exit 3 before anything runs); this catches the CLI --model / --endpoint
  // inputs the file could not — still before any step executes.
  opts.resolveModel(undefined);

  const runTask = async (ctx: { prompt: string }, task: OrchestratorTask): Promise<TaskOutcome> => {
    const step = byId.get(task.id);
    if (!step) {
      return { taskId: task.id, success: false, summary: `unknown step "${task.id}"`, turns: 0 };
    }
    if (step.kind === 'agent') {
      const model = opts.resolveModel(step.model);
      const prompt = ctx.prompt + inlineReads(runDir, step, log);
      const r = await opts.client.complete(model, prompt, { temperature: opts.temperature ?? 0.7 });
      // Fail-closed on the empty reply: writing an empty file and crediting
      // the step would poison every dependent that reads it. (A truncated
      // reply still lands — the client already re-requested once at 4x the
      // budget; emptiness is the case that is unambiguously broken.)
      if (!r.content || !r.content.trim()) {
        return {
          taskId: step.id,
          success: false,
          summary: 'model returned an empty reply — nothing written (retryable via step repair)',
          turns: 1,
        };
      }
      const target = step.writes?.[0];
      if (target) {
        mkdirSync(dirname(join(runDir, target)), { recursive: true });
        writeFileSync(join(runDir, target), r.content);
      }
      const summary = target
        ? `wrote ${target} (${r.content.length} chars)`
        : r.content.slice(0, 200).replace(/\s+/g, ' ');
      return { taskId: step.id, success: true, summary, turns: 1 };
    }
    if (step.kind === 'command') {
      if (!step.command) {
        // Loader already rejects this; fail-closed anyway — never spawn a lie.
        return { taskId: step.id, success: false, summary: 'command step without command:', turns: 0 };
      }
      log(`  $ ${step.command}`);
      // Commands run with cwd = the run directory (the file ledger), but the
      // workflow's own assets (harness scripts) stay in the workflow dir:
      // $UAP_WORKFLOW_DIR is the explicit, injection-free seam between them.
      const proc = await spawnCommand(
        step.command,
        runDir,
        loaded.dir,
        step.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
      );
      const target = step.writes?.[0] ?? `${step.id}.log`;
      mkdirSync(dirname(join(runDir, target)), { recursive: true });
      writeFileSync(join(runDir, target), proc.output);
      if (proc.startError) {
        return {
          taskId: step.id,
          success: step.neverFails === true,
          summary: `command failed to start: ${proc.startError}`,
          turns: 1,
        };
      }
      if (proc.timedOut || proc.status === null) {
        return {
          taskId: step.id,
          success: step.neverFails === true,
          summary: `command timed out after ${step.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS}ms (output captured)`,
          turns: 1,
        };
      }
      return {
        taskId: step.id,
        success: step.neverFails === true || proc.status === 0,
        summary:
          step.neverFails === true
            ? `exit ${proc.status} (never-fails: captured to ${target})`
            : `exit ${proc.status} (output in ${target})`,
        turns: 1,
      };
    }
    // gate: wait for the operator's approval file, bounded by waitMs.
    const approvalFile = join(runDir, GATES_DIR, `${step.id}.approved`);
    const deadline = Date.now() + (step.waitMs ?? 0);
    while (!existsSync(approvalFile) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, GATE_POLL_MS));
    }
    if (existsSync(approvalFile)) {
      return { taskId: step.id, success: true, summary: `gate approved`, turns: 1 };
    }
    return {
      taskId: step.id,
      success: false,
      summary: `${GATE_BLOCKED_PREFIX} — run \`uap workflow approve <runId> ${step.id}\`, then resume`,
      turns: 1,
    };
  };

  // The orchestrator's governor hard-truncates the assembled prompt at the
  // budget; at the default 6000 a long role prompt would be cut mid-text.
  // Lift the budget by the largest role prompt so the GOAL always survives
  // intact — dependency summaries stay governed (they are what the governor
  // elides first, by design). Reads are bounded separately (16k/file,
  // 48k/step) and documented as such.
  const maxRolePromptChars = Math.max(0, ...[...loaded.rolePrompts.values()].map((p) => p.length));
  const contextBudget = (loaded.def.contextBudgetChars ?? 6000) + maxRolePromptChars;

  const result = await orchestrate({
    mission,
    tasks,
    runTask,
    concurrency: opts.parallel ?? loaded.def.parallel ?? 1,
    ...(loaded.def.maxRepairsPerStep !== undefined ? { maxRepairsPerTask: loaded.def.maxRepairsPerStep } : {}),
    contextBudgetChars: contextBudget,
    ...(opts.initialDone ? { initialDone: opts.initialDone } : {}),
    onProgress: (done) => {
      state.done = done;
      state.updatedAt = new Date().toISOString();
      writeRunState(runDir, state);
    },
    onTask: (task, outcome) => {
      log(`  ${outcome.success ? '✓' : '✗'} ${task.id}: ${outcome.summary}`);
    },
  });

  // Blocked gate ≠ failed step — but the distinction must be honest in BOTH
  // directions. A gate in the FINAL failed set (last-entry-wins: an approved
  // retry removes it) makes the run BLOCKED (exit 2, resumable), together
  // with every descendant the skip cascade dropped behind it. A real defect
  // anywhere OUTSIDE that blocked subtree reports failed (exit 1) — a broken
  // step never hides behind a gate.
  const gateIds = new Set(loaded.def.steps.filter((s) => s.kind === 'gate').map((s) => s.id));
  const blockedGates = result.failed.filter((id) => gateIds.has(id));
  let status: WorkflowRunState['status'] = 'failed';
  let blockedStep: string | undefined;
  if (!result.success && blockedGates.length > 0) {
    const blockedSubtree = new Set<string>(blockedGates);
    const queue = [...blockedGates];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const s of loaded.def.steps) {
        if ((s.requires ?? []).includes(cur) && !blockedSubtree.has(s.id)) {
          blockedSubtree.add(s.id);
          queue.push(s.id);
        }
      }
    }
    const realFailures = result.failed.filter((id) => !blockedSubtree.has(id));
    if (realFailures.length === 0) {
      status = 'blocked';
      // Last blocked outcome of the last blocked gate (repair retries emit
      // several; the last one is the operative state).
      const lastBlocked = result.outcomes
        .filter((o) => blockedGates.includes(o.taskId) && o.summary.startsWith(GATE_BLOCKED_PREFIX))
        .pop();
      blockedStep = lastBlocked?.taskId;
    }
  } else if (result.success) {
    status = 'succeeded';
  }
  state.status = status;
  state.failed = result.failed;
  state.updatedAt = new Date().toISOString();
  if (status !== 'blocked') state.endedAt = new Date().toISOString();
  writeRunState(runDir, state);

  return {
    status,
    exitCode:
      status === 'succeeded'
        ? WORKFLOW_EXIT.ok
        : status === 'blocked'
          ? WORKFLOW_EXIT.blocked
          : WORKFLOW_EXIT.stepFailed,
    completed: result.completed,
    failed: result.failed,
    ...(blockedStep !== undefined ? { blockedStep } : {}),
    turns: result.turns,
  };
}

/** Create the approval marker a gate step polls for. */
export function approveGate(runDir: string, stepId: string): string {
  const gates = join(runDir, GATES_DIR);
  mkdirSync(gates, { recursive: true });
  const p = join(gates, `${stepId}.approved`);
  writeFileSync(p, new Date().toISOString() + '\n');
  return p;
}
