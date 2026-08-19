/**
 * `uap self-harness` — CLI for the self-improving harness (arXiv:2606.09498).
 *
 * `analyze` — read-only weakness mining + heuristic Mod proposal from a paired
 *             bench `records.jsonl` (mine + propose, no apply).
 * `run`     — the autonomous closed loop: mine -> propose -> validate (real paired
 *             bench per Mod) -> decide -> (with --apply) commit + versioned
 *             snapshot. Dry-run by default (touches nothing).
 * `transfer`/`mine-prod`/`pending`/`prune` — cross-model store + online gate (P3).
 */

import { readFileSync, existsSync, copyFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import type { RunRecord } from '../benchmarks/paired/types.js';
import {
  MockAdapter,
  opencodeAdapter,
  claudeAdapter,
  RawCompletionAdapter,
  DeliverCliAdapter,
  type AgentAdapter,
} from '../benchmarks/paired/index.js';
import { mineFromRecords } from '../self-harness/mine.js';
import { heuristicProposer } from '../self-harness/propose.js';
import { describeMod } from '../self-harness/mods.js';
import {
  profileFromEnvFile,
  emptyProfile,
  type HarnessProfile,
} from '../self-harness/profile.js';
import { buildValidator } from '../self-harness/validate.js';
import { runSelfHarnessLoop } from '../self-harness/run.js';
import {
  JsonTransferStore,
  makeTransferProposer,
  describeEntry,
} from '../self-harness/transfer.js';
import type { Proposer } from '../self-harness/propose.js';

export interface SelfHarnessOptions {
  records?: string;
  env?: string;
  json?: boolean;
  /** Path to a JSON transfer store to seed proposals from (cross-model, P3). */
  transfer?: string;
  /** HALO traces.jsonl to mine (mine-prod). */
  traces?: string;
  /** Proxy journal unit to mine, e.g. uap-anthropic-proxy.service (mine-prod). */
  unit?: string;
  /** journalctl --since window for proxy-log mining (mine-prod). */
  since?: string;
  /** Model family stamp for online mining. */
  model?: string;
  pending?: string;
  // --- run ---
  suite?: string;
  heldout?: string;
  adapter?: string;
  epochs?: string;
  concurrency?: string;
  maxCandidates?: string;
  apply?: boolean;
  restartCmd?: string;
  snapshot?: string;
  history?: string;
  seed?: string;
}

const DEFAULT_TRANSFER = join(homedir(), '.uap', 'self-harness', 'transfer.json');
const DEFAULT_PENDING = join(homedir(), '.uap', 'self-harness', 'pending.json');
const DEFAULT_HALO = join(homedir(), '.uap', 'halo', 'traces.jsonl');
const DEFAULT_SNAPSHOT = join(homedir(), '.uap', 'self-harness', 'profile.json');
const DEFAULT_HISTORY = join(homedir(), '.uap', 'self-harness', 'history.jsonl');

function loadRecords(path: string): { records: RunRecord[]; model: string } {
  let file = path;
  if (existsSync(path) && !path.endsWith('.jsonl')) file = join(path, 'records.jsonl');
  if (!existsSync(file)) throw new Error(`records not found: ${file}`);
  const records: RunRecord[] = [];
  let model = 'unknown';
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.model) model = r.model;
    records.push(r as RunRecord);
  }
  return { records, model };
}

const DEFAULT_ENV = join(homedir(), '.config', 'uap', 'llama-server.env');

function pickAdapter(name: string, model: string): AgentAdapter {
  switch (name) {
    case 'mock':
      return new MockAdapter();
    case 'opencode':
      return opencodeAdapter(model);
    case 'claude':
      return claudeAdapter(model);
    case 'raw':
      return new RawCompletionAdapter();
    case 'deliver':
      return new DeliverCliAdapter();
    default:
      throw new Error(`Unknown adapter '${name}' (expected: mock | opencode | claude | raw | deliver)`);
  }
}

