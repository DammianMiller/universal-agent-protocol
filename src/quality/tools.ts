/**
 * External tool adapters. Every adapter follows the same contract:
 * unavailable tool -> null (the metric is SKIPPED with a logged warning),
 * available tool -> authoritative numbers that override the built-in
 * heuristics. Nothing here throws on a missing binary.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Violation } from './scanner.js';
import { QualityConfig, QualityThresholds } from './config.js';

export function toolAvailable(name: string): boolean {
  const r = spawnSync('which', [name], { encoding: 'utf-8', timeout: 5_000 });
  return r.status === 0;
}

export interface ToolStatus {
  name: string;
  available: boolean;
  provides: string[];
}

/** Probe every optional tool the gate can use. */
export function probeTools(): ToolStatus[] {
  return [
    { name: 'lizard', available: toolAvailable('lizard'), provides: ['cyclomatic', 'locPerFile'] },
    { name: 'rust-code-analysis', available: toolAvailable('rust-code-analysis'), provides: ['cognitive', 'halsteadDifficulty'] },
    { name: 'jscpd', available: toolAvailable('jscpd'), provides: ['duplicateBlocks'] },
    { name: 'knip', available: toolAvailable('knip'), provides: ['deadCode'] },
    { name: 'vulture', available: toolAvailable('vulture'), provides: ['deadCode (python)'] },
    { name: 'stryker', available: toolAvailable('stryker'), provides: ['survivingMutants'] },
  ];
}

interface LizardFunction {
  name: string;
  long_name?: string;
  filename?: string;
  cyclomatic_complexity: number;
  nloc: number;
  start_line?: number;
}

interface LizardFile {
  filename: string;
  function_list?: LizardFunction[];
  nloc?: number;
}

function relFromRoot(abs: string, root: string): string {
  return abs.startsWith(root) ? abs.slice(root.length + 1) : abs;
}

function lizardFnViolation(fn: LizardFunction, rel: string, t: QualityThresholds): Violation | null {
  if (fn.cyclomatic_complexity <= t.maxCyclomatic) return null;
  const name = (fn.long_name ?? fn.name).split('(')[0].trim();
  const line = (fn.start_line ?? 0) + 1;
  return {
    file: rel,
    metric: 'cyclomatic',
    value: fn.cyclomatic_complexity,
    threshold: t.maxCyclomatic,
    signature: `${rel}::cyclomatic::${name}@${line}`,
    message: `${rel}:${line} ${name}() cyclomatic ${fn.cyclomatic_complexity} (lizard) exceeds max ${t.maxCyclomatic}`,
  };
}

