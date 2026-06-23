/**
 * Self-Harness — Stage 1 weakness mining from paired-bench run records.
 *
 * P1 mines from the structured `RunRecord`s the paired bench already produces
 * (correct, error, latency, turns) — a HALO-trace miner is additive (P3). Each
 * failing record is classified into a `FailureKind`; classifications aggregate
 * into ranked `WeaknessReport`s keyed by a stable signature. Pure + testable.
 */

import type { RunRecord } from '../benchmarks/paired/types.js';
import {
  FailureKind,
  WeaknessReport,
  signatureHash,
  rankWeaknesses,
} from './weakness.js';

/**
 * Classify a single run's failure into a FailureKind, or null if it succeeded.
 * Heuristics are derived from the observed Qwen3.6-A3B failure modes
 * (see memory project_uap_paired_bench): timeout vs verify-fail vs runaway etc.
 */
export function classifyFailure(rec: RunRecord): FailureKind | null {
  if (rec.metrics.correct) return null;
  const err = (rec.metrics.error ?? '').toLowerCase();
  if (err.includes('timed out') || err.includes('timeout')) return 'agent.timeout';
  if (err.includes('verify failed')) {
    // A verify failure with very high turns is a non-termination/garble loop;
    // otherwise it's a plain wrong answer.
    if ((rec.metrics.turns ?? 0) >= 40) return 'loop.nonterminate';
    return 'verify.fail';
  }
  if (err.includes('exit') || err.includes('spawn')) return 'agent.error';
  // Fell through with no error but incorrect → treat as a wrong answer.
  return 'verify.fail';
}

export interface MineOptions {
  /** Model family the records were produced on (for signature keying). */
  model: string;
  /** Only emit weaknesses occurring at least this many times. Default 1. */
  minFrequency?: number;
}

/** Mine ranked weaknesses from a set of paired-bench run records. */
export function mineFromRecords(records: RunRecord[], opts: MineOptions): WeaknessReport[] {
  const minFreq = opts.minFrequency ?? 1;
  const byKind = new Map<FailureKind, { tasks: Set<string>; evidence: string[]; count: number }>();

  for (const rec of records) {
    const kind = classifyFailure(rec);
    if (!kind) continue;
    let agg = byKind.get(kind);
    if (!agg) {
      agg = { tasks: new Set(), evidence: [], count: 0 };
      byKind.set(kind, agg);
    }
    agg.count += 1;
    agg.tasks.add(rec.taskId);
    if (agg.evidence.length < 5) {
      agg.evidence.push(`${rec.taskId}#${rec.seed} ${rec.condition}: ${rec.metrics.error ?? 'incorrect'}`);
    }
  }

  const reports: WeaknessReport[] = [];
  for (const [kind, agg] of byKind) {
    if (agg.count < minFreq) continue;
    reports.push({
      signature: signatureHash({ kind, model: opts.model }),
      kind,
      model: opts.model,
      frequency: agg.count,
      affectedTasks: [...agg.tasks],
      hypothesis: HYPOTHESIS[kind],
      evidence: agg.evidence,
    });
  }
  return rankWeaknesses(reports);
}

const HYPOTHESIS: Record<FailureKind, string> = {
  'toolcall.path.garbled':
    'The model mangles tool-call file paths (case/extension/stray dirs) and never lands a correct edit.',
  'toolcall.args.truncated':
    'Tool-call arguments are cut off mid-value, producing empty/partial writes.',
  'gen.runaway.npredict':
    'A single turn generates up to the n-predict cap, consuming the wall-clock budget.',
  'loop.nonterminate':
    'The agent keeps emitting tool calls without converging on a terminal answer.',
  'guardrail.poison.recon':
    'A guardrail (recon-convergence) wedged tool access across requests.',
  'verify.fail':
    'The agent terminates and submits, but the deterministic verifier rejects the answer.',
  'agent.timeout':
    'The agent exceeded its wall-clock budget without producing a verifiable result.',
  'agent.error':
    'The agent process exited non-zero or failed to spawn.',
};