export async function selfHarnessAnalyze(options: SelfHarnessOptions = {}): Promise<void> {
  if (!options.records) {
    console.error('Error: --records <dir|records.jsonl> is required.');
    process.exitCode = 1;
    return;
  }
  const { records, model } = loadRecords(options.records);
  const weaknesses = mineFromRecords(records, { model });

  const envPath = options.env || DEFAULT_ENV;
  const profile: HarnessProfile = existsSync(envPath) ? profileFromEnvFile(envPath) : emptyProfile();

  // Seed proposals from the cross-model transfer store when available (P3).
  const transferPath = options.transfer || DEFAULT_TRANSFER;
  let proposer: Proposer = heuristicProposer;
  let transferActive = false;
  if (existsSync(transferPath)) {
    proposer = makeTransferProposer(new JsonTransferStore(transferPath), heuristicProposer);
    transferActive = true;
  }
  const proposed = proposer.propose(weaknesses, profile);

  if (options.json) {
    console.log(JSON.stringify({ model, runs: records.length, weaknesses, proposed }, null, 2));
    return;
  }

  console.log(chalk.bold(`\nSelf-Harness — weakness analysis`));
  console.log(chalk.dim(`  model=${model}  runs=${records.length}  profile=${existsSync(envPath) ? envPath : '(none)'}`));
  console.log(chalk.bold('\nWeaknesses (ranked by frequency × impact):'));
  if (weaknesses.length === 0) {
    console.log('  no failures mined — nothing to propose.');
    return;
  }
  for (const w of weaknesses) {
    console.log(
      `  ${chalk.yellow(w.kind.padEnd(24))} ×${w.frequency}  ${w.affectedTasks.length} task(s)  ${chalk.dim('sig=' + w.signature)}`,
    );
    console.log(`    ${chalk.dim(w.hypothesis)}`);
  }

  console.log(
    chalk.bold(`\nProposed Mods (${proposer.id}, minimal):`) +
      (transferActive ? chalk.dim(`  [transfer store: ${transferPath}]`) : ''),
  );
  if (proposed.length === 0) {
    console.log(chalk.dim('  (none — no current profile value to scale, or no mapped heuristic)'));
  } else {
    for (const m of proposed) console.log(`  • ${describeMod(m)}`);
  }
  console.log(
    chalk.dim(
      `\n  analyze is read-only (mine+propose). The validate+apply loop is \`uap self-harness run\`.`,
    ),
  );
}

/**
 * The autonomous closed loop. Mines a baseline records set, proposes bounded
 * Mods, validates EACH against a real paired bench (baseline arm vs candidate
 * arm with the env physically toggled + server restarted), and — only with
 * --apply — commits the accepted env Mods + writes a versioned profile snapshot.
 * Dry-run by default: runs against a throwaway env copy with a no-op restart and
 * persists nothing.
 */
