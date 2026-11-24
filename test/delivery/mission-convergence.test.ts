/**
 * Wave 4 G — the convergence budget: every real deliver acceptance check that
 * exercises a tier records a 1-round, 1-candidate ladder run to
 * .uap/quality/convergence.jsonl. The tier gate's shadow→block promotion
 * decision was evidence-starved (the log held 0 runs because only the
 * harvested `uap quality ladder` CLI ever wrote it); the acceptance path is
 * where real artifacts by real models get measured, so it is where the
 * budget must accumulate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMissionAcceptanceGate } from '../../src/delivery/mission-acceptance.js';
import type { TierGateResult } from '../../src/quality/tier-gate.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-mission-conv-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A minimal healthy deps tail — same shape capability-profile.test.ts uses. */
function deps(over: Record<string, unknown> = {}) {
  const healthyProfile = {
    measured: true,
    elapsedMs: 2000,
    frames: 120,
    drawCalls: 1320,
    glDrawCalls: 1320,
    ctx2dDrawCalls: 0,
    programsUsed: 5,
    listenerTypes: 6,
    listeners: 12,
    entry: 'index.html',
  };
  return {
    primary: true,
    specs: { resolve: () => 'spec', breaker: () => ({ check: (_s: string, v: unknown) => v }) },
    judgeExecutor: (async () => '{}') as never,
    note: () => undefined,
    visualGate: async () => ({ skipped: true, passed: true, structural: false, pages: [] }),
    interactionGate: async () => ({ skipped: true, passed: true, feedback: '' }),
    visionReview: async () => null,
    userPathsNote: () => null,
    judge: async () => ({ passed: true, score: 9, criteria: [] }),
    executionGate: async () => ({ passed: true, exitCode: 0, outputTail: '', durationMs: 1 }),
    capabilityBaseline: () => healthyProfile,
    capabilityCurrent: () => healthyProfile,
    ...over,
  };
}

function gateResult(over: Partial<TierGateResult> = {}): TierGateResult {
  return {
    mode: 'shadow',
    reports: [
      {
        tier: 'visual-scene/frontier-prior',
        pass: true,
        failing: 0,
        axes: 7,
        worst: null,
        capture: join(dir, 'cap.png'),
      },
    ],
    pass: true,
    ...over,
  };
}

function records(): Array<Record<string, unknown>> {
  const f = join(dir, '.uap', 'quality', 'convergence.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('mission acceptance records the convergence budget (wave 4 G)', () => {
  it('a passing tier measurement records a tier-reached run', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<p>x</p>', 'utf-8');
    const gate = buildMissionAcceptanceGate(
      deps({ tierGate: () => gateResult() }) as never
    );
    await gate(dir, undefined as never);
    const rs = records();
    expect(rs.length).toBe(1);
    expect(rs[0]).toMatchObject({
      tier: 'visual-scene/frontier-prior',
      outcome: 'tier-reached',
      rounds: 1,
      candidatesMeasured: 1,
      winnerPassed: true,
      escalationFired: false,
      model: null,
    });
  });

  it('a below-tier measurement records the cut — the budget needs both halves', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<p>x</p>', 'utf-8');
    const gate = buildMissionAcceptanceGate(
      deps({
        tierGate: () =>
          gateResult({
            reports: [
              {
                tier: 'visual-scene/frontier-prior',
                pass: false,
                failing: 2,
                axes: 7,
                worst: 'colors12',
                capture: join(dir, 'cap.png'),
              },
            ],
          }),
      }) as never
    );
    await gate(dir, undefined as never);
    const rs = records();
    expect(rs.length).toBe(1);
    expect(rs[0]).toMatchObject({ outcome: 'cut-exhausted', winnerPassed: false });
  });

  it('one record per (tier, capture) report — two captures, two measurements', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<p>x</p>', 'utf-8');
    const gate = buildMissionAcceptanceGate(
      deps({
        tierGate: () =>
          gateResult({
            reports: [
              {
                tier: 'visual-scene/frontier-prior',
                pass: true,
                failing: 0,
                axes: 7,
                worst: null,
                capture: join(dir, 'a.png'),
              },
              {
                tier: 'visual-scene/frontier-prior',
                pass: true,
                failing: 0,
                axes: 7,
                worst: null,
                capture: join(dir, 'b.png'),
              },
            ],
          }),
      }) as never
    );
    await gate(dir, undefined as never);
    expect(records().length).toBe(2);
  });

  it('a skipped gate records nothing — silent on tier-less projects', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<p>x</p>', 'utf-8');
    const gate = buildMissionAcceptanceGate(
      deps({ tierGate: () => gateResult({ skipped: 'no derived tiers', reports: [] }) }) as never
    );
    await gate(dir, undefined as never);
    expect(records()).toEqual([]);
  });

  it('a read-only project root must not fail the delivery — recording is best effort', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<p>x</p>', 'utf-8');
    // The recording is reached with root = a FILE path: mkdirSync inside
    // recordLadderRun throws, the try/catch absorbs it, the gate continues.
    const gate = buildMissionAcceptanceGate(deps({ tierGate: () => gateResult() }) as never);
    const r = await gate(join(dir, 'index.html'), undefined as never);
    expect(r.passed).toBeDefined();
    expect(records()).toEqual([]);
  });
});
