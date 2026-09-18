/**
 * ROUTING EVAL — measures rank-1 *description separability* of the pattern,
 * droid, and skill registries against curated fixtures with planted traps.
 *
 * This is a separability proxy, not a replica of production routing: the
 * production pattern router is keyword-substring multi-match, and droids and
 * skills are routed by the LLM reading descriptions. What this eval guards
 * is the shared failure mode — descriptions that stop being distinguishable
 * as the registry grows. For patterns, a parity baseline against the real
 * PatternRouter is reported alongside (informational, not gated).
 *
 * Kind-scoped ranking: a fixture case declares its surface (pattern, droid,
 * or skill) and is ranked only against that surface, matching how the
 * surfaces are actually consumed (pattern router vs Task subagent_type vs
 * Skill invocation). Threshold failures exit nonzero in CI.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { TfIdfIndex } from './tfidf.js';
import {
  loadRoutingCorpus,
  type RoutingEntry,
  type RoutingKind,
} from './routing-corpus.js';
import { PatternRouter } from '../coordination/pattern-router.js';

/** All routable surfaces — add a fourth kind here, not in two places. */
export const ROUTING_KINDS: RoutingKind[] = ['pattern', 'droid', 'skill'];

export interface RoutingEvalCase {
  kind: RoutingKind;
  query: string;
  /** Expected entry id within the kind, or null for "should match nothing". */
  expect: string | null;
  /** Planted trap: deliberately confusable with a near-neighbor entry. */
  trap?: boolean;
  note?: string;
}

export interface CaseResult {
  kind: RoutingKind;
  query: string;
  expect: string | null;
  actual: string | null;
  score: number;
  /** rank1 minus rank2 score for positive cases — near-tie fragility gauge. */
  margin: number;
  /** Distinct content tokens shared between query and top-ranked entry. */
  overlap: number;
  pass: boolean;
  trap: boolean;
}

export interface KindReport {
  total: number;
  passed: number;
  rank1Accuracy: number;
}

export interface RoutingEvalReport {
  total: number;
  passed: number;
  failed: number;
  /** Rank-1 accuracy over positive (non-null expect) cases. */
  rank1Accuracy: number;
  trapTotal: number;
  trapPassed: number;
  negativeTotal: number;
  negativePassed: number;
  perKind: Record<string, KindReport>;
  /** Corpus entries embedded from a body fallback (weak routing surface). */
  weakEntries: string[];
  failures: CaseResult[];
  /** Smallest rank1–rank2 margin among passing positive cases. */
  minMargin: number;
  /** Entries whose bare name exists under more than one kind (cross-kind collision). */
  crossKindNames: string[];
  /** PatternRouter (keyword multi-match) inclusion rate on pattern positives. */
  patternRouterBaseline: { total: number; included: number } | null;
  threshold: number;
  meetsThreshold: boolean;
}

export const DEFAULT_CASES_PATH = 'evals/routing/cases.json';
export const DEFAULT_THRESHOLD = 0.9;
/**
 * Backstop ceiling on a negative case's top cosine score. The real negative
 * gate is token overlap (below) — calibration showed cosine alone cannot
 * separate near-domain negatives (single high-idf shared token, score up to
 * ~0.31) from weak positives (down to ~0.23), so this only catches
 * pathological full-coverage matches.
 */
export const DEFAULT_NEGATIVE_MAX_SCORE = 0.5;
/**
 * Real negative gate: a route claim resting on at most one shared content
 * token is not a route. Negatives with 2+ distinct shared tokens fail.
 * Ranker-agnostic, unlike a cosine ceiling.
 */
export const DEFAULT_NEGATIVE_MAX_OVERLAP = 1;

