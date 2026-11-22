/**
 * Class-prior tests (U-I frontier regimes) — the reference-free floor.
 *
 * Live findings generalized: voxel-pagoda runs 3-4 shipped 5/7 axes below
 * the frontier register with NO tier machinery touching them, because
 * deriveTier needs anchors and the projects had none. Priors close that seam:
 * baked frontier-envelope thresholds resolve whenever a class has no tier of
 * its own, both frontier art directions pass them by construction, the
 * run-3-style degraded vector fails them on five axes, and max fidelity
 * escalates prior failures to a DONE refusal (anchor tiers never escalate).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  builtinPriorTiers,
  priorFidelityTargets,
  priorTierForClass,
} from '../../src/quality/class-priors.js';
import { compileGap, resolveTiers, saveTier, TierProfile } from '../../src/quality/tiers.js';
import { runTierGate } from '../../src/quality/tier-gate.js';
import { TierVector, TIER_EXTRACTOR_VERSION } from '../../src/quality/tier.js';
import { pngPath } from './png-fixture.js';

let tmp: string;
/** Env pinned into the sandbox: no fleet-global store can leak into the tests. */
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  UAP_TIER_STORE: join(tmp, 'global-tiers.json'),
  ...over,
});
/** resolveTiers bound to the sandbox env — runTierGate's load seam. */
const sandboxLoad = (root: string) => resolveTiers(root, env());

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-priors-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A frontier-register visual vector except where overridden. */
const vector = (over: Partial<TierVector>): TierVector => ({
  extractorVersion: TIER_EXTRACTOR_VERSION,
  canonicalWidth: 16,
  canonicalHeight: 16,
  sha256: 'priors-fixture',
  colors12: 1200,
  edgeFrac: 0.13,
  glowFrac: 0.01,
  darkFrac: 0.01,
  contrast: 0.22,
  valMean: 0.79,
  satMean: 0.3,
  ...over,
});

/** A stored (non-builtin) tier — the escalation contrast case. */
const storedTier = (key: string, thresholds: TierProfile['thresholds']): TierProfile => ({
  key,
  anchors: [],
  anchorCount: 1,
  extractorVersion: TIER_EXTRACTOR_VERSION,
  derivedAt: '2026-11-22T00:00:00.000Z',
  tolerance: 0.75,
  thresholds,
});

describe('builtin class priors (the harvest)', () => {
  it('ships the visual-scene frontier prior spanning BOTH art directions', () => {
    const prior = priorTierForClass('visual-scene');
    expect(prior?.key).toBe('visual-scene/frontier-prior');
    expect(prior?.builtin).toBe(true);
    expect(prior?.anchorCount).toBe(0);
    expect(prior?.extractorVersion).toBe(TIER_EXTRACTOR_VERSION);
    const t = prior!.thresholds;
    // glow is the bimodal axis: the band must hold the restrained direction
    // (Opus 0.006-0.014) AND the theatrical one (Kimi 0.12-0.26)
    expect(t.glowFrac.min!).toBeLessThanOrEqual(0.00614);
    expect(t.glowFrac.max!).toBeGreaterThanOrEqual(0.25665);
    // darkFrac is max-only: the envelope ceiling widened by tolerance
    expect(t.darkFrac).toEqual({ max: 0.02085 });
    expect(priorTierForClass('api-behavior')).toBeNull();
    expect(builtinPriorTiers().length).toBeGreaterThanOrEqual(1);
  });

  it('resolveTiers fills the prior ONLY for classes with no tier of their own', () => {
    // a project with nothing: the prior resolves (the reference-free floor)
    expect(Object.keys(resolveTiers(tmp, env()).tiers)).toEqual(['visual-scene/frontier-prior']);
    // a project with its own visual-scene tier: the prior yields
    saveTier(tmp, storedTier('visual-scene/local', { colors12: { min: 700 } }));
    expect(Object.keys(resolveTiers(tmp, env()).tiers)).toEqual(['visual-scene/local']);
  });

  it('UAP_TIER_PRIORS=off disables priors without touching stored tiers', () => {
    expect(Object.keys(resolveTiers(tmp, env({ UAP_TIER_PRIORS: 'off' })).tiers)).toEqual([]);
    saveTier(tmp, storedTier('visual-scene/local', { colors12: { min: 700 } }));
    expect(Object.keys(resolveTiers(tmp, env({ UAP_TIER_PRIORS: 'off' })).tiers)).toEqual([
      'visual-scene/local',
    ]);
  });

  it('priors never persist into the project store (code constants, not policy files)', () => {
    resolveTiers(tmp, env());
    saveTier(tmp, storedTier('visual-scene/mine', { colors12: { min: 1 } }));
    const onDisk = JSON.parse(readFileSync(join(tmp, '.uap', 'quality', 'tiers.json'), 'utf8'));
    expect(Object.keys(onDisk.tiers)).toEqual(['visual-scene/mine']);
  });
});

