/**
 * Quality report orchestration: collect files, run every available metric,
 * merge external-tool numbers over built-in heuristics, compute CRAP from
 * coverage, and split violations into blocking vs grandfathered via the
 * ratchet baseline.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';
import { QualityConfig } from './config.js';
import { Violation, isScannableSource, scanContent, MetricId } from './scanner.js';
import { analyzeComplexity } from './complexity.js';
import { languageForFile } from './languages.js';
import { crapScore, coverageFor, loadCoverageSummary } from './crap.js';
import {
  ToolStatus, jscpdViolations, lizardViolations, probeTools, rcaViolations,
} from './tools.js';
import { QualityBaseline, loadBaseline, ratchet } from './baseline.js';

export interface QualityReport {
  root: string;
  filesScanned: number;
  violations: Violation[];
  blocking: Violation[];
  grandfathered: Violation[];
  improved: Array<{ violation: Violation; baselineValue: number }>;
  /** Metrics skipped because their tool/data source is unavailable. */
  skipped: Array<{ metric: string; reason: string }>;
  tools: ToolStatus[];
  pass: boolean;
  baselinePresent: boolean;
}

/** Recursively collect scannable source files under root/src (or root). */
export function collectSourceFiles(root: string, config: QualityConfig): string[] {
  const seeds = ['src', 'tools', 'scripts', 'web'].filter((d) => existsSync(join(root, d)));
  const dirs = seeds.length > 0 ? seeds : ['.'];
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!config.excludeDirs.includes(name)) walk(p);
        continue;
      }
      const rel = relative(root, p).replace(/\\/g, '/');
      if (isScannableSource(rel, config)) out.push(rel);
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out.sort();
}

/** Files changed vs the upstream base PLUS staged/unstaged/untracked work —
 * a per-commit gate that only sees committed diffs would miss the commit's
 * actual content. */
export function changedFiles(root: string, config: QualityConfig): string[] {
  const found = new Set<string>();
  const tryGit = (args: string): boolean => {
    try {
      const out = execSync(`git ${args}`, { cwd: root, encoding: 'utf-8', timeout: 10_000 });
      for (const l of out.split('\n')) {
        const f = l.trim();
        if (f) found.add(f);
      }
      return true;
    } catch {
      return false;
    }
  };
  let baseResolved = false;
  for (const base of ['origin/master', 'origin/main', 'master', 'main']) {
    if (tryGit(`diff --name-only ${base}...HEAD`)) {
      baseResolved = true;
      break;
    }
  }
  // Uncommitted work: staged, unstaged, and untracked source files.
  tryGit('diff --name-only --cached');
  tryGit('diff --name-only');
  tryGit('ls-files --others --exclude-standard');
  if (!baseResolved && found.size === 0) {
    console.error('quality: no upstream base resolvable and no working-tree changes — scanning nothing');
  }
  return [...found].filter((f) => isScannableSource(f, config)).sort();
}

export interface ReportOptions {
  /** Explicit relative file list; default: full scan of collectSourceFiles. */
  files?: string[];
  /** Skip external tools even when installed (fast path / tests). */
  builtinOnly?: boolean;
}

type Skipped = Array<{ metric: string; reason: string }>;

/** Stage 1: the always-available built-in scan. */
function builtinScan(root: string, files: string[], config: QualityConfig): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    let content = '';
    try {
      content = readFileSync(join(root, f), 'utf-8');
    } catch {
      continue;
    }
    out.push(...scanContent(f, content, config));
  }
  return out;
}

function hasTool(tools: ToolStatus[], name: string): boolean {
  return tools.some((t) => t.name === name && t.available);
}

/** Stage 2a: lizard's authoritative cyclomatic/NLOC numbers replace the
 * built-in ones when lizard is installed. */
function applyLizard(
  violations: Violation[], files: string[], root: string, config: QualityConfig,
  options: ReportOptions, skipped: Skipped
): Violation[] {
  if (options.builtinOnly) return violations;
  if (!hasTool(probeCached(options), 'lizard')) {
    skipped.push({ metric: 'cyclomatic(authoritative)', reason: 'lizard not installed — built-in heuristic used' });
    return violations;
  }
  const lv = lizardViolations(files.map((f) => join(root, f)), root, config);
  if (!lv) return violations;
  return [...violations.filter((v) => v.metric !== 'cyclomatic' && v.metric !== 'locPerFile'), ...lv];
}

/** Stage 2b: rust-code-analysis cognitive/Halstead replaces built-in
 * cognitive when installed. */
function applyRca(
  violations: Violation[], files: string[], root: string, config: QualityConfig,
  options: ReportOptions, skipped: Skipped
): Violation[] {
  if (options.builtinOnly) return violations;
  if (!hasTool(probeCached(options), 'rust-code-analysis')) {
    skipped.push({ metric: 'halsteadDifficulty', reason: 'rust-code-analysis not installed' });
    return violations;
  }
  const rv = rcaViolations(files.map((f) => join(root, f)), root, config);
  if (!rv) return violations;
  return [...violations.filter((v) => v.metric !== 'cognitive'), ...rv];
}

