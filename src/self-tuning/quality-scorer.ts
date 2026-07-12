/**
 * LLM Self-Tuning — the Quality Scorer (P0).
 *
 * The paired benchmark answers "did the code work" (pass/fail). Raising a small
 * model toward Opus 4.8 is a QUALITY problem, not just a correctness one, so the
 * tuner needs a richer signal. This module produces a `QualityScore`
 * (correctness, quality, efficiency, toolReliability, planning + composite) per
 * run so the tuner has something continuous to optimize.
 *
 * Two production paths, chosen by whether a judge model is available:
 *   - HEURISTIC (no judge): every dimension derived deterministically from the
 *     metric vector + ground-truth `correct`. Zero cost, fully reproducible,
 *     network-free — the default and the test path.
 *   - JUDGE (a stronger model configured): correctness/quality/planning graded
 *     by the judge over the task spec + agent output; efficiency/toolReliability
 *     stay deterministic (they are metric facts, not opinions). The two are
 *     fused into a 'hybrid' score.
 *
 * The composite weighting (correctness 40 / quality 30 / efficiency 15 /
 * toolReliability 15) matches docs/design/LLM_SELF_TUNING_ANALYSIS.md §3.3.1.
 */

import {
  QualityScore,
  QualityScoreSchema,
  QualityDimension,
  compositeQuality,
  DEFAULT_QUALITY_WEIGHTS,
  MetricVector,
  RunRecord,
} from '../benchmarks/paired/types.js';
import type { JudgeClient } from './judge.js';
import { parseJsonLenient } from './judge.js';

// Re-export the type so consumers can import it from the scorer (per the design
// doc, which locates the QualityScore contract here). The Zod schema + composite
// helper live in the dependency-free paired core so RunRecord can carry a score.
export type { QualityScore, QualityDimension } from '../benchmarks/paired/types.js';

/** The evidence a scorer needs about a single run. */
export interface QualityScoreInput {
  /** The verbatim task instruction handed to the agent. */
  taskInstruction: string;
  /** Ground-truth correctness from the deterministic verify command. */
  correct: boolean;
  /** The run's metric vector (tokens/turns/toolCalls/wellFormed/…). */
  metrics: MetricVector;
  /** Agent output evidence for the judge: the diff, final answer, or raw log tail. */
  output?: string;
  /** Optional reference / rubric the judge grades against. */
  reference?: string;
}

export interface ScoreOptions {
  /** A resolved judge client. When omitted, the heuristic path is used. */
  judge?: JudgeClient | null;
  /** Composite weights override (renormalized over supplied dims). */
  weights?: Partial<Record<QualityDimension, number>>;
  /**
   * Reference "good" token spend for efficiency normalization. Efficiency is
   * refTokens / (refTokens + tokens) → 50 at refTokens, →100 as tokens→0.
   * Default 15000 (the doc's qwen3.6 baseline tokens-per-correct-answer).
   */
  refTokens?: number;
  /** Reference "good" turn count for the planning heuristic. Default 6. */
  refTurns?: number;
  /** Max chars of `output` fed to the judge. Default 6000. */
  maxOutputChars?: number;
}

const DEFAULT_REF_TOKENS = 15000;
const DEFAULT_REF_TURNS = 6;

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/**
 * Deterministic efficiency (0-100). An INCORRECT run spent its tokens on a wrong
 * answer, so efficiency is heavily penalized (tokens were wasted). A correct run
 * scores by leanness against `refTokens`.
 */
export function efficiencyScore(metrics: MetricVector, refTokens = DEFAULT_REF_TOKENS): number {
  const tokens = metrics.tokens;
  if (tokens == null) return metrics.correct ? 60 : 20; // unknown spend: neutral-ish
  const leanness = (refTokens / (refTokens + Math.max(0, tokens))) * 100; // 100→50→0
  return clamp100(metrics.correct ? leanness : leanness * 0.3);
}

/**
 * Deterministic tool reliability (0-100) from well-formedness + productivity.
 * A malformed edit is the small-model failure mode this dimension surfaces.
 */
export function toolReliabilityScore(metrics: MetricVector): number {
  let base: number;
  if (metrics.wellFormed === false) base = 30;
  else if (metrics.wellFormed === true) base = 90;
  else base = 70; // unknown
  // Productivity: a run that made tool calls but never got correct is churning.
  const productivity = metrics.correct ? 1 : 0.7;
  // Penalize a run that made no tool calls yet was expected to act.
  if (metrics.toolCalls != null && metrics.toolCalls === 0 && !metrics.correct) base *= 0.7;
  return clamp100(base * productivity);
}

/** Deterministic planning heuristic (0-100): correct + few turns == coherent. */
export function planningScore(metrics: MetricVector, refTurns = DEFAULT_REF_TURNS): number {
  const turns = metrics.turns;
  const floor = metrics.correct ? 60 : 25;
  if (turns == null) return floor;
  // Fewer turns than the reference reads as tighter planning; more reads looser.
  const turnFactor = refTurns / (refTurns + Math.max(0, turns - refTurns));
  return clamp100(floor + (metrics.correct ? 40 : 15) * turnFactor);
}

/**
 * Purely deterministic score — no network. Correctness is the ground-truth
 * boolean projected to 0/100; quality is proxied from correctness + wellFormed;
 * the rest come from the heuristics above. This is the default and test path.
 */
