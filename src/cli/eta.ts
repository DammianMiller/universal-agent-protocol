/**
 * `uap eta` — the operator's window into the agent's own measured pace
 * (bridge P5: S1b "ETA surfaces").
 *
 * Prints the EWMA estimate for one (model, taskType, complexity) key — or,
 * with `--all`, every key that has history. The estimate is built ONLY from
 * this project's own recorded attempts (S1a), and it never hides the
 * sample count, the spread, or the failure rate: a number without its
 * provenance is exactly the kind of confident guess this feature exists
 * to replace.
 */

import chalk from 'chalk';
import { resolveActiveModel } from '../delivery/handsfree-config.js';
import {
  estimatePace,
  formatDurationMs,
  listPaceKeys,
  type EtaEstimate,
} from '../delivery/eta-estimate.js';
import { parsePositiveInt } from './diff.js';
import { termSafe } from '../utils/terminal-safe.js';

export interface EtaOptions {
  /** Model id (default: the active/executor model). */
  model?: string;
  /** Sample key: task type (default 'orchestrated'). */
  taskType?: string;
  /** Sample key: complexity tier (default 'medium'). */
  complexity?: string;
  /** List every key with history instead of one key. */
  all?: boolean;
  /** Sample window / half-life overrides. */
  limit?: string;
  halfLife?: string;
  /** Test/odd-layout seam: pin the analytics DB path. */
  db?: string;
  json?: boolean;
}

/** Render one estimate as a single operator-scannable line. */
export function renderEtaLine(
  key: { modelId: string; taskType: string; complexity: string },
  est: EtaEstimate
): string {
  const thin = est.confidence === 'thin' ? chalk.yellow(' [thin data]') : '';
  const spread = chalk.dim(` (spread ${formatDurationMs(est.minMs)}–${formatDurationMs(est.maxMs)})`);
  const failures =
    est.successRate < 1
      ? chalk.yellow(
          ` · ${(100 * (1 - est.successRate)).toFixed(0)}% of attempts fail → expect ~${est.attemptsPerSuccess.toFixed(1)}x wall time`
        )
      : '';
  return (
    `${chalk.cyan(termSafe(key.modelId))} ${chalk.dim(`${termSafe(key.taskType)}/${termSafe(key.complexity)}`)}: ` +
    chalk.bold(`~${formatDurationMs(est.etaMs)}`) +
    ` per successful task, ~${est.etaTurns.toFixed(1)} turns` +
    ` ${chalk.dim(`(EWMA n=${est.samples}/${est.observed} attempts, half-life ${est.halfLifeSamples})`)}${spread}${failures}${thin}`
  );
}

export async function etaCommand(options: EtaOptions = {}): Promise<void> {
  const cwd = process.cwd();
  // NaN must never reach the fold: `Math.max(1, parseInt('abc'))` is NaN and
  // a NaN half-life would print a confident-looking garbage line. Loud refusal.
  const halfLifeRaw = parsePositiveInt(options.halfLife);
  if (options.halfLife !== undefined && halfLifeRaw === null) {
    console.error(chalk.red(`--half-life must be a positive integer (got '${options.halfLife}')`));
    process.exitCode = 1;
    return;
  }
  const halfLife: number | undefined = halfLifeRaw ?? undefined;
  const limitRaw = parsePositiveInt(options.limit);
  if (options.limit !== undefined && limitRaw === null) {
    console.error(chalk.red(`--limit must be a positive integer (got '${options.limit}')`));
    process.exitCode = 1;
    return;
  }
  const limit: number | undefined = limitRaw ?? undefined;

  if (options.all) {
    // Enumerate every key with history in ONE store open; show the estimates
    // and the keys whose history is still too thin to estimate (so the
    // operator knows WHY a key they expect is missing, and what would fill
    // it). --json stays PURE JSON (guidance text is gated to the human path).
    const { keys, estimates, truncated } = listPaceKeys({
      dbPath: options.db,
      limit,
      halfLifeSamples: halfLife,
    });
    if (keys.length === 0) {
      if (options.json) {
        console.log(JSON.stringify({ keys: [], estimates: [], truncated: false }, null, 2));
        return;
      }
      console.log(chalk.dim('No recorded attempts yet — run an orchestrated mission; the estimator needs'));
      console.log(chalk.dim('at least 3 successful attempts per (model, taskType, complexity) key.'));
      return;
    }
    if (options.json) {
      console.log(
        JSON.stringify(
          { keys, estimates: estimates.filter((e) => e.estimate).map((e) => ({ key: e.key, ...e.estimate })), truncated },
          null,
          2
        )
      );
      return;
    }
    console.log(chalk.bold('Measured pace — this project\'s own recorded attempts (EWMA):'));
    for (const e of estimates) {
      if (e.estimate) {
        console.log('  ' + renderEtaLine(e.key, e.estimate));
      } else {
        console.log(
          `  ${chalk.cyan(termSafe(e.key.modelId))} ${chalk.dim(`${termSafe(e.key.taskType)}/${termSafe(e.key.complexity)}`)}: ` +
            chalk.dim('— too few successful attempts to estimate (needs ≥3)')
        );
      }
    }
    if (truncated) console.log(chalk.dim('  … and more keys beyond the first 50 (oldest-activity keys elided)'));
    return;
  }

  const modelId = options.model || resolveActiveModel(cwd);
  const taskType = options.taskType || 'orchestrated';
  const complexity = options.complexity || 'medium';
  const key = { modelId, taskType, complexity };
  const est = estimatePace({ modelId, taskType, complexity, limit, halfLifeSamples: halfLife, dbPath: options.db });
  if (options.json) {
    console.log(JSON.stringify({ key, estimate: est }, null, 2));
    return;
  }
  if (!est) {
    console.log(
      chalk.dim(
        `No estimate for ${termSafe(modelId)} ${termSafe(taskType)}/${termSafe(complexity)}: fewer than 3 successful attempts recorded.`
      )
    );
    console.log(
      chalk.dim('  `uap eta --all` lists every key with history; the estimator will not guess from thin data.')
    );
    return;
  }
  console.log(chalk.bold('Measured pace — this project\'s own recorded attempts (EWMA):'));
  console.log('  ' + renderEtaLine(key, est));
  console.log(chalk.dim(`  newest sample: ${termSafe(est.lastSampleAt)}`));
}
