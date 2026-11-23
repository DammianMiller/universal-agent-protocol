/**
 * Quality outcome classes — the class-generic layer over the tier machinery.
 *
 * The 0.1/0.2 seam shipped visual-scene only: one extractor (PNG), one
 * hard-coded axis table. Wave 1.1 generalizes it: every outcome class
 * registers a ClassSpec — how to extract a deterministic vector from the
 * class's artifact, which axes it can gate with their fail directions, the
 * directional directive vocabulary for the gap compiler, and an optional
 * degenerate-evidence guard.
 *
 * The registry is also the Goodhart guard's home: a class's `degenerate`
 * predicate recognizes measurements that cannot support a verdict (a
 * near-uniform washed-out frame, an empty transcript, an empty bench run).
 * Found live in the 0.4 reference run — a ~99%-white capture PASSED glowFrac
 * and valMean while failing everything else, so the tier loop steered against
 * a symptom. A degenerate vector now fails the gap outright, first, with the
 * directive naming the evidence problem.
 *
 * Backward compatibility: classes without a registered spec (operator-chosen
 * anchor names, pre-registry projects) resolve to the VISUAL spec — the
 * original behavior was PNG-anchored for every class name, and old stores
 * (tiers.json, anchors) must keep deriving and gapping unchanged.
 */
import { readFileSync } from 'fs';
import { extractTierVector, storeAnchorRecord, TierVector } from './tier.js';
import { extractApiVector } from './api-behavior.js';
import { extractBenchVector } from './bench-score.js';
import { extractDocVector } from './doc-style.js';
import { extractIdeationVector } from './ideation.js';

export type AxisDirection = 'min' | 'max' | 'band';

/** One measurable axis: how a capture can fail it, and what to do about it. */
export interface AxisSpec {
  direction: AxisDirection;
  /** Directional fix directives; `low` under a min, `high` over a max. */
  directives: { low?: string; high?: string };
}

export interface SamplingProfile {
  /**
   * Default executor temperature for this class. Executors keep their own
   * pinned profiles; this is the class's DECLARED preference the uplift
   * loop reads when the operator has not pinned one (the small-model
   * stability doctrine still allows executors to pin lower).
   */
  temperature: number;
  /** Optional top-p companion; omitted means "leave the executor's default". */
  topP?: number;
}

export interface ClassSpec {
  cls: string;
  /** Extract a deterministic vector from an artifact file (anchor or capture). */
  extract: (path: string) => TierVector | null;
  axes: Record<string, AxisSpec>;
  /**
   * Degenerate-evidence guard. Returns a directive naming the evidence
   * problem when the vector cannot support a verdict, null when it can.
   */
  degenerate?: (v: TierVector) => string | null;
  /** Human phrase for what one artifact of this class is. */
  artifact: string;
  /**
   * The class's sampling profile (Wave 1.3): precision classes run cold
   * (a transcript must carry exact fields), generative classes run warm
   * (a scene must explore palette vocabulary). Omitted = executor default.
   */
  sampling?: SamplingProfile;
}

/* ------------------------- visual-scene (Wave 0) ------------------------- */

const VISUAL_AXES: Record<string, AxisSpec> = {
  colors12: {
    direction: 'min',
    directives: {
      low: 'palette vocabulary: per-material tone ramps and wider per-voxel jitter (aging, moss, grain), hue-shifted shadow tinting, multi-stop sky gradient',
    },
  },
  edgeFrac: {
    direction: 'min',
    directives: {
      low: 'structure density: mid-ground props and foreground silhouettes; hero framing that fills 60-85% of the frame from 35-55 degrees',
    },
  },
  glowFrac: {
    // Banded (live finding, voxel-pagoda-speedy-uap-max): a luminous wash —
    // a saturated orange sky/fog covering a third of the frame — measured
    // glowFrac 9-15x the Fable anchors and PASSED, because the axis was
    // min-only ("more glow is more presence"). Glow is frame COVERAGE: too
    // much is a wash symptom exactly like too little is a dead scene. The
    // anchors set the register on both sides. Already-derived tiers keep
    // gapping on their stored thresholds unchanged (the store is policy);
    // re-derive to pick up the band.
    direction: 'band',
    directives: {
      low: 'emissive coverage: expand the glow voxel set and brighten emissives (windows, lantern fire, water sparkle), then lower the bloom threshold or raise strength',
      high: 'glow register: the frame is a luminous wash, not a lit scene — mute the bright saturated masses (sky, fog, hot palette) toward the anchor band before touching emissives; coverage past the band measured the wash, not the lights',
    },
  },
  darkFrac: {
    direction: 'max',
    directives: {
      high: 'lighten the blacks FIRST (dim is usually dark surfaces, not exposure): lift hemisphere/ambient fill and warm the shadows before touching exposure',
    },
  },
  contrast: {
    direction: 'band',
    directives: {
      low: 'tonal separation: deepen selected shadows and add focal contrast toward the anchor band',
      high: 'tonal balance: one exposure and tone-map pass — the frame is bimodal (washed highlights plus crushed blacks); move both toward balanced midtones',
    },
  },
  valMean: {
    direction: 'min',
    directives: {
      low: 'overall exposure: raise scene brightness through fill or exposure without washing out the highlights',
      high: 'overall exposure: pull back exposure or fill; the frame is brighter than the anchor',
    },
  },
  satMean: {
    direction: 'band',
    directives: {
      low: 'chroma: enrich material colors toward the anchor band',
      high: 'chroma: mute the palette toward the anchor band',
    },
  },
};