/** Load and validate eval cases from JSON. Throws on malformed fixtures. */
export function loadEvalCases(path: string): RoutingEvalCase[] {
  if (!existsSync(path)) {
    throw new Error(`routing eval cases not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as { version?: number; cases: unknown[] };
  // Honor the fixture format version: a ranker swap changes score semantics,
  // so unknown versions must force recalibration instead of silently reusing
  // fixtures calibrated for a different scorer.
  if (raw.version !== 1) {
    throw new Error(`routing eval cases malformed: unsupported version "${String(raw.version)}" in ${path}`);
  }
  if (!Array.isArray(raw.cases)) {
    throw new Error(`routing eval cases malformed: missing "cases" array in ${path}`);
  }
  const kinds = new Set(['pattern', 'droid', 'skill']);
  return raw.cases.map((c, i) => {
    const kase = c as Partial<RoutingEvalCase>;
    if (!kinds.has(String(kase.kind))) {
      throw new Error(`case ${i}: invalid kind "${String(kase.kind)}"`);
    }
    if (typeof kase.query !== 'string' || kase.query.length < 5) {
      throw new Error(`case ${i}: query missing or too short`);
    }
    if (kase.expect !== null && typeof kase.expect !== 'string') {
      throw new Error(`case ${i}: expect must be a string id or null`);
    }
    return kase as RoutingEvalCase;
  });
}

function evaluateCase(
  kase: RoutingEvalCase,
  entries: RoutingEntry[],
  index: TfIdfIndex,
  negativeMaxScore: number,
  negativeMaxOverlap: number,
): CaseResult {
  const scores = index.score(kase.query);
  let topIdx = -1;
  let top = 0;
  let second = 0;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > top) {
      second = top;
      top = scores[i];
      topIdx = i;
    } else if (scores[i] > second) {
      second = scores[i];
    }
  }
  const actual = topIdx >= 0 ? entries[topIdx].id : null;
  const overlap = topIdx >= 0 ? index.sharedTokens(kase.query, topIdx).length : 0;
  const pass =
    kase.expect === null
      ? overlap <= negativeMaxOverlap && top <= negativeMaxScore
      : actual === kase.expect;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    kind: kase.kind,
    query: kase.query,
    expect: kase.expect,
    actual,
    score: round(top),
    margin: round(top - second),
    overlap,
    pass,
    trap: kase.trap === true,
  };
}

function emptyKindReport(): KindReport {
  return { total: 0, passed: 0, rank1Accuracy: 0 };
}

export interface RunRoutingEvalOptions {
  casesPath?: string;
  threshold?: number;
  negativeMaxScore?: number;
  negativeMaxOverlap?: number;
  /** Pre-loaded cases (unit tests inject synthetic fixtures). */
  cases?: RoutingEvalCase[];
  /** Pre-loaded corpus (unit tests inject synthetic corpora). */
  corpus?: RoutingEntry[];
}

export function runRoutingEval(
  projectDir: string,
  options: RunRoutingEvalOptions = {},
): RoutingEvalReport {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const negativeMaxScore = options.negativeMaxScore ?? DEFAULT_NEGATIVE_MAX_SCORE;
  const negativeMaxOverlap = options.negativeMaxOverlap ?? DEFAULT_NEGATIVE_MAX_OVERLAP;
  const cases =
    options.cases ?? loadEvalCases(join(projectDir, options.casesPath ?? DEFAULT_CASES_PATH));
  const corpus = options.corpus ?? loadRoutingCorpus(projectDir);

  // Fixture integrity: every expected id must exist in its kind's corpus.
  for (const kase of cases) {
    if (kase.expect === null) continue;
    if (!corpus.some((e) => e.kind === kase.kind && e.id === kase.expect)) {
      throw new Error(
        `fixture integrity: case "${kase.query.slice(0, 60)}…" expects unknown ${kase.kind} "${kase.expect}"`,
      );
    }
  }

  // One TF-IDF index per kind — kind-scoped ranking matches how the
  // surfaces are consumed (pattern router vs droid registry vs skills).
  const indexes = new Map<RoutingKind, { entries: RoutingEntry[]; index: TfIdfIndex }>();
  for (const kind of ROUTING_KINDS) {
    const entries = corpus.filter((e) => e.kind === kind);
    if (entries.length > 0) {
      indexes.set(kind, { entries, index: new TfIdfIndex(entries.map((e) => e.text)) });
    }
  }

  const results: CaseResult[] = [];
  for (const kase of cases) {
    const surface = indexes.get(kase.kind);
    if (!surface) {
      throw new Error(`routing corpus is empty for kind "${kase.kind}"`);
    }
    results.push(
      evaluateCase(kase, surface.entries, surface.index, negativeMaxScore, negativeMaxOverlap),
    );
  }

  const positives = results.filter((r) => r.expect !== null);
  if (positives.length === 0) {
    // Guard against a silently vacuous pass: with no positive cases the
    // accuracy gate is meaningless, so this is an error, not a 100% run.
    throw new Error('routing eval has no positive cases — refusing to pass vacuously');
  }
  const traps = results.filter((r) => r.trap);
  const negatives = results.filter((r) => r.expect === null);
  const failures = results.filter((r) => !r.pass);
  const rank1Accuracy = positives.filter((r) => r.pass).length / positives.length;

  const perKind: Record<string, KindReport> = {};
  for (const kind of ROUTING_KINDS) {
    const kindPositives = positives.filter((r) => r.kind === kind);
    const report = emptyKindReport();
    report.total = kindPositives.length;
    report.passed = kindPositives.filter((r) => r.pass).length;
    report.rank1Accuracy = report.total === 0 ? 1 : report.passed / report.total;
    perKind[kind] = report;
  }

  const passingPositives = positives.filter((r) => r.pass);
  const minMargin = Math.min(...passingPositives.map((r) => r.margin));

  // Cross-kind name collisions: the production LLM sees all registries at
  // once, so a name that exists as both droid and skill is a real routing
  // hazard even though the eval ranks kind-scoped. Surfaced as a warning.
  const kindsByName = new Map<string, Set<RoutingKind>>();
  for (const e of corpus) {
    if (!kindsByName.has(e.id)) kindsByName.set(e.id, new Set());
    kindsByName.get(e.id)!.add(e.kind);
  }
  const crossKindNames = [...kindsByName.entries()]
    .filter(([, kinds]) => kinds.size > 1)
    .map(([name]) => name);

  // Parity baseline: run pattern positives through the production keyword
  // router and measure inclusion rate (multi-match, so rank-1 n/a).
  // Skipped for injected synthetic corpora (unit tests).
  let patternRouterBaseline: RoutingEvalReport['patternRouterBaseline'] = null;
  if (options.corpus === undefined) {
    const router = new PatternRouter();
    if (router.loadPatterns(projectDir)) {
      const patternCases = cases.filter((c) => c.kind === 'pattern' && c.expect !== null);
      const included = patternCases.filter((c) =>
        router.matchPatterns(c.query).some((p) => String(p.id) === c.expect),
      ).length;
      patternRouterBaseline = { total: patternCases.length, included };
    }
  }

  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: failures.length,
    rank1Accuracy,
    trapTotal: traps.length,
    trapPassed: traps.filter((r) => r.pass).length,
    negativeTotal: negatives.length,
    negativePassed: negatives.filter((r) => r.pass).length,
    perKind,
    weakEntries: corpus.filter((e) => !e.hasDescription).map((e) => e.key),
    failures,
    minMargin,
    crossKindNames,
    patternRouterBaseline,
    threshold,
    // Gate: rank-1 accuracy over positives must clear the threshold, and
    // every negative case must stay below the no-match score ceiling —
    // false-routing garbage input is a hard fail, not a percentage point.
    meetsThreshold:
      rank1Accuracy >= threshold && negatives.every((r) => r.pass),
  };
}

/** Human-readable summary for CLI output. */
export function formatReport(report: RoutingEvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `rank-1 accuracy: ${pct(report.rank1Accuracy)} (threshold ${pct(report.threshold)})`,
    `cases: ${report.passed}/${report.total} passed` +
      ` | traps: ${report.trapPassed}/${report.trapTotal}` +
      ` | negatives: ${report.negativePassed}/${report.negativeTotal}`,
    ...Object.entries(report.perKind).map(
      ([kind, r]) => `  ${kind}: ${pct(r.rank1Accuracy)} (${r.passed}/${r.total})`,
    ),
    `min rank1-rank2 margin (passing positives): ${report.minMargin.toFixed(3)}`,
  ];
  if (report.patternRouterBaseline) {
    const b = report.patternRouterBaseline;
    lines.push(`production pattern-router inclusion baseline: ${b.included}/${b.total}`);
  }
  if (report.crossKindNames.length > 0) {
    lines.push(`cross-kind name collisions: ${report.crossKindNames.join(', ')}`);
  }
  if (report.weakEntries.length > 0) {
    lines.push(`weak entries (no description, body fallback): ${report.weakEntries.join(', ')}`);
  }
  for (const f of report.failures) {
    lines.push(
      `FAIL [${f.kind}] "${f.query.slice(0, 70)}" → got ${f.actual ?? '∅'} (${f.score}), expected ${f.expect ?? 'no match'}`,
    );
  }
  lines.push(report.meetsThreshold ? 'PASS' : 'FAIL — below threshold');
  return lines.join('\n');
}
