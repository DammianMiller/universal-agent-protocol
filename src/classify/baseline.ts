/**
 * Baseline System-1 backend: deterministic, CPU-only, dependency-free.
 *
 * Token-density scoring against per-question seed vocabularies, squashed
 * through a logistic curve. It is deliberately simple: its job is to be the
 * always-available local floor (airgap-pure, <50ms p95 trivially) and the
 * shadow-mode reference that a trained embedding head must beat before
 * promotion. Seeded from UAP's own incident vocabulary (the 2026-09-18 OOM
 * timeline, gate outcomes, escalation telemetry language).
 *
 * v1 scope: the baseline answers ONLY the built-in questions (it keys its
 * vocabulary off the question name). A custom question gets a ClassifyError,
 * not a silently mis-scoped answer — the trained head is the generalizer.
 */

import {
  Assessment,
  AssessResult,
  ClassifierBackend,
  ClassifyError,
  BUILTIN_QUESTIONS,
  Question,
} from './types.js';

/** Tokens that mark elevated escalation risk in a state description. */
const ESCALATION_TOKENS = [
  'error', 'failed', 'failure', 'crash', 'oom', 'sigabrt', 'killed', 'stuck',
  'loop', 'looping', 'restarting', 'timeout', 'timed', 'denied', 'refused',
  'corrupt', 'unrecoverable', 'exception', 'fatal', 'panic', 'deadlock',
  'blocked', 'cannot', 'unable', 'unknown', 'missing', 'broken', 'regression',
  'conflict', 'diverged', 'mismatch', 'unexpected', 'anomaly', 'leak',
];

/** Tokens that mark destructive/irreversible operations (task-risk score). */
const DESTRUCTIVE_TOKENS = [
  'delete', 'remove', 'rm', 'drop', 'truncate', 'destroy', 'wipe', 'purge',
  'overwrite', 'reset', 'force', 'push', 'deploy', 'migrate', 'production',
  'secrets', 'credentials', 'rotate', 'revoke', 'sudo', 'chmod', 'chown',
];

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'at',
  'by', 'as', 'from', 'not', 'no', 'we', 'i', 'you', 'they',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Sigmoid around a calibrated midpoint. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** hits / sqrt(length): sub-linear length normalization — long clean prose
 * dilutes a few keyword hits, but a wall of repeated keywords still
 * saturates (numerator grows linearly). Saturation resistance, if wanted,
 * must come from the calibrated head, not from this ratio. */
function hitRatio(tokens: string[], vocab: string[]): number {
  if (tokens.length === 0) return 0;
  const set = new Set(vocab);
  const hits = tokens.filter((t) => set.has(t)).length;
  return hits / Math.sqrt(tokens.length);
}

export class BaselineBackend implements ClassifierBackend {
  readonly name = 'baseline-tfidf-v1';

  assess(state: string, questions: Question[]): AssessResult {
    const tokens = tokenize(state);
    const out: AssessResult = {};
    for (const q of questions) {
      out[q.name] = this.answer(q, tokens);
    }
    return out;
  }

  private answer(q: Question, tokens: string[]): Assessment {
    // Question-blind scoring would silently answer a custom noul question
    // with the escalation vocabulary — refuse instead (the trained head is
    // the generalizer; see module header).
    if (!BUILTIN_QUESTIONS.some((b) => b.name === q.name)) {
      throw new ClassifyError(
        `baseline backend answers only the built-in questions; got "${q.name}"`,
      );
    }
    switch (q.kind) {
      case 'noul':
        return this.noul(tokens);
      case 'score':
        return this.score(tokens);
      case 'choice':
        return this.choice(q, tokens);
    }
  }

  private noul(tokens: string[]): Assessment {
    const r = hitRatio(tokens, ESCALATION_TOKENS);
    // Midpoint ~0.35 ratio → p 0.5; steep enough to separate clean states.
    const probability = sigmoid((r - 0.35) * 8);
    // Confidence scales with evidence mass; empty states are low-confidence.
    const confidence = Math.min(1, tokens.length / 40) * (0.5 + Math.abs(probability - 0.5));
    return {
      value: probability >= 0.5,
      probability,
      confidence,
      backend: this.name,
    };
  }

  private score(tokens: string[]): Assessment {
    const r = hitRatio(tokens, DESTRUCTIVE_TOKENS);
    // Map 0..~0.8 ratio onto 1..5 with a soft curve.
    const raw = 1 + 4 * Math.min(1, r / 0.8);
    const value = Math.round(raw);
    const probability = 1 - Math.min(1, Math.abs(raw - value) * 2);
    const confidence = Math.min(1, tokens.length / 40);
    return { value, probability, confidence, backend: this.name };
  }

  private choice(q: Question, tokens: string[]): Assessment {
    const options = q.options ?? [];
    if (options.length === 0) {
      return { value: '', probability: 0, confidence: 0, backend: this.name };
    }
    // Deterministic scoring: 'escalate'/'stop' track escalation + destructive
    // density, 'verify-first' tracks moderate signals, 'proceed' is the rest.
    const esc = hitRatio(tokens, ESCALATION_TOKENS);
    const dst = hitRatio(tokens, DESTRUCTIVE_TOKENS);
    const scores: Record<string, number> = {
      escalate: 2 * esc + dst,
      // stop must beat escalate on pure-destructive-no-incident states, so
      // it gets an escalation-independent margin (escalate >= dst always).
      stop: dst > 0.6 && esc < 0.2 ? 2 * dst + 0.1 : 0,
      'verify-first': esc > 0.1 && esc < 0.5 ? 0.4 : 0.1,
      proceed: Math.max(0.05, 0.5 - esc - dst),
    };
    let best = options[0];
    let bestScore = -Infinity;
    let total = 0;
    for (const opt of options) {
      const s = scores[opt] ?? 0.05;
      total += s;
      if (s > bestScore) {
        bestScore = s;
        best = opt;
      }
    }
    return {
      value: best,
      probability: total > 0 ? bestScore / total : 1 / options.length,
      confidence: Math.min(1, tokens.length / 40),
      backend: this.name,
    };
  }
}