export async function selfHarnessRun(options: SelfHarnessOptions = {}): Promise<void> {
  if (!options.records) {
    console.error('Error: --records <dir|records.jsonl> is required (baseline to mine).');
    process.exitCode = 1;
    return;
  }
  if (!options.suite) {
    console.error('Error: --suite <dir> is required (validation task suite).');
    process.exitCode = 1;
    return;
  }
  const apply = !!options.apply;
  const { records, model: recModel } = loadRecords(options.records);
  const model = options.model || recModel;
  const realEnv = options.env || DEFAULT_ENV;
  const profile: HarnessProfile = existsSync(realEnv) ? profileFromEnvFile(realEnv) : emptyProfile();

  const adapterName = options.adapter || 'mock';
  const adapter = pickAdapter(adapterName, model);
  const epochs = Math.max(1, parseInt(options.epochs || '5', 10));
  const concurrency = Math.max(1, parseInt(options.concurrency || '4', 10));
  const maxCandidates = Math.max(1, parseInt(options.maxCandidates || '3', 10));
  const seed = parseInt(options.seed || '1', 10);

  // On a dry-run, isolate all env mutation to a throwaway copy so the real env
  // file is never touched and no server is restarted.
  let envPath = realEnv;
  let restart = async (): Promise<void> => {};
  if (!apply) {
    const tmp = join(mkdtempSync(join(tmpdir(), 'sh-dryrun-')), 'llama-server.env');
    if (existsSync(realEnv)) copyFileSync(realEnv, tmp);
    envPath = tmp;
  } else if (options.restartCmd) {
    const cmd = options.restartCmd;
    restart = async () => {
      const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf-8' });
      if (r.status !== 0) throw new Error(`restart failed (exit ${r.status}): ${r.stderr || r.stdout}`);
    };
  }

  const log = options.json ? () => {} : (m: string) => console.error(chalk.dim(m));
  const validate = buildValidator({
    suiteDir: options.suite,
    heldoutDir: options.heldout || null,
    envPath,
    restart,
    adapter,
    model,
    epochs,
    concurrency,
    analyzeOpts: { seed },
    log,
  });

  // Seed proposals from the transfer store when present (cross-model priors).
  const transferPath = options.transfer || DEFAULT_TRANSFER;
  const store = existsSync(transferPath) ? new JsonTransferStore(transferPath) : undefined;
  const proposer: Proposer = store ? makeTransferProposer(store, heuristicProposer) : heuristicProposer;

  if (!options.json) {
    console.error(
      chalk.bold(`\nSelf-Harness run — model=${model} adapter=${adapterName} ${apply ? chalk.green('[APPLY]') : chalk.yellow('[dry-run]')}`),
    );
    console.error(chalk.dim(`  suite=${options.suite}${options.heldout ? `  held-out=${options.heldout}` : ''}  epochs=${epochs}  maxCandidates=${maxCandidates}`));
  }

  const result = await runSelfHarnessLoop({
    model,
    records,
    profile,
    validate,
    proposer,
    maxCandidates,
    decision: {},
    transferStore: store,
    log,
    now: new Date().toISOString(),
    apply,
    envPath: realEnv,
    snapshotPath: options.snapshot || DEFAULT_SNAPSHOT,
    historyPath: options.history || DEFAULT_HISTORY,
    restart,
    provenance: `self-harness run (${adapterName}/${model})`,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          model,
          apply,
          weaknesses: result.iteration.weaknesses,
          proposed: result.iteration.proposed.map(describeMod),
          outcomes: result.iteration.outcomes.map((o) => ({ mod: describeMod(o.mod), verdict: o.decision.verdict, reason: o.decision.reason })),
          committed: result.committed.map(describeMod),
          persisted: result.persisted,
          snapshot: result.snapshot,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(chalk.bold(`\nOutcomes:`));
  for (const o of result.iteration.outcomes) {
    const tag = o.accepted ? chalk.green('ACCEPT') : chalk.red('reject');
    console.log(`  ${tag}  ${describeMod(o.mod)}  ${chalk.dim(o.decision.reason)}`);
  }
  if (result.iteration.outcomes.length === 0) {
    console.log(chalk.dim('  no candidate Mods (no mined weakness mapped to an env knob).'));
  }
  if (result.persisted && result.snapshot) {
    console.log(chalk.green(`\n✓ committed ${result.committed.length} Mod(s) → profile snapshot v${result.snapshot.version}`));
    console.log(chalk.dim(`  revert: restore the prior env value + restart, or roll back the snapshot file.`));
  } else if (apply) {
    console.log(chalk.dim('\n  nothing accepted — profile unchanged.'));
  } else {
    console.log(chalk.yellow('\n  dry-run: nothing applied. Re-run with --apply to commit accepted Mods.'));
  }
}

export async function selfHarnessTransfer(options: SelfHarnessOptions = {}): Promise<void> {
  const path = options.transfer || DEFAULT_TRANSFER;
  if (!existsSync(path)) {
    console.log(`No transfer store at ${path} yet (it fills as self-harness accepts Mods).`);
    return;
  }
  const store = new JsonTransferStore(path);
  const all = store.all();
  if (options.json) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  console.log(chalk.bold(`\nSelf-Harness transfer store — ${all.length} entr(y/ies)`));
  console.log(chalk.dim(`  ${path}`));
  for (const e of all) console.log(`  ${e.accepted ? chalk.green('✓') : chalk.red('✗')} ${describeEntry(e)}`);
}

/**
 * Online mining from production traces -> propose -> ENQUEUE for gated
 * validation. Never applies anything; prod-mined proposals always go through the
 * pending queue + a human/auto gate.
 */
export async function selfHarnessMineProd(options: SelfHarnessOptions = {}): Promise<void> {
  const { mineFromHaloSpans, mineFromProxyLogLines } = await import('../self-harness/trace-mine.js');
  const { PendingQueue } = await import('../self-harness/pending.js');
  const model = options.model || 'qwen3.8-27b';
  const weaknesses: import('../self-harness/weakness.js').WeaknessReport[] = [];

  // Source 1: HALO spans (deliver pipeline).
  const tracePath = options.traces || DEFAULT_HALO;
  if (existsSync(tracePath)) {
    const spans = readFileSync(tracePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    weaknesses.push(...mineFromHaloSpans(spans, { model }));
  }
  // Source 2: proxy journal (claude-local proxy path) — where path-garbling shows.
  if (options.unit) {
    const since = options.since || '24 hours ago';
    const out = spawnSync('journalctl', ['--user', '-u', options.unit, '--since', since, '--no-pager', '-o', 'cat'], { encoding: 'utf-8' });
    if (out.stdout) weaknesses.push(...mineFromProxyLogLines(out.stdout.split('\n'), { model }));
  }

  // Propose (seeded from transfer when present) and ENQUEUE — no apply.
  const transferPath = options.transfer || DEFAULT_TRANSFER;
  let proposer: Proposer = heuristicProposer;
  if (existsSync(transferPath)) proposer = makeTransferProposer(new JsonTransferStore(transferPath), heuristicProposer);
  const queue = new PendingQueue(options.pending || DEFAULT_PENDING);

  const proposed = proposer.propose(weaknesses, emptyProfile());
  let enqueued = 0;
  const now = new Date().toISOString();
  for (const w of weaknesses) {
    for (const mod of proposer.propose([w], emptyProfile())) {
      queue.enqueue({
        id: `${w.signature}:${JSON.stringify(mod).length}:${enqueued}`,
        signature: w.signature, kind: w.kind, model, mod,
        source: options.unit ? 'proxy-log+halo' : 'halo',
        frequency: w.frequency, createdAt: now,
      });
      enqueued += 1;
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ model, weaknesses, proposed, enqueued }, null, 2));
    return;
  }
  console.log(chalk.bold(`\nSelf-Harness — online prod mining (model=${model})`));
  console.log(`  mined ${weaknesses.length} weakness(es): ${weaknesses.map((w) => `${w.kind}×${w.frequency}`).join(', ') || '(none)'}`);
  console.log(`  enqueued ${enqueued} proposal(s) → ${options.pending || DEFAULT_PENDING}`);
  console.log(chalk.dim('  NOTHING applied. Review with `uap self-harness pending`; promotion needs validation + gate.'));
}

export async function selfHarnessPending(options: SelfHarnessOptions = {}): Promise<void> {
  const { PendingQueue } = await import('../self-harness/pending.js');
  const path = options.pending || DEFAULT_PENDING;
  if (!existsSync(path)) {
    console.log(`No pending queue at ${path} (run \`uap self-harness mine-prod\` first).`);
    return;
  }
  const { describeMod } = await import('../self-harness/mods.js');
  const items = new PendingQueue(path).list();
  if (options.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  console.log(chalk.bold(`\nSelf-Harness pending proposals — ${items.length}`));
  console.log(chalk.dim(`  ${path}`));
  for (const it of items) {
    const gate = it.gate === 'human' ? chalk.yellow('[human-gate]') : chalk.cyan('[auto-after-validation]');
    console.log(`  ${it.status === 'pending' ? '○' : '●'} ${gate} [${it.kind}×${it.frequency}] ${describeMod(it.mod)} ${chalk.dim('(' + it.source + ')')}`);
  }
}

/** Ablation-prune stale / no-longer-paying-off transfer + pending entries. */
export async function selfHarnessPrune(options: SelfHarnessOptions = {}): Promise<void> {
  const { JsonTransferStore } = await import('../self-harness/transfer.js');
  const { PendingQueue } = await import('../self-harness/pending.js');
  const txPath = options.transfer || DEFAULT_TRANSFER;
  const pqPath = options.pending || DEFAULT_PENDING;
  let txRemoved = 0;
  let txKept = 0;
  if (existsSync(txPath)) {
    const r = new JsonTransferStore(txPath).prune();
    txRemoved = r.removed.length;
    txKept = r.kept;
  }
  const pqRemoved = existsSync(pqPath) ? new PendingQueue(pqPath).prune().length : 0;
  if (options.json) {
    console.log(JSON.stringify({ transfer: { removed: txRemoved, kept: txKept }, pending: { removed: pqRemoved } }, null, 2));
    return;
  }
  console.log(chalk.bold('\nSelf-Harness — ablation prune'));
  console.log(`  transfer store: removed ${txRemoved} stale/no-longer-paying entr(y/ies), ${txKept} kept`);
  console.log(`  pending queue:  removed ${pqRemoved} stale entr(y/ies)`);
}

export async function selfHarnessCommand(
  action: string,
  options: SelfHarnessOptions,
): Promise<void> {
  if (action === 'analyze') return selfHarnessAnalyze(options);
  if (action === 'run') return selfHarnessRun(options);
  if (action === 'transfer') return selfHarnessTransfer(options);
  if (action === 'mine-prod') return selfHarnessMineProd(options);
  if (action === 'pending') return selfHarnessPending(options);
  if (action === 'prune') return selfHarnessPrune(options);
  console.error(`Unknown self-harness action: ${action}`);
  process.exitCode = 1;
}
