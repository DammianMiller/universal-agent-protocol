import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeManifest,
  attributeManifest,
  decideManifest,
  ManifestStore,
} from '../../src/self-harness/manifest.js';
import type { Mod } from '../../src/self-harness/mods.js';
import type { RunRecord } from '../../src/benchmarks/paired/types.js';

const MOD: Mod = { kind: 'env', key: 'LLAMA_N_PREDICT', from: '2048', to: '4096' };

function rec(taskId: string, correct: boolean, seed = 0): RunRecord {
  return {
    taskId,
    condition: 'uap-full',
    seed,
    adapter: 'mock',
    model: 'm',
    metrics: { correct } as RunRecord['metrics'],
  };
}

const manifest = makeManifest({
  id: 'm1',
  mod: MOD,
  now: '2026-07-31T00:00:00Z',
  predictedFixes: ['t1'],
  predictedRisks: ['t2'],
});

describe('attributeManifest (harness plan C)', () => {
  it('credits a predicted fix that actually flipped', () => {
    const a = attributeManifest(manifest, [rec('t1', false)], [rec('t1', true)]);
    expect(a.fixesRealised).toEqual(['t1']);
    expect(a.fixesMissed).toEqual([]);
    expect(a.netDelta).toBe(1);
  });

  it('records a predicted fix that did not materialise as missed', () => {
    const a = attributeManifest(manifest, [rec('t1', false)], [rec('t1', false)]);
    expect(a.fixesRealised).toEqual([]);
    expect(a.fixesMissed).toEqual(['t1']);
  });

  it('separates declared risk from undeclared regression', () => {
    const before = [rec('t1', false), rec('t2', true), rec('t3', true)];
    const after = [rec('t1', true), rec('t2', false), rec('t3', false)];
    const a = attributeManifest(manifest, before, after);
    expect(a.risksRealised).toEqual(['t2']); // declared
    expect(a.unpredictedRegressions).toEqual(['t3']); // not declared
  });

  it('does not count a flaky task as a fix', () => {
    // Passes on one seed, fails on another — calling that a realised prediction
    // would let noise masquerade as harness improvement.
    const a = attributeManifest(manifest, [rec('t1', false)], [rec('t1', true, 0), rec('t1', false, 1)]);
    expect(a.fixesRealised).toEqual([]);
  });
});

describe('decideManifest (harness plan C)', () => {
  it('keeps a change that delivered its prediction cleanly', () => {
    const a = attributeManifest(manifest, [rec('t1', false)], [rec('t1', true)]);
    const d = decideManifest(manifest, a);
    expect(d.verdict).toBe('keep');
    expect(d.revert).toBeUndefined();
  });

  it('reverts on ANY undeclared regression, even alongside a realised fix', () => {
    const before = [rec('t1', false), rec('t3', true)];
    const after = [rec('t1', true), rec('t3', false)];
    const d = decideManifest(manifest, attributeManifest(manifest, before, after));
    expect(d.verdict).toBe('revert');
    expect(d.reason).toMatch(/undeclared/);
    // The revert is the inverse Mod, ready to apply.
    expect(d.revert).toEqual({ kind: 'env', key: 'LLAMA_N_PREDICT', from: '4096', to: '2048' });
  });

  it('reverts a change that predicted fixes and realised none', () => {
    const d = decideManifest(manifest, attributeManifest(manifest, [rec('t1', false)], [rec('t1', false)]));
    expect(d.verdict).toBe('revert');
    expect(d.reason).toMatch(/realised none/);
  });

  it('reverts on a negative net delta', () => {
    const before = [rec('t1', false), rec('t2', true)];
    const after = [rec('t1', false), rec('t2', false)];
    const d = decideManifest(manifest, attributeManifest(manifest, before, after));
    expect(d.verdict).toBe('revert');
  });

  it('tolerates declared risk when the net stays non-negative', () => {
    const before = [rec('t1', false), rec('t2', true)];
    const after = [rec('t1', true), rec('t2', false)];
    const d = decideManifest(manifest, attributeManifest(manifest, before, after));
    expect(d.verdict).toBe('keep');
  });
});

describe('ManifestStore', () => {
  it('round-trips open manifests and closes them with a verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-manifest-'));
    try {
      const store = new ManifestStore(dir);
      store.record(manifest);
      expect(store.open().map((m) => m.id)).toEqual(['m1']);

      // A fresh instance reads the same file — the loop survives a restart.
      expect(new ManifestStore(dir).open()).toHaveLength(1);

      const a = attributeManifest(manifest, [rec('t1', false)], [rec('t1', true)]);
      store.close(manifest, a, decideManifest(manifest, a));
      expect(store.open()).toHaveLength(0);
      expect(store.closed()).toHaveLength(1);
      expect(new ManifestStore(dir).closed()[0].decision.verdict).toBe('keep');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
