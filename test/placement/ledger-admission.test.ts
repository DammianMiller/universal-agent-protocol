/**
 * Placement ledger, admission math, and preview (spec §4.2, §4.4, §4.5).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deriveLiveResidents,
  loadLedger,
  probeDeviceStates,
  syncLedger,
  withLedger,
  placementLedgerPath,
  emptyLedger,
  type LedgerResident,
} from '../../src/placement/ledger.js';
import { computeOptions, matchingConfigs } from '../../src/placement/admission.js';
import { buildVictimPreviews, previewStillValid, victimSignature } from '../../src/placement/preview.js';
import {
  configCostMiB,
  isMeasuredConfig,
  loadModelRegistry,
  validateRegistry,
  type ModelRegistry,
} from '../../src/placement/registry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const registry: ModelRegistry = {
  version: 1,
  devices: {
    gpu0: { kind: 'gpu', total_mib: 24576, reserved_mib: 1293 },
    cpu0: { kind: 'cpu', total_mib: 126944, reserved_mib: 8192 },
  },
  models: {
    'qwen3.8-flash-next': {
      display: 'Qwen3.8 Flash Next',
      engine: 'strata',
      unit: 'uap-strata-server',
      advertises: ['qwen3.8-flash-next-iq3_s'],
      task_affinity: ['code'],
      affinity: { device: ['gpu0'] },
      configs: {
        'strata-iq3_s': {
          unit: 'uap-strata-server',
          resident_gpu_mib: 21812,
          host_rss_mib: 52857,
          context_pool_cells: 131072,
          kv_resident_cells: 32768,
          kv_kind: 'int8',
          measured_at: '2026-10-08T14:02:00Z',
          measured_on: 'gpu0',
        },
      },
    },
    'qwen3.8-27b': {
      display: 'Qwen3.8 27B',
      engine: 'llama.cpp',
      unit: 'uap-llama-server',
      advertises: ['qwen3.8-27b-mtp'],
      task_affinity: ['code', 'general'],
      affinity: { device: ['gpu0'] },
      configs: {
        'llama-mtp': {
          unit: 'uap-llama-server',
          resident_gpu_mib: 15200,
          host_rss_mib: 18000,
          context_pool_cells: 131072,
          kv_resident_cells: 131072,
          kv_kind: 'q8_0',
          measured_at: '2026-10-08T14:02:00Z',
          measured_on: 'gpu0',
        },
      },
    },
  },
};

let dir: string;
function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'placement-'));
  return dir;
}
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function ledgerWith(residents: LedgerResident[], cpuFree = 30424) {
  return {
    version: 1 as const,
    devices: {
      gpu0: { kind: 'gpu' as const, total_mib: 24576, free_mib: 1016, reserved_mib: 1293, source: 'nvidia-smi' },
      cpu0: { kind: 'cpu' as const, total_mib: 126944, free_mib: cpuFree, reserved_mib: 8192, source: 'MemAvailable' },
    },
    residents,
    pending: [],
  };
}

function resident(model: string, config: string, gpu_mib: number, host_rss_mib: number): LedgerResident {
  return {
    model,
    config,
    device: 'gpu0',
    state: 'hot',
    gpu_mib,
    host_rss_mib,
    holders: [],
    since: '2026-10-08T09:14:02Z',
  };
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

describe('placement ledger', () => {
  it('loads empty when the file does not exist (no residents = nothing to trust)', () => {
    const path = join(freshDir(), 'placement.json');
    expect(loadLedger(path)).toEqual(emptyLedger());
  });

  it('withLedger re-reads before committing: two sequential writers do not clobber', () => {
    const path = join(freshDir(), 'placement.json');
    withLedger(path, (l) => {
      l.residents.push(resident('a', 'a', 100, 200));
    });
    withLedger(path, (l) => {
      // Must see the first writer's resident.
      expect(l.residents.length).toBe(1);
      l.residents.push(resident('b', 'b', 300, 400));
    });
    const after = loadLedger(path);
    expect(after.residents.map((r) => r.model).sort()).toEqual(['a', 'b']);
    expect(after.updated_at).toBeDefined();
  });

  it('corrupt ledger fails closed to empty, never a partial parse', () => {
    const path = join(freshDir(), 'placement.json');
    writeFileSync(path, '{ this is not json');
    expect(loadLedger(path)).toEqual(emptyLedger());
  });

  it('syncLedger PRESERVES draining markers: a concurrent status read never re-opens admission mid-drain', () => {
    const reg: ModelRegistry = JSON.parse(JSON.stringify(registry));
    const path = join(freshDir(), 'placement.json');
    // An enforcement marked the strata resident draining; its drain window
    // can outlast a concurrent `models status` / dashboard auto-refresh.
    withLedger(path, (l) => {
      const r = deriveLiveResidents(reg, () => true)[0];
      l.residents = [{ ...r, state: 'draining' }];
    });
    const synced = syncLedger(reg, path, () => true);
    const strata = synced.residents.find((r) => r.model === 'qwen3.8-flash-next');
    expect(strata?.state).toBe('draining'); // NOT reset to hot by the rebuild
    // But draining never RESURRECTS a dead unit: the unit stopped, the
    // resident is gone.
    const after = syncLedger(reg, path, () => false);
    expect(after.residents).toEqual([]);
  });

  it('probeDeviceStates maps gpuN → nvidia-smi index N and cpu → MemAvailable', () => {
    const reg: ModelRegistry = {
      version: 1,
      devices: { gpu0: { kind: 'gpu', total_mib: 24576, reserved_mib: 1293 }, gpu1: { kind: 'gpu' }, cpu0: { kind: 'cpu' } },
      models: {},
    };
    const states = probeDeviceStates(reg, {
      gpu: new Map([[0, { total_mib: 24576, free_mib: 1016 }], [1, { total_mib: 23040, free_mib: 22000 }]]),
      hostAvailable: 30424,
    });
    expect(states.gpu0.free_mib).toBe(1016);
    expect(states.gpu0.source).toBe('nvidia-smi');
    expect(states.gpu1.free_mib).toBe(22000);
    expect(states.cpu0.free_mib).toBe(30424);
    expect(states.cpu0.source).toBe('MemAvailable');
  });

  it('unprobeable devices read as unprobed, never guessed', () => {
    const reg: ModelRegistry = { version: 1, devices: { gpu2: { kind: 'gpu' }, cpu1: { kind: 'cpu' } }, models: {} };
    const states = probeDeviceStates(reg, { gpu: new Map(), hostAvailable: null });
    expect(states.gpu2.free_mib).toBeUndefined();
    expect(states.gpu2.source).toBe('unprobed');
    expect(states.cpu1.source).toBe('unprobed');
  });

  it('deriveLiveResidents records active units as facts, with cost when measured', () => {
    const reg: ModelRegistry = JSON.parse(JSON.stringify(registry));
    reg.models['qwen3.8-27b'].configs['llama-mtp'] = { status: 'unmeasured', unit: 'uap-llama-server' };
    const rs = deriveLiveResidents(reg, (unit) => unit === 'uap-strata-server' || unit === 'uap-llama-server');
    expect(rs.length).toBe(2);
    const strata = rs.find((r) => r.model === 'qwen3.8-flash-next') as LedgerResident;
    expect(strata.state).toBe('hot');
    expect(strata.gpu_mib).toBe(21812);
    expect(strata.host_rss_mib).toBe(52857);
    const llama = rs.find((r) => r.model === 'qwen3.8-27b') as LedgerResident;
    expect(llama.gpu_mib).toBeUndefined(); // fact of residence, cost still fail-closed
  });
});

// ---------------------------------------------------------------------------
// admission math
// ---------------------------------------------------------------------------

describe('computeOptions', () => {
  it('reuse: a resident config satisfying the request ranks first, even unmeasured', () => {
    const unmeasuredRegistry: ModelRegistry = JSON.parse(JSON.stringify(registry));
    delete (unmeasuredRegistry.models['qwen3.8-flash-next'].configs['strata-iq3_s'] as Record<string, unknown>).resident_gpu_mib;
    unmeasuredRegistry.models['qwen3.8-flash-next'].configs['strata-iq3_s'] = { status: 'unmeasured', unit: 'uap-strata-server' };
    const ledger = ledgerWith([resident('qwen3.8-flash-next', 'strata-iq3_s', 21812, 52857)]);
    const result = computeOptions(unmeasuredRegistry, ledger, 'qwen3.8-flash-next-iq3_s');
    expect(result.matched).toBe(true);
    expect(result.options.length).toBe(1);
    expect(result.options[0].kind).toBe('reuse');
  });

  it('not in registry: park, never auto-load, no options', () => {
    const result = computeOptions(registry, ledgerWith([]), 'claude-opus-4-5');
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('not_in_registry');
    expect(result.options).toEqual([]);
  });

  it('matching but unmeasured configs fail closed with a note', () => {
    const reg: ModelRegistry = JSON.parse(JSON.stringify(registry));
    reg.models['qwen3.8-27b'].configs['llama-mtp'] = { status: 'unmeasured', unit: 'uap-llama-server' };
    const result = computeOptions(reg, ledgerWith([]), 'qwen3.8-27b-mtp');
    expect(result.matched).toBe(true);
    expect(result.reason).toBe('no_measured_config');
    expect(result.options).toEqual([]);
    expect(result.notes[0]).toMatch(/unmeasured/);
  });

  it('load_alongside when the config fits the device budget sum', () => {
    // Card: 24576 − 1293 reserve − 8000 staying = 15283 available; the
    // 27b config costs 15200 — fits with 83 MiB to spare.
    const ledger = ledgerWith([resident('other', 'other', 8000, 8000)]);
    const result = computeOptions(registry, ledger, 'qwen3.8-27b-mtp');
    expect(result.options.map((o) => o.kind)).toEqual(['load_alongside']);
    expect(result.options[0].cost_mib).toBe(15200);
  });

  it('the budget is a sum, not a free reading: 1016 free still rejects an unfit config', () => {
    // Full card except the resident: nothing fits alongside; displace is the
    // only option — exactly what the Conflicts= graph encodes, in MiB.
    const ledger = ledgerWith([resident('qwen3.8-flash-next', 'strata-iq3_s', 21812, 52857)]);
    const result = computeOptions(registry, ledger, 'qwen3.8-27b-mtp');
    expect(result.options.map((o) => o.kind)).toEqual(['displace']);
    expect(result.options[0].victims?.length).toBe(1);
    expect(result.options[0].victims?.[0].model).toBe('qwen3.8-flash-next');
  });

  it('host RAM is a hard gate: GPU fit + host overflow is refused', () => {
    // cpu free 8192+10000=18192 after reserve... free 10000, reserve 8192 →
    // budget 1808 < the 27b's 18000 RSS → host gate kills every option.
    const ledger = ledgerWith([resident('other', 'other', 8000, 8000)], 10000);
    const result = computeOptions(registry, ledger, 'qwen3.8-27b-mtp');
    expect(result.options).toEqual([]);
    expect(result.reason).toBe('no_feasible_option');
  });

  it('displacement frees host too: evicting the 52.9 GiB engine passes the host gate', () => {
    const ledger = ledgerWith([resident('qwen3.8-flash-next', 'strata-iq3_s', 21812, 52857)], 30424);
    const result = computeOptions(registry, ledger, 'qwen3.8-27b-mtp');
    // GPU: 24576 − 1293 − 0 staying = fits 15200. Host: 30424 + 52857 freed
    // − 8192 = 75089 ≥ 18000. Feasible.
    expect(result.options.map((o) => o.kind)).toEqual(['displace']);
  });

  it('smallest displacement ranks first among displace options', () => {
    const ledger = ledgerWith([resident('small', 'small', 4000, 4000), resident('big', 'big', 20000, 20000)]);
    const reg: ModelRegistry = JSON.parse(JSON.stringify(registry));
    reg.models['qwen3.8-27b'].configs['llama-mtp'] = {
      ...reg.models['qwen3.8-27b'].configs['llama-mtp'],
      resident_gpu_mib: 19000,
    } as never;
    const result = computeOptions(reg, ledger, 'qwen3.8-27b-mtp');
    // Staying = 24000 > budget −19000... displace 'big' (frees 20000,
    // staying 4000: 24576−1293−4000=19283 ≥ 19000 ✓); displace 'small'
    // (frees 4000, staying 20000: 3283 < 19000 ✗). Only the big victim works.
    expect(result.options.map((o) => o.kind)).toEqual(['displace']);
    expect(result.options[0].victims?.[0].model).toBe('big');
  });

  it('unknown device totals refuse the option rather than trusting free memory', () => {
    // The ledger device carries no total (registry had none to overlay).
    const ledger = ledgerWith([]);
    delete (ledger.devices.gpu0 as Record<string, unknown>).total_mib;
    const result = computeOptions(registry, ledger, 'qwen3.8-27b-mtp');
    expect(result.options).toEqual([]);
    expect(result.notes.some((n) => /total\/reserve unmeasured/.test(n))).toBe(true);
  });

  it('cost beyond the measured KV pool without a rate is refused', () => {
    const reg: ModelRegistry = JSON.parse(JSON.stringify(registry));
    const cfg = reg.models['qwen3.8-27b'].configs['llama-mtp'] as Record<string, unknown>;
    delete cfg.kv_mib_per_1k_cells;
    cfg.kv_resident_cells = 65536; // pool covers only half the card's request
    const result = computeOptions(reg, ledgerWith([]), 'qwen3.8-27b-mtp', { cells: 131072 });
    expect(result.options).toEqual([]);
    expect(result.notes.some((n) => /beyond the measured KV pool/.test(n))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

describe('preview', () => {
  it('victim previews state the consequence and mark in-flight unknown', () => {
    const victims = [resident('qwen3.8-flash-next', 'strata-iq3_s', 21812, 52857)];
    const previews = buildVictimPreviews(registry, victims);
    expect(previews[0].frees_gpu_mib).toBe(21812);
    expect(previews[0].reload_cost_mib).toBe(21812);
    expect(previews[0].inflight).toBe('unknown');
    expect(previews[0].consequence).toMatch(/in-flight view unavailable from the proxy/);
  });

  it('enforcement aborts when the re-derived victim set differs from the approved one', () => {
    const approved = [resident('a', 'x', 1, 1), resident('b', 'y', 2, 2)];
    const sameDifferentOrder = [resident('b', 'y', 2, 2), resident('a', 'x', 1, 1)];
    const changed = [resident('a', 'x', 1, 1), resident('c', 'z', 3, 3)];
    expect(previewStillValid(approved, sameDifferentOrder)).toBe(true);
    expect(previewStillValid(approved, changed)).toBe(false);
    expect(victimSignature(approved)).toBe('a/x,b/y');
  });
});

// ---------------------------------------------------------------------------
// end-to-end: registry file → admission (the pipeline the proxy gate uses)
// ---------------------------------------------------------------------------

describe('registry → admission pipeline', () => {
  it('a machine-local measurement flips a config from fail-closed to placeable', () => {
    const d = freshDir();
    const repo = join(d, 'repo.json');
    const local = join(d, 'local.json');
    const repoDoc: ModelRegistry = JSON.parse(JSON.stringify(registry));
    repoDoc.models['qwen3.8-27b'].configs['llama-mtp'] = { status: 'unmeasured', unit: 'uap-llama-server' };
    writeFileSync(repo, JSON.stringify(repoDoc));
    const before = loadModelRegistry(d, { repoPath: repo, localPath: local });
    expect(isMeasuredConfig(before.registry.models['qwen3.8-27b'].configs['llama-mtp'])).toBe(false);
    expect(computeOptions(before.registry, ledgerWith([]), 'qwen3.8-27b-mtp').reason).toBe('no_measured_config');

    const localDoc = {
      version: 1,
      models: {
        'qwen3.8-27b': {
          display: 'Qwen3.8 27B',
          configs: {
            'llama-mtp': {
              unit: 'uap-llama-server',
              resident_gpu_mib: 15200,
              host_rss_mib: 18000,
              context_pool_cells: 131072,
              kv_resident_cells: 131072,
              kv_kind: 'q8_0',
              measured_at: '2026-10-08T15:00:00Z',
              measured_on: 'gpu0',
            },
          },
        },
      },
    };
    writeFileSync(local, JSON.stringify(localDoc));
    const after = loadModelRegistry(d, { repoPath: repo, localPath: local });
    // No policy services declared → no cross-check errors, but the measured
    // config carries no service link, which is a warning, not silence.
    const findings = validateRegistry(after.registry, { version: 1, services: [] });
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(findings.some((f) => f.severity === 'warning' && /no capacity-policy service/.test(f.message))).toBe(true);
    const result = computeOptions(after.registry, ledgerWith([]), 'qwen3.8-27b-mtp');
    expect(result.options.map((o) => o.kind)).toEqual(['load_alongside']);
    expect(configCostMiB(after.registry.models['qwen3.8-27b'].configs['llama-mtp'] as never, 131072)).toBe(15200);
  });
});
