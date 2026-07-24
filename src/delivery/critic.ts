/**
 * Structured Critic (Phase 3)
 *
 * Replaces raw gate-output dumps with a decomposed repair plan. After a
 * failed iteration, the critic analyzes the gate feedback through a
 * gate-specific lens and emits a numbered, file-scoped fix list sized for
 * small-model context budgets — one concrete action per line beats a wall
 * of compiler output.
 */

import type { LoopExecutor } from './convergence-loop.js';
import type { IterationRecord } from './convergence-loop.js';
import type { ApproachRewrite } from './reflect.js';

export interface CritiqueInput {
  instruction: string;
  /** The failed iteration being critiqued */
  record: IterationRecord;
  /** Gate feedback from the ladder (already truncated) */
  feedback: string;
  /** Model output from the failed attempt (already truncated) */
  attemptOutput: string;
}

export interface Critique {
  /** Numbered, file-scoped repair steps */
  fixList: string[];
  /** Gate the critique focuses on (first failing required gate) */
  focusGate?: string;
  /**
   * GEPA reflect (S6): an optional strategic rewrite of the APPROACH (not just
   * a per-turn fix-list) — why the approach failed + a rewritten instruction.
   * Consumed via IterationDirective.mutateInstruction.
   */
  approachRewrite?: ApproachRewrite;
}

export type Critic = (input: CritiqueInput) => Promise<Critique>;

/** Gate-specific analyst personas — the lens shapes what the critic looks for. */
const GATE_PERSONAS: Record<string, string> = {
  build:
    'You are a compiler-error analyst. Map each error to its file and the exact change that resolves it.',
  typecheck:
    'You are a TypeScript type-system expert. For each type error, state the file, the conflicting types, and the precise fix.',
  test:
    'You are a test-failure analyst. For each failing test, state what behavior it expects, which source file implements that behavior, and what must change.',
  lint: 'You are a code-style reviewer. List the mechanical fixes per file.',
};

const DEFAULT_PERSONA =
  'You are a senior engineer diagnosing why a change failed verification.';

const MAX_FIX_STEPS = 8;

function firstFailingGate(record: IterationRecord): string | undefined {
  return record.gateResults.find((g) => !g.passed && !g.skipped)?.id;
}

function buildCriticPrompt(input: CritiqueInput): string {
  const gate = firstFailingGate(input.record);
  const persona = (gate && GATE_PERSONAS[gate]) ?? DEFAULT_PERSONA;

  return [
    persona,
    '',
    `TASK BEING ATTEMPTED: ${input.instruction}`,
    '',
    input.record.filesApplied.length > 0
      ? `FILES CHANGED BY THE ATTEMPT: ${input.record.filesApplied.join(', ')}`
      : 'THE ATTEMPT CHANGED NO FILES.',
    '',
    'VERIFICATION FEEDBACK:',
    input.feedback,
    '',
    'THE ATTEMPT (truncated):',
    input.attemptOutput,
    '',
    `Produce a repair plan: at most ${MAX_FIX_STEPS} numbered steps, each naming a specific file and a specific change.`,
    'Format strictly as numbered lines ("1. <file>: <change>"). No prose before or after.',
  ].join('\n');
}

/** Max characters of critic output parsed (bounds work on untrusted text). */
const MAX_CRITIC_CHARS = 20_000;
/** Linear, anchored matcher — no overlapping quantifiers (avoids ReDoS). */
const FIX_LINE_RE = /^\s{0,8}(\d{1,3})[.)]\s+(\S[^\n]*?)\s*$/;

/** Parse numbered lines ("1. ...", "2) ...") out of model output. */
export function parseFixList(text: string): string[] {
  const steps: string[] = [];
  const bounded = text.length > MAX_CRITIC_CHARS ? text.slice(0, MAX_CRITIC_CHARS) : text;
  for (const line of bounded.split('\n')) {
    const match = FIX_LINE_RE.exec(line);
    if (match) steps.push(match[2]);
    if (steps.length >= MAX_FIX_STEPS) break;
  }
  return steps;
}

/**
 * Model-backed critic. Fail-soft: on executor error or unparseable output
 * it returns an empty fix list, and the loop falls back to raw feedback.
 */
export function createModelCritic(executor: LoopExecutor): Critic {
  return async (input) => {
    const focusGate = firstFailingGate(input.record);
    try {
      const raw = await executor(buildCriticPrompt(input));
      return { fixList: parseFixList(raw), focusGate };
    } catch {
      return { fixList: [], focusGate };
    }
  };
}
