/**
 * Tier derivation + gap compiler — quality-tier uplift plan 0.2.
 *
 * A tier is thresholds derived from the anchor medians of an outcome class
 * (docs/plans/quality-tier-uplift-2026-11-16.md): the bar comes from
 * measured exemplars, never vibes, and ships as an editable, reviewed policy
 * file (.uap/quality/tiers.json, project-local). The tolerance is a
 * multiplicative floor: a min axis allows `median * tolerance`, a max axis
 * allows `median / tolerance`, a band axis allows both sides. The default
 * 0.75 means "at worst 25% below the bar" — tighten with --tolerance.
 *
 * The gap report is both verdict and critique: per-axis pass/fail with the
 * signed delta, a normalized severity (so the convergence loop can fix the
 * single biggest gap first, P39 style), and one directional directive per
 * failing axis an executor can act on without ever seeing the reference.
 *
 * Fail closed: a tier derived by a different extractor version is refused,
 * never silently compared (stale evidence fails closed).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { extractTierVector, listAnchors, TIER_EXTRACTOR_VERSION, TierVector } from './tier.js';

export const DEFAULT_TOLERANCE = 0.75;

export interface TierThreshold {
  min?: number;
  max?: number;
}

export interface TierProfile {
  key: string;
  anchors: string[];
  anchorCount: number;
  extractorVersion: number;
  derivedAt: string;
  tolerance: number;
  thresholds: Record<string, TierThreshold>;
}

export interface AxisGap {
  axis: string;
  value: number;
  threshold: TierThreshold;
  status: 'pass' | 'fail';
  /** Signed distance past the failing bound (0 on pass). */
  delta: number;
  /** 0..1, distance past the bound relative to the bound (0 on pass). */
  severity: number;
  /** Directional fix directive for the failing side, null on pass. */
  directive: string | null;
}

export interface GapReport {
  tier: string;
  capture: string;
  pass: boolean;
  failing: number;
  /** Failing axes first, ordered by severity; passing axes after. */
  axes: AxisGap[];
  worst: string | null;
  vector: TierVector;
  tierProfile: TierProfile;
}

/** The gated scalar axes: direction is how a capture can FAIL them. */
const AXES = {
  colors12: 'min',
  edgeFrac: 'min',
  glowFrac: 'min',
  darkFrac: 'max',
  contrast: 'band',
  valMean: 'min',
  satMean: 'band',
} as const;
type ScalarAxis = keyof typeof AXES;
type Direction = 'min' | 'max' | 'band';

/**
 * Directional directives, P39-flavored: each names the craft move for that
 * failing side. `low` fires when the value is under a min (or under a band);
 * `high` when over a max (or over a band).
 */
const DIRECTIVES: Record<ScalarAxis, { low?: string; high?: string }> = {
  colors12: {
    low: 'palette vocabulary: per-material tone ramps and wider per-voxel jitter (aging, moss, grain), hue-shifted shadow tinting, multi-stop sky gradient',
  },
  edgeFrac: {
    low: 'structure density: mid-ground props and foreground silhouettes; hero framing that fills 60-85% of the frame from 35-55 degrees',
  },
  glowFrac: {
    low: 'emissive coverage: expand the glow voxel set and brighten emissives (windows, lantern fire, water sparkle), then lower the bloom threshold or raise strength',
  },
  darkFrac: {
    high: 'lighten the blacks FIRST (dim is usually dark surfaces, not exposure): lift hemisphere/ambient fill and warm the shadows before touching exposure',
  },
  contrast: {
    low: 'tonal separation: deepen selected shadows and add focal contrast toward the anchor band',
    high: 'tonal balance: one exposure and tone-map pass — the frame is bimodal (washed highlights plus crushed blacks); move both toward balanced midtones',
  },
  valMean: {
    low: 'overall exposure: raise scene brightness through fill or exposure without washing out the highlights',
    high: 'overall exposure: pull back exposure or fill; the frame is brighter than the anchor',
  },
  satMean: {
    low: 'chroma: enrich material colors toward the anchor band',
    high: 'chroma: mute the palette toward the anchor band',
  },
};

const r5 = (x: number): number => Math.round(x * 1e5) / 1e5;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function tiersPath(projectRoot: string): string {
  return join(projectRoot, '.uap', 'quality', 'tiers.json');
}

export interface TierStore {
  version: number;
  tiers: Record<string, TierProfile>;
}

const emptyStore = (): TierStore => ({ version: 1, tiers: {} });