const VISUAL_SPEC: ClassSpec = {
  cls: 'visual-scene',
  extract: extractTierVector,
  axes: VISUAL_AXES,
  artifact: 'PNG capture',
  // generative class: palette vocabulary comes from exploration, not precision
  sampling: { temperature: 0.8, topP: 0.95 },
  degenerate: (v) => {
    // The 0.4 wash signature: near-uniformly bright AND desaturated — a frame
    // whose PASSING glow/val axes measured the wash, not the scene. Saturated
    // bright frames (a red test fixture, a sunset) are legitimate evidence;
    // crushed dark frames are not laundered here — darkFrac's max axis fails
    // them loudly with its own directive, which is the correct critique.
    if (v.valMean > 0.97 && v.satMean < 0.1) {
      return 'degenerate capture: the frame is a near-white wash (uniformly bright, no chroma) — fix rendering or capture BEFORE trusting tier axes; passing glow/val here measured the wash, not the artifact (plan finding 1, Goodhart)';
    }
    return null;
  },
};

/* ---------------------------- api-behavior ------------------------------- */

const API_AXES: Record<string, AxisSpec> = {
  schemaConformance: {
    direction: 'min',
    directives: {
      low: 'API shape: every response must carry the required fields with the declared types — validate against the contract before replying',
    },
  },
  fieldCoverage: {
    direction: 'min',
    directives: {
      low: 'contract coverage: emit the full golden field inventory, including optional fields the exemplars always populated',
    },
  },
  semanticFidelity: {
    direction: 'min',
    directives: {
      low: 'response correctness: ground each response in the golden semantics — right shape with wrong values still fails the tier',
    },
  },
  latencyP95Ms: {
    direction: 'max',
    directives: {
      high: 'latency envelope: batch or parallelize the slow exchanges, cache repeated reads, and move heavy work off the critical path',
    },
  },
};

/* ----------------------------- bench-score ------------------------------- */

const BENCH_AXES: Record<string, AxisSpec> = {
  passRate: {
    direction: 'min',
    directives: {
      low: 'bench outcome: fix the failing task classes first — the tier bar is the pass-rate floor the exemplar runs set',
    },
  },
  errorRate: {
    direction: 'max',
    directives: {
      high: 'bench stability: crashes and timeouts before wrong answers — a run that errors cannot climb, stabilize the harness path first',
    },
  },
};

/* ------------------------------ doc-style -------------------------------- */

const DOC_AXES: Record<string, AxisSpec> = {
  emDashPer1k: {
    direction: 'max',
    directives: {
      high: 'punctuation: replace prose em dashes with commas, colons, or a separate sentence by context (the v2.51.1 normalization normalized 2131 corpus-wide)',
    },
  },
  sentenceLenMean: {
    direction: 'band',
    directives: {
      low: 'flow: combine choppy fragments where the meaning is continuous',
      high: 'readability: split long sentences at their natural joints — one topic per sentence',
    },
  },
  wordLenMean: {
    direction: 'band',
    directives: {
      high: 'plain words: prefer the short verb over the long nominalization',
      low: 'precision: keep the domain term where the plain word loses meaning',
    },
  },
  dupSentenceFrac: {
    direction: 'max',
    directives: {
      high: 'bloat: cut repeated sentences — the same point stated twice is duplication, not emphasis',
    },
  },
};

/* --------------------------- ideation-outcome ---------------------------- */

const IDEATION_AXES: Record<string, AxisSpec> = {
  stanceShare: {
    direction: 'min',
    directives: {
      low: 'stance: every candidate takes and KEEPS a position — commit language ("we choose X because", "X wins on Y"), never a hedge stack; a candidate that answers "what would we build?" with "it depends" is not a candidate (P48 rule 1)',
    },
  },
  compositionDepth: {
    direction: 'min',
    directives: {
      low: 'composition: decompose each candidate into its parts — mechanism, surface, failure mode as sub-structure (sub-headings, list items), not one flat paragraph of vibes',
    },
  },
  topicDiversity: {
    direction: 'min',
    directives: {
      low: 'coverage: draw from more of the solution space — the anchors set the floor for how many distinct domains and mechanisms a candidate set touches (the ambition floor, generalized out of visual-scene)',
    },
  },
  ideaDistance: {
    direction: 'min',
    directives: {
      low: 'novelty: separate the candidates — nearest-neighbor distance at the floor means the set clusters on one idea (the hivemind failure the open-collider exists to break); vary mechanism, domain, or scale until each candidate is measurably apart',
    },
  },
};

