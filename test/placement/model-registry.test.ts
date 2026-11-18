/**
 * Model placement registry: load, repo/local merge, provenance, fail-closed
 * unmeasured handling, cost math, and the capacity-policy cross-check
 * (spec: docs/specs/operator-model-placement.md §4.1, §7).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { parsePolicy } from '../../src/capacity/policy.js';
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
          context_pool_cells: 196608,
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
      http: { url: 'http://127.0.0.1:8080', kind: 'strata' as const, metricsMustMatch: { kv: 'int8', max_context: 196608 } },
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
    // 21812 + 147456/1000 × 12.2 = 21812 + 1798.9632
    expect(configCostMiB(measured, 180224)).toBeCloseTo(23610.9632, 2);
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
    // The measured entry agrees with the policy: kv int8, max_context 196608.
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

// ---------------------------------------------------------------------------
// Repo registry wiring: the ugc-factory brain (qwen3.6-27b via uap-dflash-server)
// ---------------------------------------------------------------------------

const repoRoot = new URL('../../', import.meta.url).pathname;

describe('repo registry: ugc brain (qwen3.6-27b) wiring', () => {
  let own: string;
  afterAll(() => {
    if (own) rmSync(own, { recursive: true, force: true });
  });
  it('ships the dflash config, advertises the ugc id, and fails closed until measured', () => {
    own = mkdtempSync(join(tmpdir(), 'ugc-registry-'));
    const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
    expect(loaded.errors).toEqual([]);
    const entry = loaded.registry.models['qwen3.6-27b'];
    expect(entry, 'config/model-registry.json must keep the qwen3.6-27b entry').toBeTruthy();
    expect(entry.unit).toBe('uap-dflash-server');
    expect(entry.engine).toBe('dflash');
    expect(entry.advertises).toContain('qwen3.6-27b');
    expect(entry.affinity?.device).toEqual(['gpu0']);
    const cfg = entry.configs['dflash-q3_k_m'];
    expect(cfg.unit).toBe('uap-dflash-server');
    // The repo ships shape only: unmeasured configs can never load (spec §4.1)
    // until `uap models measure` records this machine's footprint.
    expect(isPlaceable(cfg)).toBe(false);
  });

  it('a measured machine-local overlay makes the ugc brain placeable', () => {
    const overlayPath = join(own, 'ugc-measured.json');
    writeFileSync(overlayPath, JSON.stringify({
      version: 1,
      models: {
        'qwen3.6-27b': {
          display: 'Qwen3.6 27B',
          configs: {
            'dflash-q3_k_m': {
              unit: 'uap-dflash-server',
              resident_gpu_mib: 16000,
              host_rss_mib: 4000,
              context_pool_cells: 16384,
              kv_resident_cells: 16384,
              kv_kind: 'tq3_0',
              measured_at: '2026-10-10T00:00:00Z',
              measured_on: 'gpu0',
            },
          },
        },
      },
    }));
    const loaded = loadModelRegistry(repoRoot, { localPath: overlayPath });
    expect(loaded.errors).toEqual([]);
    const cfg = loaded.registry.models['qwen3.6-27b'].configs['dflash-q3_k_m'];
    expect(isPlaceable(cfg)).toBe(true);
    // configCostMiB must be answerable within the measured pool.
    expect(configCostMiB(cfg, 16384)).toBe(16000);
  });
});

// ---------------------------------------------------------------------------
// Files manifest: what `uap models ensure` recovers a deleted weight from
// ---------------------------------------------------------------------------

describe('files manifest (model-file recovery)', () => {
  it('accepts path/repo/rev/bytes/sha256 on any config, measured or unmeasured', () => {
    const own = mkdtempSync(join(tmpdir(), 'files-registry-'));
    try {
      const repoPath = join(own, 'repo.json');
      writeFileSync(repoPath, JSON.stringify({
        version: 1,
        devices: { gpu0: { kind: 'gpu' }, cpu0: { kind: 'cpu' } },
        models: {
          'qwen3.8-27b': {
            display: 'Qwen3.8 27B',
            configs: {
              ampere: {
                status: 'unmeasured',
                files: [
                  {
                    path: '/home/x/Qwen3.8-27B-ATX-4-XS.gguf',
                    repo: 'jakeatx/Qwen3.8-27B-ATX-IQ4_XS-M-GGUF',
                    bytes: 15588551712,
                    sha256: 'a'.repeat(64),
                  },
                ],
              },
              openjet: {
                // A measured entry must also carry the manifest — a measure
                // write replaces the repo config wholesale, so identity
                // (files included) has to survive it.
                unit: 'uap-openjet-server',
                files: [
                  {
                    path: '/home/x/Qwen3.8-27B-Q4_K_M.gguf',
                    repo: 'unsloth/Qwen3.8-27B-GGUF',
                    rev: '566347e99d832d31f6245a577198d10d5bdd389e',
                    bytes: 17106775008,
                  },
                ],
                resident_gpu_mib: 23600,
                host_rss_mib: 24000,
                context_pool_cells: 115968,
                kv_resident_cells: 115968,
                kv_kind: 'q8_0',
                measured_at: '2026-10-28T00:00:00Z',
                measured_on: 'gpu0',
              },
            },
          },
        },
      }));
      const loaded = loadModelRegistry(own, { repoPath, localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const ampere = loaded.registry.models['qwen3.8-27b'].configs['ampere'];
      expect(ampere.files?.[0].repo).toBe('jakeatx/Qwen3.8-27B-ATX-IQ4_XS-M-GGUF');
      const openjet = loaded.registry.models['qwen3.8-27b'].configs['openjet'];
      expect(openjet.files?.[0].rev).toBe('566347e99d832d31f6245a577198d10d5bdd389e');
      expect(isPlaceable(openjet)).toBe(true);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('rejects a malformed sha256 — never record a digest we cannot verify against', () => {
    const own = mkdtempSync(join(tmpdir(), 'files-bad-registry-'));
    try {
      const repoPath = join(own, 'repo.json');
      writeFileSync(repoPath, JSON.stringify({
        version: 1,
        devices: { gpu0: { kind: 'gpu' } },
        models: {
          m: {
            display: 'M',
            configs: {
              c: {
                status: 'unmeasured',
                files: [{ path: '/home/x/a.gguf', repo: 'o/r', sha256: 'A'.repeat(63) }],
              },
            },
          },
        },
      }));
      const loaded = loadModelRegistry(own, { repoPath, localPath: join(own, 'no-local.json') });
      expect(loaded.errors.length).toBeGreaterThan(0);
      expect(loaded.errors[0]).toMatch(/sha256/);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('the shipped registry declares the 27B arms with recorded sources and sizes', () => {
    const own = mkdtempSync(join(tmpdir(), 'files-shipped-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const ampere = loaded.registry.models['qwen3.8-27b'].configs['ampere'];
      expect(ampere.files?.[0]).toMatchObject({
        repo: 'jakeatx/Qwen3.8-27B-ATX-IQ4_XS-M-GGUF',
        bytes: 15588551712,
      });
      const openjet = loaded.registry.models['qwen3.8-27b'].configs['openjet'];
      // unsloth deleted the Q4_K_M from main — the manifest MUST pin the rev.
      expect(openjet.files?.[0].rev).toBe('566347e99d832d31f6245a577198d10d5bdd389e');
      const strata = loaded.registry.models['qwen3.8-flash-next'].configs['strata-abliterated-iq2_xs'];
      expect(strata.files).toHaveLength(2);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-11-11: the Unsloth Dynamic v3.1 arm — installed for the aidavid125
// stack (Strata 0.2.13.1 / engine 0.1.59); the base IQ3_S arm was dropped
// the same day (superseded by the Swift 1.5 arm at the same quant since
// 2026-10-17, its shards deleted after a links=1 check). RETIRED 2026-11-17:
// the operator switched the fleet to the ISTA-DASLab base IQ3_S arm and
// removed every other flash-next quant — the entry below stays as the
// pinned re-fetch manifest for a future re-stage.
// ---------------------------------------------------------------------------

describe('repo registry: unsloth UD-IQ4_XS-v31 arm wiring (retired 2026-11-17)', () => {
  it('keeps the retired v31 config as the pinned re-fetch manifest — not advertised, alias retired', () => {
    const own = mkdtempSync(join(tmpdir(), 'unsloth-v31-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const entry = loaded.registry.models['qwen3.8-flash-next'];
      // Retired with the 2026-11-17 removal round: the alias left the
      // family advertises for retired_local_aliases (the sync's migration
      // source), and the manifest carries the WEIGHTS REMOVED marker.
      const raw = JSON.parse(
        readFileSync(join(repoRoot, 'config/model-registry.json'), 'utf8'),
      ) as { retired_local_aliases?: string[] };
      expect(entry.advertises).not.toContain('qwen3.8-flash-next-unsloth-ud-iq4_xs-v31');
      expect(raw.retired_local_aliases).toContain('qwen3.8-flash-next-unsloth-ud-iq4_xs-v31');
      const cfg = entry.configs['strata-unsloth-ud-iq4_xs-v31'];
      expect(cfg, 'the retired v31 arm must keep its re-fetch manifest').toBeTruthy();
      expect(cfg.unit).toBe('uap-strata-server');
      expect(cfg.engine).toBe('strata');
      expect(cfg.note).toMatch(/WEIGHTS REMOVED 2026-11-17/);
      // Shape only until `uap models measure` records this machine (spec §4.1).
      expect(isPlaceable(cfg)).toBe(false);
      // The v3.1 republication is HEAD-pinned: every shard must record the
      // revision, size and digest, or `uap models ensure` could re-download
      // from a moved head (the openjet lesson — unsloth moves files).
      expect(cfg.files).toHaveLength(4);
      expect(cfg.files?.every((f) => f.rev === 'd96201194f103c906994f283f504209dc8d2a10c')).toBe(true);
      // The shards live under the repo's UD-IQ4_XS/ SUBFOLDER — the manifest
      // must record the repo-relative path, or `uap models ensure` repair
      // hits a 404 even with the revision pinned (the 2026-11-11 review
      // catch; hfResolveUrl encodes each segment on its own).
      expect(cfg.files?.map((f) => f.file)).toEqual([
        'UD-IQ4_XS/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00004.gguf',
        'UD-IQ4_XS/Qwen3.8-Flash-Next-UD-IQ4_XS-00002-of-00004.gguf',
        'UD-IQ4_XS/Qwen3.8-Flash-Next-UD-IQ4_XS-00003-of-00004.gguf',
        'UD-IQ4_XS/Qwen3.8-Flash-Next-UD-IQ4_XS-00004-of-00004.gguf',
      ]);
      expect(cfg.files?.[1]).toMatchObject({
        repo: 'unsloth/Qwen3.8-Flash-Next-GGUF',
        bytes: 49604491008,
        sha256: '13d5dc8b93d039e4cfade5a9af7037f10c97f7ec4e53f75bd2e9ae34aae54aeb',
      });
      // Shard 4 is the n-gram table, byte-identical across every 4-shard
      // v3.1 set (the 3-shard sets carry a different n-gram shard).
      expect(cfg.files?.[3].sha256).toBe('5de8b5dbf89409acc39468decafd4a4a95b13c29d88a14b0356107897829ec36');
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('reinstated the base IQ3_S arm as the 2026-11-17 default and keeps every retired manifest', () => {
    const own = mkdtempSync(join(tmpdir(), 'iq3s-dropped-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const entry = loaded.registry.models['qwen3.8-flash-next'];
      // 2026-11-17 (evening): the DavidAU abliterated IQ3_S pair is BACK as
      // the LIVE default — the strata default + the speedy engine A/B, same
      // weight set — after the morning ISTA switch, so the 11-11 "dropped
      // arm" expectation inverts again.
      expect(entry.configs['strata-abliterated-iq3_s']).toBeTruthy();
      expect(entry.configs['strata-abliterated-iq3_s'].unit).toBe('uap-strata-server');
      // What ships after the reinstatement round: the LIVE abliterated
      // pair (the strata default + the speedy engine A/B, same weight set),
      // the kept-on-disk ISTA base pair (switchable, not retired), plus
      // every retired arm kept as a pinned re-fetch manifest — each naming
      // the unit that serves its config family.
      expect(Object.keys(entry.configs).sort()).toEqual([
        'speedy-abliterated-iq3_s',
        'speedy-iq3_s',
        'speedy-unsloth-ud-iq4_xs-v31',
        'strata-abliterated-iq2_xs',
        'strata-abliterated-iq3_s',
        'strata-iq3_s',
        'strata-swift-iq3_s',
        'strata-unsloth-ud-iq4_xs-v31',
        'strata-unsloth-ud-q3_k_xl',
      ]);
      expect(entry.configs['strata-iq3_s'].unit).toBe('uap-strata-base-iq3s-server');
      expect(entry.configs['speedy-iq3_s'].unit).toBe('uap-speedy-base-iq3s-server');
      expect(entry.configs['speedy-abliterated-iq3_s'].unit).toBe('uap-speedy-server');
      expect(entry.configs['strata-abliterated-iq2_xs'].unit).toBe('uap-strata-abliterated-server');
      expect(entry.configs['strata-abliterated-iq3_s'].unit).toBe('uap-strata-server');
      expect(entry.configs['strata-swift-iq3_s'].unit).toBe('uap-strata-swift-server');
      expect(entry.configs['strata-unsloth-ud-iq4_xs-v31'].unit).toBe('uap-strata-server');
      expect(entry.configs['strata-unsloth-ud-q3_k_xl'].unit).toBe(
        'uap-strata-unsloth-q3_k_xl-server',
      );
      expect(entry.configs['speedy-unsloth-ud-iq4_xs-v31'].unit).toBe('uap-speedy-server');
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-11-14: the DavidAU abliterated Flash-Next IQ3_S tier — the arm that
// served as the :8080 default 2026-10-23 -> 2026-10-28 (moved to the IQ2_XS
// tier in the 10-28 kernel-OOM fix), re-staged as a switchable inference-
// panel arm (unit uap-strata-abliterated-iq3_s-server.service, switch
// model-switch.sh strata-abliterated-iq3_s; weights on disk since the 10-23
// adoption, re-verified against the HF LFS digests at the 11-14 re-staging).
// RETIRED 2026-11-17 (weights removed with the other flash-next quants),
// then REINSTATED the 2026-11-17 EVENING by operator follow-up: the same
// 2-shard set re-fetched (shard 1 sha256-verified against the Hub LFS oid
// at the pinned rev; shard 2 hardlinked from the live ISTA base copy —
// the tier-shared PLE table, zero re-download; mmproj reused), pack
// rebuilt (1079 tensors, 302 native, arena 1.43 GiB), config realigned to
// the 196608 fleet posture. The :8080 DEFAULT again, served by
// uap-strata-server.service with strata-abliterated-iq3_s.json; the
// morning's ISTA base set stays switchable as strata-base-iq3s.
// ---------------------------------------------------------------------------

describe('repo registry: strata-abliterated-iq3_s arm wiring (reinstated default 2026-11-17 evening)', () => {
  it('ships the reinstated default arm with the pinned DavidAU manifest and fails closed until measured', () => {
    const own = mkdtempSync(join(tmpdir(), 'iq3s-abliterated-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const entry = loaded.registry.models['qwen3.8-flash-next'];
      // Reinstated the 2026-11-17 evening: advertised again, alias
      // un-retired, manifest re-verified on disk at the reinstatement.
      const raw = JSON.parse(
        readFileSync(join(repoRoot, 'config/model-registry.json'), 'utf8'),
      ) as { retired_local_aliases?: string[] };
      expect(entry.advertises).toContain('abliterated-iq3_s');
      expect(raw.retired_local_aliases).not.toContain('abliterated-iq3_s');
      const cfg = entry.configs['strata-abliterated-iq3_s'];
      expect(cfg, 'the reinstated iq3_s arm must keep its manifest').toBeTruthy();
      expect(cfg.engine).toBe('strata');
      expect(cfg.unit).toBe('uap-strata-server');
      expect(cfg.note).toMatch(/REINSTATED/);
      // Shape only until `uap models measure` records this machine (spec §4.1).
      expect(isPlaceable(cfg)).toBe(false);
      // Head-pinned like every shipped manifest — `uap models ensure` must be
      // able to re-fetch and verify from this pin (the openjet lesson).
      expect(cfg.files).toHaveLength(2);
      expect(
        cfg.files?.every(
          (f) =>
            f.repo ===
              'DavidAU/Qwen3.8-Flash-Next-Abliterated-Uncensored-Turbo-Brilliance-50x-Reasoning-Instruct-GSQ-RCO-GGUF' &&
            f.rev === '623b419bd443e6e76ec51ca4b95d951da93c6969',
        ),
      ).toBe(true);
      expect(cfg.files?.map((f) => f.file)).toEqual([
        'Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_S-00001-of-00002.gguf',
        'Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_S-00002-of-00002.gguf',
      ]);
      expect(cfg.files?.[0]).toMatchObject({
        bytes: 55063664928,
        sha256: '78706315c2fe912777c006b4ae18be1024c9f4353bd25d33b8a306c9c55f9e34',
      });
      expect(cfg.files?.[1]).toMatchObject({
        bytes: 28800138432,
        sha256: '316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113',
      });
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('ships the speedy engine A/B on the same DavidAU manifest (one variable: the engine)', () => {
    const own = mkdtempSync(join(tmpdir(), 'speedy-abliterated-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const entry = loaded.registry.models['qwen3.8-flash-next'];
      // The registration id this arm advertises at /v1/models (cfg
      // model_name).
      expect(entry.advertises).toContain('qwen3.8-flash-next-speedy-abliterated-iq3_s');
      const cfg = entry.configs['speedy-abliterated-iq3_s'];
      expect(cfg, 'config/model-registry.json must keep the speedy abliterated arm').toBeTruthy();
      // The engine is the variable, not the weights: engine speedy on the
      // strata-family serve layer, its own unit, its own panel id.
      expect(cfg.engine).toBe('speedy');
      expect(cfg.unit).toBe('uap-speedy-server');
      // Shape only until `uap models measure` records this machine (spec §4.1).
      expect(isPlaceable(cfg)).toBe(false);
      // Byte-identical shard manifest to the strata abliterated default:
      // same paths, bytes, digests and HEAD pin, so `uap models ensure`
      // repairs either arm from one pin and the A/B has exactly one
      // variable (the 2026-11-15 invariant, carried to the reinstated set).
      const base = entry.configs['strata-abliterated-iq3_s'];
      expect(cfg.files).toHaveLength(2);
      expect(cfg.files).toEqual(base.files);
      expect(
        cfg.files?.every((f) => f.rev === '623b419bd443e6e76ec51ca4b95d951da93c6969'),
      ).toBe(true);
      expect(
        cfg.files?.every(
          (f) =>
            f.repo ===
            'DavidAU/Qwen3.8-Flash-Next-Abliterated-Uncensored-Turbo-Brilliance-50x-Reasoning-Instruct-GSQ-RCO-GGUF',
        ),
      ).toBe(true);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('cross-links the tier-shared shard 2 with the IQ2_XS arm entry', () => {
    // Shard 2 (the PLE/expert shard) is byte-identical across the release's
    // tiers — both shipped arm entries must pin the SAME digest, or the
    // tier-sharing invariant silently broke in one of them.
    const own = mkdtempSync(join(tmpdir(), 'iq3s-tier-shared-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const configs = loaded.registry.models['qwen3.8-flash-next'].configs;
      const iq2xs = configs['strata-abliterated-iq2_xs'];
      const iq3s = configs['strata-abliterated-iq3_s'];
      expect(iq3s.files?.[1].sha256).toBe(iq2xs.files?.[1].sha256);
      expect(iq3s.files?.[1].bytes).toBe(iq2xs.files?.[1].bytes);
      // 2026-11-17: the ISTA base IQ3_S default hardlinked the same
      // tier-shared table at install — the digest chain now runs through
      // the live arm too.
      const base = configs['strata-iq3_s'];
      expect(base.files?.[1].sha256).toBe(iq2xs.files?.[1].sha256);
      expect(base.files?.[1].bytes).toBe(iq2xs.files?.[1].bytes);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-11-13: the Edge0 145B latent-MoE arm — the first edge0-strata engine
// backend in the fleet (HF Edge0/Edge0-145B-q3k, derived from Qwen3.8-Flash-
// Next; served by edge0-infer serve delegating to the edge0-strata fork,
// inference-panel id edge0-145b, unit uap-edge0-145b-server.service).
// ---------------------------------------------------------------------------

describe('repo registry: edge0-145b latent-MoE arm wiring', () => {
  it('ships the edge0 config with the full pinned manifest and fails closed until measured', () => {
    const own = mkdtempSync(join(tmpdir(), 'edge0-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const entry = loaded.registry.models['edge0-145b'];
      expect(entry, 'config/model-registry.json must carry the edge0-145b model').toBeTruthy();
      expect(entry.engine).toBe('edge0-strata');
      // Full unit name: the model is systemd-probed by its policy service,
      // and the validator requires model.unit to equal the policy's unit.
      expect(entry.unit).toBe('uap-edge0-145b-server.service');
      expect(entry.endpoint).toBe('http://127.0.0.1:8080');
      // The registration id edge0-infer serve advertises (--alias edge0_145b).
      expect(entry.advertises).toContain('edge0_145b');
      const cfg = entry.configs['edge0-145b-q3k'];
      expect(cfg, 'config/model-registry.json must keep the edge0-145b-q3k arm').toBeTruthy();
      expect(cfg.engine).toBe('edge0-strata');
      expect(cfg.unit).toBe('uap-edge0-145b-server.service');
      // Shape only until `uap models measure` records this machine (spec §4.1).
      expect(isPlaceable(cfg)).toBe(false);
      // The whole serving folder is pinned at one revision — 68 files: the
      // big LFS blobs (experts, PLE, skeleton, both du variants, dense,
      // labels, profile, MTP), all 48 Q3_K scales, the tokenizer and the
      // pack metadata. Any one of them missing or corrupt stops serve, so
      // `uap models ensure` must be able to restore any one of them.
      expect(cfg.files).toHaveLength(68);
      const REV = 'd7de835cfce7d9bb22a3d5ebb7d1e8565d4ecf74';
      expect(cfg.files?.every((f) => f.repo === 'Edge0/Edge0-145B-q3k' && f.rev === REV)).toBe(true);
      expect(
        cfg.files?.every((f) => f.path.startsWith('/home/cogtek/models/Edge0-145B-q3k/')),
      ).toBe(true);
      const byName = new Map(cfg.files?.map((f) => [f.file, f]));
      // The three giants: LFS oids are sha256 of content, verified by
      // huggingface_hub at download time.
      expect(byName.get('experts.bin')).toMatchObject({
        bytes: 40076574720,
        sha256: '947d15f3d69ecdb45d602a62bc84803451da779a22294e1db5b3568290b42879',
      });
      expect(byName.get('ple-fp8.gguf')).toMatchObject({
        bytes: 51200246112,
        sha256: 'c7615c59b060277ddf6f84729fa8f7469cfc82c7fb983d6e7eab5a2f7446f170',
      });
      expect(byName.get('model-skeleton.gguf')).toMatchObject({
        bytes: 5991569248,
        sha256: 'ab49fbe7590cdcda45d7a2bcae4be0bd42c6a70b951d594a00eb158d7df0b72f',
      });
      // Both D/U variants pinned, so the q4 choice is restorable too.
      expect(byName.get('latent_dense_q8.bin')).toBeDefined();
      expect(byName.get('latent_dense_q4.bin')).toBeDefined();
      // The Q3_K scales (48 files, one per layer) and the MTP draft layer.
      expect(cfg.files?.filter((f) => f.file.startsWith('scales/l')).length).toBe(48);
      expect(byName.get('scales/l47.f32')).toMatchObject({ bytes: 7168 });
      expect(byName.get('mtp/experts.bin')).toBeDefined();
      expect(byName.get('mtp/draft_vocab.bin')).toBeDefined();
      expect(byName.get('tokenizer/vocab.json')).toBeDefined();
      expect(byName.get('model.json')).toBeDefined();
      // Repo furniture (README, LICENSE, assets, start.sh, bench metadata)
      // is not part of serving — it must not masquerade as one.
      expect(byName.get('README.md')).toBeUndefined();
      expect(byName.get('start.sh')).toBeUndefined();
      expect(byName.get('model-bench.json')).toBeUndefined();
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('cross-links the edge0-145b-server capacity service the registry declares', () => {
    // The registry `service` field names a capacity-policy service — the
    // validator errors when it does not exist — and the policy's unit must
    // be the one the panel fleet starts (uap-edge0-145b-server.service).
    const policy = parsePolicy(
      readFileSync(join(repoRoot, 'config/capacity-policy.json'), 'utf8'),
      'capacity-policy.json',
    );
    const svc = policy.services.find((s) => s.name === 'edge0-145b-server');
    expect(svc).toBeDefined();
    expect(svc?.systemd).toEqual({ unit: 'uap-edge0-145b-server.service', scope: 'user' });
    // The ExecStart drift pins mirror the unit's actual command line
    // (verified against the `systemctl --user show` rendering, 2026-11-13;
    // --vram-reserve-mib and 1200 are separate words there, separated by
    // the repeating --strata-arg, so they are pinned separately).
    expect(svc?.budget?.execStartMustContain).toEqual(
      expect.arrayContaining([
        '--model /home/cogtek/models/Edge0-145B-q3k',
        '--port 8080',
        '--alias edge0_145b',
        '--vram-reserve-mib',
        '1200',
      ]),
    );
    // Same engine-manages-its-own-reserve doctrine as strata-server.
    expect(svc?.headroom).toEqual({ gpuMinFreeMiB: 200 });
    expect(svc?.restartBudget).toEqual({ knownRestarts: 0, allowedNew: 0 });
  });
});

// ---------------------------------------------------------------------------
// 2026-11-14: the unsloth UD-Q3_K_XL arm — the IQ3_S-CLASS tier of
// unsloth/Qwen3.8-Flash-Next-GGUF (the repo ships no IQ3_S; its 3-bit ladder
// tops out at UD-Q3_K_XL 3.5 bpw, the same class as the fleet's IQ3_S arms),
// staged as the switchable inference-panel arm ABOVE the v31 UD-IQ4_XS
// default (panel id strata-unsloth-q3_k_xl, unit
// uap-strata-unsloth-q3_k_xl-server.service). RETIRED 2026-11-17 (weights
// removed with the other flash-next quants; entry = re-fetch manifest).
// ---------------------------------------------------------------------------

describe('repo registry: strata-unsloth-ud-q3_k_xl arm wiring (retired 2026-11-17)', () => {
  it('keeps the retired q3_k_xl config as the pinned re-fetch manifest and fails closed until measured', () => {
    const own = mkdtempSync(join(tmpdir(), 'q3kxl-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const entry = loaded.registry.models['qwen3.8-flash-next'];
      // Retired with the 2026-11-17 removal round: not advertised, alias
      // retired, manifest kept with the WEIGHTS REMOVED marker.
      const raw = JSON.parse(
        readFileSync(join(repoRoot, 'config/model-registry.json'), 'utf8'),
      ) as { retired_local_aliases?: string[] };
      expect(entry.advertises).not.toContain('qwen3.8-flash-next-unsloth-ud-q3_k_xl');
      expect(raw.retired_local_aliases).toContain('qwen3.8-flash-next-unsloth-ud-q3_k_xl');
      const cfg = entry.configs['strata-unsloth-ud-q3_k_xl'];
      expect(cfg, 'the retired q3_k_xl arm must keep its re-fetch manifest').toBeTruthy();
      expect(cfg.engine).toBe('strata');
      expect(cfg.unit).toBe('uap-strata-unsloth-q3_k_xl-server');
      expect(cfg.note).toMatch(/WEIGHTS REMOVED 2026-11-17/);
      // Shape only until `uap models measure` records this machine (spec §4.1).
      expect(isPlaceable(cfg)).toBe(false);
      // Head-pinned like every shipped manifest — `uap models ensure` must be
      // able to re-fetch and verify from this pin (the openjet lesson).
      expect(cfg.files).toHaveLength(4);
      const REV = '39e6e4a86cc6517a6f39ef37adce5e9f3a81280c';
      expect(
        cfg.files?.every((f) => f.repo === 'unsloth/Qwen3.8-Flash-Next-GGUF' && f.rev === REV),
      ).toBe(true);
      expect(
        cfg.files?.every((f) =>
          f.path.startsWith('/home/cogtek/models/strata-data/models/unsloth-UD-Q3_K_XL/'),
        ),
      ).toBe(true);
      expect(cfg.files?.map((f) => f.file)).toEqual([
        'UD-Q3_K_XL/Qwen3.8-Flash-Next-UD-Q3_K_XL-00001-of-00004.gguf',
        'UD-Q3_K_XL/Qwen3.8-Flash-Next-UD-Q3_K_XL-00002-of-00004.gguf',
        'UD-Q3_K_XL/Qwen3.8-Flash-Next-UD-Q3_K_XL-00003-of-00004.gguf',
        'engram/Qwen3.8-Flash-Next-engram-Q8_0.gguf_file',
      ]);
      // Shards 1-3: the release's own files, pinned to the HF LFS oids
      // (verified against the downloaded bytes 2026-11-14).
      expect(cfg.files?.[0]).toMatchObject({
        bytes: 10946618,
        sha256: '7666000ba91eb5527f8e12e0414de36766dc82a082876337f7827c2caa859143',
      });
      expect(cfg.files?.[1]).toMatchObject({
        bytes: 49742117248,
        sha256: 'e954cb3044ae087a003ce8cc1631c9d40fe15ae64a8befcf4aa06457848c647c',
      });
      expect(cfg.files?.[2]).toMatchObject({
        bytes: 10911746208,
        sha256: 'fcce26b1e5e6e54559a7e7c2f8d6e37067ec695ff1f14bce662810bde78abe1f',
      });
      // Shard 4: NOT the set's native 28.8 GB IQ4_NL engram but the Q8_0
      // engram table, restamped via set_split.py and HARDLINKED from the v31
      // set's shard 4 — zero extra disk, the measured-best table (+19-22%
      // long-prompt decode, the 11-13 swap round). The pinned sha256 is the
      // LOCAL post-restamp hash (what the .done marker verifies), the same
      // convention as the v31 set's marker.
      expect(cfg.files?.[3]).toMatchObject({
        file: 'engram/Qwen3.8-Flash-Next-engram-Q8_0.gguf_file',
        bytes: 54400261312,
        sha256: '4375b925a3abfb3859f6b634dafaab3343d9e2cdf9b3452253be465a12361426',
      });
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-11-15: the Speedy engine arm — the flash-next ENGINE A/B on the v31
// weights (DevDock-AI/Speedy 0.4.7, a measured fork of Strata v0.2.7.1
// tuned for Qwen3.8-Flash-Next on RTX 30-class cards), staged as a
// switchable inference-panel arm (panel id speedy, unit
// uap-speedy-server.service). Same 4-shard v31 manifest as the strata
// default — the engine is the only variable between the two arms.
// RETIRED 2026-11-17: the A/B moved to the ISTA base IQ3_S set (speedy-iq3_s);
// this entry stays as the pinned re-fetch manifest.
// ---------------------------------------------------------------------------

describe('repo registry: speedy-unsloth-ud-iq4_xs-v31 arm wiring (retired 2026-11-17)', () => {
  it('keeps the retired speedy config as the pinned v31 re-fetch manifest and fails closed until measured', () => {
    const own = mkdtempSync(join(tmpdir(), 'speedy-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const entry = loaded.registry.models['qwen3.8-flash-next'];
      // Retired with the 2026-11-17 IQ3_S switch: not advertised, alias
      // retired, manifest kept with the WEIGHTS REMOVED marker.
      const raw = JSON.parse(
        readFileSync(join(repoRoot, 'config/model-registry.json'), 'utf8'),
      ) as { retired_local_aliases?: string[] };
      expect(entry.advertises).not.toContain('qwen3.8-flash-next-speedy-ud-iq4_xs-v31');
      expect(raw.retired_local_aliases).toContain('qwen3.8-flash-next-speedy-ud-iq4_xs-v31');
      const cfg = entry.configs['speedy-unsloth-ud-iq4_xs-v31'];
      expect(cfg, 'the retired speedy arm must keep its re-fetch manifest').toBeTruthy();
      expect(cfg.note).toMatch(/WEIGHTS REMOVED 2026-11-17/);
      // The engine is the variable, not the weights: engine speedy on the
      // strata-family serve layer, its own unit, its own panel id.
      expect(cfg.engine).toBe('speedy');
      expect(cfg.unit).toBe('uap-speedy-server');
      // Shape only until `uap models measure` records this machine (spec §4.1).
      expect(isPlaceable(cfg)).toBe(false);
      // Byte-identical shard manifest to the strata v31 arm: same paths,
      // bytes, digests and HEAD pin, so `uap models ensure` repairs either
      // arm from one pin and the A/B has exactly one variable.
      const v31 = entry.configs['strata-unsloth-ud-iq4_xs-v31'];
      expect(cfg.files).toHaveLength(4);
      // Full deep-equality against the v31 manifest — path, bytes, sha256,
      // repo, file (the repo-relative path `uap models ensure` actually
      // fetches) and order, one assertion that self-maintains against the
      // v31 arm (the 2026-11-15 review catch: a speedy-only `file` corruption
      // would otherwise stay green until a disk-loss repair 404s).
      expect(cfg.files).toEqual(v31.files);
      expect(
        cfg.files?.every((f) => f.rev === 'd96201194f103c906994f283f504209dc8d2a10c'),
      ).toBe(true);
      expect(cfg.files?.every((f) => f.repo === 'unsloth/Qwen3.8-Flash-Next-GGUF')).toBe(true);
      expect(
        cfg.files?.every((f) =>
          f.path.startsWith('/home/cogtek/models/strata-data/models/unsloth-UD-IQ4_XS-v31/'),
        ),
      ).toBe(true);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-11-17: the ISTA-DASLab base GSQ-RCO IQ3_S pair — the operator switch
// that made the pristine base IQ3_S arm the :8080 default (unit
// uap-strata-server, config strata-iq3_s.json) and moved the Speedy engine
// A/B onto the SAME weight set (unit uap-speedy-server, config
// speedy-iq3_s.json), deleting every other flash-next quant the same day.
// The advertised alias is deliberately NOT the historical
// qwen3.8-flash-next-iq3_s (retired 2026-11-11): reusing it would break the
// sync's retired-alias migration source.
// EVENING 2026-11-17: the operator's same-day follow-up reinstated the
// DavidAU abliterated IQ3_S tier as the default; this base pair STAYS ON
// DISK as the switchable strata-base-iq3s arm (unit
// uap-strata-base-iq3s-server.service) — switchable, not retired.
// ---------------------------------------------------------------------------

describe('repo registry: strata-iq3_s (ISTA base IQ3_S, switchable strata-base-iq3s) arm wiring', () => {
  it('keeps the switchable base arm on disk with the pinned 2-shard ISTA manifest and fails closed until measured', () => {
    const own = mkdtempSync(join(tmpdir(), 'iq3s-base-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const entry = loaded.registry.models['qwen3.8-flash-next'];
      // The registration id this arm advertises at /v1/models when serving
      // (cfg model_name) — the dash form, the same convention as the
      // config file. Switchable since the 2026-11-17 evening round (the
      // DavidAU abliterated tier reinstated as the default): NOT advertised
      // by the default pair, but NOT retired either — weights + pack stay
      // on disk behind uap-strata-base-iq3s-server.
      expect(entry.advertises).not.toContain('qwen3.8-flash-next-gsq-rco-iq3_s');
      expect(entry.advertises).not.toContain('qwen3.8-flash-next-iq3_s');
      const raw = JSON.parse(
        readFileSync(join(repoRoot, 'config/model-registry.json'), 'utf8'),
      ) as { retired_local_aliases?: string[] };
      expect(raw.retired_local_aliases).toContain('qwen3.8-flash-next-iq3_s');
      expect(raw.retired_local_aliases).not.toContain('qwen3.8-flash-next-gsq-rco-iq3_s');
      const cfg = entry.configs['strata-iq3_s'];
      expect(cfg, 'config/model-registry.json must keep the switchable base arm').toBeTruthy();
      expect(cfg.engine).toBe('strata');
      expect(cfg.unit).toBe('uap-strata-base-iq3s-server');
      // Shape only until `uap models measure` records this machine (spec §4.1).
      expect(isPlaceable(cfg)).toBe(false);
      // Head-pinned like every shipped manifest — `uap models ensure` must
      // be able to re-fetch and verify from this pin (the openjet lesson).
      expect(cfg.files).toHaveLength(2);
      const REV = 'ed59f92082b1e93c0e96d60a8b11aab089b52f09';
      expect(
        cfg.files?.every(
          (f) => f.repo === 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF' && f.rev === REV,
        ),
      ).toBe(true);
      expect(
        cfg.files?.every((f) =>
          f.path.startsWith('/home/cogtek/models/strata-data/models/IQ3_S/'),
        ),
      ).toBe(true);
      // Shard 1: the experts shard, downloaded fresh and sha256-verified
      // against the Hub LFS oid at the pinned rev (the .done marker).
      expect(cfg.files?.[0]).toMatchObject({
        bytes: 54817524224,
        sha256: '4c1eb2ceb4915e1192f4f386021897bde56a97f40a0bb78bb86465e0f7d2aca3',
      });
      // Shard 2: the tier-shared PLE n-gram table, the same digest every
      // GSQ-RCO tier pins — hardlinked at install from the since-removed
      // abliterated copy (zero re-download, one inode, links=1 verified
      // after the removal round).
      expect(cfg.files?.[1]).toMatchObject({
        bytes: 28800138432,
        sha256: '316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113',
      });
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('repo registry: speedy-iq3_s (fork preset on disk for the ISTA set) arm wiring', () => {
  it('keeps the speedy ISTA preset on disk with the byte-identical manifest and fails closed until measured', () => {
    const own = mkdtempSync(join(tmpdir(), 'speedy-iq3s-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const entry = loaded.registry.models['qwen3.8-flash-next'];
      // The registration id this arm advertises at /v1/models when serving
      // (cfg model_name). 2026-11-18: the IQ3_S-only panel round switched
      // :8080 to this ISTA base preset under its own unit
      // (uap-speedy-base-iq3s-server, panel id speedy-base) — it is the LIVE
      // default arm and IS advertised; the uap-speedy-server unit (DavidAU
      // abliterated set since 2026-11-17 evening) is the parked A/B arm.
      expect(entry.advertises).toContain('qwen3.8-flash-next-speedy-gsq-rco-iq3_s');
      const cfg = entry.configs['speedy-iq3_s'];
      expect(cfg, 'config/model-registry.json must keep the speedy ISTA preset').toBeTruthy();
      // The engine is the variable, not the weights: engine speedy on the
      // strata-family serve layer, its own unit, its own panel id.
      expect(cfg.engine).toBe('speedy');
      expect(cfg.unit).toBe('uap-speedy-base-iq3s-server');
      // Shape only until `uap models measure` records this machine (spec §4.1).
      expect(isPlaceable(cfg)).toBe(false);
      // Byte-identical shard manifest to the strata IQ3_S default: same
      // paths, bytes, digests and HEAD pin, so `uap models ensure` repairs
      // either arm from one pin and the A/B has exactly one variable (the
      // 2026-11-15 invariant, carried to the IQ3_S set).
      const base = entry.configs['strata-iq3_s'];
      expect(cfg.files).toHaveLength(2);
      expect(cfg.files).toEqual(base.files);
      expect(
        cfg.files?.every((f) => f.rev === 'ed59f92082b1e93c0e96d60a8b11aab089b52f09'),
      ).toBe(true);
      expect(
        cfg.files?.every((f) => f.repo === 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF'),
      ).toBe(true);
      expect(
        cfg.files?.every((f) =>
          f.path.startsWith('/home/cogtek/models/strata-data/models/IQ3_S/'),
        ),
      ).toBe(true);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-11-15: the Gemma 4 31B arm — the operator's speed-optimal Gemma arm on
// llama.cpp (the fleet's FIRST llama.cpp-arm; the Strata family has no
// gemma-4 arch support, upstream included, so the engine builds fresh).
// ---------------------------------------------------------------------------

describe('repo registry: gemma-4-31b arm wiring', () => {
  it('ships the gemma config with the pinned QAT+MTP 2-file manifest and fails closed until measured', () => {
    const own = mkdtempSync(join(tmpdir(), 'gemma-registry-'));
    try {
      const loaded = loadModelRegistry(repoRoot, { localPath: join(own, 'no-local.json') });
      expect(loaded.errors).toEqual([]);
      const entry = loaded.registry.models['gemma-4-31b'];
      expect(entry, 'config/model-registry.json must keep the gemma family').toBeTruthy();
      // The registration id this arm advertises at /v1/models (the --alias).
      expect(entry.advertises).toContain('gemma-4-31b-qat-ud-q4_k-xl-mtp');
      const cfg = entry.configs['gemma-4-31b-it-qat-ud-q4_k-xl-mtp'];
      expect(cfg, 'the gemma-4-31b family must keep its one config').toBeTruthy();
      // The FIRST llama.cpp arm: its own engine + unit, weights are the
      // Google-QAT pair (main GGUF + trained MTP head), not a family reuse.
      expect(cfg.engine).toBe('llama.cpp');
      expect(cfg.unit).toBe('uap-gemma-server.service');
      // Shape only until `uap models measure` records this machine (spec §4.1).
      expect(isPlaceable(cfg)).toBe(false);
      // The pinned pair: QAT UD-Q4_K_XL main + the QAT-derived MTP head from
      // the SAME repo rev, so `uap models ensure` restores them together.
      expect(cfg.files).toHaveLength(2);
      expect(
        cfg.files?.every((f) => f.rev === '43cc1aeb31adf47ec06a854507ce552cd9862e6f'),
      ).toBe(true);
      expect(cfg.files?.every((f) => f.repo === 'unsloth/gemma-4-31B-it-qat-GGUF')).toBe(true);
      expect(
        cfg.files?.every((f) => f.path.startsWith('/home/cogtek/models/gemma-4-31B-it-qat/')),
      ).toBe(true);
      const [main, draft] = cfg.files ?? [];
      expect(main.bytes).toBe(17287670048); // QAT UD-Q4_K_XL 17.3 GB
      expect(draft.bytes).toBe(279955968); // trained MTP head 280 MB
      expect(main.sha256).toBe('00b5a7c497f0c8934033088c10a7fa9a4c015e46ee6d89e9c6890650ba5d0e71');
      expect(draft.sha256).toBe('3a5e99fd8d0b23afb1fccd1ee0c9ebd1f571d00399c2dae2292d217feeec0f6b');
      // The MTP-head digest is the HF LFS oid AND the locally computed
      // sha256 of the completed download (cross-validated 2026-11-15).
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});
