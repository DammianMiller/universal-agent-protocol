/**
 * CRAP (Change Risk Anti-Patterns) score: cc^2 * (1 - cov)^3 + cc
 * where cc is cyclomatic complexity and cov is the line-coverage fraction.
 *
 * Function-level coverage is not reliably available from every provider, so
 * the gate computes CRAP per function using the FILE's line-coverage fraction
 * — an approximation documented in the policy. A file with 0% coverage makes
 * CRAP = cc^2 + cc, so untested complex functions blow past the threshold
 * fast, which is exactly the pressure the metric exists to apply.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export function crapScore(cyclomatic: number, coverageFraction: number): number {
  const c = Math.min(1, Math.max(0, coverageFraction));
  return cyclomatic * cyclomatic * Math.pow(1 - c, 3) + cyclomatic;
}

/**
 * Parse per-file line-coverage fractions from a vitest/istanbul
 * coverage-summary.json (`<root>/coverage/coverage-summary.json`).
 * Returns null when absent — coverage metrics are then skipped (fail-open
 * with a logged warning), matching the missing-tool policy.
 */
export function loadCoverageSummary(root: string): Map<string, number> | null {
  const p = join(root, 'coverage', 'coverage-summary.json');
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<
      string,
      { lines?: { pct?: number } }
    >;
    const out = new Map<string, number>();
    for (const [file, data] of Object.entries(raw)) {
      if (file === 'total') continue;
      const pct = data?.lines?.pct;
      if (typeof pct === 'number') out.set(file, pct / 100);
    }
    return out;
  } catch {
    return null;
  }
}

/** Resolve the coverage fraction for a scanned file, tolerating path shape. */
export function coverageFor(coverage: Map<string, number>, root: string, file: string): number | null {
  const norm = file.replace(/\\/g, '/');
  for (const [covFile, pct] of coverage) {
    const cf = covFile.replace(/\\/g, '/');
    if (cf === norm || cf === join(root, norm).replace(/\\/g, '/') || cf.endsWith(`/${norm}`)) {
      return pct;
    }
  }
  return null;
}
