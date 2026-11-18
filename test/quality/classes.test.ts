/**
 * Class-generic tier machinery tests — Wave 1.1: the api-behavior and
 * bench-score extractors, the class registry (axis/directive/degenerate
 * dispatch), class-generic derive/gap, cross-class refusal, and the
 * backward-compat seam (unregistered class names keep the visual behavior).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractApiVector } from '../../src/quality/api-behavior.js';
import { extractBenchVector } from '../../src/quality/bench-score.js';
import { classOfTierKey, resolveClass, storeArtifactAnchor } from '../../src/quality/classes.js';
import { storeAnchor } from '../../src/quality/tier.js';
import { compileGap, deriveTier, gapReport } from '../../src/quality/tiers.js';
import { qualityCommand } from '../../src/cli/quality.js';
import { pngPath } from './png-fixture.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-classes-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/* ------------------------------ fixtures ------------------------------- */

interface ExchangeFixture {
  request?: unknown;
  expected?: unknown;
  response?: unknown;
  latencyMs?: number;
}

function transcriptFile(name: string, exchanges: ExchangeFixture[], required: string[] = ['id', 'status']): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify({
    version: 1,
    schema: {
      required,
      properties: { id: 'string', status: 'string', items: 'array', count: 'integer' },
    },
    exchanges,
  }));
  return p;
}

function benchFile(name: string, results: Array<{ task: string; status: string }>): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify({ version: 1, results }));
  return p;
}

const ok = (latencyMs: number): ExchangeFixture => ({
  request: { op: 'list' },
  expected: { id: 'run-1', status: 'ok', items: ['a', 'b'], count: 2 },
  response: { id: 'run-1', status: 'ok', items: ['a', 'b'], count: 2 },
  latencyMs,
});

const degraded = (latencyMs: number): ExchangeFixture => ({
  request: { op: 'list' },
  expected: { id: 'run-1', status: 'ok', items: ['a', 'b'], count: 2 },
  response: { status: 'oops' }, // missing id, missing items/count, wrong status value
  latencyMs,
});

/* --------------------------- api-behavior ------------------------------ */

describe('extractApiVector', () => {
  it('measures an exemplar transcript at 1.0 on the quality axes with nearest-rank p95', () => {
    const exchanges = [ok(100), ok(300), ok(200), ok(50)];
    const v = extractApiVector(transcriptFile('exemplar.json', exchanges))!;
    expect(v.scalars?.schemaConformance).toBe(1);
    expect(v.scalars?.fieldCoverage).toBe(1);
    expect(v.scalars?.semanticFidelity).toBe(1);
    expect(v.scalars?.exchangeCount).toBe(4);
    // nearest-rank p95 of [50,100,200,300]: rank = ceil(0.95*4) = 4 → 300
    expect(v.scalars?.latencyP95Ms).toBe(300);
    expect(v.extractorVersion).toBe(1);
    expect(v.sha256).toHaveLength(64);
  });

  it('is deterministic: the same file extracts to the same vector', () => {
    const p = transcriptFile('same.json', [ok(120), ok(90)]);
    const a = extractApiVector(p)!;
    const b = extractApiVector(p)!;
    expect(a.sha256).toBe(b.sha256);
    expect(a.scalars).toEqual(b.scalars);
  });

  it('penalizes a degraded run on every quality axis', () => {
    const v = extractApiVector(transcriptFile('bad.json', [degraded(10), ok(20)]))!;
    // one of two responses misses the required id → conformance 0.5
    expect(v.scalars?.schemaConformance).toBe(0.5);
    // golden leaves per exchange: id, status, count, items.0, items.1 (arrays
    // decompose to indexed leaves); degraded exchange covers only status → 6 of 10
    expect(v.scalars?.fieldCoverage).toBeCloseTo(6 / 10, 5);
    expect(v.scalars?.semanticFidelity).toBeLessThan(0.7);
    expect(v.scalars?.semanticFidelity).toBeGreaterThan(0);
  });

  it('fails soft to null on unreadable or malformed transcripts', () => {
    expect(extractApiVector(join(tmp, 'nope.json'))).toBeNull();
    const garbage = join(tmp, 'garbage.json');
    writeFileSync(garbage, '{not json');
    expect(extractApiVector(garbage)).toBeNull();
    const noExchanges = join(tmp, 'shape.json');
    writeFileSync(noExchanges, JSON.stringify({ schema: {} }));
    expect(extractApiVector(noExchanges)).toBeNull();
  });
});

