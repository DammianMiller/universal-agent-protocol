/**
 * The nine assessment dimensions — each a PURE function over a bounded
 * Observation. Heuristics are the floor: they always answer. An optional
 * classifier (structural contract only — the SYS1 classifier lands
 * separately) may RAISE a flag when confident, but can never clear one the
 * heuristic set, and a throwing/absent classifier changes nothing. That is
 * the fail-closed posture: model failure degrades to reviewed heuristics,
 * never to looser supervision.
 */
import type { DimensionAssessment, Observation, SupervisorConfig } from './types.js';

/**
 * Structural match for the SYS1 classifier contract (PR #807 — do NOT import
 * src/classify, it is unmerged). Only the built-in question names below may
 * be sent; the backend throws on custom names, so none exist here. When #807
 * lands, this interface is replaced by the real import and reconciled.
 */
export interface ClassifierQuestion {
  name: string;
  kind: 'noul' | 'choice' | 'score';
  prompt: string;
  options?: string[];
}

export interface ClassifierLike {
  name: string;
  assess(
    state: string,
    questions: ClassifierQuestion[]
  ): Record<string, { value: unknown; probability: number; confidence: number }>;
}

/** The ONLY questions ever sent — the SYS1 built-ins. */
const BUILTIN_QUESTIONS: ClassifierQuestion[] = [
  {
    name: 'escalation-risk',
    kind: 'noul',
    prompt: 'Does this mission evidence indicate escalation-level risk (stuck, off-track, or needing a human)?',
  },
  {
    name: 'action-class',
    kind: 'choice',
    prompt: 'Which supervisor action class does this evidence most suggest?',
  },
];

/**
 * Human-need means an INTERROGATIVE the mission cannot answer itself:
 * credential prompts and approve/confirm questions. Declaratives like
 * "Permission denied" or "approved the change" must NOT fire.
 */
const HUMAN_NEEDED_RE =
  /\b(enter|type|provide|requires?)\b.{0,24}\b(password|passphrase|credentials?)\b|\b(password|passphrase)\s*[:?]|\b(approve|confirm|allow)\s+(this|the|these)?\s*(action|change|operation)s?\?|\[y(?:es)?\/n(?:o)?\]/i;
const SUCCESS_RE = /(delivered in \d+ turn|delivery complete|mission complete|✓ delivered)/i;
const TEST_EVIDENCE_RE = /(npm (run )?test|vitest|pytest|go test|cargo test|tests? (passed|pass)|✓ tests)/i;
const ERROR_LINE_RE = /(error|fatal|exception|failed)/i;
/** Healthy summaries like "0 failed" / "0 errors" are not error evidence. */
const HEALTHY_COUNT_RE = /\b0\s+(failed|failures?|errors?)\b/i;
const DESTRUCTIVE_RE = /(rm\s+-rf|drop\s+table|force-push|git\s+push\s+--force|delete\s+from|truncate\s+table|mkfs|git\s+reset\s+--hard)/gi;

/** Error-evidence lines: error-shaped MINUS healthy zero-count summaries. */
function errorLines(tail: string): string[] {
  return tail
    .split('\n')
    .filter((l) => ERROR_LINE_RE.test(l) && !HEALTHY_COUNT_RE.test(l));
}

function flag(name: string, value: boolean, confidence: number, defer = false): DimensionAssessment {
  return { name, value, probability: value ? confidence : 1 - confidence, confidence, defer, source: 'heuristic' };
}

function score(name: string, value: number, confidence: number): DimensionAssessment {
  const v = Math.max(1, Math.min(5, Math.round(value)));
  return { name, value: v, probability: confidence, confidence, defer: false, source: 'heuristic' };
}

/** 1. running, but no state update past the stall budget. */
export function progressStalled(obs: Observation, cfg: SupervisorConfig): DimensionAssessment {
  const stalled = obs.status === 'running' && obs.minutesSinceUpdate > cfg.stallMinutes;
  return flag('progress-stalled', stalled, 0.9);
}

/**
 * 2. diff touches paths with NO overlap with instruction keywords. A simple
 * heuristic by design: absence of evidence (no diff, no keywords) is an
 * abstention (defer), never an accusation.
 */
export function offTrack(obs: Observation): DimensionAssessment {
  const stat = obs.diffStat;
  if (!stat || !stat.trim()) return flag('off-track', false, 0.2, true);
  const keywords = obs.instruction
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
  const paths = stat
    .split('\n')
    .map((l) => l.split('|')[0].trim())
    .filter((p) => p.length > 0 && !p.startsWith('...'));
  if (keywords.length === 0 || paths.length === 0) return flag('off-track', false, 0.2, true);
  const related = paths.some((p) => keywords.some((k) => p.toLowerCase().includes(k)));
  return flag('off-track', !related, 0.6);
}

/** 3. the mission is asking for something only a human can provide. */
export function humanNeeded(obs: Observation): DimensionAssessment {
  return flag('human-needed', HUMAN_NEEDED_RE.test(obs.recentLogTail), 0.9);
}

/**
 * 4. stuck-loop: too many recorded failures, or ONE error signature repeated
 * >= 3 times in the tail (same normalized line — the loop is saying the same
 * thing, not making new mistakes).
 */
