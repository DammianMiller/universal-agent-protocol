/**
 * Deliver tier gate tests (0.5) — shadow-first doctrine, block-mode refusal
 * with the gap report attached, tier-passing artifacts unaffected, escape
 * hatch, and the acceptance-path wiring that refuses DONE before the judge.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deriveTier, saveTier } from '../../src/quality/tiers.js';
import { storeAnchor, TIER_EXTRACTOR_VERSION } from '../../src/quality/tier.js';
import {
  formatTierGateLine,
  resolveTierGateMode,
  runTierGate,
} from '../../src/quality/tier-gate.js';
import { buildMissionAcceptanceGate } from '../../src/delivery/mission-acceptance.js';
import { createSpecRegistry } from '../../src/delivery/spec-registry.js';
import type { VisualVerdict } from '../../src/delivery/visual-gate.js';
import { pngPath } from './png-fixture.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'uap-tiergate-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

const red = (name: string): string => pngPath(tmp, name, 16, 16, () => [255, 0, 0]);
const black = (name: string): string => pngPath(tmp, name, 16, 16, () => [0, 0, 0]);

/** A project with a red-anchor tier: red captures pass, black captures gap. */
function redTierProject(): void {
  storeAnchor(tmp, 'visual-scene', red('anchor.png'));
  deriveTier(tmp, 'visual-scene', 't');
}

describe('resolveTierGateMode', () => {
  it('defaults to shadow, honors off/block, garbage falls back to shadow', () => {
    expect(resolveTierGateMode({})).toBe('shadow');
    expect(resolveTierGateMode({ UAP_TIER_GATE: 'off' })).toBe('off');
    expect(resolveTierGateMode({ UAP_TIER_GATE: 'block' })).toBe('block');
    expect(resolveTierGateMode({ UAP_TIER_GATE: 'nonsense' })).toBe('shadow');
  });
});

describe('runTierGate', () => {
  it('mode off skips everything (the escape hatch)', () => {
    redTierProject();
    const r = runTierGate({ projectRoot: tmp, captures: [black('c.png')], mode: 'off' });
    expect(r.skipped).toContain('gate off');
    expect(r.pass).toBe(true);
    expect(r.reports).toHaveLength(0);
  });

  it('skips a tier-less project and a capture-less turn', () => {
    expect(runTierGate({ projectRoot: tmp, captures: [red('c.png')], mode: 'shadow' }).skipped).toBe('no derived tiers');
    redTierProject();
    expect(runTierGate({ projectRoot: tmp, captures: [], mode: 'shadow' }).skipped).toBe('no captures');
  });

  it('skips when nothing decodes', () => {
    redTierProject();
    const bad = join(tmp, 'bad.png');
    writeFileSync(bad, 'garbage');
    expect(runTierGate({ projectRoot: tmp, captures: [bad], mode: 'shadow' }).skipped).toBe('no decodable captures');
  });

  it('shadow: a below-tier artifact is ASSESSED, never blocked', () => {
    redTierProject();
    const r = runTierGate({ projectRoot: tmp, captures: [black('c.png')], mode: 'shadow' });
    expect(r.pass).toBe(true);
    expect(r.feedback).toBeUndefined();
    expect(r.reports[0].pass).toBe(false);
    expect(r.reports[0].failing).toBeGreaterThan(0);
    expect(r.reports[0].worst).toBe('darkFrac');
  });

  it('block: a below-tier artifact is refused DONE with the gap report attached', () => {
    redTierProject();
    const r = runTierGate({ projectRoot: tmp, captures: [black('c.png')], mode: 'block' });
    expect(r.pass).toBe(false);
    expect(r.feedback).toContain('TIER GATE');
    expect(r.feedback).toContain('visual-scene/t');
    expect(r.feedback).toContain('refused DONE');
    expect(r.feedback).toContain('darkFrac');
    expect(r.feedback).toContain('lighten the blacks');
  });

  it('block: a tier-passing artifact is unaffected', () => {
    redTierProject();
    const r = runTierGate({ projectRoot: tmp, captures: [red('c.png')], mode: 'block' });
    expect(r.pass).toBe(true);
    expect(r.feedback).toBeUndefined();
  });

  it('block: a stale-extractor tier is refused, not silently passed', () => {
    storeAnchor(tmp, 'visual-scene', red('anchor.png'));
    saveTier(tmp, {
      key: 'visual-scene/stale',
      anchors: [],
      anchorCount: 1,
      extractorVersion: TIER_EXTRACTOR_VERSION + 99,
      derivedAt: '2026-11-16T00:00:00.000Z',
      tolerance: 0.75,
      thresholds: { colors12: { min: 100 } },
    });
    const r = runTierGate({ projectRoot: tmp, captures: [red('c.png')], mode: 'block' });
    // gapReport refuses stale tiers fail-closed; the deliver gate inherits
    // that refusal instead of grading against a bar it cannot verify.
    expect(r.pass).toBe(false);
  });
});

