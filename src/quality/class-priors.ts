/**
 * Built-in class-prior tiers (U-I frontier regimes) — the reference-free
 * quality bar.
 *
 * The tier system digitizes quality: `deriveTier` turns ANCHOR exemplars into
 * thresholds and `compileGap` measures captures against them. But derivation
 * needs anchors, and a project with no reference material got the tier gate's
 * "no derived tiers" skip — the executor never saw a numeric bar (the live
 * counterfactual: voxel-pagoda runs 3-4 shipped 5/7 axes below the frontier
 * register with nothing measuring them).
 *
 * Class priors close that seam WITHOUT requiring reference material at
 * runtime: the reference was consumed ONCE at harvest time, and what ships is
 * numbers. A prior is a TierProfile baked into the code, resolved (behind the
 * project and fleet-global stores) whenever a class has no tier of its own.
 * Anchor-derived and published tiers always win — a prior is the floor for
 * projects that never curated exemplars, never an override for those that did.
 *
 * Harvest provenance (visual-scene/frontier-prior, extractor v1):
 *   Source: dual-panel frontier comparison video 889410aa-7dcf-4acf-be09-
 *   5d9c6abcc01e (2026-11), same prompt rendered by Kimi 3.1 Pro ($5.71) and
 *   Opus 5.5 ($17.13): "Build a beautiful, fully animated 3D voxel-style
 *   pagoda island using Three.js and React." Ten clean 928x904 panel stills
 *   (frames 150/330/420/690/840) measured with extractTierVector.
 *
 *   The exemplar set is BIMODAL by art direction — Opus chose restrained-
 *   premium (glowFrac 0.006-0.014, satMean ~0.29) and Kimi chose theatrical-
 *   premium (glowFrac 0.12-0.26, satMean ~0.38). Median derivation (the
 *   anchor doctrine) would fail one frontier direction, so priors use
 *   ENVELOPE semantics: the band spans what ANY frontier exemplar
 *   demonstrated, widened by the standard tolerance. Measured envelopes
 *   (min..max across the ten stills, extractor v1):
 *     colors12  1182..1404    edgeFrac  0.11702..0.16720
 *     glowFrac  0.00614..0.25665   darkFrac  0.00119..0.01564
 *     contrast  0.20109..0.24436   valMean   0.77097..0.83283
 *     satMean   0.28630..0.38423
 *
 *   Thresholds below = envelope floor x 0.75 (min axes) / envelope ceiling
 *   ÷ 0.75 (max axes), both for bands — the deriveTier tolerance doctrine
 *   applied to the envelope instead of the median. The run-3 local capture
 *   (colors12 485, edgeFrac 0.024, glowFrac 0.0023, darkFrac 0.244, valMean
 *   0.571) fails 5 of 7 axes against this prior; every frontier still passes
 *   by construction. That separation IS the generalization: the amateur tier
 *   sits far outside the frontier envelope on the axes that carry the
 *   perception of quality, and no reference file is needed to say so.
 *
 * Escape hatch: UAP_TIER_PRIORS=off (priors only; anchor/global tiers and
 * UAP_TIER_GATE semantics are untouched).
 */
import { TIER_EXTRACTOR_VERSION } from './tier.js';
import type { TierProfile } from './tiers.js';

/** The deriveTier tolerance doctrine, applied to the harvest envelope. */
const PRIOR_TOLERANCE = 0.75;

/** Baked harvest date — priors are code constants, not runtime derivations. */
const PRIOR_HARVESTED_AT = '2026-11-22T00:00:00.000Z';

const VISUAL_SCENE_PRIOR: TierProfile = {
  key: 'visual-scene/frontier-prior',
  anchors: [],
  anchorCount: 0,
  extractorVersion: TIER_EXTRACTOR_VERSION,
  derivedAt: PRIOR_HARVESTED_AT,
  tolerance: PRIOR_TOLERANCE,
  builtin: true,
  thresholds: {
    // palette vocabulary: floor 1182 x 0.75
    colors12: { min: 886.5 },
    // structure density: floor 0.11702 x 0.75
    edgeFrac: { min: 0.08777 },
    // emissive presence: envelope band [0.00614 x 0.75, 0.25665 / 0.75] —
    // the low side fails dead scenes, the high side fails luminous washes
    glowFrac: { min: 0.00461, max: 0.3422 },
    // crushed blacks: ceiling 0.01564 / 0.75
    darkFrac: { max: 0.02085 },
    // tonal balance: envelope band [0.20109 x 0.75, 0.24436 / 0.75]
    contrast: { min: 0.15082, max: 0.32581 },
    // overall exposure: floor 0.77097 x 0.75
    valMean: { min: 0.57823 },
    // chroma discipline: envelope band [0.28630 x 0.75, 0.38423 / 0.75]
    satMean: { min: 0.21473, max: 0.51231 },
  },
};

const PRIORS: TierProfile[] = [VISUAL_SCENE_PRIOR];

/** Every built-in class prior (extend as new classes are harvested). */
export function builtinPriorTiers(): TierProfile[] {
  return PRIORS.map((p) => ({ ...p, thresholds: { ...p.thresholds } }));
}

/** The built-in prior for one class, or null when the class has none. */
export function priorTierForClass(cls: string): TierProfile | null {
  const found = PRIORS.find((p) => p.key.startsWith(`${cls}/`));
  return found ? { ...found, thresholds: { ...found.thresholds } } : null;
}

/**
 * Format a prior's thresholds as binding fidelity-target lines — the
 * blueprint auto-merge uses these so even a thin blueprint carries the
 * frontier numbers as self-measurable targets (no reference comparison).
 */
export function priorFidelityTargets(cls: string): string[] {
  const prior = priorTierForClass(cls);
  if (!prior) return [];
  const lines: string[] = [];
  for (const [axis, t] of Object.entries(prior.thresholds)) {
    const range =
      t.min !== undefined && t.max !== undefined
        ? `${axis} between ${t.min} and ${t.max}`
        : t.min !== undefined
          ? `${axis} >= ${t.min}`
          : `${axis} <= ${t.max}`;
    lines.push(
      `Self-measured frontier regime (${cls} class prior, extractor v1): ${range} — ` +
        `measure the artifact's own captures with \`uap quality gap\` and iterate until every axis is in regime; ` +
        `no reference media is needed or consulted`
    );
  }
  return lines;
}