/* ---------------------------- bench-score ------------------------------ */

describe('extractBenchVector', () => {
  it('counts pass/error rates with unknown statuses as fail-but-not-error', () => {
    const v = extractBenchVector(benchFile('run.json', [
      { task: 'a', status: 'pass' },
      { task: 'b', status: 'pass' },
      { task: 'c', status: 'error' },
      { task: 'd', status: 'weird' },
    ]))!;
    expect(v.scalars?.passRate).toBe(0.5);
    expect(v.scalars?.errorRate).toBe(0.25);
    expect(v.scalars?.taskCount).toBe(4);
  });

  it('measures an empty run as zero evidence (degenerate guard territory)', () => {
    const v = extractBenchVector(benchFile('empty.json', []))!;
    expect(v.scalars?.taskCount).toBe(0);
    expect(v.scalars?.passRate).toBe(0);
  });

  it('fails soft to null on unreadable or malformed files', () => {
    expect(extractBenchVector(join(tmp, 'missing.json'))).toBeNull();
    const garbage = join(tmp, 'bad.json');
    writeFileSync(garbage, 'nope');
    expect(extractBenchVector(garbage)).toBeNull();
  });
});

/* ------------------------------ registry ------------------------------- */

describe('resolveClass + classOfTierKey', () => {
  it('each registered class carries its own artifact phrase and axes', () => {
    expect(resolveClass('visual-scene').artifact).toBe('PNG capture');
    expect(resolveClass('api-behavior').artifact).toBe('API transcript (JSON)');
    expect(resolveClass('bench-score').artifact).toBe('bench results (JSON)');
    expect(Object.keys(resolveClass('api-behavior').axes).sort()).toEqual(
      ['fieldCoverage', 'latencyP95Ms', 'schemaConformance', 'semanticFidelity'],
    );
    expect(Object.keys(resolveClass('bench-score').axes).sort()).toEqual(['errorRate', 'passRate']);
    expect(Object.keys(resolveClass('visual-scene').axes).sort()).toEqual(
      ['colors12', 'contrast', 'darkFrac', 'edgeFrac', 'glowFrac', 'satMean', 'valMean'],
    );
  });

  it('unregistered class names resolve to the visual spec (backward compat)', () => {
    const spec = resolveClass('operator-chosen-name');
    expect(spec.cls).toBe('visual-scene');
    expect(spec.artifact).toBe('PNG capture');
    expect(spec.extract(join(tmp, 'nothing.png'))).toBeNull();
  });

  it('classOfTierKey splits the tier key at the first slash', () => {
    expect(classOfTierKey('visual-scene/fable-high')).toBe('visual-scene');
    expect(classOfTierKey('api-behavior/frontier')).toBe('api-behavior');
    expect(classOfTierKey('bare')).toBe('bare');
  });
});

/* -------------------- class-generic derive + gap ----------------------- */

describe('api-behavior tier: anchor, derive, gap', () => {
  it('derives exactly the class axes from exemplar anchors and persists the tier', () => {
    storeArtifactAnchor(tmp, 'api-behavior', transcriptFile('ex1.json', [ok(100), ok(120)]));
    storeArtifactAnchor(tmp, 'api-behavior', transcriptFile('ex2.json', [ok(200), ok(220)]));
    const tier = deriveTier(tmp, 'api-behavior', 'fable-high')!;
    expect(tier.key).toBe('api-behavior/fable-high');
    expect(tier.anchorCount).toBe(2);
    expect(Object.keys(tier.thresholds).sort()).toEqual(
      ['fieldCoverage', 'latencyP95Ms', 'schemaConformance', 'semanticFidelity'],
    );
    // exemplars are perfect: quality floors at 1 * 0.75, latency max = median(120,220)/0.75
    expect(tier.thresholds.schemaConformance).toEqual({ min: 0.75 });
    expect(tier.thresholds.semanticFidelity).toEqual({ min: 0.75 });
    expect(tier.thresholds.latencyP95Ms).toEqual({ max: 226.66667 });
  });

  it('an at-tier transcript passes; a degraded transcript fails with the class directives', () => {
    storeArtifactAnchor(tmp, 'api-behavior', transcriptFile('ex.json', [ok(100), ok(150)]));
    const tier = deriveTier(tmp, 'api-behavior', 'fable-high')!;

    const good = gapReport(tmp, transcriptFile('cap.json', [ok(110), ok(140)]), 'api-behavior/fable-high');
    expect(good.kind).toBe('ok');
    expect(good.report.pass).toBe(true);

    const bad = gapReport(tmp, transcriptFile('cap-bad.json', [degraded(10), degraded(20)]), 'api-behavior/fable-high');
    expect(bad.kind).toBe('ok');
    expect(bad.report.pass).toBe(false);
    const failing = bad.report.axes.filter((a) => a.status === 'fail').map((a) => a.axis);
    expect(failing).toContain('schemaConformance');
    expect(failing).toContain('fieldCoverage');
    expect(failing).toContain('semanticFidelity');
    const directiveText = bad.report.axes.map((a) => a.directive).join(' ');
    expect(directiveText).toContain('right shape with wrong values');
  });

  it('a degenerate transcript (no exchanges) fails first with the guard directive', () => {
    storeArtifactAnchor(tmp, 'api-behavior', transcriptFile('ex.json', [ok(100)]));
    const tier = deriveTier(tmp, 'api-behavior', 'fable-high')!;
    const res = gapReport(tmp, transcriptFile('empty.json', []), 'api-behavior/fable-high');
    expect(res.kind).toBe('ok');
    expect(res.report.pass).toBe(false);
    expect(res.report.worst).toBe('degenerate');
    const guard = res.report.axes[0];
    expect(guard.axis).toBe('degenerate');
    expect(guard.directive).toContain('no exchanges');
  });

  it('refuses to derive from only-degenerate anchors', () => {
    storeArtifactAnchor(tmp, 'api-behavior', transcriptFile('empty.json', []));
    expect(deriveTier(tmp, 'api-behavior', 'x')).toBeNull();
  });
});