/** Stage 3: coverage deficit + per-function CRAP, from vitest's
 * coverage/coverage-summary.json. */
function coverageStage(root: string, files: string[], config: QualityConfig, skipped: Skipped): Violation[] {
  const coverage = loadCoverageSummary(root);
  if (!coverage) {
    skipped.push({ metric: 'coverage', reason: 'no coverage/coverage-summary.json (run npm run test:coverage)' });
    skipped.push({ metric: 'crap', reason: 'needs coverage data' });
    return [];
  }
  const t = config.thresholds;
  const out: Violation[] = [];
  for (const f of files) {
    const cov = coverageFor(coverage, root, f);
    if (cov === null) continue;
    if (cov * 100 < t.minCoveragePct) {
      // The ratchet treats HIGHER value as worse, but coverage is better
      // when higher — store the DEFICIT (threshold − pct) so a coverage
      // regression ratchets up and an improvement ratchets down, like
      // every other metric.
      const deficit = Math.round((t.minCoveragePct - cov * 100) * 10) / 10;
      out.push({
        file: f,
        metric: 'coverage',
        value: deficit,
        threshold: t.minCoveragePct,
        signature: `${f}::coverage::<file>`,
        message: `${f}: ${(cov * 100).toFixed(1)}% line coverage below min ${t.minCoveragePct}% (deficit ${deficit})`,
      });
    }
    out.push(...crapViolations(root, f, cov, t.maxCrap));
  }
  return out;
}

/** CRAP per function: file coverage × function complexity. */
function crapViolations(root: string, f: string, cov: number, maxCrap: number): Violation[] {
  const lang = languageForFile(f);
  if (!lang) return [];
  let content = '';
  try {
    content = readFileSync(join(root, f), 'utf-8');
  } catch {
    return [];
  }
  const out: Violation[] = [];
  for (const fn of analyzeComplexity(content, lang).functions) {
    const score = crapScore(fn.cyclomatic, cov);
    if (score > maxCrap) {
      out.push({
        file: f,
        metric: 'crap',
        value: Math.round(score * 10) / 10,
        threshold: maxCrap,
        signature: `${f}::crap::${fn.name}@${fn.line}`,
        message: `${f}:${fn.line} ${fn.name}() CRAP ${score.toFixed(1)} (cc=${fn.cyclomatic}, cov=${(cov * 100).toFixed(0)}%) exceeds max ${maxCrap}`,
      });
    }
  }
  return out;
}

/** Stage 4: jscpd duplication. */
function duplicationStage(root: string, config: QualityConfig, options: ReportOptions, skipped: Skipped): Violation[] {
  if (options.builtinOnly) return [];
  if (!hasTool(probeCached(options), 'jscpd')) {
    skipped.push({ metric: 'duplicateBlocks', reason: 'jscpd not installed' });
    return [];
  }
  return jscpdViolations(root, config) ?? [];
}

/** Stage 5: note metrics that are report-only or have no available tool. */
function noteUnavailable(options: ReportOptions, skipped: Skipped): void {
  if (options.builtinOnly) return;
  if (!hasTool(probeCached(options), 'knip') && !hasTool(probeCached(options), 'vulture')) {
    skipped.push({ metric: 'deadCode', reason: 'knip/vulture not installed' });
  }
  skipped.push({ metric: 'survivingMutants', reason: 'run `uap quality mutate` (changed-files incremental)' });
}

/** Probe tools once per report; stage helpers read the cached list. */
const probeCache = new WeakMap<ReportOptions, ToolStatus[]>();
function probeCached(options: ReportOptions): ToolStatus[] {
  let t = probeCache.get(options);
  if (!t) {
    t = options.builtinOnly ? [] : probeTools();
    probeCache.set(options, t);
  }
  return t;
}

/** Build the full quality report for a set of files. */
export function buildReport(
  root: string,
  config: QualityConfig,
  options: ReportOptions = {}
): QualityReport {
  const files = options.files ?? collectSourceFiles(root, config);
  const skipped: Skipped = [];
  const tools = probeCached(options);

  let violations = builtinScan(root, files, config);
  violations = applyLizard(violations, files, root, config, options, skipped);
  violations = applyRca(violations, files, root, config, options, skipped);
  violations.push(...coverageStage(root, files, config, skipped));
  violations.push(...duplicationStage(root, config, options, skipped));
  noteUnavailable(options, skipped);

  // Ratchet against the baseline.
  const baseline: QualityBaseline | null = loadBaseline(root);
  const r = ratchet(violations, baseline);

  return {
    root,
    filesScanned: files.length,
    violations,
    blocking: r.blocking,
    grandfathered: r.grandfathered,
    improved: r.improved,
    skipped,
    tools,
    pass: r.blocking.length === 0,
    baselinePresent: baseline !== null,
  };
}

export type { MetricId };
