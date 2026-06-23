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

export interface SelfHarnessOptions {
  records?: string;
  env?: string;
  json?: boolean;
}

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
  const proposed = heuristicProposer.propose(weaknesses, profile);

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

  console.log(chalk.bold('\nProposed Mods (heuristic, minimal):'));
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

export async function selfHarnessCommand(
  action: string,
  options: SelfHarnessOptions,
): Promise<void> {
  if (action === 'analyze') return selfHarnessAnalyze(options);
  console.error(`Unknown self-harness action: ${action}`);
  process.exitCode = 1;
}
