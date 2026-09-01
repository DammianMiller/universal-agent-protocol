import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  QualityBaseline, baselinePath, loadBaseline, ratchet, writeBaseline,
} from '../../src/quality/baseline.js';
import { Violation } from '../../src/quality/scanner.js';
import { buildReport } from '../../src/quality/report.js';
import { writeDefaultConfig } from '../../src/quality/config.js';

function v(file: string, metric: Violation['metric'], value: number, site = '<file>'): Violation {
  return {
    file,
    metric,
    value,
    threshold: 0,
    signature: `${file}::${metric}::${site}`,
    message: `${file} ${metric}=${value}`,
  };
}

describe('ratchet semantics', () => {
  const baseline: QualityBaseline = {
    version: 1,
    generatedAt: '2026-08-31T00:00:00Z',
    entries: [
      { signature: 'a.ts::cyclomatic::tangle@1', value: 30 },
      { signature: 'b.ts::locPerFile::<file>', value: 600 },
    ],
  };

  it('blocks violations with no baseline entry (new debt)', () => {
    const r = ratchet([v('new.ts', 'cyclomatic', 25, 'f@1')], baseline);
    expect(r.blocking).toHaveLength(1);
    expect(r.grandfathered).toHaveLength(0);
  });

  it('blocks violations worse than the baseline value', () => {
    const r = ratchet([v('a.ts', 'cyclomatic', 31, 'tangle@1')], baseline);
    expect(r.blocking).toHaveLength(1);
  });

  it('grandfather violations at or below the baseline value', () => {
    const r = ratchet(
      [v('a.ts', 'cyclomatic', 30, 'tangle@1'), v('a.ts', 'cyclomatic', 25, 'tangle@1')],
      baseline
    );
    expect(r.blocking).toHaveLength(0);
    expect(r.grandfathered).toHaveLength(2);
  });

  it('records improved violations so the baseline can shrink', () => {
    const r = ratchet([v('a.ts', 'cyclomatic', 25, 'tangle@1')], baseline);
    expect(r.improved).toHaveLength(1);
    expect(r.improved[0].baselineValue).toBe(30);
  });

  it('blocks everything when no baseline exists (fail-closed for new debt)', () => {
    const r = ratchet([v('a.ts', 'cyclomatic', 30, 'tangle@1')], null);
    expect(r.blocking).toHaveLength(1);
  });
});

