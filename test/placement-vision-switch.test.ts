/**
 * Dynamic vision switching (uplift): a vision-encoder-OOM park resolves by
 * SWITCHING to a vision-capable arm, not by loading the requested model.
 *
 * The live failure this encodes: the inkling2 arm advertises vision
 * ("vision dynamic"), so image blocks forward, but its elastic KV pool ate
 * the card (505 MiB free) and the image encoder needs 792 MiB — every
 * image request 400s at encode time. The registry's `vision` field marks
 * switch targets; a vision park's options, pending display, apply, and
 * auto-enforcement all compute from the vision-capable candidate set.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeOptions, optionsForPending, visionCapableConfigs } from '../src/placement/admission.js';
import { getPlacementAdmit, resetColdProbeForTests } from '../src/dashboard/placement-routes.js';
import { resolvePendingPlacement, type EnforceDeps, type EnforceTimeouts, type PlacementInflightEntry } from '../src/placement/enforce.js';
import { ModelEntrySchema } from '../src/placement/registry.js';
import type { ModelRegistry } from '../src/placement/registry.js';
import { loadLedger, withLedger, type LedgerResident } from '../src/placement/ledger.js';
import { resetAutoSchedulerForTests, type AutoPolicy } from '../src/placement/auto.js';

// The 5090 fleet shape: inkling2 is the starved dynamic-vision arm;
// the basalt arms run the encoder on CPU ("vision cpu") — immune to the
// device-memory failure class, so they are the switch targets.
const registry: ModelRegistry = {
  version: 1,
  devices: {
    gpu0: { kind: 'gpu', total_mib: 32607, reserved_mib: 512 },
    cpu0: { kind: 'cpu', total_mib: 182000, reserved_mib: 8192 },
  },
  models: {
    'inkling2': {
      display: 'Inkling 2 Mini',
      engine: 'basalt',
      unit: 'uap-basalt-inkling2-server',
      endpoint: 'http://127.0.0.1:8080',
      advertises: ['inkling2-mini-basalt-nvfp4'],
      affinity: { device: ['gpu0'] },
      vision: 'dynamic',
      configs: {
        'nvfp4-q8': {
          unit: 'uap-basalt-inkling2-server',
          resident_gpu_mib: 31000,
          host_rss_mib: 30000,
          context_pool_cells: 262144,
          kv_resident_cells: 262144,
          kv_kind: 'fp8',
          measured_at: '2026-11-22T10:00:00Z',
          measured_on: 'gpu0',
        },
      },
    },
    'basalt-fn': {
      display: 'Qwen3.8 Flash Next Basalt',
      engine: 'basalt',
      unit: 'uap-basalt-fn-server',
      endpoint: 'http://127.0.0.1:8080',
      advertises: ['qwen3.8-fn-basalt-nvfp4'],
      affinity: { device: ['gpu0'] },
      vision: 'cpu',
      configs: {
        'nvfp4-dq6': {
          unit: 'uap-basalt-fn-server',
          resident_gpu_mib: 19700,
          host_rss_mib: 50000,
          context_pool_cells: 262144,
          kv_resident_cells: 262144,
          kv_kind: 'int8',
          measured_at: '2026-11-22T10:00:00Z',
          measured_on: 'gpu0',
        },
      },
    },
    'basalt-27b': {
      display: 'Qwen3.8 27B Basalt',
      engine: 'basalt',
      unit: 'uap-basalt-27b-server',
      endpoint: 'http://127.0.0.1:8080',
      advertises: ['qwen3.8-27b-basalt-nvfp4'],
      affinity: { device: ['gpu0'] },
      vision: 'cpu',
      configs: {
        'nvfp4-qat': {
          unit: 'uap-basalt-27b-server',
          resident_gpu_mib: 21000,
          host_rss_mib: 52000,
          context_pool_cells: 262144,
          kv_resident_cells: 262144,
          kv_kind: 'int8',
          measured_at: '2026-11-22T10:00:00Z',
          measured_on: 'gpu0',
        },
      },
    },
    'text-only-arm': {
      display: 'A text-only arm',
      engine: 'strata',
      unit: 'uap-strata-server',
      endpoint: 'http://127.0.0.1:8080',
      advertises: ['text-only'],
      affinity: { device: ['gpu0'] },
      configs: {
        'iq3_s': {
          unit: 'uap-strata-server',
          resident_gpu_mib: 18000,
          host_rss_mib: 40000,
          context_pool_cells: 131072,
          kv_resident_cells: 32768,
          kv_kind: 'int8',
          measured_at: '2026-11-22T10:00:00Z',
          measured_on: 'gpu0',
        },
      },
    },
  },
};

const loaded = { registry, measuredFrom: new Map(), errors: [] };

let dir: string;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshLedger(residents: LedgerResident[] = []): string {
  dir = mkdtempSync(join(tmpdir(), 'placement-vision-'));
  const ledgerPath = join(dir, 'placement.json');
  withLedger(ledgerPath, (l) => {
    l.devices = {
      gpu0: { kind: 'gpu', total_mib: 32607, free_mib: 505, reserved_mib: 512, source: 'nvidia-smi' },
      cpu0: { kind: 'cpu', total_mib: 182000, free_mib: 76000, reserved_mib: 8192, source: 'MemAvailable' },
    };
    l.residents.push(...residents);
  });
  return ledgerPath;
}

function residentOf(model: string, config: string, unit: string, gpuMib: number): LedgerResident {
  return {
    model, config, device: 'gpu0', unit, state: 'hot',
    gpu_mib: gpuMib, host_rss_mib: 30000, holders: [], since: '2026-11-22T10:14:02Z',
  };
}

const inklingResident = (): LedgerResident =>
  residentOf('inkling2', 'nvfp4-q8', 'uap-basalt-inkling2-server', 31000);

// Hermeticity: these admits run against process.cwd() as the project dir,
// so the attention enqueue would otherwise write the DEV's real
// .uap/attention.json with fake asks. The rail's kill switch is the seam.
const savedAttentionOff = process.env.UAP_ATTENTION_OFF;
beforeEach(() => {
  process.env.UAP_ATTENTION_OFF = '1';
  resetAutoSchedulerForTests();
  resetColdProbeForTests();
  vi.restoreAllMocks();
});
afterEach(() => {
  if (savedAttentionOff === undefined) delete process.env.UAP_ATTENTION_OFF;
  else process.env.UAP_ATTENTION_OFF = savedAttentionOff;
});

describe('registry vision field', () => {
  it('accepts the capability vocabulary and rejects anything else', () => {
    const base = { display: 'x', configs: {} };
    for (const vision of ['none', 'cpu', 'gpu', 'dynamic'] as const) {
      expect(ModelEntrySchema.parse({ ...base, vision }).vision).toBe(vision);
    }
    expect(ModelEntrySchema.parse(base).vision).toBeUndefined(); // absent = unknown/incapable
    expect(() => ModelEntrySchema.parse({ ...base, vision: 'telepathy' })).toThrow();
  });

  it('counts only cpu/gpu arms as switch targets — dynamic and absent are fail-closed', () => {
    const targets = visionCapableConfigs(registry).map((c) => c.model).sort();
    // inkling2 is 'dynamic' (its measurement excludes the on-demand encoder —
    // the exact understated cost that produced the OOM) and text-only-arm
    // has no field: neither is a switch target.
    expect(targets).toEqual(['basalt-27b', 'basalt-fn'].sort());
  });
});

describe('computeOptions capability: vision', () => {
  it('reuses a resident vision-capable arm but never the arm that just failed', () => {
    // A cpu-encoder variant of the starved arm: once its encoder runs
    // off-device it is vision-capable, so its own reuse becomes a candidate
    // again — and only excludeReuseOf keeps the failed arm out of its own
    // resolution list.
    const cpuEncoderArm: ModelRegistry = {
      ...registry,
      models: {
        ...registry.models,
        'inkling2': { ...registry.models['inkling2']!, vision: 'cpu' },
      },
    };
    const ledgerPath = freshLedger([
      residentOf('inkling2', 'nvfp4-q8', 'uap-basalt-inkling2-server', 31000),
      residentOf('basalt-27b', 'nvfp4-qat', 'uap-basalt-27b-server', 21000),
    ]);
    const ledger = loadLedger(ledgerPath);
    const withoutExclude = computeOptions(cpuEncoderArm, ledger, 'inkling2', { capability: 'vision' });
    // Without the exclusion the failed arm reappears as its own resolution —
    // the reuse that resolves nothing.
    expect(withoutExclude.options.filter((o) => o.kind === 'reuse').map((o) => o.model).sort())
      .toEqual(['basalt-27b', 'inkling2'].sort());
    const withExclude = computeOptions(cpuEncoderArm, ledger, 'inkling2', {
      capability: 'vision', excludeReuseOf: 'inkling2',
    });
    expect(withExclude.options.filter((o) => o.kind === 'reuse').map((o) => o.model)).toEqual(['basalt-27b']);
  });

  it('displaces the starved arm when the switch target does not fit alongside', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const options = computeOptions(registry, loadLedger(ledgerPath), 'inkling2', {
      capability: 'vision', excludeReuseOf: 'inkling2',
    }).options;
    // 32607 total - 512 reserved - 31000 staying = 1095 free: no vision arm
    // fits alongside a 19700 MiB pack, so every option displaces inkling2.
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) {
      expect(o.kind).toBe('displace');
      expect(o.victims?.map((v) => v.model)).toEqual(['inkling2']);
    }
  });

  it('refuses with a vision-shaped note when no capable arm is registered', () => {
    const noVision: ModelRegistry = {
      ...registry,
      models: {
        'inkling2': registry.models['inkling2']!, // dynamic — not a target
        'text-only-arm': registry.models['text-only-arm']!, // no field
      },
    };
    const ledgerPath = freshLedger([inklingResident()]);
    const result = computeOptions(noVision, loadLedger(ledgerPath), 'inkling2', {
      capability: 'vision', excludeReuseOf: 'inkling2',
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('not_in_registry');
    expect(result.notes[0]).toContain('no vision-capable');
  });

  it('fail-closes on unmeasured vision arms with the vision note', () => {
    const unmeasured: ModelRegistry = {
      ...registry,
      models: {
        'inkling2': registry.models['inkling2']!, // dynamic — not a target
        'text-only-arm': registry.models['text-only-arm']!, // no vision field
        'basalt-fn': {
          ...registry.models['basalt-fn']!,
          configs: { 'nvfp4-dq6': { unit: 'uap-basalt-fn-server', status: 'unmeasured' } },
        },
      },
    };
    const ledgerPath = freshLedger([inklingResident()]);
    const result = computeOptions(unmeasured, loadLedger(ledgerPath), 'inkling2', {
      capability: 'vision', excludeReuseOf: 'inkling2',
    });
    expect(result.reason).toBe('no_measured_config');
    expect(result.options).toEqual([]);
    expect(result.notes[0]).toContain('vision-capable arm is unmeasured');
  });
});

describe('getPlacementAdmit: vision-encoder OOM park', () => {
  const visionAsk = { model_id: 'inkling2', client: 'byok-droid', reason: 'vision_encoder_oom' };

  it('parks even though the resident serves the requested id — forwarding IS the bug', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(process.cwd(), visionAsk, { loaded, ledgerPath });
    // The decisive regression: a plain admit would forward here (reuse).
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('vision_encoder_oom');
    const entry = loadLedger(ledgerPath).pending[0];
    expect(entry?.capability).toBe('vision');
    expect(entry?.reason).toBe('vision_encoder_oom');
    expect(entry?.requested_model).toBe('inkling2');
  });

  it('answers vision_auto_loading and enforces the SWITCH with capability context when auto applies', async () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const policy: AutoPolicy = { enabled: true, allow_displace: ['basalt-fn'] };
    const enforce = vi.fn().mockResolvedValue({ ok: true, steps: [] });
    const answer = getPlacementAdmit(process.cwd(), visionAsk, {
      loaded, ledgerPath, auto: { policy, enforce },
    });
    expect(answer.reason).toBe('vision_auto_loading');
    // scheduleAutoResolution yields a tick before running; give it one.
    await new Promise((r) => setTimeout(r, 20));
    // The enforcement runs the SWITCH (a different arm), not a load of the
    // failed model — and with the capability context its step-0 re-derive
    // accepts (a model-scoped re-derive would call it drift and refuse).
    expect(enforce).toHaveBeenCalledTimes(1);
    expect(enforce).toHaveBeenCalledWith(
      expect.anything(), // the registry
      'inkling2',
      expect.objectContaining({ kind: 'displace', model: 'basalt-fn' }),
      expect.objectContaining({ capability: 'vision', excludeReuseOf: 'inkling2' }),
    );
  });

  it('keeps the vision park (no auto) when displacement is not allowlisted, with actionable attention', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const policy: AutoPolicy = { enabled: true, allow_displace: [] };
    const enforce = vi.fn();
    const answer = getPlacementAdmit(process.cwd(), visionAsk, {
      loaded, ledgerPath, auto: { policy, enforce },
    });
    expect(answer.reason).toBe('vision_encoder_oom'); // never promises a refused run
    expect(enforce).not.toHaveBeenCalled();
  });

  it('does not collide a vision park with a not-resident park for the same model+client', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    getPlacementAdmit(process.cwd(), visionAsk, { loaded, ledgerPath });
    // A not-resident ask for the same model+client (different decision
    // class) must mint its OWN entry, not reuse the vision one.
    const plain = getPlacementAdmit(process.cwd(), { model_id: 'inkling2', client: 'byok-droid' }, { loaded, ledgerPath });
    expect(plain.decision).toBe('forward'); // resident serves it — admission forwards
    const again = getPlacementAdmit(process.cwd(), visionAsk, { loaded, ledgerPath });
    const visionEntries = loadLedger(ledgerPath).pending.filter((p) => p.capability === 'vision');
    expect(visionEntries.length).toBe(1); // the vision ask reuses its own entry
    expect(again.placement_id).toBe(visionEntries[0]!.id);
  });

  it('ignores an off-allowlist reason string — closed allowlist, not a pass-through', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(
      process.cwd(),
      { model_id: 'inkling2', reason: 'not_resident_please' },
      { loaded, ledgerPath },
    );
    // The bogus reason is ignored; the resident-forward branch runs as usual.
    expect(answer.decision).toBe('forward');
  });
});

describe('resolve + pending display share the capability context', () => {
  const timeouts: EnforceTimeouts = { drainMs: 20, startMs: 20, freeMs: 20, pollMs: 1 };

  function fakeDeps(): { deps: EnforceDeps; started: string[] } {
    const started: string[] = [];
    const active = ['uap-basalt-inkling2-server'];
    // The harness clock advances inside sleep — the poll loops in enforceOption
    // (drain, verify-free, wait-for-up) bound themselves by deps.nowMs(), and a
    // frozen clock makes their deadlines unreachable (infinite poll).
    let clock = 0;
    let stopped = false;
    const deps: EnforceDeps = {
      isUnitActive: (u) => active.includes(u),
      stopUnit: async (u) => {
        stopped = true;
        active.splice(active.indexOf(u), 1);
      },
      startUnit: async (u) => {
        started.push(u);
        active.push(u);
      },
      // 505 MiB free with the starved arm resident; stopping it returns the
      // full 31,000 MiB it held (the card has 32,607).
      gpuFreeMiB: () => (stopped ? 31505 : 505),
      inflightForTarget: async () => [],
      httpGetJson: async (url) =>
        // /health for the new unit; /v1/models must list every arm's ids so
        // whichever unit the enforcement lands on verifies as serving.
        url.endsWith('/health')
          ? { status: 'ok' }
          : {
              data: [
                { id: 'inkling2-mini-basalt-nvfp4' },
                { id: 'qwen3.8-fn-basalt-nvfp4' },
                { id: 'qwen3.8-27b-basalt-nvfp4' },
              ],
            },
      refreshProxy: async () => true,
      sleep: async (ms) => {
        clock += ms;
      },
      nowMs: () => clock,
      probeDevices: () => ({
        gpu0: { kind: 'gpu', total_mib: 32607, free_mib: 505, reserved_mib: 512, source: 'nvidia-smi' },
        cpu0: { kind: 'cpu', total_mib: 182000, free_mib: 76000, reserved_mib: 8192, source: 'MemAvailable' },
      }),
    };
    return { deps, started };
  }

  function parkVision(ledgerPath: string, id: string): void {
    withLedger(ledgerPath, (l) => {
      l.pending.push({
        id,
        requested_model: 'inkling2',
        client: 'byok-droid',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        reason: 'vision_encoder_oom',
        capability: 'vision',
        cells: 32768,
      });
    });
  }

  it('resolvePendingPlacement applies a SWITCH option to a vision entry', async () => {
    const ledgerPath = freshLedger([inklingResident()]);
    parkVision(ledgerPath, 'plc-9a9a9a');
    const repoPath = join(dir, 'model-registry.json');
    writeFileSync(repoPath, JSON.stringify(registry));
    const { deps, started } = fakeDeps();
    const result = await resolvePendingPlacement(process.cwd(), 'plc-9a9a9a', 1, {
      ledgerPath, repoPath, localPath: join(dir, 'no-local-overlay.json'),
      deps, timeouts,
    });
    expect(result.ok).toBe(true);
    // The switch ran: the starved arm stopped, the vision-cpu arm started.
    expect(started).toEqual(['uap-basalt-fn-server']);
    // Resolved: the pending entry is gone.
    expect(loadLedger(ledgerPath).pending.some((p) => p.id === 'plc-9a9a9a')).toBe(false);
  });

  it('optionsForPending computes switch options for a vision entry and load options for a plain one', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const ledger = loadLedger(ledgerPath);
    const vision = optionsForPending(registry, ledger, {
      requested_model: 'inkling2', cells: 32768, capability: 'vision',
    });
    expect(vision.options.length).toBeGreaterThan(0);
    expect(vision.options.every((o) => o.model !== 'inkling2' || o.kind !== 'reuse')).toBe(true);
    const plain = optionsForPending(registry, ledger, { requested_model: 'basalt-27b' });
    expect(plain.options.map((o) => o.model)).toEqual(['basalt-27b']); // the model's own reuse
  });
});