export function loadTiers(projectRoot: string): TierStore {
  const path = tiersPath(projectRoot);
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TierStore>;
    if (parsed.version === 1 && parsed.tiers && typeof parsed.tiers === 'object') {
      return { version: 1, tiers: parsed.tiers as Record<string, TierProfile> };
    }
  } catch {
    /* malformed store — empty, callers fail closed */
  }
  return emptyStore();
}

export function saveTier(projectRoot: string, tier: TierProfile): string {
  const store = loadTiers(projectRoot);
  store.tiers[tier.key] = tier;
  const path = tiersPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
  return path;
}

/**
 * Derive a tier from a class's anchors (at the current extractor version) and
 * persist it. Returns null when the class has no usable anchors — the caller
 * reports and fails; a tier with no anchors must never be invented.
 */
export function deriveTier(
  projectRoot: string,
  cls: string,
  name = 'default',
  tolerance = DEFAULT_TOLERANCE,
): TierProfile | null {
  const anchors = listAnchors(projectRoot, cls);
  if (anchors.length === 0) return null;
  const thresholds: Record<string, TierThreshold> = {};
  for (const axis of Object.keys(AXES) as ScalarAxis[]) {
    const med = median(anchors.map((a) => a.vector[axis]));
    const direction: Direction = AXES[axis];
    if (direction === 'min') thresholds[axis] = { min: r5(med * tolerance) };
    else if (direction === 'max') thresholds[axis] = { max: r5(med / tolerance) };
    else thresholds[axis] = { min: r5(med * tolerance), max: r5(med / tolerance) };
  }
  const tier: TierProfile = {
    key: `${cls}/${name}`,
    anchors: anchors.map((a) => a.path),
    anchorCount: anchors.length,
    extractorVersion: TIER_EXTRACTOR_VERSION,
    derivedAt: new Date().toISOString(),
    tolerance,
    thresholds,
  };
  saveTier(projectRoot, tier);
  return tier;
}

const scalarOf = (v: TierVector, axis: ScalarAxis): number => v[axis];

/** Compare a measured vector against a tier: verdict + per-axis critique. Pure. */
export function compileGap(vector: TierVector, tier: TierProfile, capturePath = ''): GapReport {
  const axes: AxisGap[] = [];
  for (const axis of Object.keys(AXES) as ScalarAxis[]) {
    const threshold = tier.thresholds[axis];
    if (!threshold) continue;
    const value = scalarOf(vector, axis);
    let status: 'pass' | 'fail' = 'pass';
    let side: 'low' | 'high' | null = null;
    let bound = 0;
    if (threshold.min !== undefined && value < threshold.min) {
      status = 'fail';
      side = 'low';
      bound = threshold.min;
    } else if (threshold.max !== undefined && value > threshold.max) {
      status = 'fail';
      side = 'high';
      bound = threshold.max;
    }
    const rawDelta = status === 'fail' ? value - bound : 0;
    const severity = status === 'fail'
      ? Math.min(1, Math.abs(rawDelta) / Math.max(1e-9, Math.abs(bound)))
      : 0;
    const directive = side ? DIRECTIVES[axis][side] ?? null : null;
    axes.push({
      axis,
      value,
      threshold,
      status,
      delta: r5(rawDelta),
      severity: r5(severity),
      directive,
    });
  }
  const failing = axes
    .filter((a) => a.status === 'fail')
    .sort((a, b) => b.severity - a.severity || a.axis.localeCompare(b.axis));
  const passing = axes.filter((a) => a.status === 'pass');
  return {
    tier: tier.key,
    capture: capturePath,
    pass: failing.length === 0,
    failing: failing.length,
    axes: [...failing, ...passing],
    worst: failing[0]?.axis ?? null,
    vector,
    tierProfile: tier,
  };
}

export type GapResult =
  | { kind: 'ok'; report: GapReport }
  | { kind: 'no-tier'; known: string[] }
  | { kind: 'stale-tier'; tierVersion: number }
  | { kind: 'unreadable' };

/** Measure a capture and gap it against a stored tier. Fails closed on every seam. */
export function gapReport(projectRoot: string, capturePath: string, tierKey: string): GapResult {
  const store = loadTiers(projectRoot);
  const tier = store.tiers[tierKey];
  if (!tier) return { kind: 'no-tier', known: Object.keys(store.tiers) };
  if (tier.extractorVersion !== TIER_EXTRACTOR_VERSION) {
    return { kind: 'stale-tier', tierVersion: tier.extractorVersion };
  }
  const vector = extractTierVector(capturePath);
  if (!vector) return { kind: 'unreadable' };
  return { kind: 'ok', report: compileGap(vector, tier, capturePath) };
}
