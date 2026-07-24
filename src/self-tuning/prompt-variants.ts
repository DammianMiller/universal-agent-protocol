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
  'output.contract': {
    id: 'output.contract',
    description: 'The file-emission output contract — hard rule, FROZEN.',
    frozen: true,
    variants: [
      {
        id: 'canonical',
        text: 'Emit each changed file as a fenced block with its path. Never truncate a file.',
      },
    ],
  },
  'autonomy.guardrails': {
    id: 'autonomy.guardrails',
    description: 'Autonomy/safety guardrails — hard rule, FROZEN.',
    frozen: true,
    variants: [
      { id: 'canonical', text: 'Do not delete tests or gates. Do not weaken acceptance criteria.' },
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
