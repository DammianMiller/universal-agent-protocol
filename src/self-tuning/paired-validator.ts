/**
 * LLM Self-Tuning — the real paired-bench tuning validator (P2).
 *
 * Turns a candidate flag config into a quality-scored paired `Comparison` vs the
 * current config, which the orchestrator's `decideTuning` accepts/rejects. For
 * each arm it: applies the arm's config (flag-writer, incl. shell env for the
 * child), runs the task suite, then reverts — so a trial never leaks state. Both
 * arms use the SAME tasks + seeds, so cells pair for the paired statistics, and
 * both record sets are quality-scored before `analyze`.
 *
 * `runArm` (run the suite and return records) is injected so this is unit-
 * testable with synthetic records; the CLI wires it to the paired `runPaired`.
 */

import { mean } from '../benchmarks/paired/stats.js';
import { analyze, type AnalyzeOptions } from '../benchmarks/paired/report.js';
import type { RunnerOutput } from '../benchmarks/paired/runner.js';
import type { RunRecord } from '../benchmarks/paired/types.js';
import { FlagConfig } from './flags.js';
import { applyFlagConfig } from './flag-writer.js';
import { scoreRuns, type QualityScoreInput, type ScoreOptions } from './quality-scorer.js';
import type { JudgeClient } from './judge.js';
import type { TuningValidator, TuningValidationOutcome } from './orchestrator.js';

const BASELINE_LABEL = 'baseline';
const CANDIDATE_LABEL = 'candidate';

export interface PairedValidatorDeps {
  /** Project dir the flag-writer targets. */
  cwd: string;
  /**
   * Run the task suite once (under whatever config is currently applied) and
   * return the raw records. The validator handles apply/revert + labeling.
   */
  runArm: (label: string) => Promise<RunRecord[]>;
  /** Per-record evidence for the quality scorer. */
  scoreInput: (r: RunRecord) => QualityScoreInput;
  /** Judge client for the scorer (null → heuristic scoring). */
  judge?: JudgeClient | null;
  /** Extra scorer options (weights, refTokens, …). */
  scoreOptions?: ScoreOptions;
  /** analyze() options (iterations, seed, qualityMargin, …). */
  analyzeOptions?: AnalyzeOptions;
  /** Model/adapter labels for the synthesized RunnerOutput. */
  model?: string;
  adapter?: string;
  /**
   * Called after applying a proxyEnv-affecting config so the running proxy picks
   * up new PROXY_* values. Optional; without it, proxyEnv changes only take
   * effect on the next proxy start (the loop still measures json/shell effects).
   */
  restartProxy?: () => Promise<void>;
  /** Stable timestamps for the RunnerOutput. */
  now?: string;
  log?: (msg: string) => void;
}

async function runUnderConfig(
  deps: PairedValidatorDeps,
  config: FlagConfig,
  label: string,
): Promise<RunRecord[]> {
  const applied = applyFlagConfig(deps.cwd, config);
  const savedEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(applied.shellEnv)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    if (deps.restartProxy) await deps.restartProxy();
    const records = await deps.runArm(label);
    // Force the arm label so both arms pair under a stable baseline/candidate id.
    return records.map((r) => ({ ...r, condition: label }));
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    applied.rollback();
    if (deps.restartProxy) await deps.restartProxy().catch(() => undefined);
  }
}

/** Build a `TuningValidator` that runs the real (or injected) paired bench. */
export function buildPairedTuningValidator(deps: PairedValidatorDeps): TuningValidator {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? '1970-01-01T00:00:00.000Z';

  return async function validate(
    candidate: FlagConfig,
    current: FlagConfig,
  ): Promise<TuningValidationOutcome> {
    log('  validating: baseline arm');
    const baseRaw = await runUnderConfig(deps, current, BASELINE_LABEL);
    log('  validating: candidate arm');
    const candRaw = await runUnderConfig(deps, candidate, CANDIDATE_LABEL);

    const scoreOpts: ScoreOptions = { judge: deps.judge, ...deps.scoreOptions };
    const scored = await scoreRuns([...baseRaw, ...candRaw], deps.scoreInput, scoreOpts);

    const output: RunnerOutput = {
      records: scored,
      model: deps.model ?? scored[0]?.model ?? 'model',
      adapter: deps.adapter ?? scored[0]?.adapter ?? 'adapter',
      epochs: new Set(scored.map((r) => r.seed)).size,
      startedAt: now,
      finishedAt: now,
    };
    const report = analyze(output, { baselineLabel: BASELINE_LABEL, ...deps.analyzeOptions });
    const validation = report.comparisons.find((c) => c.label === CANDIDATE_LABEL);
    if (!validation) {
      throw new Error('paired-validator: candidate arm produced no comparable cells');
    }

    const candComposites = scored
      .filter((r) => r.condition === CANDIDATE_LABEL)
      .map((r) => r.qualityScore?.composite)
      .filter((v): v is number => v != null);
    const candidateQuality = candComposites.length ? mean(candComposites) : NaN;

    return { validation, heldout: null, candidateQuality };
  };
}
