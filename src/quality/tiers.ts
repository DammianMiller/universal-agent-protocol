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
import { listAnchors, TierVector } from './tier.js';
import { classOfTierKey, extractorVersionFor, resolveClass } from './classes.js';

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

/**
 * Read an axis value from a vector, class-generically (Wave 1.1): the scalars
 * map first, then the legacy named visual fields — so pre-1.1 stored anchors
 * and fresh non-visual vectors both resolve.
 */
export function scalarOfVector(v: TierVector, axis: string): number | undefined {
  const fromScalars = v.scalars?.[axis];
  if (fromScalars !== undefined) return fromScalars;
  const legacy = (v as unknown as Record<string, unknown>)[axis];
  return typeof legacy === 'number' ? legacy : undefined;
}

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
 * Derive a tier from a class's anchors (at the class's extractor version) and
 * persist it. Returns null when the class has no usable anchors — the caller
 * reports and fails; a tier with no anchors must never be invented.
 *
 * Wave 1.1: the axes come from the CLASS's registry entry, and an axis enters
 * the tier only when EVERY anchor measures it — partial evidence must not
 * invent a threshold (fail-closed on the axis, fail-soft on the class).
 */
export function deriveTier(
  projectRoot: string,
  cls: string,
  name = 'default',
  tolerance = DEFAULT_TOLERANCE,
): TierProfile | null {
  const spec = resolveClass(cls);
  const version = extractorVersionFor(cls);
  const loaded = listAnchors(projectRoot, cls, version);
  // Degenerate anchors (the Goodhart guard's evidence shapes) never set
  // policy — an exemplar that cannot support a verdict must not define one.
  const anchors = loaded.filter((a) => !spec.degenerate?.(a.vector));
  if (anchors.length === 0) return null;
  const axisTable = spec.axes;
  const thresholds: Record<string, TierThreshold> = {};
  for (const [axis, spec] of Object.entries(axisTable)) {
    const values: number[] = [];
    for (const a of anchors) {
      const v = scalarOfVector(a.vector, axis);
      if (v === undefined) break;
      values.push(v);
    }
    // Every anchor must measure the axis, or the axis is not derived.
    if (values.length !== anchors.length) continue;
    const med = median(values);
    if (spec.direction === 'min') thresholds[axis] = { min: r5(med * tolerance) };
    else if (spec.direction === 'max') thresholds[axis] = { max: r5(med / tolerance) };
    else thresholds[axis] = { min: r5(med * tolerance), max: r5(med / tolerance) };
  }
  const tier: TierProfile = {
    key: `${cls}/${name}`,
    anchors: anchors.map((a) => a.path),
    anchorCount: anchors.length,
    extractorVersion: version,
    derivedAt: new Date().toISOString(),
    tolerance,
    thresholds,
  };
  saveTier(projectRoot, tier);
  return tier;
}

/**
 * Compare a measured vector against a tier: verdict + per-axis critique. Pure.
 *
 * Wave 1.1: the gapped axes are the TIER's own thresholds (any class), the
 * directives come from the tier's class registry entry, and a degenerate
 * measurement (the Goodhart guard — a washed frame, an empty transcript)
 * fails FIRST with the directive naming the evidence problem.
 */
export function compileGap(vector: TierVector, tier: TierProfile, capturePath = ''): GapReport {
  const cls = classOfTierKey(tier.key);
  const spec = resolveClass(cls);
  const axes: AxisGap[] = [];

  const degenerate = spec.degenerate?.(vector) ?? null;
  if (degenerate) {
    axes.push({
      axis: 'degenerate',
      value: 0,
      threshold: {},
      status: 'fail',
      delta: 0,
      severity: 1,
      directive: degenerate,
    });
  }

  for (const [axis, threshold] of Object.entries(tier.thresholds)) {
    const raw = scalarOfVector(vector, axis);
    if (raw === undefined) {
      // The tier gates this axis but the vector does not carry it — that is a
      // broken probe, reported as such rather than laundered into a pass.
      axes.push({
        axis,
        value: NaN,
        threshold,
        status: 'fail',
        delta: NaN,
        severity: 1,
        directive: `unmeasured axis: this ${spec.artifact} did not produce a value for ${axis} — the measurement is broken, not the artifact`,
      });
      continue;
    }
    const value = raw;
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
    const directive = side ? spec.axes[axis]?.directives[side] ?? null : null;
    axes.push({
      axis,
      value,
      threshold,
      status,
      delta: status === 'fail' ? r5(rawDelta) : 0,
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
  | { kind: 'unreadable'; cls: string };

/** Measure an artifact and gap it against a stored tier. Fails closed on every seam. */
export function gapReport(projectRoot: string, capturePath: string, tierKey: string): GapResult {
  const store = loadTiers(projectRoot);
  const tier = store.tiers[tierKey];
  if (!tier) return { kind: 'no-tier', known: Object.keys(store.tiers) };
  const cls = classOfTierKey(tier.key);
  if (tier.extractorVersion !== extractorVersionFor(cls)) {
    return { kind: 'stale-tier', tierVersion: tier.extractorVersion };
  }
  // The tier's class selects the extractor: a visual tier reads PNG captures,
  // an api-behavior tier reads API transcripts — never silently cross-read.
  const vector = resolveClass(cls).extract(capturePath);
  if (!vector) return { kind: 'unreadable', cls };
  return { kind: 'ok', report: compileGap(vector, tier, capturePath) };
}
