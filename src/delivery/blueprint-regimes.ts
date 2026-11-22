/**
 * Blueprint quality regimes + art direction (U-I frontier regimes).
 *
 * Extracted from the Phase 0 outcome-blueprint module so both stay under the
 * LOC budget: this file owns the two demands that generalize frontier
 * ambition/ideation WITHOUT any runtime reference media —
 *
 *   (1) SELF-MEASURABLE numeric regimes: per-axis in-regime ranges plus the
 *       deterministic extraction method measured on the artifact itself, and
 *   (2) exactly ONE named art direction: a single ideation stance plus the
 *       principles applying it consistently (mixed stances read amateur).
 *
 * It also owns the auto-merge gate: a rendered-visual task whose blueprint
 * declared no regimes falls back to the built-in class prior — the frontier
 * envelope harvested across BOTH frontier art directions and baked into the
 * binary (src/quality/class-priors.ts), measured on the artifact's own
 * captures, never a reference.
 */

import { priorTierForClass } from '../quality/class-priors.js';

/** A self-measurable quality axis with a numeric in-regime range (U-I). */
export interface BlueprintQualityRegime {
  /** The axis name (e.g. "structure density", "brightness", "latency p95"). */
  axis: string;
  /** The numeric in-regime range, measured on the artifact ITSELF (e.g. "edgeFrac >= 0.088"). */
  range: string;
  /** The deterministic extraction method — how the axis is measured with no reference media. */
  howMeasured: string;
}

/** The chosen ideation codex (U-I): ONE named art stance + how it applies. */
export interface BlueprintArtDirection {
  /** The single named stance chosen once for the whole artifact (e.g. "restrained-premium"). */
  stance: string;
  /** 3-6 principles applying the stance consistently across the artifact. */
  principles: string[];
}

export interface RawQualityRegime {
  axis?: string;
  range?: string;
  howMeasured?: string;
  how_measured?: string;
}

export interface RawArtDirection {
  stance?: string;
  principles?: string[];
}

/** The payload fields the regime/art-direction parsers read (camel or snake). */
export interface RegimePayload {
  qualityRegimes?: RawQualityRegime[];
  quality_regimes?: RawQualityRegime[];
  artDirection?: RawArtDirection;
  art_direction?: RawArtDirection;
}

/** Trim/filter/cap a raw string list (tolerant of absence and junk entries). */
export function cleanStringList(input: string[] | undefined, cap = 12): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item): item is string => typeof item === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, cap);
}

/** Parse self-measured quality regimes (tolerant of absence — U-I). */
export function parseQualityRegimes(obj: RegimePayload): BlueprintQualityRegime[] {
  const raw = obj.qualityRegimes ?? obj.quality_regimes ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is RawQualityRegime => Boolean(r && typeof r === 'object'))
    .map((r) => ({
      axis: typeof r.axis === 'string' ? r.axis.trim() : '',
      range: typeof r.range === 'string' ? r.range.trim() : '',
      howMeasured:
        typeof (r.howMeasured ?? r.how_measured) === 'string'
          ? String(r.howMeasured ?? r.how_measured).trim()
          : '',
    }))
    .filter((r) => r.axis.length > 0 && r.range.length > 0)
    .slice(0, 10);
}

/** Parse the chosen art direction (tolerant of absence — U-I). */
export function parseArtDirection(obj: RegimePayload): BlueprintArtDirection | undefined {
  const raw = obj.artDirection ?? obj.art_direction;
  if (!raw || typeof raw !== 'object') return undefined;
  const stance = typeof raw.stance === 'string' ? raw.stance.trim() : '';
  const principles = cleanStringList(raw.principles, 8);
  if (stance.length === 0 && principles.length === 0) return undefined;
  return {
    stance: stance || 'a single named art direction applied consistently',
    principles,
  };
}

/** Task language that implies a rendered-visual artifact (the class-prior auto-merge gate). */
export const VISUAL_SCENE_HINT =
  /three\.?js|webgl|webgpu|3-?d|voxel|scene|render|shader|game|animation|animated|visual|canvas|pagoda|island|diorama|ui\b|interface|page|dashboard|landing/i;

/**
 * The built-in class prior as binding quality regimes (U-I auto-merge): when
 * the model declared no self-measured regimes and the task is a rendered-
 * visual artifact, the harvested frontier envelope fills in — measured on the
 * artifact's own captures, no reference media involved.
 */
export function priorQualityRegimes(cls: string): BlueprintQualityRegime[] {
  const prior = priorTierForClass(cls);
  if (!prior) return [];
  return Object.entries(prior.thresholds).map(([axis, t]) => ({
    axis,
    range:
      t.min !== undefined && t.max !== undefined
        ? `${t.min}..${t.max}`
        : t.min !== undefined
          ? `>= ${t.min}`
          : `<= ${t.max}`,
    howMeasured: `uap quality gap --file <capture> --tier ${prior.key} (built-in ${cls} class prior, extractor v1 — measures the artifact itself, never a reference)`,
  }));
}

