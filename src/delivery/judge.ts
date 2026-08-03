/**
 * Candidate Judge
 *
 * Tie-breaks exploration candidates whose objective (gate) scores are equal.
 * Objective verification always outranks judgment — the judge is consulted
 * only among candidates tied at the top of the ladder ranking.
 */

import type { LoopExecutor } from './convergence-loop.js';
import { judgeablePrinciples } from '../principles/rules.js';

export interface JudgeCandidate {
  /** Stable candidate id, e.g. 'c1' */
  id: string;
  /** Strategy seed that produced this candidate */
  strategy: string;
  /** Model output (the judge prompt truncates it before embedding) */
  output: string;
  /** Gate feedback for this candidate */
  ladderFeedback: string;
  /** Objective gate score */
  score: number;
}

export interface JudgeVerdict {
  winnerId: string;
  rationale: string;
}

export type Judge = (task: string, candidates: JudgeCandidate[]) => Promise<JudgeVerdict>;

const CANDIDATE_OUTPUT_CHARS = 2_000;

function buildJudgePrompt(task: string, candidates: JudgeCandidate[]): string {
  const sections = [
    'You are a strict senior code reviewer judging competing solutions to the same task.',
    'Rate on: correctness, completeness, simplicity, and how well gate feedback was addressed.',
    // Two candidates that both pass the gates are separated by how they are
    // built, so make that explicit rather than leaving "simplicity" to carry it.
    // Composed from the principles themselves — a hand-copied paraphrase here
    // would drift the moment the rules are reworded.
    `Then break ties on these, in order: ${judgeablePrinciples()}`,
    '',
    `TASK: ${task}`,
    '',
  ];

  for (const c of candidates) {
    sections.push(`=== CANDIDATE ${c.id} (strategy: ${c.strategy}, gate score: ${Math.round(c.score * 100)}%) ===`);
    sections.push(c.output.slice(0, CANDIDATE_OUTPUT_CHARS));
    if (c.ladderFeedback) {
      sections.push(`Gate feedback: ${c.ladderFeedback.slice(0, 500)}`);
    }
    sections.push('');
  }

  sections.push(
    `Respond with ONLY a JSON object: {"winner": "<candidate id>", "rationale": "<one sentence>"}`
  );
  return sections.join('\n');
}

/** Extract the first JSON object from model output (tolerates prose/fences). */
export function extractJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Model-backed judge. Falls back to the first candidate (caller's ranking
 * order) when the verdict is unparseable or names an unknown candidate.
 */
export function createModelJudge(executor: LoopExecutor): Judge {
  return async (task, candidates) => {
    const fallback: JudgeVerdict = {
      winnerId: candidates[0].id,
      rationale: 'judge fallback: kept objective ranking',
    };
    if (candidates.length < 2) return fallback;

    let raw: string;
    try {
      raw = await executor(buildJudgePrompt(task, candidates));
    } catch {
      return fallback;
    }

    const parsed = extractJson(raw);
    const winner = typeof parsed?.winner === 'string' ? parsed.winner : undefined;
    if (!winner || !candidates.some((c) => c.id === winner)) {
      return fallback;
    }

    return {
      winnerId: winner,
      rationale: typeof parsed?.rationale === 'string' ? parsed.rationale : '',
    };
  };
}
