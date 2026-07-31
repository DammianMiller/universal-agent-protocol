/**
 * `uap bench paired` — run the controlled UAP-on vs UAP-off benchmark.
 *
 * Holds the base model + agent constant and toggles the UAP scaffold over the
 * same real-gate task suite and seeds, then writes a paired report (deltas with
 * CIs, McNemar gate-value 2x2, optional per-component ablation, Pareto).
 */

import chalk from 'chalk';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  analyze,
  analyzeAblation,
  buildAblationConditions,
  claudeAdapter,
  loadSuite,
  makeBaselineCondition,
  makeFullCondition,
  MockAdapter,
  miniSweAdapter,
  opencodeAdapter,
  RawCompletionAdapter,
  renderAblationMarkdown,
  renderMarkdown,
  runPaired,
  tmpWorkRoot,
  type AgentAdapter,
  type Condition,
  type RunnerConfig,
  makeLazyCondition,
  DeliverCliAdapter,
} from '../benchmarks/paired/index.js';

export interface BenchPairedOptions {
  /** Add the uap-lazy condition (bare first attempt, UAP on gate failure). */
  lazy?: boolean;
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
    case 'mini':
    case 'mini-swe-agent':
      // Community-standard bash-only scaffold; external comparability anchor and
      // the most robust baseline for local Qwen (no structured tool-calls).
      return miniSweAdapter(model);
    case 'raw':
      // Non-agentic single-shot completion; gate loop when the 'gates' component
      // is active. Isolates UAP gate value vs a baseline that cannot self-verify.
      return new RawCompletionAdapter();
    case 'deliver':
      // The REAL convergence stack: cells run `uap deliver` itself, so the
      // treatment is the full machine (lazy attempt, critic, acceptance, ...).
      return new DeliverCliAdapter();
    default:
      throw new Error(
        `Unknown adapter '${name}' (expected: mock | opencode | claude | mini | raw | deliver)`
      );
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
  if (options.lazy && !options.ablation) conditions.push(makeLazyCondition());

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
  // Harness plan F: attach the ETCSOVG card. Harness variance dominates model
  // variance 7.8x (arXiv 2605.23950), so a paired report WITHOUT the harness it
  // ran under is not comparable to the next one — which is the whole point of
  // producing these numbers.
  const report = analyze(output, {
    seed,
    iterations,
    ropeMargin,
    harness: await currentHarnessCardInput(adapterName),
  });
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


/**
 * Describe the harness this process is about to benchmark with, for the
 * disclosure card. Reads the live knobs ONCE, here, rather than letting the card
 * builder reach into `process.env` at render time.
 */
async function describeMemoryModeSafe(): Promise<string> {
  try {
    const { describeMemoryMode } = await import('../memory/reconstruct-store.js');
    return describeMemoryMode(process.cwd());
  } catch {
    return 'semantic retrieval';
  }
}

function uapVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return String(JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')).version);
  } catch {
    return 'unknown';
  }
}

async function currentHarnessCardInput(adapter: string) {
  const { toolsFor, readWindowBytes, defaultMaxToolRounds, editToleranceEnabled } = await import(
    '../delivery/agentic-executor.js'
  );
  const allowBash =
    process.env.UAP_DELIVER_ALLOW_BASH === '1' || process.env.UAP_SANDBOX_ACTIVE === '1';
  // Only the `deliver` adapter drives UAP's own agentic executor; for any other
  // adapter the tool surface belongs to that agent, and claiming ours would be a
  // false disclosure.
  const ours = adapter === 'deliver';
  return {
    uapVersion: uapVersion(),
    tools: ours ? toolsFor(allowBash).map((t) => t.function.name) : undefined,
    allowBash: ours ? allowBash : undefined,
    sandboxed: process.env.UAP_SANDBOX_ACTIVE === '1',
    maxToolRounds: ours ? defaultMaxToolRounds() : undefined,
    readWindowBytes: ours ? readWindowBytes() : undefined,
    editStrategy: ours
      ? editToleranceEnabled()
        ? 'exact, then whitespace-tolerant, then nearest-region report'
        : 'exact only'
      : `external adapter (${adapter})`,
    // Derived, not hardcoded: a literal here made the bench card state the wrong
    // retrieval mode for the run — the exact failure the card exists to prevent.
    memoryMode: await describeMemoryModeSafe(),
    stubGuard: process.env.UAP_DELIVER_ALLOW_STUBS !== '1',
    guttingGuard: process.env.UAP_DELIVER_ALLOW_GUTTING !== '1',
    middleware:
      process.env.UAP_MW_TOOLCALL_PATH_NORMALIZER === '0' ? [] : ['toolcall-path-normalizer'],
    verification: ['build', 'test', 'runtime'],
  };
}
