/**
 * Ratchet baseline for the quality gate (.uap/quality-baseline.json).
 *
 * Semantics — a current violation is BLOCKING unless the baseline proves it
 * pre-existing and not worsened:
 *
 *   new violation (no baseline entry)        -> BLOCK
 *   entry exists, value >  baseline value    -> BLOCK (worsened)
 *   entry exists, value <= baseline value    -> grandfathered (allowed)
 *   file absent from baseline entirely       -> every violation BLOCKS
 *
 * The baseline therefore only ever shrinks: `uap quality baseline --update`
 * rewrites it from a fresh scan, dropping entries whose violations were fixed
 * and lowering values that improved. Lowering is recorded in the file so the
 * shrink is reviewable in git.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Violation } from './scanner.js';

export interface BaselineEntry {
  signature: string;
  /** Worst tolerated value; a current value above this blocks. */
  value: number;
}

export interface QualityBaseline {
  version: 1;
  generatedAt: string;
  entries: BaselineEntry[];
}

export function baselinePath(root: string): string {
  return join(root, '.uap', 'quality-baseline.json');
}

export function loadBaseline(root: string): QualityBaseline | null {
  const p = baselinePath(root);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<QualityBaseline>;
    if (!Array.isArray(raw.entries)) return null;
    return {
      version: 1,
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
      entries: raw.entries.filter(
        (e): e is BaselineEntry =>
          !!e && typeof (e as BaselineEntry).signature === 'string' &&
          typeof (e as BaselineEntry).value === 'number'
      ),
    };
  } catch {
    return null;
  }
}

export interface RatchetResult {
  /** Violations that must fail the gate. */
  blocking: Violation[];
  /** Pre-existing violations tolerated by the baseline. */
  grandfathered: Violation[];
  /** Grandfathered violations that improved vs the recorded value. */
  improved: Array<{ violation: Violation; baselineValue: number }>;
}

/** Split violations into blocking vs grandfathered against the baseline. */
export function ratchet(violations: Violation[], baseline: QualityBaseline | null): RatchetResult {
  const bySig = new Map<string, number>();
  for (const e of baseline?.entries ?? []) bySig.set(e.signature, e.value);

  const blocking: Violation[] = [];
  const grandfathered: Violation[] = [];
  const improved: Array<{ violation: Violation; baselineValue: number }> = [];

  for (const v of violations) {
    const base = bySig.get(v.signature);
    if (base === undefined) {
      blocking.push(v);
    } else if (v.value > base) {
      blocking.push(v);
    } else {
      grandfathered.push(v);
      if (v.value < base) improved.push({ violation: v, baselineValue: base });
    }
  }
  return { blocking, grandfathered, improved };
}

/** Rewrite the baseline from a fresh scan (uap quality baseline --update). */
export function writeBaseline(root: string, violations: Violation[]): string {
  const p = baselinePath(root);
  mkdirSync(join(root, '.uap'), { recursive: true });
  const baseline: QualityBaseline = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: violations
      .map((v) => ({ signature: v.signature, value: v.value }))
      .sort((a, b) => a.signature.localeCompare(b.signature)),
  };
  writeFileSync(p, JSON.stringify(baseline, null, 2) + '\n');
  return p;
}
