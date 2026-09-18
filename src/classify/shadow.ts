/**
 * Shadow-mode logging (uplift §6 risk mitigation): the classifier assesses,
 * heuristics decide, divergence is logged. Promotion to active only after
 * measured agreement.
 *
 * Privacy: the raw state text is NEVER persisted — only a content hash, the
 * word count, and the assessment (no raw-text surface; note the hash is
 * equality-revealing for low-entropy boilerplate states — acceptable for a
 * local-only join key). Calibration replays join outcome labels by hash;
 * the text itself stays in the session where it was produced. The log is
 * local-only (.uap/, git-ignored, mode 0600).
 */

import { appendFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { AssessResult, Question } from './types.js';

export interface ShadowRecord {
  /** Schema version — the first calibration replay will want one. */
  v: 1;
  ts: string;
  /** SHA-256 of the state text — join key for later outcome labels. */
  stateHash: string;
  wordCount: number;
  questions: string[];
  result: AssessResult;
  /** The heuristic decision that actually fired while the classifier was in
   * shadow — the divergence the promotion gate measures. Optional because
   * the CLI's ad-hoc --shadow has no heuristic in the loop; Wave 1 consumers
   * (supervisor, AutoMode) must populate it. */
  heuristicDecision?: Record<string, unknown>;
}

export function shadowLogPath(projectDir: string): string {
  return join(projectDir, '.uap', 'classify-shadow.jsonl');
}

export function recordShadow(
  projectDir: string,
  state: string,
  questions: Question[],
  result: AssessResult,
  opts: { logPath?: string; heuristicDecision?: Record<string, unknown> } = {},
): void {
  const logPath = opts.logPath ?? shadowLogPath(projectDir);
  const rec: ShadowRecord = {
    v: 1,
    ts: new Date().toISOString(),
    stateHash: createHash('sha256').update(state).digest('hex'),
    wordCount: state.split(/\s+/).filter(Boolean).length,
    questions: questions.map((q) => q.name),
    result,
    ...(opts.heuristicDecision !== undefined ? { heuristicDecision: opts.heuristicDecision } : {}),
  };
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(rec) + '\n', { encoding: 'utf-8', mode: 0o600 });
}
