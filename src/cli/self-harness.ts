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
}

const DEFAULT_TRANSFER = join(homedir(), '.uap', 'self-harness', 'transfer.json');

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

export async function selfHarnessCommand(
  action: string,
  options: SelfHarnessOptions,
): Promise<void> {
  if (action === 'analyze') return selfHarnessAnalyze(options);
  if (action === 'transfer') return selfHarnessTransfer(options);
  console.error(`Unknown self-harness action: ${action}`);
  process.exitCode = 1;
}
