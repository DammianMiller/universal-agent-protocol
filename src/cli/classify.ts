/**
 * `uap classify` — the System-1 classifier surface (uplift §6).
 *
 *   uap classify "<state text>"                     # all built-in questions
 *   uap classify "<state>" --question escalation-risk
 *   uap classify "<state>" --shadow                 # also append to the shadow log
 *   uap classify --bench [n]                        # latency check (p95 budget: 50ms)
 *   uap classify "<state>" --json
 *
 * Shadow mode is the promotion path: classifier assesses, heuristics decide,
 * divergence logged; a trained head is promoted only after measured agreement
 * on the shadow data. Advisory — always exit 0 unless usage is wrong.
 */

import chalk from 'chalk';
import { performance } from 'perf_hooks';
import {
  assessWithThresholds,
  defaultBackend,
  loadThresholds,
  recordShadow,
  BUILTIN_QUESTIONS,
  ClassifyError,
  type Question,
} from '../classify/index.js';

const P95_BUDGET_MS = 50;

export interface ClassifyOptions {
  projectDir: string;
  state?: string;
  question?: string;
  json?: boolean;
  shadow?: boolean;
  bench?: number;
  thresholds?: string;
}

function pickQuestions(name?: string): Question[] {
  if (!name) return BUILTIN_QUESTIONS;
  const q = BUILTIN_QUESTIONS.find((x) => x.name === name);
  if (!q) {
    const known = BUILTIN_QUESTIONS.map((x) => x.name).join(', ');
    throw new ClassifyError(`unknown question "${name}" — built-ins: ${known}`);
  }
  return [q];
}

export async function classifyCommand(options: ClassifyOptions): Promise<void> {
  if (options.bench !== undefined) {
    // Latency self-check needs no threshold config — don't fail on one.
    const n = Number.isFinite(options.bench) && options.bench > 0 ? Math.min(options.bench, 100_000) : 200;
    runBench(n, options.json);
    return;
  }

  const thresholds = loadThresholds(options.projectDir, options.thresholds);

  if (!options.state) {
    throw new ClassifyError('state text is required (or use --bench)');
  }
  const questions = pickQuestions(options.question);
  const backend = defaultBackend();
  const t0 = performance.now();
  const decided = assessWithThresholds(options.state, questions, thresholds, backend);
  const ms = performance.now() - t0;

  if (options.shadow) {
    // Shadow logs the raw backend result (pre-threshold) — calibration needs
    // probabilities, not decisions.
    recordShadow(options.projectDir, options.state, questions, backend.assess(options.state, questions));
  }

  if (options.json) {
    console.log(JSON.stringify({ reportVersion: 1, backend: backend.name, ms: round(ms), assessments: decided }, null, 2));
    return;
  }

  console.log(chalk.bold(`classify (${backend.name}, ${round(ms)}ms)`));
  for (const d of decided) {
    const defer = d.defer ? chalk.yellow(' [defer: below confidence floor — heuristic decides]') : '';
    console.log(
      `  ${d.name}: ${chalk.cyan(String(d.value))}  p=${d.probability.toFixed(3)} conf=${d.confidence.toFixed(3)}${defer}`,
    );
  }
  if (options.shadow) {
    console.log(chalk.dim('  shadow-logged to .uap/classify-shadow.jsonl'));
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Latency self-check: the §6 budget is <50ms p95 per assessment batch. */
function runBench(iterations: number, json?: boolean): void {
  const backend = defaultBackend();
  const sample =
    'The deliver mission failed with SIGABRT after the KV cache exceeded the VBR ' +
    'budget; the service is stuck restarting and the gate is blocked on missing evidence.';
  const lat: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    backend.assess(sample, BUILTIN_QUESTIONS);
    lat.push(performance.now() - t0);
  }
  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length * 0.5)];
  const p95 = lat[Math.floor(lat.length * 0.95)];
  const p99 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.99))];
  const ok = p95 < P95_BUDGET_MS;
  if (json) {
    console.log(JSON.stringify({
      reportVersion: 1,
      bench: { n: iterations, p50: round(p50), p95: round(p95), p99: round(p99), budgetMs: P95_BUDGET_MS, pass: ok },
    }));
  } else {
    console.log(
      `classify bench n=${iterations}: p50=${round(p50)}ms p95=${round(p95)}ms p99=${round(p99)}ms ` +
        `(budget p95<${P95_BUDGET_MS}ms) — ${ok ? 'PASS' : 'FAIL'}`,
    );
  }
  if (!ok) process.exitCode = 1;
}
