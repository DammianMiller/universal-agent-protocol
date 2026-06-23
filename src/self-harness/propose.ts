/**
 * Self-Harness — Stage 2 harness-proposal.
 *
 * A `Proposer` turns a ranked `WeaknessReport[]` + the current harness profile
 * into candidate `Mod`s (all DSL-validated). P1 ships a deterministic
 * `heuristicProposer` (a known-failure -> candidate-Mod mapping) so the whole
 * loop runs and is testable without an LLM; the `Proposer` interface is the seam
 * an LLM proposer (P1+) drops into. Proposals are biased toward MINIMAL edits
 * (single knob / single block), per the paper.
 */

import { Mod, EnvMod, KnownKnob, KNOB_ALLOWLIST, validateMod, knobSpec } from './mods.js';
import { WeaknessReport, FailureKind } from './weakness.js';
import type { HarnessProfile } from './profile.js';

export interface Proposer {
  readonly id: string;
  propose(weaknesses: WeaknessReport[], profile: HarnessProfile): Mod[];
}

/** Clamp a numeric knob value to its declared safe range. */
function clampKnob(key: KnownKnob, value: number): number {
  const spec = knobSpec(key);
  if (spec.type !== 'number') return value;
  const v = Math.max(spec.min, Math.min(spec.max, value));
  return spec.integer ? Math.round(v) : v;
}

/** Read the current value of a knob from the profile (or its declared default). */
function currentKnob(profile: HarnessProfile, key: KnownKnob): number | null {
  const raw = profile.env[key];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a numeric env Mod that moves `key` toward `factor`×current (clamped),
 * or null if the current value is unknown or the move is a no-op / out of range.
 */
function scaleKnob(profile: HarnessProfile, key: KnownKnob, factor: number): EnvMod | null {
  const cur = currentKnob(profile, key);
  if (cur == null) return null;
  const next = clampKnob(key, cur * factor);
  if (next === cur) return null;
  const mod: EnvMod = { kind: 'env', key, from: String(cur), to: String(next) };
  return validateMod(mod).ok ? mod : null;
}

/**
 * Deterministic heuristic proposer: maps each weakness kind to a minimal,
 * known-good candidate Mod. This intentionally encodes the fixes that worked in
 * the manual campaign (e.g. halving LLAMA_N_PREDICT for runaway generation).
 */
export const heuristicProposer: Proposer = {
  id: 'heuristic',
  propose(weaknesses: WeaknessReport[], profile: HarnessProfile): Mod[] {
    const out: Mod[] = [];
    for (const w of weaknesses) {
      const cand = HEURISTICS[w.kind]?.(profile);
      if (cand && validateMod(cand).ok) out.push(cand);
    }
    return out;
  },
};

const HEURISTICS: Partial<Record<FailureKind, (p: HarnessProfile) => Mod | null>> = {
  // Runaway generation eating the wall-clock -> halve the per-turn cap.
  'gen.runaway.npredict': (p) => scaleKnob(p, 'LLAMA_N_PREDICT', 0.5),
  // Non-termination loops -> tighten the hard finalize ceiling.
  'loop.nonterminate': (p) => scaleKnob(p, 'PROXY_HARD_FINALIZE_TURNS', 0.75),
  // Wall-clock timeouts are usually runaway-driven on this stack -> cap n-predict.
  'agent.timeout': (p) => scaleKnob(p, 'LLAMA_N_PREDICT', 0.5),
  // Wrong answers -> append a "verify before done" directive to the gates block.
  'verify.fail': () => ({
    kind: 'scaffold',
    component: 'gates',
    op: 'append',
    text:
      'After writing, run the verify/test command and confirm exit 0 before declaring done. ' +
      'If it fails, fix in place at the same path and re-run.',
  }),
  // Path garbling -> append the path-fidelity learning to the patterns block.
  // (The mechanical middleware fix is P2; this is the P1 instruction-level attempt.)
  'toolcall.path.garbled': () => ({
    kind: 'scaffold',
    component: 'patterns',
    op: 'append',
    text:
      'Tool-call path fidelity: use the EXACT filename and path from the task, character for ' +
      'character — never change case, drop the extension, or create a new subdirectory.',
  }),
};

// Re-export so callers don't need the allow-list import path.
export { KNOB_ALLOWLIST };
