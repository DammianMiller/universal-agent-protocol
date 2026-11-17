/**
 * Auto-applied tier machinery tests — the two live findings from
 * voxel-pagoda-speedy-uap-max (2026-11-17), shipped as capabilities:
 *
 * 1. glowFrac is a BAND, not a floor. The finding: a saturated orange wash
 *    (sky + fog covering a third of the frame) measured glowFrac 9-15x the
 *    Fable anchors and PASSED the min-only threshold — "more glow" measured
 *    the wash, not the lights. A wash frame (every other axis in-band, glow
 *    above the band) must now fail HIGH with the wash directive.
 *
 * 2. The fleet-global tier store. The finding: a fresh project with no
 *    derived tiers gets the tier gate's "no derived tiers" skip and the
 *    executor never sees the contract. A published global tier now resolves
 *    in EVERY project (project tiers override on collision), and saveTier
 *    never copies borrowed global tiers into a project's policy file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { storeAnchor, TierVector, TIER_EXTRACTOR_VERSION } from '../../src/quality/tier.js';
import {
  compileGap, deriveTier, gapReport, globalTiersPath, loadTiers, resolveTiers, saveGlobalTier, saveTier, TierProfile,
} from '../../src/quality/tiers.js';
import { runTierGate } from '../../src/quality/tier-gate.js';
import { tierContractText, tierKeysFor } from '../../src/quality/tier-contract.js';
import { qualityCommand } from '../../src/cli/quality.js';
import { pngPath } from './png-fixture.js';

let tmp: string;
let globalStorePath: string;
/** The env view that pins the fleet store into the test sandbox. */
const env = (): NodeJS.ProcessEnv => ({ UAP_TIER_STORE: globalStorePath });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-autoapply-'));
  globalStorePath = join(tmp, 'global-tiers.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const red = (name: string): string => pngPath(tmp, name, 16, 16, () => [255, 0, 0]);
const black = (name: string): string => pngPath(tmp, name, 16, 16, () => [0, 0, 0]);

/** A visual vector at the fable-high register except where overridden. */
const registerVector = (over: Partial<TierVector>): TierVector => ({
  extractorVersion: TIER_EXTRACTOR_VERSION,
  canonicalWidth: 16,
  canonicalHeight: 16,
  sha256: 'autoapply-fixture',
  colors12: 821,
  edgeFrac: 0.09386,
  glowFrac: 0.03459,
  darkFrac: 0.06233,
  contrast: 0.21759,
  valMean: 0.72664,
  satMean: 0.30,
  ...over,
});

/** The fable-high register as derived with the banded glow (tolerance 0.75). */
const fableTier = (): TierProfile => ({
  key: 'visual-scene/fable-high',
  anchors: [],
  anchorCount: 2,
  extractorVersion: TIER_EXTRACTOR_VERSION,
  derivedAt: '2026-11-17T00:00:00.000Z',
  tolerance: 0.75,
  thresholds: {
    colors12: { min: 743.625 },
    edgeFrac: { min: 0.08767 },
    glowFrac: { min: 0.02305, max: 0.04093 },
    darkFrac: { max: 0.07138 },
    contrast: { min: 0.16001, max: 0.28445 },
    valMean: { min: 0.49866 },
    satMean: { min: 0.22992, max: 0.40875 },
  },
});

/** A tier in a project-local store. */
const projectTier = (key: string, tolerance = 0.75): TierProfile => ({
  key,
  anchors: [],
  anchorCount: 1,
  extractorVersion: TIER_EXTRACTOR_VERSION,
  derivedAt: '2026-11-17T00:00:00.000Z',
  tolerance,
  thresholds: { colors12: { min: 700 } },
});

describe('glowFrac band (the wash finding)', () => {
  it('derives both sides from anchor medians', () => {
    storeAnchor(tmp, 'visual-scene', red('anchor-red.png'));
    storeAnchor(tmp, 'visual-scene', black('anchor-black.png'));
    const tier = deriveTier(tmp, 'visual-scene', 'test', 0.75);
    expect(tier?.thresholds.glowFrac).toEqual({ min: 0.375, max: 0.66667 });
  });

  it('a wash frame (all else in-band, glow 15x the anchor) fails HIGH with the wash directive', () => {
    // The uap-max measurement: satMean 0.618 is ALSO out of band there; this
    // fixture isolates the glow axis — saturation in-band, coverage 0.35.
    const report = compileGap(registerVector({ glowFrac: 0.35, satMean: 0.35 }), fableTier());
    expect(report.pass).toBe(false);
    expect(report.worst).toBe('glowFrac');
    const glow = report.axes.find((a) => a.axis === 'glowFrac')!;
    expect(glow.status).toBe('fail');
    expect(glow.value).toBe(0.35);
    expect(glow.directive).toContain('luminous wash');
    expect(glow.directive).toContain('mute');
    expect(glow.severity).toBe(1);
    // only the glow axis fails — the wash is the whole failure
    expect(report.axes.filter((a) => a.status === 'fail')).toHaveLength(1);
  });

  it('an at-register frame passes clean', () => {
    const report = compileGap(registerVector({}), fableTier());
    expect(report.pass).toBe(true);
    expect(report.failing).toBe(0);
  });

  it('a dim frame still fails LOW with the emissive directive (the band keeps the floor)', () => {
    const report = compileGap(registerVector({ glowFrac: 0.002 }), fableTier());
    expect(report.worst).toBe('glowFrac');
    const glow = report.axes.find((a) => a.axis === 'glowFrac')!;
    expect(glow.directive).toContain('emissive coverage');
  });
});

describe('fleet-global tier store (auto-apply)', () => {
  it('an empty global store changes nothing', () => {
    saveTier(tmp, projectTier('visual-scene/local'));
    const resolved = resolveTiers(tmp, env());
    expect(Object.keys(resolved.tiers)).toEqual(['visual-scene/local']);
  });

  it('a published global tier resolves in a project that derived none', () => {
    saveGlobalTier(fableTier(), env());
    const resolved = resolveTiers(tmp, env());
    expect(Object.keys(resolved.tiers)).toEqual(['visual-scene/fable-high']);
    // and the project store itself stays empty — the tier is borrowed, not copied
    expect(Object.keys(loadTiers(tmp).tiers)).toEqual([]);
  });

  it('project tiers override the global store on key collision', () => {
    saveGlobalTier(fableTier(), env());
    const local = fableTier();
    local.tolerance = 0.9; // a distinguishable local policy
    saveTier(tmp, local);
    const resolved = resolveTiers(tmp, env());
    expect(resolved.tiers['visual-scene/fable-high'].tolerance).toBe(0.9);
  });

  it('a malformed global store fails soft to the project view', () => {
    mkdirSync(dirname(globalStorePath), { recursive: true });
    writeFileSync(globalStorePath, '{broken');
    saveTier(tmp, projectTier('visual-scene/local'));
    const resolved = resolveTiers(tmp, env());
    expect(Object.keys(resolved.tiers)).toEqual(['visual-scene/local']);
  });

  it('saveTier never copies borrowed global tiers into the project policy file', () => {
    saveGlobalTier(fableTier(), env());
    saveTier(tmp, projectTier('visual-scene/mine'));
    const onDisk = JSON.parse(readFileSync(join(tmp, '.uap', 'quality', 'tiers.json'), 'utf8'));
    expect(Object.keys(onDisk.tiers)).toEqual(['visual-scene/mine']);
  });

  it('globalTiersPath honors UAP_TIER_STORE and defaults into ~/.uap', () => {
    expect(globalTiersPath({ UAP_TIER_STORE: '/x/t.json' })).toBe('/x/t.json');
    expect(globalTiersPath({}).endsWith(join('.uap', 'quality', 'tiers.json'))).toBe(true);
  });

  it('gapReport resolves a global tier in a project without one', () => {
    saveGlobalTier(fableTier(), env());
    const prev = process.env.UAP_TIER_STORE;
    process.env.UAP_TIER_STORE = globalStorePath;
    try {
      const res = gapReport(tmp, red('c.png'), 'visual-scene/fable-high');
      expect(res.kind).toBe('ok');
      expect(res.report.tier).toBe('visual-scene/fable-high');
    } finally {
      if (prev === undefined) delete process.env.UAP_TIER_STORE;
      else process.env.UAP_TIER_STORE = prev;
    }
  });

  it('the tier gate stops skipping and measures when a global tier exists', () => {
    saveGlobalTier(fableTier(), env());
    const prev = process.env.UAP_TIER_STORE;
    process.env.UAP_TIER_STORE = globalStorePath;
    try {
      const gate = runTierGate({
        projectRoot: tmp,
        captures: [red('gate-capture.png')],
        mode: 'shadow',
      });
      expect(gate.skipped).toBeUndefined();
      expect(gate.reports.length).toBeGreaterThan(0);
      expect(gate.reports[0].tier).toBe('visual-scene/fable-high');
      // shadow never blocks, whatever the measurement says
      expect(gate.pass).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.UAP_TIER_STORE;
      else process.env.UAP_TIER_STORE = prev;
    }
  });

  it('the contract composer sees global tiers', () => {
    saveGlobalTier(fableTier(), env());
    const prev = process.env.UAP_TIER_STORE;
    process.env.UAP_TIER_STORE = globalStorePath;
    try {
      expect(tierKeysFor(tmp)).toContain('visual-scene/fable-high');
      const contract = tierContractText(tmp, 'visual-scene/fable-high');
      expect(contract).toContain('between 0.02305 and 0.04093');
      expect(contract).toContain('luminous wash');
    } finally {
      if (prev === undefined) delete process.env.UAP_TIER_STORE;
      else process.env.UAP_TIER_STORE = prev;
    }
  });
});

describe('qualityCommand publish', () => {
  it('publishes a project tier into the fleet store; other projects resolve it', async () => {
    saveTier(tmp, fableTier());
    const prev = process.env.UAP_TIER_STORE;
    process.env.UAP_TIER_STORE = globalStorePath;
    try {
      await qualityCommand('publish', { target: 'visual-scene/fable-high', projectDir: tmp });
      expect(process.exitCode).toBeUndefined();
      const onDisk = JSON.parse(readFileSync(globalStorePath, 'utf8'));
      expect(Object.keys(onDisk.tiers)).toEqual(['visual-scene/fable-high']);
      // a DIFFERENT project resolves the published tier without deriving one
      const other = mkdtempSync(join(tmpdir(), 'uap-autoapply-other-'));
      try {
        expect(Object.keys(resolveTiers(other, env()).tiers)).toEqual(['visual-scene/fable-high']);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      if (prev === undefined) delete process.env.UAP_TIER_STORE;
      else process.env.UAP_TIER_STORE = prev;
    }
  });

  it('refuses to publish a tier the project does not carry', async () => {
    const prev = process.env.UAP_TIER_STORE;
    process.env.UAP_TIER_STORE = globalStorePath;
    try {
      await qualityCommand('publish', { target: 'visual-scene/missing', projectDir: tmp });
      expect(process.exitCode).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.UAP_TIER_STORE;
      else process.env.UAP_TIER_STORE = prev;
    }
  });

  it('usage without a tier key exits 2', async () => {
    await qualityCommand('publish', { projectDir: tmp });
    expect(process.exitCode).toBe(2);
  });
});
