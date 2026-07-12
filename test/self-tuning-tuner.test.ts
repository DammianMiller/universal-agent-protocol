import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  TUNABLE_FLAGS,
  defaultFlagConfig,
  isFlagActive,
  getTunableFlag,
  coerceToDomain,
  diffConfigs,
  applyChanges,
  activeFlags,
  type FlagConfig,
} from '../src/self-tuning/flags.js';
import { applyFlagChanges } from '../src/self-tuning/flag-writer.js';
import { proposeNext, generateCandidates, fitAndPredict, type Observation } from '../src/self-tuning/search-reducer.js';
import { sanitizeChanges, proposeTuning, type TuningContext } from '../src/self-tuning/llm-tuner.js';
import type { JudgeClient } from '../src/self-tuning/judge.js';
import { validateMod, invertMod, describeMod, type ConfigMod } from '../src/self-harness/mods.js';

describe('flags — domain + dependency model', () => {
  it('builds a default config over every tunable flag', () => {
    const cfg = defaultFlagConfig();
    expect(Object.keys(cfg).length).toBe(TUNABLE_FLAGS.length);
  });

  it('gates a dependent flag on its parent', () => {
    const fusionN = getTunableFlag('recipes.fusionN')!;
    const off: FlagConfig = { ...defaultFlagConfig(), 'recipes.enabled': false, 'recipes.recipe': 'auto' };
    const on: FlagConfig = { ...off, 'recipes.enabled': true, 'recipes.recipe': 'fusion' };
    expect(isFlagActive(fusionN, off)).toBe(false); // parent recipe not fusion/auto → gated... 'auto' is allowed
    // With recipes off, recipes.recipe itself is inactive, so fusionN's parent
    // value is 'auto' (default) but recipes.recipe is gated → treat as inactive.
    expect(isFlagActive(fusionN, on)).toBe(true);
  });

  it('coerces values into their domain (clamp + int snap + enum fallback)', () => {
    expect(coerceToDomain('recipes.fusionN', 99)).toBe(6); // clamp to max
    expect(coerceToDomain('recipes.fusionN', 3.7)).toBe(4); // int snap
    expect(coerceToDomain('recipes.recipe', 'nonsense')).toBe(getTunableFlag('recipes.recipe')!.default);
    expect(coerceToDomain('recipes.enabled', 'true')).toBe(true);
    expect(coerceToDomain('not.a.flag', 1)).toBeNull();
  });

  it('diffs and applies configs (minimal change set, round-trips)', () => {
    const a = defaultFlagConfig();
    const b = { ...a, 'recipes.enabled': !a['recipes.enabled'] };
    const changes = diffConfigs(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0].key).toBe('recipes.enabled');
    const applied = applyChanges(a, changes);
    expect(applied['recipes.enabled']).toBe(b['recipes.enabled']);
  });
});