export function heuristicQuality(input: QualityScoreInput, opts: ScoreOptions = {}): QualityScore {
  const m = input.metrics;
  const correctness = input.correct ? 100 : 0;
  // Quality proxy: a correct, well-formed answer is decent; without a judge we
  // cannot see nuance, so we stay conservative (never award judge-level highs).
  const qualityProxy = input.correct ? (m.wellFormed === false ? 60 : 78) : m.wellFormed === true ? 30 : 20;
  const dims: Record<QualityDimension, number> = {
    correctness,
    quality: qualityProxy,
    efficiency: efficiencyScore(m, opts.refTokens),
    toolReliability: toolReliabilityScore(m),
    planning: planningScore(m, opts.refTurns),
  };
  const composite = compositeQuality(dims, opts.weights ?? DEFAULT_QUALITY_WEIGHTS);
  return QualityScoreSchema.parse({ ...dims, composite, source: 'heuristic' });
}

/** Build the judge prompt: grade correctness/quality/planning as 0-100 JSON. */
export function buildJudgePrompt(input: QualityScoreInput, maxOutputChars: number): string {
  const output = (input.output ?? '').slice(0, maxOutputChars);
  return [
    'You are a strict senior engineer grading an AI agent\'s work on a task.',
    'Grade three dimensions on a 0-100 scale, where 100 is what a top-tier model',
    '(Claude Opus) would produce and 50 is mediocre-but-acceptable.',
    '',
    'DIMENSIONS:',
    '- correctness: does the work actually satisfy the task as specified?',
    '- quality: is the solution clean, idiomatic, complete, and free of shortcuts?',
    '- planning: is the approach coherent and well-sequenced (vs flailing)?',
    '',
    `GROUND TRUTH (from a hidden deterministic test): the task was ${input.correct ? 'RESOLVED' : 'NOT resolved'}.`,
    'Weight correctness heavily toward that ground truth, but you may still judge',
    'quality/planning on partial or over-engineered work.',
    '',
    'TASK INSTRUCTION:',
    input.taskInstruction,
    ...(input.reference ? ['', 'REFERENCE / RUBRIC:', input.reference] : []),
    '',
    'AGENT OUTPUT (diff / answer / log tail):',
    output || '(no output captured)',
    '',
    'Respond with ONLY a JSON object, no prose:',
    '{"correctness": <0-100>, "quality": <0-100>, "planning": <0-100>, "rationale": "<one sentence>"}',
  ].join('\n');
}

interface JudgeVerdict {
  correctness?: number;
  quality?: number;
  planning?: number;
  rationale?: string;
}

/**
 * Score a single run. Uses the judge for correctness/quality/planning when one
 * is supplied and reachable; efficiency/toolReliability are always the
 * deterministic metric facts. Any judge failure degrades gracefully to the
 * heuristic score (never throws), so a scoring pass can never wedge a bench.
 */
export async function scoreQuality(
  input: QualityScoreInput,
  opts: ScoreOptions = {},
): Promise<QualityScore> {
  const heuristic = heuristicQuality(input, opts);
  if (!opts.judge) return heuristic;

  const maxOut = opts.maxOutputChars ?? 6000;
  let verdict: JudgeVerdict | null = null;
  try {
    const raw = await opts.judge.complete(buildJudgePrompt(input, maxOut), { json: true, temperature: 0.1 });
    verdict = parseJsonLenient<JudgeVerdict>(raw);
  } catch {
    verdict = null; // network/parse failure → heuristic fallback
  }
  if (!verdict || typeof verdict.correctness !== 'number') return heuristic;

  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp100(v) : fallback;

  const dims: Record<QualityDimension, number> = {
    // Anchor judged correctness to ground truth: a judge that contradicts the
    // hidden test is pulled toward it (70/30) so a hallucinated pass can't win.
    correctness: clamp100(0.3 * num(verdict.correctness, input.correct ? 100 : 0) + 0.7 * (input.correct ? 100 : 0)),
    quality: num(verdict.quality, heuristic.quality),
    efficiency: heuristic.efficiency,
    toolReliability: heuristic.toolReliability,
    planning: num(verdict.planning, heuristic.planning),
  };
  const composite = compositeQuality(dims, opts.weights ?? DEFAULT_QUALITY_WEIGHTS);
  return QualityScoreSchema.parse({
    ...dims,
    composite,
    source: 'hybrid',
    ...(verdict.rationale ? { rationale: String(verdict.rationale).slice(0, 300) } : {}),
  });
}

/**
 * Attach quality scores to a set of run records in place-returning form. The
 * `inputFor` mapper supplies the per-record evidence (task instruction, output).
 * Scoring is bounded-concurrent to avoid overwhelming the judge endpoint.
 */
export async function scoreRuns(
  records: RunRecord[],
  inputFor: (r: RunRecord) => QualityScoreInput,
  opts: ScoreOptions & { concurrency?: number } = {},
): Promise<RunRecord[]> {
  const concurrency = Math.max(1, opts.concurrency ?? (opts.judge ? 4 : 16));
  const out: RunRecord[] = new Array(records.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= records.length) return;
      const r = records[i];
      const score = await scoreQuality(inputFor(r), opts);
      out[i] = { ...r, qualityScore: score };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, () => worker()));
  return out;
}
