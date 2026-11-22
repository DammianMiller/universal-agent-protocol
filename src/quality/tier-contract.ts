/**
 * Tier contract (Wave 1.3) — the digitized quality bar as an injectable
 * prompt block, so the executor prompt CARRIES the contract instead of
 * discovering it through failed gates.
 *
 * A smaller model climbing a tier needs the target in its prompt: the
 * measured axes with their thresholds and fail directions, the directive
 * for each failing side (the same text the gap compiler emits), the
 * degenerate-evidence guard, and the class's sampling profile (precision
 * classes run cold, generative classes warm). The block is compact — a
 * few hundred characters — deterministic, and derived from the SAME
 * store the gates read, so the prompt can never drift from the gate.
 *
 * The proxy-side injection (rewriting executor requests at the uap-omni
 * seam) is recorded as a seam: this module is the repo-side half.
 */
import { classOfTierKey, resolveClass, SamplingProfile } from './classes.js';
import { resolveTiers, TierProfile } from './tiers.js';

/** The class's declared sampling profile; null = executor keeps its default. */
export function classSamplingProfile(cls: string): SamplingProfile | null {
  // Unregistered classes resolve to the visual spec — the registry's
  // backward-compat rule — so they inherit the visual (generative) profile.
  return resolveClass(cls).sampling ?? null;
}

/** Load one tier profile by key. Null when neither project nor fleet store carries it. */
export function loadTierByKey(projectRoot: string, tierKey: string): TierProfile | null {
  const store = resolveTiers(projectRoot);
  return store.tiers[tierKey] ?? null;
}

function bandOf(threshold: { min?: number; max?: number }): string {
  if (threshold.min !== undefined && threshold.max !== undefined) {
    return `between ${threshold.min} and ${threshold.max}`;
  }
  if (threshold.min !== undefined) return `at least ${threshold.min}`;
  if (threshold.max !== undefined) return `at most ${threshold.max}`;
  return 'unbounded';
}

/**
 * The tier contract as prompt text: what the artifact must measure, how it
 * fails, what to do on each failing side, the evidence guard, and the class's
 * sampling profile. Null when the tier does not exist (never invent a bar).
 */
export function tierContractText(projectRoot: string, tierKey: string): string | null {
  const tier = loadTierByKey(projectRoot, tierKey);
  if (!tier) return null;
  const cls = classOfTierKey(tier.key);
  const spec = resolveClass(cls);
  const provenance = tier.builtin
    ? 'built-in class prior — harvested frontier envelope, measured on the artifact itself, no reference media'
    : `from ${tier.anchorCount} anchor(s)`;
  const lines: string[] = [
    `TARGET QUALITY CONTRACT — tier ${tier.key} (${spec.artifact} class, extractor v${tier.extractorVersion}, ${provenance})`,
    'The artifact is measured on these axes; it must land at or inside every band:',
  ];
  for (const [axis, threshold] of Object.entries(tier.thresholds)) {
    const axisSpec = spec.axes[axis];
    const low = axisSpec?.directives.low ? ` if under: ${axisSpec.directives.low};` : '';
    const high = axisSpec?.directives.high ? ` if over: ${axisSpec.directives.high};` : '';
    lines.push(`- ${axis}: ${bandOf(threshold)}.${low}${high}`);
  }
  if (spec.degenerate) {
    lines.push(
      `Evidence guard: a degenerate artifact (the ${cls} class's washed/empty shape) fails outright regardless of the axes — fix the evidence before the numbers.`,
    );
  }
  const sampling = spec.sampling;
  if (sampling) {
    lines.push(
      `Sampling for this class: temperature ${sampling.temperature}${sampling.topP !== undefined ? `, top_p ${sampling.topP}` : ''} (precision classes run cold; executors may pin lower for stability).`,
    );
  }
  return lines.join('\n');
}

/**
 * Append the contract to an executor prompt — the composition helper the
 * uplift loop's generator uses (Wave 1.3: the executor prompt carries the
 * contract). Returns the prompt unchanged when the tier does not exist.
 */
export function withTierContract(prompt: string, projectRoot: string, tierKey: string): string {
  const contract = tierContractText(projectRoot, tierKey);
  if (!contract) return prompt;
  return `${prompt}\n\n${contract}`;
}

/** Tier keys visible to a project (project + fleet-global), optionally filtered by class. */
export function tierKeysFor(projectRoot: string, cls?: string): string[] {
  const store = resolveTiers(projectRoot);
  return Object.keys(store.tiers)
    .filter((k) => (cls ? classOfTierKey(k) === cls : true))
    .sort();
}