/* ------------------------------- registry -------------------------------- */

const REGISTRY: Record<string, ClassSpec> = {
  'visual-scene': VISUAL_SPEC,
  'api-behavior': {
    cls: 'api-behavior',
    extract: (p) => extractApiVector(p),
    axes: API_AXES,
    artifact: 'API transcript (JSON)',
    // precision class: a transcript must carry exact fields and values
    sampling: { temperature: 0.2 },
    degenerate: (v) =>
      (v.scalars?.exchangeCount ?? 0) < 1
        ? 'degenerate transcript: no exchanges were measured — a run with zero evidence cannot be gapped (re-run with the fixture set)'
        : null,
  },
  'bench-score': {
    cls: 'bench-score',
    extract: (p) => extractBenchVector(p),
    axes: BENCH_AXES,
    artifact: 'bench results (JSON)',
    // precision class: outcomes are deterministic or they are noise
    sampling: { temperature: 0.2 },
    degenerate: (v) =>
      (v.scalars?.taskCount ?? 0) < 1
        ? 'degenerate bench run: zero tasks recorded — the pass-rate is vacuous, re-run the suite before gapping'
        : null,
  },
  'doc-style': {
    cls: 'doc-style',
    extract: (p) => extractDocVector(p),
    axes: DOC_AXES,
    artifact: 'documentation (Markdown)',
    // writing class: moderate exploration — more than a transcript, less than a scene
    sampling: { temperature: 0.4 },
    degenerate: (v) =>
      (v.scalars?.proseChars ?? 0) < 200
        ? 'degenerate document: under 200 prose characters after stripping code, tables, and links — a config file or a stub is not doc-style evidence'
        : null,
  },
  'ideation-outcome': {
    cls: 'ideation-outcome',
    extract: (p) => extractIdeationVector(p),
    axes: IDEATION_AXES,
    artifact: 'ideation document (Markdown, one ## section per candidate)',
    // generative class: exploration IS the outcome — novelty is a gated axis,
    // so the sampling profile runs at least as warm as visual-scene
    sampling: { temperature: 0.9, topP: 0.95 },
    degenerate: (v) => {
      const n = v.scalars?.candidateCount ?? 0;
      if (n < 2) {
        return (
          'degenerate ideation artifact: fewer than 2 candidates measured — the class judges a SET of alternatives. ' +
          'Render the candidates as one ## section each (uap ideate ideas --render does) and anchor THAT'
        );
      }
      if ((v.scalars?.stanceShare ?? 1) === 0) {
        return (
          'degenerate ideation artifact: no candidate carries a stance — a list of maybes cannot support a verdict. ' +
          'Commit each candidate to a position before gapping (the stanceShare axis then polices the degree)'
        );
      }
      return null;
    },
  },
};

/**
 * Resolve a class spec. Unregistered class names resolve to the VISUAL spec —
 * the pre-registry behavior anchored PNGs under arbitrary class names, and
 * every existing store (tiers, anchors) must keep working unchanged.
 */
export function resolveClass(cls: string): ClassSpec {
  return REGISTRY[cls] ?? VISUAL_SPEC;
}

/** `visual-scene/fable-high` → `visual-scene` (everything before the first /). */
export function classOfTierKey(tierKey: string): string {
  const i = tierKey.indexOf('/');
  return i === -1 ? tierKey : tierKey.slice(0, i);
}

/**
 * Measure an artifact and store it as an anchor for its class — the general
 * form of `storeAnchor`: extraction is the CLASS's extractor, storage is the
 * same anchor layout/policy (project-local, gitignored, measuring-only).
 * Null when the artifact is unreadable for the class.
 */
export function storeArtifactAnchor(
  projectRoot: string,
  cls: string,
  artifactPath: string,
): ReturnType<typeof storeAnchorRecord> | null {
  const spec = resolveClass(cls);
  const vector = spec.extract(artifactPath);
  if (!vector) return null;
  return storeAnchorRecord(projectRoot, cls, artifactPath, vector);
}

/**
 * Read an artifact's raw text — a small helper so CLI callers can report
 * file problems without duplicating fs plumbing.
 */
export function readArtifactText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The extractor version that defines a class's measurements. */
export function extractorVersionFor(_cls: string): number {
  // v1 for every shipped class: the visual pipeline is unchanged since 0.1,
  // and api-behavior/bench-score/doc-style/ideation-outcome start at v1. A
  // class whose measurement definition changes bumps ONLY its version —
  // stored tiers of other classes must not go stale by association.
  return 1;
}