export function stuckLoop(obs: Observation, cfg: SupervisorConfig): DimensionAssessment {
  if (obs.failures >= cfg.maxFailures) return flag('stuck-loop', true, 0.9);
  const counts = new Map<string, number>();
  for (const line of errorLines(obs.recentLogTail)) {
    const sig = line
      .toLowerCase()
      .replace(/\d{4}-\d{2}-\d{2}[t ][\d:.]+z?/g, '')
      .replace(/\d+/g, '#')
      .trim()
      .slice(0, 120);
    if (!sig) continue;
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  let maxRepeat = 0;
  for (const n of counts.values()) maxRepeat = Math.max(maxRepeat, n);
  return flag('stuck-loop', maxRepeat >= 3, 0.8);
}

/** 5. delivered status, or the mission's own success markers in the tail. */
export function completionSignaled(obs: Observation): DimensionAssessment {
  const done = obs.status === 'delivered' || SUCCESS_RE.test(obs.recentLogTail);
  return flag('completion-signaled', done, 0.9);
}

/** 6. a checkpoint exists but the tail shows no test run to back it. */
export function verificationPending(obs: Observation): DimensionAssessment {
  const pending = obs.hasCheckpoint && !TEST_EVIDENCE_RE.test(obs.recentLogTail);
  return flag('verification-pending', pending, 0.6, !obs.hasCheckpoint);
}

/** 7. error-line density in the tail, scored 1-5. */
export function errorDensity(obs: Observation): DimensionAssessment {
  const lines = obs.recentLogTail.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return score('error-density', 1, 0.5);
  const errors = errorLines(obs.recentLogTail).length;
  return score('error-density', 1 + Math.min(4, Math.floor((errors / lines.length) * 20)), 0.7);
}

/** 8. how much of the turn budget is spent, scored 1-5. */
export function iterationPressure(obs: Observation, cfg: SupervisorConfig): DimensionAssessment {
  const ratio = obs.turnsCompleted / cfg.maxTurns;
  return score('iteration-pressure', 1 + Math.min(4, Math.round(ratio * 4)), 0.9);
}

/** 9. destructive-token density in the tail, scored 1-5. */
export function risk(obs: Observation): DimensionAssessment {
  const matches = obs.recentLogTail.match(DESTRUCTIVE_RE);
  return score('risk', 1 + Math.min(4, matches ? matches.length : 0), 0.6);
}

export const DIMENSIONS = [
  'progress-stalled',
  'off-track',
  'human-needed',
  'stuck-loop',
  'completion-signaled',
  'verification-pending',
  'error-density',
  'iteration-pressure',
  'risk',
] as const;

export function heuristicAssessAll(obs: Observation, cfg: SupervisorConfig): DimensionAssessment[] {
  return [
    progressStalled(obs, cfg),
    offTrack(obs),
    humanNeeded(obs),
    stuckLoop(obs, cfg),
    completionSignaled(obs),
    verificationPending(obs),
    errorDensity(obs),
    iterationPressure(obs, cfg),
    risk(obs),
  ];
}

/** Bounded, redaction-friendly summary handed to the classifier. */
export function summarizeObservation(obs: Observation): string {
  return [
    `run=${obs.runId} status=${obs.status}`,
    `elapsed=${obs.elapsedMinutes.toFixed(1)}m sinceUpdate=${obs.minutesSinceUpdate.toFixed(1)}m`,
    `turns=${obs.turnsCompleted} failures=${obs.failures} checkpoint=${obs.hasCheckpoint}`,
    `gitDirty=${obs.gitDirtyFiles ?? 'n/a'}`,
    `diffStat: ${(obs.diffStat ?? 'n/a').slice(0, 500)}`,
    `logTail: ${obs.recentLogTail.slice(-2000)}`,
  ].join('\n');
}

function clamp01(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

type ClassifierAnswer = { value: unknown; probability: number; confidence: number };

/** Raise a flag dimension from a classifier answer — NEVER clears one. */
function raiseFlag(
  dims: DimensionAssessment[],
  name: string,
  a: ClassifierAnswer
): DimensionAssessment[] {
  return dims.map((d) =>
    d.name === name && d.value !== true
      ? {
          name,
          value: true,
          probability: clamp01(a.probability),
          confidence: clamp01(a.confidence),
          defer: false,
          source: 'classifier' as const,
        }
      : d
  );
}

/**
 * Assess all nine dimensions. With a classifier, ONLY the SYS1 built-in
 * questions are asked (escalation-risk noul, action-class choice); confident
 * answers map onto flag dimensions:
 *   escalation-risk=true (probability ≥ classifierTau AND confidence ≥
 *     classifierConfidenceMin) → raises off-track
 *   action-class 'escalate'   → raises stuck-loop
 *   action-class 'stop'       → raises off-track
 * The classifier may RAISE a flag, never clear one (never looser), and any
 * classifier error leaves the pure heuristics in charge (fail closed).
 */
export function assessAll(
  obs: Observation,
  cfg: SupervisorConfig,
  classifier?: ClassifierLike
): DimensionAssessment[] {
  const heuristics = heuristicAssessAll(obs, cfg);
  if (!classifier) return heuristics;
  let answers: Record<string, ClassifierAnswer>;
  try {
    answers = classifier.assess(summarizeObservation(obs), BUILTIN_QUESTIONS);
  } catch {
    return heuristics;
  }
  if (!answers || typeof answers !== 'object') return heuristics;
  let out = heuristics;
  const er = answers['escalation-risk'];
  if (
    er &&
    er.value === true &&
    clamp01(er.probability) >= cfg.classifierTau &&
    clamp01(er.confidence) >= cfg.classifierConfidenceMin
  ) {
    out = raiseFlag(out, 'off-track', er);
  }
  const ac = answers['action-class'];
  if (ac && clamp01(ac.confidence) >= cfg.classifierConfidenceMin) {
    if (ac.value === 'escalate') out = raiseFlag(out, 'stuck-loop', ac);
    else if (ac.value === 'stop') out = raiseFlag(out, 'off-track', ac);
  }
  return out;
}