describe('flag-writer — atomic write + rollback', () => {
  it('applies json/proxyEnv/shell flags and rolls back file writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-flagwriter-'));
    try {
      const uapJson = join(dir, '.uap.json');
      writeFileSync(uapJson, JSON.stringify({ version: '1.0.0', recipes: { enabled: false } }, null, 2));
      const before = readFileSync(uapJson, 'utf-8');

      const res = applyFlagChanges(dir, [
        { key: 'recipes.enabled', from: false, to: true, category: 'recipes' },
        { key: 'PROXY_LOOP_BREAKER', from: true, to: false, category: 'proxy' },
        { key: 'UAP_HANDSFREE_STAGNATION_LIMIT', from: 8, to: 5, category: 'orchestration' },
      ]);

      // json flag written
      const afterJson = JSON.parse(readFileSync(uapJson, 'utf-8'));
      expect(afterJson.recipes.enabled).toBe(true);
      // proxyEnv flag written to .uap/proxy.env
      const proxyEnv = join(dir, '.uap', 'proxy.env');
      expect(existsSync(proxyEnv)).toBe(true);
      expect(readFileSync(proxyEnv, 'utf-8')).toMatch(/PROXY_LOOP_BREAKER=/);
      // shell flag staged, not persisted
      expect(res.shellEnv.UAP_HANDSFREE_STAGNATION_LIMIT).toBe('5');
      expect(res.applied.length).toBe(3);

      // rollback restores exactly
      res.rollback();
      expect(readFileSync(uapJson, 'utf-8')).toBe(before);
      expect(existsSync(proxyEnv)).toBe(false); // did not exist before → removed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry-run computes effects without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-flagwriter-dry-'));
    try {
      writeFileSync(join(dir, '.uap.json'), JSON.stringify({ recipes: { enabled: false } }));
      const before = readFileSync(join(dir, '.uap.json'), 'utf-8');
      const res = applyFlagChanges(dir, [{ key: 'recipes.enabled', from: false, to: true, category: 'recipes' }], { dryRun: true });
      expect(res.applied).toHaveLength(1);
      expect(readFileSync(join(dir, '.uap.json'), 'utf-8')).toBe(before); // untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('search-reducer — Gaussian-process Bayesian optimizer', () => {
  // A synthetic quality surface: peaks when recipes are on and recon threshold low.
  const quality = (cfg: FlagConfig): number => {
    let q = 50;
    if (cfg['recipes.enabled'] === true) q += 20;
    const recon = Number(cfg['PROXY_RECON_CONVERGENCE_THRESHOLD']);
    q += Math.max(0, 15 - Math.abs(recon - 30) / 4);
    return q;
  };

  const seedObs = (): Observation[] => {
    const base = defaultFlagConfig();
    return [
      { config: { ...base, 'recipes.enabled': false, PROXY_RECON_CONVERGENCE_THRESHOLD: 100 }, quality: quality({ ...base, 'recipes.enabled': false, PROXY_RECON_CONVERGENCE_THRESHOLD: 100 }) },
      { config: { ...base, 'recipes.enabled': true, PROXY_RECON_CONVERGENCE_THRESHOLD: 80 }, quality: quality({ ...base, 'recipes.enabled': true, PROXY_RECON_CONVERGENCE_THRESHOLD: 80 }) },
      { config: { ...base, 'recipes.enabled': true, PROXY_RECON_CONVERGENCE_THRESHOLD: 40 }, quality: quality({ ...base, 'recipes.enabled': true, PROXY_RECON_CONVERGENCE_THRESHOLD: 40 }) },
      { config: { ...base, 'recipes.enabled': false, PROXY_RECON_CONVERGENCE_THRESHOLD: 40 }, quality: quality({ ...base, 'recipes.enabled': false, PROXY_RECON_CONVERGENCE_THRESHOLD: 40 }) },
    ];
  };

  it('generates dependency-respecting candidate configs distinct from the best', () => {
    const best = defaultFlagConfig();
    const cands = generateCandidates(best, { seed: 1, poolSize: 64 });
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => JSON.stringify(c) !== JSON.stringify(best))).toBe(true);
  });

  it('fits a GP and returns finite predictive mean/std', () => {
    const obs = seedObs();
    const pred = fitAndPredict(obs, { ...defaultFlagConfig(), 'recipes.enabled': true, PROXY_RECON_CONVERGENCE_THRESHOLD: 30 });
    expect(pred).not.toBeNull();
    expect(Number.isFinite(pred!.mean)).toBe(true);
    expect(pred!.std).toBeGreaterThanOrEqual(0);
  });

  it('proposes an EI-maximizing candidate, deterministically per seed', () => {
    const obs = seedObs();
    const a = proposeNext(obs, { seed: 7, poolSize: 128 });
    const b = proposeNext(obs, { seed: 7, poolSize: 128 });
    expect(a).not.toBeNull();
    expect(a!.config).toEqual(b!.config); // same seed → same proposal
    expect(Number.isFinite(a!.mean)).toBe(true);
  });

  it('converges toward the optimum over BO iterations', () => {
    let obs = seedObs();
    let best = Math.max(...obs.map((o) => o.quality));
    for (let i = 0; i < 12; i++) {
      const s = proposeNext(obs, { seed: 100 + i, poolSize: 200 });
      if (!s) break;
      const q = quality(s.config);
      obs = [...obs, { config: s.config, quality: q }];
      best = Math.max(best, q);
    }
    // The true optimum is 50+20+15 = 85 (recipes on, recon=30). BO should get close.
    expect(best).toBeGreaterThan(80);
  });
});

