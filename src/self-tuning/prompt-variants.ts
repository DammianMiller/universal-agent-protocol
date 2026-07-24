/**
 * Tunable prompts (S8 — MIPRO-style instruction optimization).
 *
 * UAP already has a full DSPy/MIPRO-shaped compiler (`uap tune`: GP-BO + LLM
 * tuner over a quality metric with held-out guards). It optimizes FLAGS. This
 * module widens the search space to PROMPTS: named prompt fragments, each with
 * a small set of candidate variants the tuner may select among — so the same
 * model gives better results because its instructions were compiled, not
 * hand-written.
 *
 * Safety: fragments encoding hard rules (output contract, autonomy guardrails)
 * are marked `frozen` — the optimizer can never mutate them, so tuning can
 * improve phrasing without eroding a gate's own instructions. Pure + testable;
 * wiring into defaultPromptBuilder and the tuner's proposer is the follow-up.
 */

export interface PromptVariant {
  id: string;
  text: string;
}

export interface TunablePrompt {
  /** Stable fragment id (e.g. 'critic.persona.build'). */
  id: string;
  /** Human description of what the fragment steers. */
  description: string;
  /** Candidate variants; index 0 is the canonical default. */
  variants: PromptVariant[];
  /** When true, the optimizer must NOT change this fragment (safety-critical). */
  frozen: boolean;
}

/**
 * The tunable-prompt catalog. Frozen fragments (output contract, autonomy
 * guardrails) carry a single canonical variant and are never mutated. Only
 * non-frozen fragments expose multiple variants for the tuner to choose.
 */
export const TUNABLE_PROMPTS: Record<string, TunablePrompt> = {
  'executor.tone': {
    id: 'executor.tone',
    description: 'Framing of the executor system prompt (non-safety wording).',
    frozen: false,
    variants: [
      { id: 'default', text: 'You are an expert engineer. Make the change and stop when the gates pass.' },
      { id: 'terse', text: 'Engineer. Change code to pass the gates. No commentary.' },
      { id: 'stepwise', text: 'You are a careful engineer. Work in small verified steps until the gates pass.' },
    ],
  },
  'critic.lead': {
    id: 'critic.lead',
    description: 'Lead-in phrasing for the structured critic repair plan.',
    frozen: false,
    variants: [
      { id: 'default', text: 'Analyze the failure and produce a numbered, file-scoped fix list.' },
      { id: 'rootcause', text: 'Identify the ROOT cause first, then the minimal fix for each failing gate.' },
    ],
  },
  // FROZEN fragments carry a NON-AUTHORITATIVE placeholder, NOT the real
  // contract text. The wiring PR MUST bind these to the canonical constants in
  // convergence-loop.ts (OUTPUT_CONTRACT / AUTONOMY_CONTRACT) — the applier
  // parses the real ```file:path``` format, so shipping divergent text here
  // would be a delivery-critical regression. They exist only to keep these
  // fragments OUT of the optimizer's search space (see tunablePromptSpace).
  'output.contract': {
    id: 'output.contract',
    description: 'File-emission output contract — hard rule, FROZEN. Bind from convergence-loop OUTPUT_CONTRACT.',
    frozen: true,
    variants: [
      { id: 'canonical', text: '__BIND_FROM__ convergence-loop.OUTPUT_CONTRACT (never optimized)' },
    ],
  },
  'autonomy.guardrails': {
    id: 'autonomy.guardrails',
    description: 'Autonomy/safety guardrails — hard rule, FROZEN. Bind from convergence-loop AUTONOMY_CONTRACT.',
    frozen: true,
    variants: [
      { id: 'canonical', text: '__BIND_FROM__ convergence-loop.AUTONOMY_CONTRACT (never optimized)' },
    ],
  },
};

/** True if a fragment is frozen (optimizer must not mutate it). */
export function isFrozen(fragmentId: string): boolean {
  return TUNABLE_PROMPTS[fragmentId]?.frozen ?? false;
}

/**
 * Resolve the active variant text for a fragment given a tuning selection map
 * (fragmentId → variantId). Frozen fragments ALWAYS return their canonical
 * variant regardless of the selection (safety). Unknown fragment/variant falls
 * back to the canonical/default. Pure.
 */
export function resolvePromptVariant(
  fragmentId: string,
  selection: Record<string, string> = {}
): string {
  const frag = TUNABLE_PROMPTS[fragmentId];
  if (!frag) return '';
  if (frag.frozen) return frag.variants[0]?.text ?? '';
  const wanted = selection[fragmentId];
  const chosen = (wanted && frag.variants.find((v) => v.id === wanted)) || frag.variants[0];
  return chosen?.text ?? '';
}

/**
 * The optimizer's search space: only NON-frozen fragments, each with its
 * selectable variant ids. Frozen fragments are excluded so they can never be
 * proposed for mutation.
 */
export function tunablePromptSpace(): Array<{ fragmentId: string; variantIds: string[] }> {
  return Object.values(TUNABLE_PROMPTS)
    .filter((f) => !f.frozen)
    .map((f) => ({ fragmentId: f.id, variantIds: f.variants.map((v) => v.id) }));
}

/** A synthetic enum tuning dimension for one non-frozen prompt fragment — the
 * adapter shape the GP-BO / LLM tuner consumes (key + enum values + default),
 * outside the settings-registry-derived TUNABLE_FLAGS catalog. */
export interface PromptDimension {
  /** Tuner flag key, namespaced: `prompt.<fragmentId>`. */
  key: string;
  fragmentId: string;
  /** Enum domain = the fragment's selectable variant ids. */
  values: string[];
  /** Default value = the canonical (index 0) variant id. */
  default: string;
}

/** One enum dimension per NON-frozen fragment (frozen ones are never proposed). */
export function promptDimensions(): PromptDimension[] {
  return tunablePromptSpace().map((s) => ({
    key: `prompt.${s.fragmentId}`,
    fragmentId: s.fragmentId,
    values: s.variantIds,
    default: s.variantIds[0],
  }));
}

/**
 * Extract a `fragmentId → variantId` selection from a tuner config, reading only
 * the `prompt.*` keys and ignoring unknown/invalid variant ids. The result feeds
 * resolvePromptVariant, so the optimizer's choices reach the PromptBuilder. Pure.
 */
export function promptSelectionFromConfig(config: Record<string, unknown>): Record<string, string> {
  const sel: Record<string, string> = {};
  for (const dim of promptDimensions()) {
    const v = config[dim.key];
    if (typeof v === 'string' && dim.values.includes(v)) sel[dim.fragmentId] = v;
  }
  return sel;
}
