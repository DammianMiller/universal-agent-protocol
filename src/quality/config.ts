/**
 * Quality-metrics gate configuration.
 *
 * Lives at `.uap/quality-metrics.json` (committed, per project). The gate is
 * INACTIVE (fails open) when the file is absent — quality policing is opt-in
 * per project via `uap quality init`, exactly like the design-token gate is
 * inactive without a DESIGN.md.
 *
 * Every threshold mirrors the policing targets:
 *   cyclomatic < 22 · cognitive < 22 · halstead difficulty < 80
 *   LOC/file < 500 · coverage 100% · CRAP < 25 · surviving mutants 0
 *   dead code 0 · redundant (duplicate) code 0 · explicit any/unknown 0
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface QualityThresholds {
  /** Max cyclomatic complexity per function. */
  maxCyclomatic: number;
  /** Max cognitive complexity per function. */
  maxCognitive: number;
  /** Max Halstead difficulty per function (requires rust-code-analysis). */
  maxHalsteadDifficulty: number;
  /** Max non-blank, non-comment lines per file. */
  maxLocPerFile: number;
  /** Min line-coverage percent per file (0-100). */
  minCoveragePct: number;
  /** Max CRAP score per function: cc^2 * (1-cov)^3 + cc. */
  maxCrap: number;
  /** Max surviving mutants (changed-files incremental run). */
  maxSurvivingMutants: number;
  /** Max duplicated-block findings (jscpd clones over the token floor). */
  maxDuplicateBlocks: number;
  /** Max dead-code findings (knip / vulture / compiler dead_code). */
  maxDeadCode: number;
  /** Max explicit any/unknown type usages (TS: any/unknown, Py: typing.Any). */
  maxAnyTypes: number;
}

export interface QualityConfig {
  version: 1;
  thresholds: QualityThresholds;
  /** Glob-ish directory prefixes to exclude from scanning. */
  excludeDirs: string[];
  /** File extensions considered source (others are ignored). */
  sourceExts: string[];
}

export const DEFAULT_THRESHOLDS: QualityThresholds = {
  maxCyclomatic: 22,
  maxCognitive: 22,
  maxHalsteadDifficulty: 80,
  maxLocPerFile: 500,
  minCoveragePct: 100,
  maxCrap: 25,
  maxSurvivingMutants: 0,
  maxDuplicateBlocks: 0,
  maxDeadCode: 0,
  maxAnyTypes: 0,
};

export const DEFAULT_SOURCE_EXTS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.cs', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
  '.rs', '.go', '.rb', '.php', '.swift', '.kt', '.scala',
];

export const DEFAULT_EXCLUDE_DIRS = [
  'node_modules', 'dist', 'build', 'out', 'target', 'coverage',
  '.git', '.worktrees', 'vendor', '__pycache__', '.venv', 'venv',
  'benchmarks', 'benchmark-results', 'third_party', 'generated',
];

export function configPath(root: string): string {
  return join(root, '.uap', 'quality-metrics.json');
}

export function defaultConfig(): QualityConfig {
  return {
    version: 1,
    thresholds: { ...DEFAULT_THRESHOLDS },
    excludeDirs: [...DEFAULT_EXCLUDE_DIRS],
    sourceExts: [...DEFAULT_SOURCE_EXTS],
  };
}

/** Load the config, or null when the gate is inactive (no config file). */
export function loadQualityConfig(root: string): QualityConfig | null {
  const p = configPath(root);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<QualityConfig>;
    const d = defaultConfig();
    return {
      version: 1,
      thresholds: { ...d.thresholds, ...(raw.thresholds ?? {}) },
      excludeDirs: raw.excludeDirs ?? d.excludeDirs,
      sourceExts: raw.sourceExts ?? d.sourceExts,
    };
  } catch {
    // A corrupt config must not silently disable policing, but crashing the
    // gate is worse — fail open and let `uap quality check` surface the error.
    return null;
  }
}

/** Write the default config (uap quality init). */
export function writeDefaultConfig(root: string): string {
  const p = configPath(root);
  mkdirSync(join(root, '.uap'), { recursive: true });
  writeFileSync(p, JSON.stringify(defaultConfig(), null, 2) + '\n');
  return p;
}