describe('prior separation (the generalization claim)', () => {
  it('the run-3 degraded vector fails 5 of 7 axes, worst-first, with directives', () => {
    const prior = priorTierForClass('visual-scene')!;
    // run-3 local capture (measured, python-probe units): the amateur tier
    const report = compileGap(
      vector({
        colors12: 485,
        edgeFrac: 0.024,
        glowFrac: 0.0023,
        darkFrac: 0.244,
        contrast: 0.203,
        valMean: 0.571,
        satMean: 0.331,
      }),
      prior
    );
    expect(report.pass).toBe(false);
    expect(report.failing).toBe(5);
    expect(report.worst).toBe('darkFrac'); // crushed blacks: 11x past the ceiling
    const dark = report.axes.find((a) => a.axis === 'darkFrac')!;
    expect(dark.directive).toContain('blacks');
    const glow = report.axes.find((a) => a.axis === 'glowFrac')!;
    expect(glow.directive).toContain('emissive coverage');
    // contrast and satMean were the passing axes — the failure is specific
    expect(report.axes.filter((a) => a.status === 'pass').map((a) => a.axis).sort()).toEqual([
      'contrast',
      'satMean',
    ]);
  });

  it('frontier-register vectors pass in BOTH art directions (harvest stills)', () => {
    const prior = priorTierForClass('visual-scene')!;
    // opus55-3 (restrained-premium), measured with extractor v1
    expect(
      compileGap(
        vector({
          satMean: 0.29777,
          valMean: 0.80661,
          contrast: 0.22967,
          edgeFrac: 0.1672,
          glowFrac: 0.01013,
          darkFrac: 0.00927,
          colors12: 1214,
        }),
        prior
      ).pass
    ).toBe(true);
    // kimi31-5 (theatrical-premium), measured with extractor v1
    expect(
      compileGap(
        vector({
          satMean: 0.38173,
          valMean: 0.77969,
          contrast: 0.21416,
          edgeFrac: 0.11702,
          glowFrac: 0.25665,
          darkFrac: 0.00274,
          colors12: 1320,
        }),
        prior
      ).pass
    ).toBe(true);
  });

  it('priorFidelityTargets renders the numeric bar as binding, reference-free lines', () => {
    const lines = priorFidelityTargets('visual-scene');
    expect(lines).toHaveLength(7);
    const joined = lines.join('\n');
    expect(joined).toContain('edgeFrac >= 0.08777');
    expect(joined).toContain('darkFrac <= 0.02085');
    expect(joined).toContain('no reference media');
    expect(priorFidelityTargets('bench-score')).toEqual([]);
  });
});

describe('max-fidelity prior escalation (the enforcement seam)', () => {
  it('shadow + max fidelity refuses a degraded capture below the prior', () => {
    const black = pngPath(tmp, 'black.png', 16, 16, () => [0, 0, 0]);
    const gate = runTierGate({
      projectRoot: tmp,
      captures: [black],
      mode: 'shadow',
      maxFidelity: true,
      load: sandboxLoad,
    });
    expect(gate.pass).toBe(false);
    expect(gate.escalated).toBe(true);
    expect(gate.feedback).toContain('max-fidelity escalation');
    expect(gate.feedback).toContain('visual-scene/frontier-prior');
    expect(gate.reports[0].pass).toBe(false);
  });

  it('shadow without max fidelity stays advisory on the same capture', () => {
    const black = pngPath(tmp, 'black.png', 16, 16, () => [0, 0, 0]);
    const gate = runTierGate({
      projectRoot: tmp,
      captures: [black],
      mode: 'shadow',
      load: sandboxLoad,
    });
    expect(gate.pass).toBe(true);
    expect(gate.escalated).toBeUndefined();
    expect(gate.reports[0].pass).toBe(false); // measured, reported, not blocking
  });

  it('anchor-derived tiers never escalate under max fidelity (promotion stays an operator act)', () => {
    const black = pngPath(tmp, 'black.png', 16, 16, () => [0, 0, 0]);
    const gate = runTierGate({
      projectRoot: tmp,
      captures: [black],
      mode: 'shadow',
      maxFidelity: true,
      load: () => ({
        version: 1,
        tiers: { 'visual-scene/local': storedTier('visual-scene/local', { colors12: { min: 4000 } }) },
      }),
    });
    expect(gate.pass).toBe(true);
    expect(gate.escalated).toBeUndefined();
    expect(gate.reports[0].pass).toBe(false);
  });

  it('the gate no longer skips for projects that never curated anchors', () => {
    const grey = pngPath(tmp, 'grey.png', 16, 16, () => [128, 128, 128]);
    const gate = runTierGate({
      projectRoot: tmp,
      captures: [grey],
      mode: 'shadow',
      load: sandboxLoad,
    });
    expect(gate.skipped).toBeUndefined();
    expect(gate.reports[0].tier).toBe('visual-scene/frontier-prior');
  });
});