describe('baseline persistence + report integration', () => {
  let proj: string;

  beforeAll(() => {
    proj = mkdtempSync(join(tmpdir(), 'uap-qb-'));
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeDefaultConfig(proj);
    writeFileSync(
      join(proj, 'src', 'bad.ts'),
      [
        'export function tangle(a: number, b: number, c: number): any {',
        '  let x: any = a;',
        '  if (a > 0) { if (b > 0) { if (c > 0) { x = a + b + c; } } }',
        '  for (let i = 0; i < a; i++) { while (b > 0) { if (c && i) { b--; } else if (i) { b -= 2; } } }',
        '  return x as any;',
        '}',
      ].join('\n')
    );
  });
  afterAll(() => rmSync(proj, { recursive: true, force: true }));

  it('a fresh scan blocks, a written baseline ratchets to pass', () => {
    const before = buildReport(proj, loadConfig(proj), { builtinOnly: true });
    expect(before.pass).toBe(false);
    expect(before.blocking.length).toBeGreaterThan(0);

    writeBaseline(proj, before.violations);
    expect(existsSync(baselinePath(proj))).toBe(true);

    const after = buildReport(proj, loadConfig(proj), { builtinOnly: true });
    expect(after.pass).toBe(true);
    expect(after.grandfathered.length).toBe(before.violations.length);
  });

  it('worsening a grandfathered violation re-blocks it, and new violation classes block', () => {
    // Make the file worse: more `any` usage (5 vs the baselined 3) AND a
    // nesting deep enough to cross the cognitive threshold — a brand-new
    // violation class with no baseline entry, which must also block.
    writeFileSync(
      join(proj, 'src', 'bad.ts'),
      [
        'export function tangle(a: number, b: number, c: number): any {',
        '  let x: any = a;',
        '  let y: any = b;',
        '  if (a > 0) { if (b > 0) { if (c > 0) { if (x) { if (y) { x = a + b + c; } } } } }',
        '  for (let i = 0; i < a; i++) { while (b > 0) { if (c && i) { b--; } else if (i) { b -= 2; } } }',
        '  return (x as any) ?? (y as any);',
        '}',
      ].join('\n')
    );
    const r = buildReport(proj, loadConfig(proj), { builtinOnly: true });
    expect(r.pass).toBe(false);
    expect(r.blocking.some((x) => x.metric === 'anyTypes')).toBe(true);
    expect(r.blocking.some((x) => x.metric === 'cognitive')).toBe(true);
  });

  it('baseline round-trips through JSON', () => {
    const b = loadBaseline(proj);
    expect(b).not.toBeNull();
    expect(b!.entries.length).toBeGreaterThan(0);
    const onDisk = JSON.parse(readFileSync(baselinePath(proj), 'utf-8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.entries[0]).toHaveProperty('signature');
    expect(onDisk.entries[0]).toHaveProperty('value');
  });
});

function loadConfig(proj: string) {
  const cfg = JSON.parse(readFileSync(join(proj, '.uap', 'quality-metrics.json'), 'utf-8'));
  return {
    version: 1 as const,
    thresholds: cfg.thresholds,
    excludeDirs: cfg.excludeDirs,
    sourceExts: cfg.sourceExts,
  };
}

describe('coverage + CRAP via coverage-summary.json', () => {
  let proj: string;

  beforeAll(() => {
    proj = mkdtempSync(join(tmpdir(), 'uap-qcov-'));
    mkdirSync(join(proj, 'src'), { recursive: true });
    mkdirSync(join(proj, 'coverage'), { recursive: true });
    writeDefaultConfig(proj);
    writeFileSync(
      join(proj, 'src', 'hot.ts'),
      [
        'export function pick(a: number): number {',
        ...Array.from({ length: 8 }, (_, i) => `  if (a === ${i}) return ${i};`),
        '  return -1;',
        '}',
      ].join('\n')
    );
    // 60% line coverage on src/hot.ts.
    writeFileSync(
      join(proj, 'coverage', 'coverage-summary.json'),
      JSON.stringify({
        total: { lines: { pct: 60 } },
        [join(proj, 'src', 'hot.ts')]: { lines: { pct: 60 } },
      })
    );
  });
  afterAll(() => rmSync(proj, { recursive: true, force: true }));

  it('emits a coverage violation whose value is the DEFICIT (higher = worse)', () => {
    const r = buildReport(proj, loadConfig(proj), { builtinOnly: true });
    const cov = r.violations.find((x) => x.metric === 'coverage');
    expect(cov).toBeDefined();
    expect(cov!.value).toBeCloseTo(40, 1); // 100 - 60
    expect(cov!.message).toContain('60.0%');
  });

  it('coverage ratchets like every metric: regression blocks, improvement is grandfathered', () => {
    const first = buildReport(proj, loadConfig(proj), { builtinOnly: true });
    writeBaseline(proj, first.violations); // deficit 40 frozen

    // Regression: coverage drops to 50% (deficit 50 > 40) -> BLOCKS.
    writeFileSync(
      join(proj, 'coverage', 'coverage-summary.json'),
      JSON.stringify({ [join(proj, 'src', 'hot.ts')]: { lines: { pct: 50 } } })
    );
    const worse = buildReport(proj, loadConfig(proj), { builtinOnly: true });
    expect(worse.blocking.some((x) => x.metric === 'coverage')).toBe(true);

    // Improvement: coverage rises to 80% (deficit 20 < 40) -> grandfathered.
    writeFileSync(
      join(proj, 'coverage', 'coverage-summary.json'),
      JSON.stringify({ [join(proj, 'src', 'hot.ts')]: { lines: { pct: 80 } } })
    );
    const better = buildReport(proj, loadConfig(proj), { builtinOnly: true });
    expect(better.blocking.some((x) => x.metric === 'coverage')).toBe(false);
    expect(better.grandfathered.some((x) => x.metric === 'coverage')).toBe(true);
    expect(better.improved.some((x) => x.violation.metric === 'coverage')).toBe(true);
  });

  it('flags CRAP on untested-but-complex functions (cc=9, cov=60% -> 9²·0.4³+9 ≈ 14.2)', () => {
    const r = buildReport(proj, loadConfig(proj), { builtinOnly: true });
    const crap = r.violations.find((x) => x.metric === 'crap');
    // cc 9 at 60% coverage is under the 25 threshold…
    if (crap) {
      expect(crap.value).toBeCloseTo(14.2, 0);
    }
    // …but at 0% coverage the same function is 9²+9 = 90, well past 25.
    writeFileSync(
      join(proj, 'coverage', 'coverage-summary.json'),
      JSON.stringify({ [join(proj, 'src', 'hot.ts')]: { lines: { pct: 0 } } })
    );
    const zero = buildReport(proj, loadConfig(proj), { builtinOnly: true });
    const crapZero = zero.violations.find((x) => x.metric === 'crap');
    expect(crapZero).toBeDefined();
    expect(crapZero!.value).toBeCloseTo(90, 0);
  });
});
