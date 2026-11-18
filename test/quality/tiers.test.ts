/**
 * Tier derivation + gap compiler tests — the 0.2 layer: thresholds derived
 * from anchor medians, gap verdicts with severity ordering and directional
 * directives, fail-closed on every seam (no anchors, stale extractor, bad
 * PNG, unknown tier).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractTierVector, storeAnchor, TIER_EXTRACTOR_VERSION } from '../../src/quality/tier.js';
import {
  compileGap, deriveTier, gapReport, loadTiers, saveTier, TierProfile,
} from '../../src/quality/tiers.js';
import { qualityCommand } from '../../src/cli/quality.js';
import { pngPath } from './png-fixture.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-tiers-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const red = (name: string): string => pngPath(tmp, name, 16, 16, () => [255, 0, 0]);
const black = (name: string): string => pngPath(tmp, name, 16, 16, () => [0, 0, 0]);
const checker = (name: string): string =>
  pngPath(tmp, name, 64, 64, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? [255, 255, 255] : [0, 0, 0]);

describe('deriveTier: thresholds from anchor medians', () => {
  it('derives a multiplicative band per axis and persists it', () => {
    storeAnchor(tmp, 'visual-scene', red('anchor-red.png'));
    storeAnchor(tmp, 'visual-scene', black('anchor-black.png'));
    const tier = deriveTier(tmp, 'visual-scene', 'test', 0.75);
    expect(tier).not.toBeNull();
    expect(tier?.key).toBe('visual-scene/test');
    expect(tier?.anchorCount).toBe(2);
    expect(tier?.extractorVersion).toBe(TIER_EXTRACTOR_VERSION);
    // medians of (red, black): colors 1, edge 0, glow 0.5, dark 0.5, contrast 0, val 0.5, sat 0.5
    expect(tier?.thresholds.colors12).toEqual({ min: 0.75 });
    expect(tier?.thresholds.glowFrac).toEqual({ min: 0.375 });
    expect(tier?.thresholds.darkFrac).toEqual({ max: 0.66667 });
    expect(tier?.thresholds.contrast).toEqual({ min: 0, max: 0 });
    expect(tier?.thresholds.valMean).toEqual({ min: 0.375 });
    expect(tier?.thresholds.satMean).toEqual({ min: 0.375, max: 0.66667 });
    // persisted and reloadable
    const store = loadTiers(tmp);
    expect(store.tiers['visual-scene/test'].tolerance).toBe(0.75);
    expect(store.tiers['visual-scene/test'].anchors).toHaveLength(2);
  });

  it('refuses to invent a tier with no anchors', () => {
    expect(deriveTier(tmp, 'empty-class', 'x')).toBeNull();
  });

  it('a malformed tiers.json fails closed to an empty store', () => {
    const dir = join(tmp, '.uap', 'quality');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tiers.json'), '{broken');
    expect(loadTiers(tmp).tiers).toEqual({});
    expect(gapReport(tmp, red('c.png'), 'any/key').kind).toBe('no-tier');
  });
});

describe('compileGap: verdict, severity ordering, directives', () => {
  it('a capture at the anchor quality passes every axis', () => {
    storeAnchor(tmp, 'visual-scene', red('anchor.png'));
    const tier = deriveTier(tmp, 'visual-scene', 't')!;
    const report = compileGap(extractTierVector(red('cap.png'))!, tier, 'cap.png');
    expect(report.pass).toBe(true);
    expect(report.failing).toBe(0);
    expect(report.worst).toBeNull();
    expect(report.axes).toHaveLength(7);
  });

  it('orders failing axes by severity and carries the P39 directives', () => {
    storeAnchor(tmp, 'visual-scene', red('anchor.png'));
    const tier = deriveTier(tmp, 'visual-scene', 't')!;
    const report = compileGap(extractTierVector(black('cap.png'))!, tier, 'cap.png');
    expect(report.pass).toBe(false);
    expect(report.worst).toBe('darkFrac');
    const fails = report.axes.filter((a) => a.status === 'fail').map((a) => a.axis);
    expect(fails).toEqual(['darkFrac', 'glowFrac', 'satMean', 'valMean']);
    const dark = report.axes.find((a) => a.axis === 'darkFrac')!;
    expect(dark.directive).toContain('lighten the blacks');
    expect(dark.severity).toBe(1);
    const glow = report.axes.find((a) => a.axis === 'glowFrac')!;
    expect(glow.directive).toContain('emissive coverage');
    expect(glow.delta).toBe(-0.75);
  });

  it('contrast over the band fails high with the tonal-balance directive', () => {
    storeAnchor(tmp, 'visual-scene', red('anchor.png'));
    const tier = deriveTier(tmp, 'visual-scene', 't')!;
    const report = compileGap(extractTierVector(checker('cap.png'))!, tier, 'cap.png');
    const contrast = report.axes.find((a) => a.axis === 'contrast')!;
    expect(contrast.status).toBe('fail');
    expect(contrast.directive).toContain('tonal balance');
    expect(contrast.severity).toBe(1);
  });

  it('contrast under the band fails low with the tonal-separation directive', () => {
    const tier: TierProfile = {
      key: 'synthetic/tight',
      anchors: [],
      anchorCount: 0,
      extractorVersion: TIER_EXTRACTOR_VERSION,
      derivedAt: '2026-11-16T00:00:00.000Z',
      tolerance: 0.75,
      thresholds: { contrast: { min: 0.5, max: 0.6 } },
    };
    const report = compileGap(extractTierVector(red('cap.png'))!, tier, 'cap.png');
    const contrast = report.axes.find((a) => a.axis === 'contrast')!;
    expect(contrast.status).toBe('fail');
    expect(contrast.directive).toContain('tonal separation');
    expect(contrast.delta).toBe(-0.5);
  });

  it('axes without a threshold are not reported', () => {
    const tier: TierProfile = {
      key: 'synthetic/one',
      anchors: [],
      anchorCount: 0,
      extractorVersion: TIER_EXTRACTOR_VERSION,
      derivedAt: '2026-11-16T00:00:00.000Z',
      tolerance: 0.75,
      thresholds: { colors12: { min: 100 } },
    };
    const report = compileGap(extractTierVector(red('cap.png'))!, tier, 'cap.png');
    expect(report.axes.map((a) => a.axis)).toEqual(['colors12']);
    expect(report.axes[0].status).toBe('fail');
    expect(report.axes[0].directive).toContain('palette vocabulary');
  });
});

describe('gapReport: fail-closed seams', () => {
  it('unknown tier reports the known keys', () => {
    const res = gapReport(tmp, red('c.png'), 'nope/nope');
    expect(res.kind).toBe('no-tier');
    if (res.kind === 'no-tier') expect(res.known).toEqual([]);
  });

  it('a tier derived by another extractor version is refused', () => {
    const stale: TierProfile = {
      key: 'visual-scene/stale',
      anchors: [],
      anchorCount: 1,
      extractorVersion: 99,
      derivedAt: '2026-11-16T00:00:00.000Z',
      tolerance: 0.75,
      thresholds: { colors12: { min: 100 } },
    };
    saveTier(tmp, stale);
    const res = gapReport(tmp, red('c.png'), 'visual-scene/stale');
    expect(res.kind).toBe('stale-tier');
    if (res.kind === 'stale-tier') expect(res.tierVersion).toBe(99);
  });

  it('an undecodable capture is reported, never guessed', () => {
    storeAnchor(tmp, 'visual-scene', red('anchor.png'));
    deriveTier(tmp, 'visual-scene', 't');
    const bad = join(tmp, 'bad.png');
    writeFileSync(bad, 'garbage');
    expect(gapReport(tmp, bad, 'visual-scene/t').kind).toBe('unreadable');
  });
});

describe('qualityCommand: derive + gap', () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  });

  it('derive prints the derived bands and stays green', async () => {
    storeAnchor(tmp, 'visual-scene', red('anchor.png'));
    await qualityCommand('derive', { projectDir: tmp, target: 'visual-scene', name: 'cli' });
    expect(process.exitCode).toBeUndefined();
    expect(logs.join('\n')).toContain('tier visual-scene/cli');
    expect(logs.join('\n')).toContain('colors12');
  });

  it('derive without anchors fails with the anchor hint', async () => {
    await qualityCommand('derive', { projectDir: tmp, target: 'nothing' });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('no anchors');
  });

  it('derive rejects an out-of-band tolerance', async () => {
    storeAnchor(tmp, 'visual-scene', red('anchor.png'));
    await qualityCommand('derive', { projectDir: tmp, target: 'visual-scene', tolerance: '1.5' });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('tolerance');
  });

  it('gap below tier exits 2 and names the worst axis', async () => {
    storeAnchor(tmp, 'visual-scene', red('anchor.png'));
    await qualityCommand('derive', { projectDir: tmp, target: 'visual-scene', name: 'cli' });
    logs.length = 0;
    await qualityCommand('gap', { projectDir: tmp, file: black('cap.png'), tier: 'visual-scene/cli' });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('worst: darkFrac');
    expect(logs.join('\n')).toContain('lighten the blacks');
  });

  it('gap at tier exits clean', async () => {
    storeAnchor(tmp, 'visual-scene', red('anchor.png'));
    await qualityCommand('derive', { projectDir: tmp, target: 'visual-scene', name: 'cli' });
    logs.length = 0;
    await qualityCommand('gap', { projectDir: tmp, file: red('cap.png'), tier: 'visual-scene/cli', json: true });
    expect(process.exitCode).toBeUndefined();
    const parsed = JSON.parse(logs.join('\n')) as { pass: boolean; axes: unknown[] };
    expect(parsed.pass).toBe(true);
    expect(parsed.axes).toHaveLength(7);
  });

  it('gap with an unknown tier key fails and lists what exists', async () => {
    await qualityCommand('gap', { projectDir: tmp, file: red('cap.png'), tier: 'no/pe' });
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain("unknown tier 'no/pe'");
  });
});
