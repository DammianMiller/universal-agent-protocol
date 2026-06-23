/**
 * `uap self-harness` — CLI for the self-improving harness (arXiv:2606.09498).
 *
 * P1 ships `analyze`: read-only weakness mining + heuristic Mod proposal from an
 * existing paired-bench `records.jsonl`. The full validate+apply loop (`run`)
 * builds on the orchestrator in src/self-harness/orchestrator.ts.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import type { RunRecord } from '../benchmarks/paired/types.js';
import { mineFromRecords } from '../self-harness/mine.js';
import { heuristicProposer } from '../self-harness/propose.js';
import { describeMod } from '../self-harness/mods.js';
import {
  profileFromEnvFile,
  emptyProfile,
  type HarnessProfile,
} from '../self-harness/profile.js';
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
}

const DEFAULT_TRANSFER = join(homedir(), '.uap', 'self-harness', 'transfer.json');
const DEFAULT_PENDING = join(homedir(), '.uap', 'self-harness', 'pending.json');
const DEFAULT_HALO = join(homedir(), '.uap', 'halo', 'traces.jsonl');

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
      `\n  analyze is read-only (mine+propose). Validation + apply is the orchestrator (P1+).`,
    ),
  );
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
  const model = options.model || 'qwen36-35b-a3b-iq4xs';
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

export async function selfHarnessCommand(
  action: string,
  options: SelfHarnessOptions,
): Promise<void> {
  if (action === 'analyze') return selfHarnessAnalyze(options);
  if (action === 'transfer') return selfHarnessTransfer(options);
  if (action === 'mine-prod') return selfHarnessMineProd(options);
  if (action === 'pending') return selfHarnessPending(options);
  console.error(`Unknown self-harness action: ${action}`);
  process.exitCode = 1;
}
