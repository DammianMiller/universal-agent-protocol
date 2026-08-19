/**
 * `uap tune` / `uap self-harness tune` — the LLM self-tuning loop CLI.
 *
 * Drives the closed loop (propose → apply → validate → decide → learn) over a
 * real-gate task suite to raise a small model's composite quality toward Opus,
 * using the LLM tuner (when a judge is configured) or the GP-BO fallback. Writes
 * a versioned `TuningProfile` and, with `--apply`, commits the best config to
 * `.uap.json` / `.uap/proxy.env`.
 *
 * Runs fully offline with `--adapter mock` (deterministic), so the plumbing is
 * exercisable without a live model.
 */

import chalk from 'chalk';
import { join, resolve } from 'path';

import {
  loadSuite,
  makeFullCondition,
  runPaired,
  tmpWorkRoot,
  type RunnerConfig,
  type TaskSpec,
  type RunRecord,
} from '../benchmarks/paired/index.js';
import { pickTuningAdapter } from './tune-adapter.js';
import { resolveJudgeClient } from '../self-tuning/judge.js';
import { describeActiveFlagsList } from '../self-tuning/flags.js';
import { TuningProfileStore } from '../self-tuning/tuning-profile.js';
import { buildPairedTuningValidator } from '../self-tuning/paired-validator.js';
import { runTuningLoop } from '../self-tuning/run.js';
import type { SearchPhase } from '../self-tuning/search-reducer.js';
import type { QualityScoreInput } from '../self-tuning/quality-scorer.js';

export interface TuneOptions {
  model?: string;
  suite?: string;
  adapter?: string;
  epochs?: string;
  concurrency?: string;
  /** Bootstrap/permutation iterations for the paired stats. */
  iterations?: string;
  /** Max tuning-loop iterations. */
  maxIterations?: string;
  /** Judge/tuner model id (else read recipes.judge.model, else GP-only). */
  judge?: string;
  /** Force a single search phase instead of the coarse→…→combinatorial schedule. */
  phase?: string;
  /** Persist accepted configs to .uap.json / proxy.env + save the profile. */
  apply?: boolean;
  seed?: string;
  json?: boolean;
}

const DEFAULT_SUITE = 'benchmarks/suites/real-gate';
const PHASES: readonly SearchPhase[] = ['coarse', 'medium', 'fine', 'combinatorial'];

export async function tuneCommand(options: TuneOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const suiteDir = resolve(options.suite ?? DEFAULT_SUITE);
  const adapterName = options.adapter ?? 'mock';
  const model = options.model ?? process.env.UAP_BENCH_MODEL ?? 'qwen38-27b';
  const epochs = Math.max(1, parseInt(options.epochs ?? '5', 10));
  const concurrency = Math.max(1, parseInt(options.concurrency ?? '4', 10));
  const iterations = Math.max(1000, parseInt(options.iterations ?? '10000', 10));
  const maxIterations = Math.max(1, parseInt(options.maxIterations ?? '6', 10));
  const seed = parseInt(options.seed ?? '1', 10);
  const now = new Date().toISOString();

  let tasks: TaskSpec[];
  try {
    tasks = loadSuite(suiteDir);
  } catch (e) {
    console.error(chalk.red(`Failed to load suite: ${e instanceof Error ? e.message : e}`));
    process.exitCode = 2;
    return;
  }
  const instructionById = new Map(tasks.map((t) => [t.id, t.instruction]));

  const adapter = pickTuningAdapter(adapterName, model);
  const judge = await resolveJudgeClient({
    judgeModel: options.judge,
    cwd,
    requireExplicit: !options.judge, // no explicit + no config → GP-only
  });

  const log = options.json ? () => {} : (m: string) => process.stderr.write(chalk.dim(m) + '\n');
  if (!options.json) {
    console.error(
      chalk.bold(
        `\n🎛  UAP self-tuning — model=${model} adapter=${adapterName} judge=${judge?.id ?? '(GP-only)'} ` +
          `tasks=${tasks.length} epochs=${epochs} maxIter=${maxIterations}\n`,
      ),
    );
  }

  // One suite run under the currently-applied config (full-UAP condition).
  const runArm = async (label: string): Promise<RunRecord[]> => {
    const cfg: RunnerConfig = {
      tasks,
      conditions: [makeFullCondition()],
      adapter,
      model,
      epochs,
      concurrency,
      workRoot: tmpWorkRoot(),
    };
    const out = await runPaired(cfg, suiteDir, now);
    log(`    ${label}: ${out.records.length} records`);
    return out.records;
  };

  const scoreInput = (r: RunRecord): QualityScoreInput => ({
    taskInstruction: instructionById.get(r.taskId) ?? r.taskId,
    correct: r.metrics.correct,
    metrics: r.metrics,
  });

  const validate = buildPairedTuningValidator({
    cwd,
    runArm,
    scoreInput,
    judge,
    analyzeOptions: { seed, iterations },
    model,
    adapter: adapterName,
    now,
    log,
  });

  const store = new TuningProfileStore(join(cwd, '.uap', 'self-tuning'));
  const result = await runTuningLoop({
    model,
    validate,
    judge,
    // Resume from a stored profile if present; otherwise let the loop seed from
    // the bundled starter profile (qwen3.6) rather than bare defaults.
    startConfig: store.load(model)?.config,
    maxIterations,
    phaseSchedule: options.phase && PHASES.includes(options.phase as SearchPhase)
      ? [options.phase as SearchPhase]
      : [...PHASES],
    tuner: { seed },
    now,
    apply: !!options.apply,
    cwd,
    profileStore: store,
    log,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          model: result.model,
          finalQuality: result.finalQuality,
          accepted: result.accepted.length,
          iterations: result.iterations.length,
          committed: result.committed,
          stoppedBecause: result.stoppedBecause,
          finalConfig: result.finalConfig,
          history: result.profile.history,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  console.log(chalk.bold(`\n=== Tuning result: ${result.model} ===`));
  console.log(
    `Accepted ${chalk.green(String(result.accepted.length))}/${result.iterations.length} proposals · ` +
      `final quality ${chalk.cyan(result.finalQuality.toFixed(1))} · stopped: ${result.stoppedBecause}` +
      (result.committed ? chalk.green(' · committed to .uap.json / proxy.env') : chalk.dim(' · dry-run (pass --apply to commit)')),
  );
  console.log(chalk.bold('\nBest config (active flags):'));
  for (const line of describeActiveFlagsList(result.finalConfig)) console.log('  ' + line);
  if (result.accepted.length) {
    console.log(chalk.bold('\nAccepted steps:'));
    for (const it of result.accepted) {
      console.log(
        '  ' +
          chalk.green('✓') +
          ` [${it.proposal.source}] ${it.proposal.changes.map((c) => `${c.key}=${c.to}`).join(', ')}` +
          chalk.dim(`  (Δquality ${it.decision!.qualityDelta.toFixed(1)})`),
      );
    }
  }
  if (!result.committed) {
    console.log(chalk.dim(`\nProfile saved on --apply. Re-run with --apply to persist the tuned config.`));
  }
}
