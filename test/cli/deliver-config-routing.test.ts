/**
 * G1 (deliver-hardening 2026-07-13): model routing is config-authoritative.
 *
 * Defect 13: routing was CLI/env-only — the choice left no trace in the repo,
 * and a stale ambient UAP_DELIVER_ROUTING in a launching shell silently
 * steered a money-critical repo onto the weakest model. `.uap.json →
 * delivery.routing` / `delivery.criticality` / `delivery.model` now declare
 * the project's posture: declared config beats ambient env, an explicit CLI
 * flag beats config, and `criticality: sandbox` keeps the local qwen default
 * (and SUPPRESSES ambient routing — a declared posture beats a stale shell).
 */

import { describe, it, expect } from 'vitest';
import { resolveRoutingId, resolveTierModelById, CRITICALITY_ROUTING } from '../../src/cli/deliver.js';
import { DeliverySchema } from '../../src/types/config.js';

describe('resolveRoutingId (G1 precedence)', () => {
  it('an explicit CLI flag beats config, criticality and env', () => {
    const r = resolveRoutingId({
      cliRouting: 'speed-tiered',
      cfgRouting: 'cost-tiered',
      cfgCriticality: 'money',
      envRouting: 'fable-local-opus',
    });
    expect(r).toEqual({ id: 'speed-tiered', source: 'cli' });
  });

  it('declared delivery.routing beats ambient env routing', () => {
    const r = resolveRoutingId({ cfgRouting: 'cost-tiered', envRouting: 'speed-tiered' });
    expect(r).toEqual({ id: 'cost-tiered', source: 'config' });
  });

  it('criticality maps to its routing preset (money → cost-tiered)', () => {
    const r = resolveRoutingId({ cfgCriticality: 'money', envRouting: 'speed-tiered' });
    expect(r).toEqual({ id: 'cost-tiered', source: 'criticality' });
  });

  it('criticality normal → sonnet-5-tiered', () => {
    expect(resolveRoutingId({ cfgCriticality: 'normal' })).toEqual({
      id: 'sonnet-5-tiered',
      source: 'criticality',
    });
  });

  it('criticality sandbox SUPPRESSES ambient env routing', () => {
    // The declared posture wins over the stale shell even when the posture is
    // "no routing": otherwise UAP_DELIVER_ROUTING in .bashrc would override a
    // repo that deliberately declared sandbox (free local only).
    const r = resolveRoutingId({ cfgCriticality: 'sandbox', envRouting: 'speed-tiered' });
    expect(r).toEqual({ id: null, source: 'criticality' });
  });

  it('falls back to ambient env when the project declares nothing', () => {
    const r = resolveRoutingId({ envRouting: 'cost-tiered' });
    expect(r).toEqual({ id: 'cost-tiered', source: 'env' });
  });

  it('returns null when nothing anywhere names a routing', () => {
    expect(resolveRoutingId({})).toEqual({ id: null, source: null });
  });

  it('ignores an unknown criticality rather than guessing', () => {
    const r = resolveRoutingId({ cfgCriticality: 'platinum', envRouting: 'cost-tiered' });
    expect(r).toEqual({ id: 'cost-tiered', source: 'env' });
  });
});

describe('criticality → preset map (G1)', () => {
  it('covers exactly money/normal/sandbox', () => {
    expect(Object.keys(CRITICALITY_ROUTING).sort()).toEqual(['money', 'normal', 'sandbox']);
    expect(CRITICALITY_ROUTING.sandbox).toBeNull();
  });

  it('every mapped preset actually exists and resolves', () => {
    for (const preset of Object.values(CRITICALITY_ROUTING)) {
      if (preset === null) continue;
      const r = resolveTierModelById(preset, 'fix a typo');
      expect(r, `preset ${preset} must resolve`).not.toBeNull();
      expect(r!.preset).toBe(preset);
    }
  });
});

describe('DeliverySchema routing fields (G1)', () => {
  it('accepts model, routing and criticality', () => {
    const d = DeliverySchema.parse({
      model: 'sonnet-5',
      routing: 'cost-tiered',
      criticality: 'money',
    });
    expect(d.model).toBe('sonnet-5');
    expect(d.routing).toBe('cost-tiered');
    expect(d.criticality).toBe('money');
  });

  it('rejects an unknown criticality at the schema boundary', () => {
    expect(() => DeliverySchema.parse({ criticality: 'platinum' })).toThrow();
  });

  it('leaves the fields absent (not defaulted) when undeclared', () => {
    const d = DeliverySchema.parse({});
    expect(d.model).toBeUndefined();
    expect(d.routing).toBeUndefined();
    expect(d.criticality).toBeUndefined();
  });
});