describe('bench-score tier: anchor, derive, gap', () => {
  it('derives pass-rate floor and error-rate ceiling; a crashing run fails both', () => {
    storeArtifactAnchor(tmp, 'bench-score', benchFile('ex.json', [
      { task: 'a', status: 'pass' },
      { task: 'b', status: 'pass' },
      { task: 'c', status: 'fail' },
    ]));
    const tier = deriveTier(tmp, 'bench-score', 'frontier')!;
    expect(tier.thresholds.passRate).toEqual({ min: 0.5 });
    expect(tier.thresholds.errorRate).toEqual({ max: 0 });

    const res = gapReport(tmp, benchFile('cap.json', [
      { task: 'a', status: 'pass' },
      { task: 'b', status: 'error' },
    ]), 'bench-score/frontier');
    expect(res.kind).toBe('ok');
    expect(res.report.pass).toBe(false);
    const failing = res.report.axes.filter((a) => a.status === 'fail').map((a) => a.axis);
    // passRate 0.5 sits exactly at the 0.5 floor (at-tier); the crash fails errorRate
    expect(failing).toEqual(['errorRate']);
    const directiveText = res.report.axes.map((a) => a.directive).join(' ');
    expect(directiveText).toContain('crashes and timeouts');
  });

  it('an empty bench run is degenerate evidence, not a pass', () => {
    storeArtifactAnchor(tmp, 'bench-score', benchFile('ex.json', [
      { task: 'a', status: 'pass' },
      { task: 'b', status: 'error' },
    ]));
    deriveTier(tmp, 'bench-score', 'frontier')!;
    const res = gapReport(tmp, benchFile('none.json', []), 'bench-score/frontier');
    expect(res.kind).toBe('ok');
    expect(res.report.pass).toBe(false);
    expect(res.report.worst).toBe('degenerate');
  });
});

describe('cross-class refusal (the tier class selects the extractor)', () => {
  it('an api tier refuses a PNG capture and a visual tier refuses a transcript', () => {
    storeArtifactAnchor(tmp, 'api-behavior', transcriptFile('ex.json', [ok(100)]));
    deriveTier(tmp, 'api-behavior', 'fable-high')!;
    const png = pngPath(tmp, 'cap.png', 16, 16, () => [255, 0, 0]);
    const res = gapReport(tmp, png, 'api-behavior/fable-high');
    expect(res.kind).toBe('unreadable');
    expect(res.kind === 'unreadable' && res.cls).toBe('api-behavior');

    storeAnchor(tmp, 'visual-scene', pngPath(tmp, 'ref.png', 16, 16, () => [255, 0, 0]));
    deriveTier(tmp, 'visual-scene', 't')!;
    const json = transcriptFile('cap2.json', [ok(1)]);
    const res2 = gapReport(tmp, json, 'visual-scene/t');
    expect(res2.kind).toBe('unreadable');
  });
});

