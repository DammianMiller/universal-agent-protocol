/**
 * File scanner: turns source content into metric violations.
 *
 * Pure (no I/O beyond what callers hand it) so the CLI, the proxy enforcer's
 * TS-side parity tests, and future callers all share one code path. External
 * tool overrides (lizard numbers, jscpd clones, coverage) are merged in by
 * report.ts — this module is the always-available built-in layer.
 */
import { extname } from 'path';
import { QualityConfig } from './config.js';
import { languageForFile, stripNoise } from './languages.js';
import { analyzeComplexity } from './complexity.js';

export type MetricId =
  | 'cyclomatic'
  | 'cognitive'
  | 'halsteadDifficulty'
  | 'locPerFile'
  | 'coverage'
  | 'crap'
  | 'survivingMutants'
  | 'duplicateBlocks'
  | 'deadCode'
  | 'anyTypes';

export interface Violation {
  file: string;
  metric: MetricId;
  /** Measured value (count, complexity, or percent depending on metric). */
  value: number;
  /** Configured threshold that was crossed. */
  threshold: number;
  /**
   * Stable identity for baseline ratcheting: file + metric + the function or
   * site the violation belongs to. Function renames intentionally re-identify
   * a violation (a renamed complex function is reviewed as if new).
   */
  signature: string;
  message: string;
}

/** Explicit any/unknown usage patterns, per language family. Built from
 * strings (not regex literals) on purpose: string contents are stripped
 * before scanning, so this file does not trip the gate over its own
 * patterns. */
const ANY_PATTERNS: Array<{ langs: string[]; re: RegExp; label: string }> = [
  // `: any`, `as any`, `<any>`, `Array<any>`, `Record<string, unknown>`, …
  {
    langs: ['typescript'],
    re: new RegExp(':\\s*any\\b|:\\s*unknown\\b|\\bas\\s+any\\b|<any>|<unknown>|Array<\\s*any\\s*>', 'g'),
    label: 'explicit any/unknown',
  },
  {
    langs: ['javascript'],
    re: new RegExp('/\\*\\s*@type\\s*\\{[^}]*\\b(?:any|unknown)\\b[^}]*\\}\\s*\\*/', 'g'),
    label: 'JSDoc any/unknown',
  },
  {
    langs: ['python'],
    re: new RegExp(':\\s*Any\\b|->\\s*Any\\b|cast\\(\\s*Any\\b', 'g'),
    label: 'typing.Any',
  },
];

/** Count explicit any/unknown usages in one file's content. */
export function countAnyTypes(content: string, file: string): { count: number; lines: number[] } {
  const lang = languageForFile(file);
  if (!lang) return { count: 0, lines: [] };
  const stripped = stripNoise(content, lang.commentStyle);
  const lines = stripped.split('\n');
  const hits: number[] = [];
  for (const pat of ANY_PATTERNS) {
    if (!pat.langs.includes(lang.name)) continue;
    for (let i = 0; i < lines.length; i++) {
      pat.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.re.exec(lines[i])) !== null) {
        hits.push(i + 1);
        if (m[0].length === 0) pat.re.lastIndex++; // safety for zero-width
      }
    }
  }
  return { count: hits.length, lines: [...new Set(hits)].sort((a, b) => a - b) };
}

/**
 * Scan one file's content for the always-available metrics:
 * LOC/file, per-function cyclomatic + cognitive complexity, any-types.
 * Halstead/CRAP/coverage/mutation/duplication/dead-code need external data
 * and are merged later by report.ts.
 */
export function scanContent(file: string, content: string, config: QualityConfig): Violation[] {
  const lang = languageForFile(file);
  if (!lang) return [];
  const t = config.thresholds;
  const out: Violation[] = [];

  const { functions, loc } = analyzeComplexity(content, lang);

  if (loc > t.maxLocPerFile) {
    out.push({
      file,
      metric: 'locPerFile',
      value: loc,
      threshold: t.maxLocPerFile,
      signature: `${file}::locPerFile::<file>`,
      message: `${file}: ${loc} LOC exceeds max ${t.maxLocPerFile}`,
    });
  }

  for (const fn of functions) {
    if (fn.cyclomatic > t.maxCyclomatic) {
      out.push({
        file,
        metric: 'cyclomatic',
        value: fn.cyclomatic,
        threshold: t.maxCyclomatic,
        signature: `${file}::cyclomatic::${fn.name}@${fn.line}`,
        message: `${file}:${fn.line} ${fn.name}() cyclomatic ${fn.cyclomatic} exceeds max ${t.maxCyclomatic}`,
      });
    }
    if (fn.cognitive > t.maxCognitive) {
      out.push({
        file,
        metric: 'cognitive',
        value: fn.cognitive,
        threshold: t.maxCognitive,
        signature: `${file}::cognitive::${fn.name}@${fn.line}`,
        message: `${file}:${fn.line} ${fn.name}() cognitive ${fn.cognitive} exceeds max ${t.maxCognitive}`,
      });
    }
  }

  const anyResult = countAnyTypes(content, file);
  if (anyResult.count > t.maxAnyTypes) {
    out.push({
      file,
      metric: 'anyTypes',
      value: anyResult.count,
      threshold: t.maxAnyTypes,
      signature: `${file}::anyTypes::<file>`,
      message: `${file}: ${anyResult.count} explicit any/unknown usage(s) (lines ${anyResult.lines.slice(0, 8).join(',')}) exceed max ${t.maxAnyTypes}`,
    });
  }

  return out;
}

/** True when `file` is a scannable source path under the config's rules. */
export function isScannableSource(file: string, config: QualityConfig): boolean {
  const norm = file.replace(/\\/g, '/');
  const ext = extname(norm).toLowerCase();
  if (!config.sourceExts.includes(ext)) return false;
  for (const dir of config.excludeDirs) {
    if (norm.includes(`/${dir}/`) || norm.startsWith(`${dir}/`)) return false;
  }
  return true;
}