/**
 * Fill regimes from the class prior when the blueprint declared none and the
 * task is a rendered-visual artifact. Declared regimes are NEVER overwritten.
 * Returns true when the prior was merged in.
 */
export function fillPriorRegimes(
  bp: { qualityRegimes?: BlueprintQualityRegime[] },
  instruction: string
): boolean {
  if (bp.qualityRegimes !== undefined && bp.qualityRegimes.length > 0) return false;
  if (!VISUAL_SCENE_HINT.test(instruction)) return false;
  bp.qualityRegimes = priorQualityRegimes('visual-scene');
  return bp.qualityRegimes.length > 0;
}

/** Markdown lines for the persisted blueprint (empty when absent). */
export function regimesMarkdownLines(regimes: BlueprintQualityRegime[] | undefined): string[] {
  if (!regimes || regimes.length === 0) return [];
  const lines = ['## Quality Regimes (self-measured, binding — no reference media)'];
  for (const q of regimes) {
    lines.push(`- **${q.axis}**: ${q.range} *(measure: ${q.howMeasured})*`);
  }
  lines.push('');
  return lines;
}

/** Markdown lines for the chosen art direction (empty when absent). */
export function artDirectionMarkdownLines(ad: BlueprintArtDirection | undefined): string[] {
  if (!ad) return [];
  const lines = ['## Art Direction (one stance, applied consistently)', `- **Stance**: ${ad.stance}`];
  for (const p of ad.principles) lines.push(`- ${p}`);
  lines.push('');
  return lines;
}

/** The binding contract section for the loop prompt (null when absent). */
export function regimesContractSection(
  regimes: BlueprintQualityRegime[] | undefined
): string | null {
  if (!regimes || regimes.length === 0) return null;
  return (
    "Quality regimes (SELF-MEASURED and binding — measure the artifact's own captures/output, no reference media; NOT DONE while any axis measures out of regime):\n" +
    regimes.map((q) => `  - ${q.axis}: ${q.range} (measure: ${q.howMeasured})`).join('\n')
  );
}

/** The binding art-direction contract section (null when absent). */
export function artDirectionContractSection(ad: BlueprintArtDirection | undefined): string | null {
  if (!ad) return null;
  return (
    `Art direction — ONE stance chosen once and applied consistently: ${ad.stance}` +
    (ad.principles.length > 0 ? '\n' + ad.principles.map((p) => `  - ${p}`).join('\n') : '')
  );
}

/** Blueprint prompt items 9-10 — the generalized ambition/ideation demands. */
export const REGIMES_PROMPT_ITEMS: string[] = [
  '9. "qualityRegimes": 3-6 SELF-MEASURABLE quality axes for the artifact, each a numeric in-regime range plus a deterministic extraction method — the artifact measures ITSELF (pixel statistics, element counts, timings, text metrics) and iterates until every axis is in regime. NO reference media is required or consulted: the ranges come from what the task language demands ("bright" → high mean value and lifted shadows; "detailed"/"intricate" → high structure density and palette vocabulary; "subtle glow" → small but NONZERO emissive coverage; "fast" → bounded latency) and from any built-in class prior for the artifact class (rendered visual scenes carry a harvested frontier envelope — `uap quality gap` measures captures against it). Capture each as {"axis","range","howMeasured"}. These are binding: the build is not DONE while any declared axis measures out of regime.',
  '10. "artDirection": choose exactly ONE named ideation stance for the whole artifact and declare 3-6 principles applying it consistently. Frontier-grade work picks a single art direction and carries it everywhere — e.g. "restrained-premium" (suppressed selective accents, soft palette, generous negative space, faint distant elements) or "theatrical-premium" (bold emissives, saturated palette, dramatic focal glow) — while mixed stances read amateur. The principles must cover: composition hierarchy (one focal mass, negative space counterweight), depth layering (near/mid/far with atmospheric desaturation), ONE coherent light story, motion hierarchy (slow ambient vs quick focal), detail gradient (dense at the focus, sparse at the periphery), and palette discipline (dominant ramp + bounded accents). Capture as {"stance","principles"}.',
];

/** The direct-mode injection tail (items 7-8 of the reactor directive). */
export const REGIMES_INJECTION_TEXT =
  '(7) declare 3-6 SELF-MEASURABLE quality regimes: numeric in-regime ranges with deterministic extraction methods measured on the artifact ITSELF (no reference media needed — for rendered visuals, `uap quality gap` measures captures against the harvested frontier class prior), and the build is not done while any declared axis measures out of regime, and ' +
  '(8) choose ONE named art direction / ideation stance and apply it consistently everywhere (composition hierarchy, depth layering, one coherent light story, motion hierarchy, detail gradient, palette discipline) — mixed stances read amateur.';
