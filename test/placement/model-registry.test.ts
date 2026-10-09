/**
 * Model placement registry: load, repo/local merge, provenance, fail-closed
 * unmeasured handling, cost math, and the capacity-policy cross-check
 * (spec: docs/specs/operator-model-placement.md §4.1, §7).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  configCostMiB,
  isPlaceable,
  loadModelRegistry,
  validateRegistry,
  type ModelRegistry,
} from '../../src/placement/registry.js';

const baseRepo: ModelRegistry = {
  version: 1,
  devices: {
    gpu0: { kind: 'gpu' },
    cpu0: { kind: 'cpu' },
  },
  models: {
    'qwen3.8-flash-next': {
      display: 'Qwen3.8 Flash Next',
      engine: 'strata',
      unit: 'uap-strata-server',
      service: 'strata-server',
      advertises: ['qwen3.8-flash-next-iq3_s'],
      affinity: { device: ['gpu0'] },
      configs: {
        'strata-iq3_s': { status: 'unmeasured', unit: 'uap-strata-server' },
      },
    },
    'qwen3.8-27b': {
      display: 'Qwen3.8 27B',
      engine: 'llama.cpp',
      affinity: { device: ['gpu0'] },
      configs: {
        'llama-mtp': { status: 'unmeasured', unit: 'uap-llama-server' },
      },
    },
  },
};

const measuredLocal = {
  version: 1,
  devices: {
    gpu0: { kind: 'gpu', name: 'NVIDIA GeForce RTX 3090', total_mib: 24576, reserved_mib: 2048 },
    cpu0: { kind: 'cpu', total_mib: 126944, reserved_mib: 8192 },
  },
  models: {
    'qwen3.8-flash-next': {
      display: 'Qwen3.8 Flash Next',
      configs: {
        'strata-iq3_s': {
          unit: 'uap-strata-server',
          resident_gpu_mib: 21812,
          host_rss_mib: 52857,
          context_pool_cells: 131072,
          kv_resident_cells: 32768,
          kv_kind: 'int8',
          kv_mib_per_1k_cells: 12.2,
          measured_at: '2026-10-08T14:02:00Z',
          measured_on: 'gpu0',
        },
      },
    },
  },
};

const policy = {
  version: 1 as const,
  services: [
    {
      name: 'strata-server',
      http: { url: 'http://127.0.0.1:8080', kind: 'strata' as const, metricsMustMatch: { kv: 'int8', max_context: 131072 } },
      headroom: { gpuMinFreeMiB: 200 },
    },
    {
      name: 'gsq-rco-server',
      systemd: { unit: 'uap-gsq-rco-server', scope: 'user' as const },
      budget: { execStartMustContain: ['-c 229376'] },
    },
  ],
};

let dir: string;
function setup(): { repo: string; local: string } {
  dir = mkdtempSync(join(tmpdir(), 'model-registry-'));
  const repo = join(dir, 'repo.json');
  const local = join(dir, 'local.json');
  writeFileSync(repo, JSON.stringify(baseRepo));
  return { repo, local };
}
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('loadModelRegistry', () => {
  it('repo defaults alone leave every config unmeasured — fail closed', () => {
    const { repo, local } = setup();
    const loaded = loadModelRegistry(dir, { repoPath: repo, localPath: local });
    expect(loaded.errors).toEqual([]);
    const cfg = loaded.registry.models['qwen3.8-flash-next'].configs['strata-iq3_s'];
    expect(isPlaceable(cfg)).toBe(false);
    expect(loaded.measuredFrom.size).toBe(0);
  });

  it('machine-local measurements merge over repo defaults with provenance', () => {
    const { repo, local } = setup();
    writeFileSync(local, JSON.stringify(measuredLocal));
    const loaded = loadModelRegistry(dir, { repoPath: repo, localPath: local });
    expect(loaded.errors).toEqual([]);
    const cfg = loaded.registry.models['qwen3.8-flash-next'].configs['strata-iq3_s'];
    expect(isPlaceable(cfg)).toBe(true);
    expect(loaded.measuredFrom.get('qwen3.8-flash-next/strata-iq3_s')).toBe('local');
    // Identity fields from the repo entry survive the merge.
    expect(cfg.unit).toBe('uap-strata-server');
    // Repo-only entries stay unmeasured.
    expect(isPlaceable(loaded.registry.models['qwen3.8-27b'].configs['llama-mtp'])).toBe(false);
    // Device totals come from the local file.
    expect(loaded.registry.devices.gpu0.total_mib).toBe(24576);
  });

  it('an invalid machine-local file is an error, never silently ignored', () => {
    const { repo, local } = setup();
    writeFileSync(local, JSON.stringify({ version: 1, models: { bogus: true } }));
    const loaded = loadModelRegistry(dir, { repoPath: repo, localPath: local });
    expect(loaded.errors.length).toBeGreaterThan(0);
    // Fail closed: the flash-next config falls back to repo shape (unmeasured).
    expect(isPlaceable(loaded.registry.models['qwen3.8-flash-next'].configs['strata-iq3_s'])).toBe(false);
  });

  it('a machine-local overlay with only models is valid — measure writes this shape', () => {
    const { repo, local } = setup();
    const { devices: _devices, ...modelsOnly } = measuredLocal;
    writeFileSync(local, JSON.stringify(modelsOnly));
    const loaded = loadModelRegistry(dir, { repoPath: repo, localPath: local });
    expect(loaded.errors).toEqual([]);
    expect(isPlaceable(loaded.registry.models['qwen3.8-flash-next'].configs['strata-iq3_s'])).toBe(true);
    // Devices fall back to repo shape.
    expect(loaded.registry.devices.gpu0.total_mib).toBeUndefined();
  });
});

describe('configCostMiB', () => {
  const measured = measuredLocal.models['qwen3.8-flash-next'].configs['strata-iq3_s'];

  it('costs the resident figure within the already-paid KV pool', () => {
    expect(configCostMiB(measured, 32768)).toBe(21812);
    expect(configCostMiB(measured, 1)).toBe(21812);
  });

  it('scales marginal KV beyond the resident pool', () => {
    // 21812 + 81920/1000 × 12.2 = 21812 + 999.424
    expect(configCostMiB(measured, 114688)).toBeCloseTo(22811.424, 2);
  });

  it('returns null — refuse, not guess — beyond the pool with no kv rate', () => {
    expect(configCostMiB({ ...measured, kv_mib_per_1k_cells: undefined }, 40000)).toBeNull();
  });
});

describe('validateRegistry', () => {
  it('cross-checks measured configs against policy metricsMustMatch', () => {
    const { repo, local } = setup();
    writeFileSync(local, JSON.stringify(measuredLocal));
    const loaded = loadModelRegistry(dir, { repoPath: repo, localPath: local });
    // Link the unmeasured llama-mtp config to the strata service so the
    // "cannot cross-check: unmeasured" path is exercised.
    const llamaCfg = loaded.registry.models['qwen3.8-27b'].configs['llama-mtp'] as { service?: string };
    llamaCfg.service = 'strata-server';
    const findings = validateRegistry(loaded.registry, policy);
    // The measured entry agrees with the policy: kv int8, max_context 131072.
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    // Unmeasured configs with a service link cannot be cross-checked.
    expect(findings.some((f) => f.severity === 'warning' && /cannot cross-check/.test(f.message))).toBe(true);
  });

  it('errors when a measured footprint contradicts the policy', () => {
    const { repo, local } = setup();
    const drifted = JSON.parse(JSON.stringify(measuredLocal)) as typeof measuredLocal;
    drifted.models['qwen3.8-flash-next'].configs['strata-iq3_s'].kv_kind = 'fp16';
    writeFileSync(local, JSON.stringify(drifted));
    const loaded = loadModelRegistry(dir, { repoPath: repo, localPath: local });
    const findings = validateRegistry(loaded.registry, policy);
    expect(findings.some((f) => f.severity === 'error' && /kv_kind 'fp16' contradicts/.test(f.message))).toBe(true);
  });

  it('errors on unknown affinity devices and impossible KV geometry', () => {
    const broken: ModelRegistry = {
      version: 1,
      devices: { gpu0: { kind: 'gpu' }, cpu0: { kind: 'cpu' } },
      models: {
        m: {
          display: 'M',
          affinity: { device: ['gpu9'] },
          configs: {
            c: {
              resident_gpu_mib: 1000,
              host_rss_mib: 2000,
              context_pool_cells: 4096,
              kv_resident_cells: 8192, // exceeds the pool
              measured_at: '2026-10-08T00:00:00Z',
              measured_on: 'cpu0', // not a gpu
            },
          },
        },
      },
    };
    const findings = validateRegistry(broken, policy);
    expect(findings.some((f) => f.severity === 'error' && /affinity device 'gpu9'/.test(f.message))).toBe(true);
    expect(findings.some((f) => f.severity === 'error' && /kv_resident_cells 8192 exceeds/.test(f.message))).toBe(true);
    expect(findings.some((f) => f.severity === 'error' && /'cpu0' is not a gpu/.test(f.message))).toBe(true);
  });

  it('errors when a declared policy service does not exist', () => {
    const broken: ModelRegistry = {
      version: 1,
      devices: { gpu0: { kind: 'gpu' } },
      models: {
        m: {
          display: 'M',
          affinity: { device: ['gpu0'] },
          service: 'no-such-service',
          configs: { c: { status: 'unmeasured' } },
        },
      },
    };
    const findings = validateRegistry(broken, policy);
    expect(findings.some((f) => f.severity === 'error' && /no service by that name/.test(f.message))).toBe(true);
  });
});