describe('formatTierGateLine', () => {
  it('renders skip, at-tier, and below-tier lines', () => {
    expect(formatTierGateLine({ mode: 'off', skipped: 'no derived tiers', reports: [], pass: true })).toContain('skipped');
    redTierProject();
    const ok = runTierGate({ projectRoot: tmp, captures: [red('c.png')], mode: 'shadow' });
    expect(formatTierGateLine(ok)).toContain('✓');
    const bad = runTierGate({ projectRoot: tmp, captures: [black('c.png')], mode: 'shadow' });
    expect(formatTierGateLine(bad)).toContain('below tier visual-scene/t');
    expect(formatTierGateLine(bad)).toContain('worst: darkFrac');
  });
});

describe('acceptance wiring: refused DONE before the judge', () => {
  const visualWith = (capture: string): VisualVerdict => ({
    passed: true,
    structural: false,
    skipped: false,
    feedback: '',
    screenshotDir: null,
    pages: [{
      file: 'index.html',
      loaded: true,
      hasCanvas: true,
      distinctColors: 5,
      dominantRatio: 1,
      motionRatio: 0,
      expectsAnimation: false,
      runtimeErrors: [],
      failedRequests: [],
      screenshots: [capture],
      problems: [],
    }],
  });

  /** Gate with every observation seam stubbed; secondary mode on a green ladder. */
  const gateWith = (capture: string, judge: ReturnType<typeof vi.fn>) =>
    buildMissionAcceptanceGate({
      primary: false,
      specs: createSpecRegistry({ initialSpec: 'spec', sharedRoot: tmp, flipLimit: 2 }),
      judgeExecutor: async () => '{}',
      note: () => undefined,
      executionGate: (async () => ({ passed: true, outputTail: '' })) as never,
      capabilityBaseline: (async () => null) as never,
      capabilityCurrent: (async () => null) as never,
      interactionGate: (async () => ({ skipped: true, passed: false, feedback: '' })) as never,
      visualGate: (async () => visualWith(capture)) as never,
      visionReview: (async () => null) as never,
      userPathsNote: () => null,
      judge: judge as never,
    });

  /** Secondary acceptance only runs on a GREEN ladder — the evidence gate
   * counts that ladder as the executable signal (same setup as the
   * mission-acceptance suite's passing-verdict tests). */
  const run = (capture: string, judge: ReturnType<typeof vi.fn>) => gateWith(capture, judge)(tmp, { ladderPassed: true });

  it('block mode refuses a below-tier artifact DONE without spending the judge', async () => {
    redTierProject();
    vi.stubEnv('UAP_TIER_GATE', 'block');
    const judge = vi.fn(async () => ({ passed: true, score: 1, criteria: [] }));
    const verdict = await run(black('shot.png'), judge);
    expect(verdict.passed).toBe(false);
    expect(verdict.feedback).toContain('TIER GATE');
    expect(verdict.feedback).toContain('lighten the blacks');
    expect(judge).not.toHaveBeenCalled();
  });

  it('block mode lets a tier-passing artifact through to the judge', async () => {
    redTierProject();
    vi.stubEnv('UAP_TIER_GATE', 'block');
    const judge = vi.fn(async () => ({ passed: true, score: 1, criteria: [{ requirement: 'x', met: true, reason: '' }] }));
    const verdict = await run(red('shot.png'), judge);
    expect(judge).toHaveBeenCalled();
    expect(verdict.passed).toBe(true);
  });

  it('the default (shadow) assesses without blocking DONE', async () => {
    redTierProject();
    const judge = vi.fn(async () => ({ passed: true, score: 1, criteria: [{ requirement: 'x', met: true, reason: '' }] }));
    const verdict = await run(black('shot.png'), judge);
    expect(judge).toHaveBeenCalled();
    expect(verdict.passed).toBe(true);
  });

  it('the escape hatch (UAP_TIER_GATE=off) skips the assessment entirely', async () => {
    redTierProject();
    vi.stubEnv('UAP_TIER_GATE', 'off');
    const judge = vi.fn(async () => ({ passed: true, score: 1, criteria: [{ requirement: 'x', met: true, reason: '' }] }));
    const verdict = await run(black('shot.png'), judge);
    expect(judge).toHaveBeenCalled();
    expect(verdict.passed).toBe(true);
  });
});