describe('degenerate visual wash fails first (the 0.4 Goodhart guard)', () => {
  it('a near-white wash fails with the guard directive even where glow/val would pass', () => {
    const ref = pngPath(tmp, 'ref.png', 16, 16, () => [255, 0, 0]);
    storeAnchor(tmp, 'visual-scene', ref);
    const tier = deriveTier(tmp, 'visual-scene', 't')!;
    const wash = pngPath(tmp, 'wash.png', 64, 64, () => [255, 255, 255]);
    const res = gapReport(tmp, wash, 'visual-scene/t');
    expect(res.kind).toBe('ok');
    expect(res.report.pass).toBe(false);
    expect(res.report.worst).toBe('degenerate');
    expect(res.report.axes[0].directive).toContain('wash');
  });
});

describe('backward compat: unregistered classes keep the visual behavior', () => {
  it('an operator-chosen class name derives and gaps exactly like visual-scene', () => {
    const red = pngPath(tmp, 'red.png', 16, 16, () => [255, 0, 0]);
    const black = pngPath(tmp, 'black.png', 16, 16, () => [0, 0, 0]);
    storeAnchor(tmp, 'my-game', red);
    storeAnchor(tmp, 'my-game', black);
    const tier = deriveTier(tmp, 'my-game', 't')!;
    expect(Object.keys(tier.thresholds).sort()).toEqual(
      ['colors12', 'contrast', 'darkFrac', 'edgeFrac', 'glowFrac', 'satMean', 'valMean'],
    );
    const res = gapReport(tmp, black, 'my-game/t');
    expect(res.kind).toBe('ok');
    expect(res.report.pass).toBe(false);
    // black vs (red, black) medians: glow 0 vs min 0.375 fails at severity 1;
    // dark 1 vs max 0.66667 fails at 0.5 — worst is glowFrac, darkFrac follows
    expect(res.report.worst).toBe('glowFrac');
    const directiveText = res.report.axes.map((a) => a.directive).join(' ');
    expect(directiveText).toContain('lighten the blacks');
  });
});

/* ------------------------------- CLI ----------------------------------- */

describe('qualityCommand: class-generic anchor/profile/gap', () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  });

  it('anchor <api-behavior> stores and prints the class summary line', async () => {
    const p = transcriptFile('ex.json', [ok(100), ok(140)]);
    await qualityCommand('anchor', { projectDir: tmp, target: 'api-behavior', file: p });
    expect(process.exitCode).toBeUndefined();
    const out = logs.join('\n');
    expect(out).toContain('anchor api-behavior/ex');
    expect(out).toContain('schemaConformance=1');
    expect(out).toContain('latencyP95Ms=140');
  });

  it('anchor with the wrong artifact kind for the class fails with the class named', async () => {
    const png = pngPath(tmp, 'not-a-transcript.png', 8, 8, () => [0, 0, 0]);
    await qualityCommand('anchor', { projectDir: tmp, target: 'api-behavior', file: png });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('not a readable API transcript (JSON)');
  });

  it('profile --class bench-score prints the bench scalars', async () => {
    const p = benchFile('cap.json', [
      { task: 'a', status: 'pass' },
      { task: 'b', status: 'fail' },
    ]);
    await qualityCommand('profile', { file: p, class: 'bench-score' });
    expect(process.exitCode).toBeUndefined();
    const out = logs.join('\n');
    expect(out).toContain('passRate=0.5');
    expect(out).toContain('taskCount=2');
  });

  it('profile with the default class still reads PNG captures', async () => {
    const p = pngPath(tmp, 'cap.png', 16, 16, () => [255, 0, 0]);
    await qualityCommand('profile', { file: p });
    expect(process.exitCode).toBeUndefined();
    expect(logs.join('\n')).toContain('colors=1');
  });

  it('gap below an api tier exits 2 and names the worst axis', async () => {
    storeArtifactAnchor(tmp, 'api-behavior', transcriptFile('ex.json', [ok(100), ok(140)]));
    await qualityCommand('derive', { projectDir: tmp, target: 'api-behavior', name: 'fable-high' });
    logs.length = 0;
    await qualityCommand('gap', {
      projectDir: tmp,
      file: transcriptFile('bad.json', [degraded(10)]),
      tier: 'api-behavior/fable-high',
    });
    expect(process.exitCode).toBe(2);
    const out = logs.join('\n');
    expect(out).toContain('schemaConformance');
    expect(out).toContain('tier api-behavior/fable-high');
  });
});
