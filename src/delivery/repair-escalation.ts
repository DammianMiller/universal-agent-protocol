/**
 * Repair escalation — a circuit breaker for the compile-error death spiral.
 *
 * Field evidence (two live missions): a weak local model that breaks the
 * build keeps WRITING on top of the breakage, compounding errors turn over
 * turn (observed 47 → 653 across one epic attempt) — it fixes 1-2 errors
 * fine but drowns at 50+, and per-write compile feedback alone cannot save a
 * model that ignores it. When the compile-error count GROWS across
 * consecutive turns, the productive move is to stop the mission work and run
 * ONE narrow repair pass — "make it compile, change nothing else" — in a
 * fresh focused session, on a stronger model when one is configured
 * (--escalate-model / $UAP_ESCALATE_MODEL), before resuming the epic.
 *
 * Implemented entirely on existing loop surfaces: the controller is an
 * onIteration hook that, when tripped, returns IterationDirective.
 * switchExecutor with a ONE-SHOT executor — its first call ignores the
 * loop's prompt and runs the repair mission, then delegates every later call
 * back to the original executor (self-restoring).
 */

import type { IterationRecord, IterationDirective, LoopExecutor } from './convergence-loop.js';

/**
 * Single source for the stronger-model id used by repair + escalation:
 * explicit flag > $UAP_ESCALATE_MODEL > `.uap.json` deliver.escalateModel.
 * The config rung makes escalation reproducible IaC state instead of a
 * per-shell env var (follow-up of the 2026-07-16 stuck-epic incident, where
 * the run had no escalation rescue because the env var wasn't set).
 */
export function resolveEscalateModelId(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  cfgRaw: Record<string, unknown> | null | undefined
): string | undefined {
  if (explicit) return explicit;
  if (env.UAP_ESCALATE_MODEL) return env.UAP_ESCALATE_MODEL;
  const deliver = cfgRaw?.deliver as Record<string, unknown> | undefined;
  const fromCfg = deliver?.escalateModel;
  return typeof fromCfg === 'string' && fromCfg.trim() !== '' ? fromCfg : undefined;
}

/**
 * Deterministic compile-error count from gate output. Prefers the compiler's
 * own total (cargo's "due to N previous errors"), else counts distinct error
 * lines (cargo `error[E...]`, tsc `error TS...`, generic `error:` lines).
 */
export function extractCompileErrorCount(text: string): number {
  if (!text) return 0;
  let max = 0;
  for (const m of text.matchAll(/due to (\d+) previous errors?/g)) {
    max = Math.max(max, Number(m[1]));
  }
  if (max > 0) return max;
  for (const re of [/^error\[E\d+\]/gm, /error TS\d+:/g, /^error(?::|\[)/gm]) {
    const n = [...text.matchAll(re)].length;
    max = Math.max(max, n);
  }
  return max;
}

export interface RepairEscalationOptions {
  /** Error count below which growth is tolerated (default 10). */
  minErrors?: number;
  /** Consecutive turns the count must GROW to trip (default 2). */
  growthTurns?: number;
  /** Turns to wait after a repair before another may trip (default 3). */
  cooldownTurns?: number;
  /** Hard cap on repair passes per loop (default 2). */
  maxRepairs?: number;
  /** Runs the narrow repair mission; returns its summary text. */
  runRepair: (errorTail: string, errorCount: number) => Promise<string>;
  /** The loop's normal executor — delegated to after the one-shot repair. */
  originalExecutor: LoopExecutor;
  /** Telemetry/logging on trip. */
  onTrigger?: (count: number, prev: number, turn: number) => void;
}

export interface RepairEscalationController {
  onIteration: (record: IterationRecord) => IterationDirective;
  /** Repairs dispatched so far (for tests/inspection). */
  repairCount(): number;
}

export function createRepairEscalation(opts: RepairEscalationOptions): RepairEscalationController {
  const minErrors = Math.max(1, opts.minErrors ?? 10);
  const growthTurns = Math.max(1, opts.growthTurns ?? 2);
  const cooldown = Math.max(0, opts.cooldownTurns ?? 3);
  const maxRepairs = Math.max(1, opts.maxRepairs ?? 2);
  let prev = 0;
  let growing = 0;
  let lastRepairTurn = Number.NEGATIVE_INFINITY;
  let repairs = 0;

  return {
    repairCount: () => repairs,
    onIteration(record: IterationRecord): IterationDirective {
      const tails = (record.gateResults ?? [])
        .filter((r) => !r.passed && !r.skipped && r.outputTail)
        .map((r) => r.outputTail)
        .join('\n');
      const count = extractCompileErrorCount(tails);
      const prevBefore = prev;
      // A growth streak requires consecutive turns with a rising nonzero count.
      growing = count > prevBefore && prevBefore > 0 ? growing + 1 : 0;
      const shouldTrip =
        count >= minErrors &&
        growing >= growthTurns - 1 &&
        repairs < maxRepairs &&
        record.turn - lastRepairTurn > cooldown;
      prev = count;
      if (!shouldTrip) return {};

      repairs++;
      lastRepairTurn = record.turn;
      growing = 0;
      opts.onTrigger?.(count, prevBefore, record.turn);
      const errorTail = tails.slice(-6_000);
      let fired = false;
      const oneShotRepair: LoopExecutor = async (prompt) => {
        if (fired) return opts.originalExecutor(prompt);
        fired = true;
        return opts.runRepair(errorTail, count);
      };
      return { switchExecutor: oneShotRepair };
    },
  };
}