function lizardFileViolations(f: LizardFile, root: string, t: QualityThresholds): Violation[] {
  const rel = relFromRoot(f.filename, root);
  const out: Violation[] = [];
  if (typeof f.nloc === 'number' && f.nloc > t.maxLocPerFile) {
    out.push({
      file: rel,
      metric: 'locPerFile',
      value: f.nloc,
      threshold: t.maxLocPerFile,
      signature: `${rel}::locPerFile::<file>`,
      message: `${rel}: ${f.nloc} NLOC (lizard) exceeds max ${t.maxLocPerFile}`,
    });
  }
  for (const fn of f.function_list ?? []) {
    const v = lizardFnViolation(fn, rel, t);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Run lizard over the given files; returns cyclomatic violations using
 * lizard's authoritative CC numbers. Null when lizard is absent.
 */
export function lizardViolations(
  files: string[],
  root: string,
  config: QualityConfig
): Violation[] | null {
  if (!toolAvailable('lizard') || files.length === 0) return null;
  const r = spawnSync('lizard', ['--json', ...files], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !r.stdout) return null;
  try {
    const filesOut = JSON.parse(r.stdout) as LizardFile[];
    return filesOut.flatMap((f) => lizardFileViolations(f, root, config.thresholds));
  } catch {
    return null;
  }
}

interface RcaMetrics {
  cyclomatic?: { sum?: number };
  cognitive?: { sum?: number };
  halstead?: { difficulty?: number };
}

interface RcaUnit {
  'function-name'?: string;
  'start-line'?: number;
  metrics?: RcaMetrics;
  spaces?: RcaUnit[];
}

interface RcaFile {
  'file-name'?: string;
  metrics?: RcaMetrics;
  spaces?: RcaUnit[];
}

function* walkRca(unit: RcaUnit): Generator<RcaUnit> {
  yield unit;
  for (const s of unit.spaces ?? []) yield* walkRca(s);
}

function rcaUnitViolations(unit: RcaUnit, rel: string, t: QualityThresholds): Violation[] {
  const out: Violation[] = [];
  const fnName = unit['function-name'] ?? '<unit>';
  const line = (unit['start-line'] ?? 0) + 1;
  const cog = unit.metrics?.cognitive?.sum;
  if (typeof cog === 'number' && cog > t.maxCognitive) {
    out.push({
      file: rel,
      metric: 'cognitive',
      value: Math.round(cog),
      threshold: t.maxCognitive,
      signature: `${rel}::cognitive::${fnName}@${line}`,
      message: `${rel}:${line} ${fnName}() cognitive ${Math.round(cog)} (rust-code-analysis) exceeds max ${t.maxCognitive}`,
    });
  }
  const hd = unit.metrics?.halstead?.difficulty;
  if (typeof hd === 'number' && hd > t.maxHalsteadDifficulty) {
    out.push({
      file: rel,
      metric: 'halsteadDifficulty',
      value: Math.round(hd * 10) / 10,
      threshold: t.maxHalsteadDifficulty,
      signature: `${rel}::halsteadDifficulty::${fnName}@${line}`,
      message: `${rel}:${line} ${fnName}() Halstead difficulty ${hd.toFixed(1)} exceeds max ${t.maxHalsteadDifficulty}`,
    });
  }
  return out;
}

function rcaFileViolations(f: RcaFile, root: string, t: QualityThresholds): Violation[] {
  const rel = relFromRoot(f['file-name'] ?? '', root);
  return (f.spaces ?? []).flatMap((sp) =>
    [...walkRca(sp)].flatMap((unit) => rcaUnitViolations(unit, rel, t))
  );
}

/**
 * Run rust-code-analysis over the given files; returns cognitive-complexity
 * and Halstead-difficulty violations. Null when the tool is absent.
 */
export function rcaViolations(
  files: string[],
  root: string,
  config: QualityConfig
): Violation[] | null {
  if (!toolAvailable('rust-code-analysis') || files.length === 0) return null;
  const r = spawnSync('rust-code-analysis', ['--metrics', '-O', 'json', '-p', ...files], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!r.stdout) return null;
  try {
    const parsed = JSON.parse(r.stdout) as Record<string, RcaFile> | RcaFile[];
    const files: RcaFile[] = Array.isArray(parsed) ? parsed : Object.values(parsed);
    return files.flatMap((f) => rcaFileViolations(f, root, config.thresholds));
  } catch {
    return null;
  }
}

/**
 * Run jscpd duplication detection. Returns one violation per clone pair over
 * the threshold count. Null when jscpd is absent or the run produced no fresh
 * report (a failed/timed-out run must never re-read a STALE report and block
 * on clones that no longer exist).
 */
export function jscpdViolations(root: string, config: QualityConfig): Violation[] | null {
  if (!toolAvailable('jscpd')) return null;
  // Per-run output dir: a fixed /tmp path collides across concurrent runs and
  // leaks stale results into the next run.
  const outDir = mkdtempSync(join(tmpdir(), 'uap-jscpd-'));
  try {
    // jscpd exits non-zero when clones are found — its exit code is signal,
    // not failure. The report file's existence is what we trust.
    spawnSync(
      'jscpd',
      [root, '--reporters', 'json', '--output', outDir, '--silent', '--ignore', config.excludeDirs.map((d) => `**/${d}/**`).join(',')],
      { cwd: root, encoding: 'utf-8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 }
    );
    const reportPath = join(outDir, 'jscpd-report.json');
    if (!existsSync(reportPath)) return null;
    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
      duplicates?: Array<{ firstFile?: { name?: string }; fragment?: string }>;
    };
    const dups = report.duplicates ?? [];
    if (dups.length <= config.thresholds.maxDuplicateBlocks) return [];
    return dups.slice(0, 50).map((d) => {
      const file = (d.firstFile?.name ?? '<unknown>').replace(/\\/g, '/');
      return {
        file,
        metric: 'duplicateBlocks' as const,
        value: dups.length,
        threshold: config.thresholds.maxDuplicateBlocks,
        signature: `${file}::duplicateBlocks::<clone>`,
        message: `${file}: duplicated block (${dups.length} clone(s) exceed max ${config.thresholds.maxDuplicateBlocks})`,
      };
    });
  } catch {
    return null;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