describe('llm-tuner — proposal sanitization + routing', () => {
  const ctx = (): TuningContext => ({
    model: 'qwen36-a3b',
    currentConfig: { ...defaultFlagConfig(), 'recipes.enabled': false, 'recipes.recipe': 'auto' },
    observations: [{ config: defaultFlagConfig(), quality: 55 }],
    validationSuites: ['s1'],
  });

  it('drops invalid keys, no-ops, and gated children; coerces + caps', () => {
    const cur = ctx().currentConfig;
    const clean = sanitizeChanges(cur, [
      { key: 'not.a.flag', to: 1 }, // dropped: unknown
      { key: 'recipes.enabled', to: false }, // dropped: no-op (already false)
      { key: 'recipes.fusionN', to: 5 }, // dropped: parent recipes disabled → gated
      { key: 'PROXY_RECON_CONVERGENCE_THRESHOLD', to: 999 }, // kept, clamped to max
    ], 4);
    const keys = clean.map((c) => c.key);
    expect(keys).toContain('PROXY_RECON_CONVERGENCE_THRESHOLD');
    expect(keys).not.toContain('not.a.flag');
    expect(keys).not.toContain('recipes.fusionN');
    const recon = clean.find((c) => c.key === 'PROXY_RECON_CONVERGENCE_THRESHOLD')!;
    expect(Number(recon.to)).toBeLessThanOrEqual(120);
  });

  it('keeps a dependent change when its parent is enabled in the same set', () => {
    const cur = { ...defaultFlagConfig(), 'recipes.enabled': false, 'recipes.recipe': 'auto' };
    const clean = sanitizeChanges(cur, [
      { key: 'recipes.enabled', to: true },
      { key: 'recipes.recipe', to: 'fusion' },
      { key: 'recipes.fusionN', to: 4 },
    ], 4);
    expect(clean.map((c) => c.key)).toEqual(['recipes.enabled', 'recipes.recipe', 'recipes.fusionN']);
  });

  it('uses the LLM path when a judge proposes valid changes', async () => {
    const judge: JudgeClient = {
      id: 'stub',
      complete: async () => JSON.stringify({
        changes: [{ key: 'recipes.enabled', to: true }],
        rationale: 'enable escalation',
        expectedDelta: 8,
        confidence: 0.7,
      }),
    };
    const p = await proposeTuning(ctx(), { judge });
    expect(p.source).toBe('llm');
    expect(p.changes.map((c) => c.key)).toContain('recipes.enabled');
    expect(p.confidence).toBeCloseTo(0.7);
  });

  it('falls back to the GP path when no judge is available', async () => {
    const c = ctx();
    c.observations = [
      { config: { ...defaultFlagConfig(), 'recipes.enabled': false }, quality: 50 },
      { config: { ...defaultFlagConfig(), 'recipes.enabled': true }, quality: 62 },
      { config: { ...defaultFlagConfig(), PROXY_LOOP_BREAKER: false }, quality: 48 },
    ];
    const p = await proposeTuning(c, {});
    expect(p.source).toBe('gp');
    expect(p.targetModel).toBe('qwen36-a3b');
  });

  it('falls back to GP when the judge output is garbage', async () => {
    const judge: JudgeClient = { id: 'bad', complete: async () => 'not json' };
    const c = ctx();
    c.observations = [
      { config: { ...defaultFlagConfig(), 'recipes.enabled': false }, quality: 50 },
      { config: { ...defaultFlagConfig(), 'recipes.enabled': true }, quality: 62 },
      { config: { ...defaultFlagConfig(), PROXY_STUCK_BREAK: false }, quality: 47 },
    ];
    const p = await proposeTuning(c, { judge });
    expect(p.source).toBe('gp-fallback');
  });
});

describe('Mod DSL — ConfigMod', () => {
  it('validates a registry-backed config change', () => {
    const good: ConfigMod = { kind: 'config', key: 'recipes.confidenceThreshold', from: '0.5', to: '0.7', category: 'recipes' };
    expect(validateMod(good)).toEqual({ ok: true });
  });

  it('rejects an out-of-range or unknown config change', () => {
    const oor: ConfigMod = { kind: 'config', key: 'recipes.confidenceThreshold', from: '0.5', to: '5', category: 'recipes' };
    expect(validateMod(oor).ok).toBe(false);
    const unknown: ConfigMod = { kind: 'config', key: 'nope.nope', from: 'a', to: 'b', category: 'general' };
    expect(validateMod(unknown).ok).toBe(false);
  });

  it('inverts and describes a config mod', () => {
    const m: ConfigMod = { kind: 'config', key: 'handsfree.intensity', from: 'normal', to: 'aggressive', category: 'orchestration' };
    expect(invertMod(m)).toMatchObject({ kind: 'config', from: 'aggressive', to: 'normal' });
    expect(describeMod(m)).toContain('handsfree.intensity');
  });
});
