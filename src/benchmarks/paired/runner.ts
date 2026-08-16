/**
 * Paired runner — the experiment engine.
 *
 * For every (task, condition, seed) cell it: materializes a fresh isolated copy
 * of the task's failing repo, runs optional setup, drives the agent adapter
 * (which injects the UAP surface for non-baseline arms), then applies the
 * deterministic verify command to score correctness. The SAME seed is used for
 * the same task across all conditions, so records pair up cell-for-cell — the
 * key to the paired statistics in ./stats.ts.
 */

import { rmSync } from 'fs';
import { dirname } from 'path';
import { concurrentMap } from '../../utils/concurrency-pool.js';
import { materializeWorkdir, runSetup, runVerify } from './suite.js';
import { MetricVector, RunRecord, RunnerConfig, TaskSpec, Condition } from './types.js';

interface Cell {
  task: TaskSpec;
  condition: Condition;
  seed: number;
}

export interface RunnerOutput {
  records: RunRecord[];
  model: string;
  adapter: string;
  epochs: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * Execute the full (tasks × conditions × epochs) grid.
 * `suiteDir` is required so the runner can locate each task's fixture repo.
 */
export async function runPaired(
  cfg: RunnerConfig,
  suiteDir: string,
  startedAtIso: string
): Promise<RunnerOutput> {
  const cells: Cell[] = [];
  for (const task of cfg.tasks) {
    for (let seed = 0; seed < cfg.epochs; seed++) {
      for (const condition of cfg.conditions) {
        cells.push({ task, condition, seed });
      }
    }
  }

  let done = 0;
  const total = cells.length;

  const records = await concurrentMap(
    cells,
    async (cell): Promise<RunRecord> => {
      const rec = await executeCell(cell, cfg, suiteDir);
      done++;
      cfg.onProgress?.(done, total, `${cell.task.id}/${cell.condition.label}#${cell.seed}`);
      return rec;
    },
    // 'model', not 'cpu': every cell is an inference call, so the ceiling is the
    // backend's slot budget, not core count. The mode only decides the fallback
    // when the caller passes no explicit concurrency — but declaring it wrong
    // meant an unset concurrency sized the run against the wrong resource.
    { maxConcurrent: cfg.concurrency, mode: 'model' }
  );

  return {
    records,
    model: cfg.model,
    adapter: cfg.adapter.id,
    epochs: cfg.epochs,
    startedAt: startedAtIso,
    finishedAt: nowIso(),
  };
}

async function executeCell(cell: Cell, cfg: RunnerConfig, suiteDir: string): Promise<RunRecord> {
  const { task, condition, seed } = cell;
  const t0 = Date.now();

  const baseMetrics = (): MetricVector => ({
    correct: false,
    tokens: null,
    costUsd: null,
    turns: null,
    toolCalls: null,
    latencyMs: Date.now() - t0,
    wellFormed: null,
    error: null,
  });

  let workdir: string;
  try {
    workdir = materializeWorkdir(suiteDir, task, cfg.workRoot);
  } catch (e) {
    return record(cell, cfg, { ...baseMetrics(), error: `materialize failed: ${errMsg(e)}` });
  }

  try {
    // Optional setup; a failed setup means the cell can't be scored fairly.
    try {
      const setup = runSetup(task, workdir);
      if (setup && !setup.passed) {
        return record(cell, cfg, {
          ...baseMetrics(),
          error: `setup failed (exit ${setup.exitCode})`,
        });
      }
    } catch (e) {
      return record(cell, cfg, { ...baseMetrics(), error: `setup error: ${errMsg(e)}` });
    }

    // Drive the agent (adapters capture their own failures in `error`).
    let agent;
    try {
      agent = await cfg.adapter.run({ task, condition, workdir, seed, model: cfg.model });
    } catch (e) {
      return record(cell, cfg, { ...baseMetrics(), error: `adapter threw: ${errMsg(e)}` });
    }

    // Score with the deterministic ground-truth verify command.
    let correct = false;
    let verifyErr: string | null = agent.error;
    try {
      const v = runVerify(task, workdir);
      correct = v.passed;
      if (!correct && !verifyErr) {
        verifyErr = v.timedOut ? 'verify timed out' : `verify failed (exit ${v.exitCode})`;
      }
    } catch (e) {
      verifyErr = `verify error: ${errMsg(e)}`;
    }

    const metrics: MetricVector = {
      correct,
      tokens: agent.tokens,
      costUsd: agent.costUsd,
      turns: agent.turns,
      toolCalls: agent.toolCalls,
      latencyMs: Date.now() - t0,
      wellFormed: agent.wellFormed,
      error: verifyErr,
    };
    return record(cell, cfg, metrics);
  } finally {
    // The cell is settled — its scratch copy has no further purpose (every
    // return above passes through here). Workdirs live in RAM-backed /tmp on
    // typical dev boxes; a 50-cell run leaked ~50 repo copies and 26k entries
    // accumulated before this (2026-08-16). UAP_BENCH_KEEP_WORKDIRS=1
    // preserves them for post-mortem debugging.
    if (process.env.UAP_BENCH_KEEP_WORKDIRS !== '1') {
      try { rmSync(dirname(workdir), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

function record(cell: Cell, cfg: RunnerConfig, metrics: MetricVector): RunRecord {
  return {
    taskId: cell.task.id,
    condition: cell.condition.label,
    seed: cell.seed,
    metrics,
    adapter: cfg.adapter.id,
    model: cfg.model,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function nowIso(): string {
  return new Date().toISOString();
}
