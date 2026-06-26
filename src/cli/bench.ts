/**
 * `uap bench paired` — run the controlled UAP-on vs UAP-off benchmark.
 *
 * Holds the base model + agent constant and toggles the UAP scaffold over the
 * same real-gate task suite and seeds, then writes a paired report (deltas with
 * CIs, McNemar gate-value 2x2, optional per-component ablation, Pareto).
 */

import chalk from 'chalk';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

import {
  analyze,
  analyzeAblation,
  buildAblationConditions,
  claudeAdapter,
  loadSuite,
  makeBaselineCondition,
  makeFullCondition,
  MockAdapter,
  opencodeAdapter,
  RawCompletionAdapter,
  renderAblationMarkdown,
  renderMarkdown,
  runPaired,
  tmpWorkRoot,
  type AgentAdapter,
  type Condition,
  type RunnerConfig,
} from '../benchmarks/paired/index.js';

export interface BenchPairedOptions {
  suite?: string;
  adapter?: string;
  model?: string;
  epochs?: string;
  concurrency?: string;
  ablation?: boolean;
  out?: string;
  seed?: string;
  iterations?: string;
  ropeMargin?: string;
  json?: boolean;
}

const DEFAULT_SUITE = 'benchmarks/suites/real-gate';

function pickAdapter(name: string, model: string): AgentAdapter {
  switch (name) {
    case 'mock':
      return new MockAdapter();
    case 'opencode':
      return opencodeAdapter(model);
    case 'claude':
      return claudeAdapter(model);
    case 'raw':
      // Non-agentic single-shot completion; gate loop when the 'gates' component
      // is active. Isolates UAP gate value vs a baseline that cannot self-verify.
      return new RawCompletionAdapter();
    default:
      throw new Error(`Unknown adapter '${name}' (expected: mock | opencode | claude | raw)`);
  }
}

export async function benchPairedCommand(options: BenchPairedOptions = {}): Promise<void> {
  const suiteDir = resolve(options.suite ?? DEFAULT_SUITE);
  const adapterName = options.adapter ?? 'mock';
  const model = options.model ?? process.env.UAP_BENCH_MODEL ?? 'qwen35-a3b';
  const epochs = Math.max(1, parseInt(options.epochs ?? '5', 10));
  const concurrency = Math.max(1, parseInt(options.concurrency ?? '4', 10));
  const seed = parseInt(options.seed ?? '1', 10);
  const iterations = Math.max(1000, parseInt(options.iterations ?? '10000', 10));

  let tasks;
  try {
    tasks = loadSuite(suiteDir);
  } catch (e) {
    console.error(chalk.red(`Failed to load suite: ${e instanceof Error ? e.message : e}`));
    process.exit(2);
    return;
  }

  const conditions: Condition[] = options.ablation
    ? buildAblationConditions()
    : [makeBaselineCondition(), makeFullCondition()];

  const adapter = pickAdapter(adapterName, model);
  const workRoot = tmpWorkRoot();

  const cfg: RunnerConfig = {
    tasks,
    conditions,
    adapter,
    model,
    epochs,
    concurrency,
    workRoot,
    onProgress: options.json
      ? undefined
      : (done, total, label) => {
          process.stderr.write(`\r${chalk.dim(`[${done}/${total}] ${label}`.padEnd(60))}`);
        },
  };

  if (!options.json) {
    console.error(
      chalk.bold(
        `\n🧪 UAP paired benchmark — adapter=${adapterName} model=${model} ` +
          `tasks=${tasks.length} epochs=${epochs} conditions=${conditions.length}\n`
      )
    );
  }

  const startedAt = new Date().toISOString();
  const output = await runPaired(cfg, suiteDir, startedAt);
  if (!options.json) process.stderr.write('\n');

  const ropeMargin = options.ropeMargin ? parseFloat(options.ropeMargin) : 0;
  const report = analyze(output, { seed, iterations, ropeMargin });
  const ablation = options.ablation ? analyzeAblation(output, { seed, iterations }) : null;

  // Persist artifacts (raw records for audit, JSON + Markdown reports).
  const outDir = resolve(options.out ?? join('benchmark-results', `paired-${stamp(startedAt)}`));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'records.jsonl'),
    output.records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8'
  );
  writeFileSync(
    join(outDir, 'report.json'),
    JSON.stringify({ report, ablation }, null, 2),
    'utf-8'
  );
  let md = renderMarkdown(report);
  if (ablation) md += '\n' + renderAblationMarkdown(ablation);
  writeFileSync(join(outDir, 'report.md'), md, 'utf-8');

  if (options.json) {
    process.stdout.write(JSON.stringify({ report, ablation, outDir }, null, 2) + '\n');
    return;
  }

  console.log(md);
  console.log(chalk.dim(`\nArtifacts written to ${outDir}`));
}

function stamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}
