import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFleetCriticRouting, pickStrongestReasoningArm } from '../../src/delivery/fleet-critic.js';
import { ModelPresets } from '../../src/models/types.js';
import type { DeliverOutcomeAggregate } from '../../src/memory/outcome-aggregation.js';

// Real preset ids, so the free/paid distinction exercises the real cost table:
// 'local-auto'/'qwen38-27b' are zero-cost local arms; 'opus-4.8' is a paid API.
const FREE_A = 'local-auto';
const FREE_B = 'qwen38-27b';
const PAID = 'opus-4.8';

function agg(model: string, runs: number, delivered: number, gates: number | null = null): DeliverOutcomeAggregate {
  return {
    model,
    runs,
    delivered,
    notDelivered: runs - delivered,
    stopped: 0,
    bestGatesMean: gates,
    bestGatesBest: gates,
    turnsMean: 5,
  };
}

describe('fleet-critic arm selection (U-C)', () => {
  it('selects a clearly stronger free arm', () => {
    const pick = pickStrongestReasoningArm(
      [agg(FREE_A, 10, 3), agg(FREE_B, 10, 9, 90)],
      FREE_A
    );
    expect(pick?.model).toBe(FREE_B);
  });

  it('keeps local routing when the edge is under the threshold', () => {
    const pick = pickStrongestReasoningArm(
      [agg(FREE_A, 10, 3), agg(FREE_B, 10, 4, 60)],
      FREE_A
    );
    expect(pick).toBeNull();
  });

  it('never auto-selects a paid arm, however strong', () => {
    const pick = pickStrongestReasoningArm(
      [agg(FREE_A, 10, 0), agg(PAID, 10, 10, 100)],
      FREE_A
    );
    expect(pick).toBeNull();
  });

  it('ignores arms with thin track records', () => {
    const pick = pickStrongestReasoningArm(
      [agg(FREE_A, 10, 3), agg(FREE_B, 4, 4, 100)],
      FREE_A
    );
    expect(pick).toBeNull();
  });

  it('takes over from an unproven active arm only with a proven-strong candidate', () => {
    const unprovenActive = [agg(FREE_A, 1, 0), agg(FREE_B, 8, 8, 95)];
    expect(pickStrongestReasoningArm(unprovenActive, FREE_A)?.model).toBe(FREE_B);

    const mediocre = [agg(FREE_A, 1, 0), agg(FREE_B, 8, 5, 60)]; // 62.5% < 75% bar
    expect(pickStrongestReasoningArm(mediocre, FREE_A)).toBeNull();
  });

  it('prefers the higher delivered rate, breaking ties on gates then turns', () => {
    const pick = pickStrongestReasoningArm(
      [
        agg(FREE_A, 10, 3),
        { ...agg(FREE_B, 10, 9, 80), turnsMean: 9 },
        agg('qwen35-a3b', 10, 9, 95), // same rate, better gates -> wins
      ],
      FREE_A
    );
    expect(pick?.model).toBe('qwen35-a3b');
  });

  it('only considers known presets — telemetry for an unknown id is not routable', () => {
    const pick = pickStrongestReasoningArm(
      [agg(FREE_A, 10, 3), agg('some-retired-arm', 10, 10, 100)],
      FREE_A
    );
    expect(pick).toBeNull();
  });

  it('reports a clear decision when disabled, and never throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-fleet-'));
    try {
      const decision = await applyFleetCriticRouting(dir, FREE_A, { disabled: true });
      expect(decision.arm).toBeUndefined();
      expect(decision.reason).toContain('disabled');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fleet-critic preset cost assumptions', () => {
  it('relies on real free and paid presets for the safety contract', () => {
    // If the cost table ever changes such that these fixtures flip class, the
    // selection tests above would silently stop testing what they claim.
    expect(ModelPresets[FREE_A]?.costPer1MInput).toBe(0);
    expect(ModelPresets[FREE_B]?.costPer1MInput).toBe(0);
    expect(ModelPresets[PAID]?.costPer1MInput ?? 0).toBeGreaterThan(0);
  });
});
