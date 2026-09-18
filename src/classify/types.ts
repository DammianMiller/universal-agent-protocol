/**
 * System-1 classifier types (uplift §6).
 *
 * One interface for every Wave 1 consumer (semantic supervisor 1.1,
 * compaction 1.2, AutoMode 1.3): assess a state against named questions,
 * get back calibrated-looking values with probability + confidence. The
 * backend is pluggable (baseline TF-IDF today; embedding + trained head
 * later) so policy code never changes when the model does.
 *
 * Question shapes mirror the noul/score/choice families so Jev-compatible
 * fixtures work unchanged.
 */

export type QuestionKind = 'noul' | 'score' | 'choice';

export interface Question {
  /** Stable identifier, e.g. "escalation-risk". */
  name: string;
  kind: QuestionKind;
  /** Natural-language description of what is being assessed. */
  prompt: string;
  /** kind=choice: the allowed values. */
  options?: string[];
}

/** noul → boolean; score → 1..5 integer; choice → one of options. */
export type AssessmentValue = boolean | number | string;

export interface Assessment {
  value: AssessmentValue;
  /** The backend's belief in the returned value, 0..1. Semantics per kind:
   * noul = probability the answer is true; score = 1 − normalized rounding
   * distance; choice = winning score's share of the total. A calibrated
   * head replaces these approximations with true calibrated probabilities;
   * consumers must only rely on 0..1 ordering. */
  probability: number;
  /** Confidence in the assessment itself, 0..1 (low → defer to heuristics). */
  confidence: number;
  /** Which backend produced this. */
  backend: string;
}

export type AssessResult = Record<string, Assessment>;

export interface ClassifierBackend {
  readonly name: string;
  assess(state: string, questions: Question[]): AssessResult;
}

/** Thresholds ship as reviewed policy config, never as model output
 * (uplift §6). A noul question is decided true iff probability >= tau and
 * confidence >= confidenceFloor; below the floor the caller must fall back
 * to its heuristic. `tau` applies to noul questions only — score/choice
 * values are returned directly and gated by confidenceFloor alone. */
export interface QuestionThresholds {
  /** noul only; defaults to 0.5. */
  tau?: number;
  confidenceFloor: number;
}

export interface ThresholdConfig {
  version: 1;
  questions: Record<string, QuestionThresholds>;
}

export const DEFAULT_THRESHOLDS: Required<QuestionThresholds> = { tau: 0.5, confidenceFloor: 0.3 };

/** Built-in v1 question registry — one dimension end-to-end per the plan's
 * scope discipline: escalation risk, the question the 1.1 supervisor asks
 * first. Consumers may define their own; these are the shipped defaults. */
export const BUILTIN_QUESTIONS: Question[] = [
  {
    name: 'escalation-risk',
    kind: 'noul',
    prompt: 'Does this state need escalation to a stronger technique or human review?',
  },
  {
    name: 'task-risk',
    kind: 'score',
    prompt: 'How risky is this operation (1 = trivially safe, 5 = irreversible/destructive)?',
  },
  {
    name: 'action-class',
    kind: 'choice',
    prompt: 'What kind of action does this state call for?',
    options: ['proceed', 'verify-first', 'escalate', 'stop'],
  },
];

export class ClassifyError extends Error {}
