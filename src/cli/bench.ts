/**
 * `uap bench paired` — run the controlled UAP-on vs UAP-off benchmark.
 *
 * Holds the base model + agent constant and toggles the UAP scaffold over the
 * same real-gate task suite and seeds, then writes a paired report (deltas with
 * CIs, McNemar gate-value 2x2, optional per-component ablation, Pareto).
 */

import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getMaxModelConcurrency } from '../utils/model-slots.js';

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
  /** Exit 0 even when the run could not measure anything (CI / exploratory use). */
  allowNoSignal?: boolean;
  /** Override the ±effect the run must be able to resolve (default 0.25). */
  minDetectableEffect?: string;
}

/**
 * Distinct from the `2` used for "failed to load suite" — a caller must be able
 * to tell "the suite is missing" from "the run completed but measured nothing".
 */
const NO_SIGNAL_EXIT = 3;

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
  // Default to the inference backend's slot budget rather than a fixed 4: every
  // cell is a model call, so a fixed number either queues cells behind each
  // other or leaves the machine idle. An explicit --concurrency still wins.
  const explicitConcurrency = options.concurrency ? parseInt(options.concurrency, 10) : NaN;
  const concurrency = Number.isFinite(explicitConcurrency)
    ? Math.max(1, explicitConcurrency)
    : await defaultBenchConcurrency(adapterName);
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
  const mde = options.minDetectableEffect ? parseFloat(options.minDetectableEffect) : undefined;
  const report = analyze(output, {
    seed,
    iterations,
    ropeMargin,
    harness: await currentHarnessCardInput(adapterName),
    discrimination: Number.isFinite(mde) ? { minDetectableEffect: mde } : undefined,
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

  // Set BEFORE the --json return: the programmatic caller is the one most
  // likely to be automated, and it was the only one getting exit 0 on a run
  // that measured nothing.
  if (!report.discrimination.usable && !options.allowNoSignal) {
    process.exitCode = NO_SIGNAL_EXIT;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({ report, ablation, outDir }, null, 2) + '\n');
    return;
  }

  console.log(md);
  console.log(chalk.dim(`\nArtifacts written to ${outDir}`));

  // A run that could not measure anything must not exit 0 with a tidy report —
  // that is how three consecutive no-signal runs got read as null results. Name
  // the problem, name a suite that would fix it, and fail the command.
  if (!report.discrimination.usable) {
    console.log('');
    const what = report.discrimination.efficiencyUsable
      ? 'No correctness signal'
      : 'No usable signal';
    console.log(chalk.yellow(`⚠️  ${what} (${report.discrimination.status}).`));
    console.log(chalk.yellow(`   ${report.discrimination.reason}`));
    if (report.discrimination.status === 'ceiling') {
      const harder = harderSuitesThan(suiteDir);
      if (harder.length) {
        console.log(chalk.dim(`   Try a harder suite: ${harder.map((h) => `--suite ${h}`).join('  |  ')}`));
      }
    }
    if (report.discrimination.status === 'underpowered') {
      // "Underpowered" is a WIDTH problem, not a difficulty problem — a harder
      // suite would only widen the interval further. Point at the wide suite,
      // and at the epoch count, which is the other lever on n.
      const wide = resolve('benchmarks/suites/real-gate-power');
      if (existsSync(wide) && resolve(suiteDir) !== wide) {
        console.log(
          chalk.dim('   This is too few paired cells, not too easy — a harder suite would not help.')
        );
        console.log(
          chalk.dim('   Widen instead: --suite benchmarks/suites/real-gate-power (15 tasks; 6 epochs ~= +/-0.15)')
        );
      } else {
        console.log(chalk.dim('   Raise --epochs to add paired cells; the interval narrows as 1/sqrt(n).'));
      }
    }
    if (report.discrimination.status === 'floor') {
      console.log(
        chalk.dim('   Check the adapter matches the suite — a mock-only suite (verifyCmd `test -f MOCK_SOLVED`)')
      );
      console.log(chalk.dim('   scores 0% against every real model, which looks identical to "too hard".'));
    }
    if (report.discrimination.efficiencyUsable) {
      console.log(chalk.dim('   Efficiency deltas (tokens/turns/latency) remain valid.'));
    }
    if (options.allowNoSignal) {
      console.log(chalk.dim('   --allow-no-signal set: exiting 0 anyway.'));
    }
  }
}

/** Sibling suites ranked harder than the one just run, if they exist on disk. */
function harderSuitesThan(suiteDir: string): string[] {
  // Ordered easiest -> hardest by construction of the suite set.
  const ladder = [
    'benchmarks/suites/real-gate',
    'benchmarks/suites/real-gate-medium',
    'benchmarks/suites/real-gate-hard',
    'benchmarks/suites/real-gate-brutal',
  ];
  const at = ladder.findIndex((s) => resolve(s) === resolve(suiteDir));
  if (at === -1) return [];
  return ladder.slice(at + 1).filter((s) => existsSync(resolve(s)));
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

/**
 * Cells per wave.
 *
 * Adapters that drive OUR backend (`raw`, `deliver`) are sized by its slot
 * budget. Adapters that shell out to another agent (`claude`, `opencode`,
 * `mini`) hit that vendor's rate limits, not our slots, so they keep the
 * conservative fixed default — sizing them by our budget is simply the wrong
 * resource.
 *
 * The probe MUST be warmed: `getMaxModelConcurrency` is synchronous and returns
 * DEFAULT_SLOTS (2) on a cold cache, so calling it bare in a fresh CLI process
 * silently HALVED bench concurrency from 4 to 2 — a throughput change in the
 * wrong direction, dressed as an optimisation.
 */
async function defaultBenchConcurrency(adapterName: string): Promise<number> {
  const OURS = new Set(['raw', 'deliver', 'mock']);
  if (!OURS.has(adapterName)) return 4;
  try {
    const { warmModelSlotBudget } = await import('../utils/model-slots.js');
    await warmModelSlotBudget(process.cwd());
    const n = getMaxModelConcurrency(process.cwd());
    return Number.isFinite(n) && n > 0 ? n : 4;
  } catch {
    return 4;
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
  const { rawMaxTokens } = await import('../benchmarks/paired/adapter.js');
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
    // NOT gated on `ours`: the completion budget is sent by the `raw` adapter
    // too, and `raw` is precisely where a 4096 ceiling silently truncated 8/15
    // first turns mid-reasoning and pinned both arms toward the floor. Gating
    // this on the deliver adapter would have left it `unset` in the exact
    // report where it mattered — which is what the first version of this change
    // did, disclosing it only in `uap harness` and not in any bench run.
    completionTokenBudget: adapter === 'raw' ? rawMaxTokens() : undefined,
    stubGuard: process.env.UAP_DELIVER_ALLOW_STUBS !== '1',
    guttingGuard: process.env.UAP_DELIVER_ALLOW_GUTTING !== '1',
    middleware:
      process.env.UAP_MW_TOOLCALL_PATH_NORMALIZER === '0' ? [] : ['toolcall-path-normalizer'],
    verification: ['build', 'test', 'runtime'],
  };
}
