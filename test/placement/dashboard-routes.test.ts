/**
 * Dashboard placement read routes (spec §4.7) — the read-only half of
 * phase 2: state, pending, and preview against injected fixtures.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlacementState, getPlacementPending, getPlacementPreview, getPlacementAdmit, PLACEMENT_PENDING_TTL_MS, resetColdProbeForTests } from '../../src/dashboard/placement-routes.js';
import { loadModelRegistry, type ModelRegistry } from '../../src/placement/registry.js';
import type { PlacementOption } from '../../src/placement/admission.js';
import type { EnforceResult } from '../../src/placement/enforce.js';
import { withLedger, type PlacementLedger } from '../../src/placement/ledger.js';
import { resetAutoSchedulerForTests } from '../../src/placement/auto.js';

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
  },
};

let dir: string;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshLedger(): string {
  dir = mkdtempSync(join(tmpdir(), 'placement-routes-'));
  return join(dir, 'placement.json');
}

describe('dashboard placement routes', () => {
  it('state: registry summary + synced ledger, with provenance per measured config', () => {
    const ledgerPath = freshLedger();
    const loaded = loadModelRegistry('', { repoPath: '', localPath: join(dir, 'absent.json') });
    // Inject a fully-populated registry via the loaded wrapper.
    const payload = getPlacementState(process.cwd(), {
      loaded: { ...loaded, registry, measuredFrom: new Map([['qwen3.8-flash-next/strata-iq3_s', 'repo']]), errors: [] },
      ledgerPath,
      isActive: () => false, // deterministic: never reconcile live units
    });
    expect(payload.registry_errors).toEqual([]);
    expect(payload.models.length).toBe(1);
    const cfg = payload.models[0].configs[0];
    expect(cfg.measured).toBe(true);
    expect(cfg.source).toBe('repo');
    expect(cfg.resident_gpu_mib).toBe(21812);
    expect(Object.keys(payload.devices)).toContain('gpu0');
    expect(payload.residents).toEqual([]);
    expect(payload.pending).toEqual([]);
  });

  it('pending: parked requests are read from the ledger as-is', () => {
    const ledgerPath = freshLedger();
    withLedger(ledgerPath, (l: PlacementLedger) => {
      l.pending.push({
        id: 'plc-7f2a',
        requested_model: 'Qwen3.8-27B',
        client: 'claude-code',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        reason: 'not_resident',
      });
    });
    const pending = getPlacementPending(ledgerPath);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe('plc-7f2a');
    expect(pending[0].reason).toBe('not_resident');
  });

  it('preview: ranked options against an injected ledger', () => {
    const ledgerPath = freshLedger();
    withLedger(ledgerPath, (l: PlacementLedger) => {
      l.devices = {
        gpu0: { kind: 'gpu', total_mib: 24576, free_mib: 1016, reserved_mib: 1293, source: 'nvidia-smi' },
        cpu0: { kind: 'cpu', total_mib: 126944, free_mib: 30424, reserved_mib: 8192, source: 'MemAvailable' },
      };
      l.residents.push({
        model: 'qwen3.8-flash-next',
        config: 'strata-iq3_s',
        device: 'gpu0',
        state: 'hot',
        gpu_mib: 21812,
        host_rss_mib: 52857,
        holders: [],
        since: new Date().toISOString(),
      });
    });
    const result = getPlacementPreview(process.cwd(), 'qwen3.8-flash-next-iq3_s', {
      registry,
      ledgerPath,
    });
    expect(result.matched).toBe(true);
    expect(result.options.map((o) => o.kind)).toEqual(['reuse']);
  });

  it('state survives a corrupt local registry file: errors surface, not a crash', () => {
    const ledgerPath = freshLedger();
    const repo = join(dir, 'repo.json');
    const local = join(dir, 'local.json');
    writeFileSync(repo, JSON.stringify(registry));
    writeFileSync(local, '{ broken');
    const payload = getPlacementState(process.cwd(), { loaded: loadModelRegistry('', { repoPath: repo, localPath: local }), ledgerPath });
    expect(payload.registry_errors.length).toBeGreaterThan(0);
    // The repo shape still summarizes: measured flash-next from repo.
    expect(payload.models[0].configs[0].measured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Admission (spec §4.3) — the proxy gate's controller endpoint
// ---------------------------------------------------------------------------

describe('placement admit (proxy gate controller)', () => {
  beforeEach(() => {
    resetAutoSchedulerForTests(); // auto-run state must not leak across cases
    resetColdProbeForTests(); // probe-throttle window is process state too
  });
  const loaded = () => ({
    registry,
    measuredFrom: new Map([['qwen3.8-flash-next/strata-iq3_s', 'repo']]),
    errors: [],
  });

  it('forwards on resident reuse with the resident target id (device:endpoint)', () => {
    const ledgerPath = freshLedger();
    withLedger(ledgerPath, (l: PlacementLedger) => {
      l.residents.push({
        model: 'qwen3.8-flash-next',
        config: 'strata-iq3_s',
        device: 'gpu0',
        endpoint: 'http://192.168.1.165:8080/v1',
        state: 'hot',
        holders: [],
        since: new Date().toISOString(),
      });
    });
    // The wire id the client asked for is the ADVERTISED alias, not the key.
    const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, { loaded: loaded(), ledgerPath });
    expect(answer.decision).toBe('forward');
    expect(answer.target_id).toBe('gpu0:http://192.168.1.165:8080/v1');
  });

  it('does not forward to a draining resident', () => {
    const ledgerPath = freshLedger();
    withLedger(ledgerPath, (l: PlacementLedger) => {
      l.residents.push({
        model: 'qwen3.8-flash-next',
        config: 'strata-iq3_s',
        device: 'gpu0',
        state: 'draining',
        holders: [],
        since: new Date().toISOString(),
      });
    });
    const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s' }, { loaded: loaded(), ledgerPath });
    expect(answer.decision).toBe('park');
  });

  it('parks with reason not_resident (measured but not loaded) and writes a pending entry', () => {
    const ledgerPath = freshLedger();
    const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code', session: 's1' }, { loaded: loaded(), ledgerPath });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('not_resident');
    expect(answer.placement_id).toMatch(/^plc-[0-9a-f]{6}$/);
    const pending = getPlacementPending(ledgerPath);
    expect(pending.length).toBe(1);
    expect(pending[0].requested_model).toBe('qwen3.8-flash-next-iq3_s');
    expect(pending[0].client).toBe('claude-code');
    expect(pending[0].reason).toBe('not_resident');
    expect(pending[0].expires_at > new Date().toISOString()).toBe(true);
  });

  it('parks with reason no_measured_config (fail closed) and unknown_model', () => {
    const ledgerPath = freshLedger();
    const unmeasured: ModelRegistry = {
      ...registry,
      models: {
        ...registry.models,
        'qwen3.8-27b': {
          display: 'Qwen3.8 27B',
          engine: 'llama',
          advertises: ['Qwen3.8-27B'],
          affinity: { device: ['gpu0'] },
          configs: { 'llama-mtp': { unit: 'uap-qwen27b' } },
        },
      },
    };
    const a = getPlacementAdmit(process.cwd(), { model_id: 'Qwen3.8-27B' }, { loaded: { registry: unmeasured, measuredFrom: new Map(), errors: [] }, ledgerPath });
    expect(a.decision).toBe('park');
    expect(a.reason).toBe('no_measured_config');
    const b = getPlacementAdmit(process.cwd(), { model_id: 'gpt-99' }, { loaded: loaded(), ledgerPath });
    expect(b.decision).toBe('park');
    expect(b.reason).toBe('unknown_model');
  });

  it('dedupes on (requested_model, client): one pending entry, one placement id', () => {
    const ledgerPath = freshLedger();
    const first = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, { loaded: loaded(), ledgerPath });
    const second = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, { loaded: loaded(), ledgerPath });
    expect(first.placement_id).toBe(second.placement_id);
    expect(getPlacementPending(ledgerPath).length).toBe(1);
    // A different client is a different prompt.
    const third = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'codex' }, { loaded: loaded(), ledgerPath });
    expect(third.placement_id).not.toBe(first.placement_id);
    expect(getPlacementPending(ledgerPath).length).toBe(2);
  });

  it('per-request cells: a 16k-pool config with no marginal-KV rate is auto-placeable only when the request fits the pool', async () => {
    // The dflash shape (the ugc-factory motivating case): a small measured
    // KV pool and NO kv_mib_per_1k_cells. cost(cells) is only known up to
    // the pool, so the 32,768-cell default is beyond it — before the proxy
    // threaded the request's real context need through, every such config
    // was fail-closed-refused on every path, even for a 1.5k-token call.
    const ledgerPath = freshLedger();
    const smallPool: ModelRegistry = {
      ...registry,
      models: {
        'qwen3.6-27b': {
          display: 'Qwen3.6 27B',
          engine: 'dflash',
          unit: 'uap-dflash-server',
          advertises: ['qwen3.6-27b'],
          affinity: { device: ['gpu0'] },
          configs: {
            'dflash-q3_k_m': {
              unit: 'uap-dflash-server',
              resident_gpu_mib: 17080,
              host_rss_mib: 13801,
              context_pool_cells: 16384,
              kv_resident_cells: 16384,
              kv_kind: 'tq3_0',
              measured_at: '2026-10-10T00:00:00Z',
              measured_on: 'gpu0',
            },
          },
        },
      },
    };
    const loadedSmall = () => ({
      registry: smallPool,
      measuredFrom: new Map([['qwen3.6-27b/dflash-q3_k_m', 'repo']]),
      errors: [],
    });
    seededDevices(ledgerPath, 23_000); // 17,080 MiB fits alongside the budget
    const enforced: string[] = [];
    const auto = {
      policy: { enabled: true, allow_displace: [] },
      enforce: async (_r: ModelRegistry, model: string) => {
        enforced.push(model);
        return { ok: true, steps: [] };
      },
    };
    // No cells → the 32,768 default is beyond the pool with no marginal
    // rate → cost unknown → fail-closed park; no run promised or scheduled.
    const refused = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.6-27b', client: 'ugc-factory' }, {
      loaded: loadedSmall(), ledgerPath, auto,
    });
    expect(refused.decision).toBe('park');
    expect(refused.reason).toBe('not_resident');
    expect(enforced).toEqual([]);

    // The request's real need (prompt + generation headroom): 4,096 cells
    // fit inside the measured pool → cost known → auto_loading + the run.
    const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.6-27b', client: 'ugc-retry', cells: 4096 }, {
      loaded: loadedSmall(), ledgerPath, auto,
    });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('auto_loading');
    // The pending entry persists the context need so `uap models apply`
    // re-runs the same cost math the controller ran.
    const pending = getPlacementPending(ledgerPath);
    expect(pending.find((p) => p.cells === 4096)?.client).toBe('ugc-retry');
    await new Promise((r) => setTimeout(r, 20)); // let the background run finish
    expect(enforced).toEqual(['qwen3.6-27b']);
    // The run resolves only ITS entry; the cost-unknown park from the first
    // call is still the operator's to answer (its math never became viable).
    const remaining = getPlacementPending(ledgerPath);
    expect(remaining.map((p) => p.client)).toEqual(['ugc-factory']);
    expect(remaining[0].cells).toBeUndefined();
  });

  it('still answers park when the ledger lock is unavailable (write fails, decision does not)', async () => {
    const ledgerPath = freshLedger();
    const { acquireLedgerLock, releaseLedgerLock } = await import('../../src/placement/ledger.js');
    expect(acquireLedgerLock(ledgerPath)).toBe(true);
    try {
      const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, { loaded: loaded(), ledgerPath });
      expect(answer.decision).toBe('park');
      expect(answer.reason).toBe('not_resident');
      expect(answer.placement_id).toMatch(/^plc-/);
    } finally {
      releaseLedgerLock(ledgerPath);
    }
  });

  it('rejects a missing model_id without touching the ledger', () => {
    const ledgerPath = freshLedger();
    const answer = getPlacementAdmit(process.cwd(), { model_id: '' }, { loaded: loaded(), ledgerPath });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('invalid_request');
    expect(getPlacementPending(ledgerPath)).toEqual([]);
  });

  it('the ledger pending TTL is the operator-prompt window (120s), deliberately longer than the proxy burst window', () => {
    // The proxy's own in-memory dedupe is a ~5s burst window so a resolved
    // placement forwards on the next request; this 120s window only bounds
    // how long one operator prompt lives. Spec §4.3 pins the split.
    expect(PLACEMENT_PENDING_TTL_MS).toBe(120_000);
  });

  // -------------------------------------------------------------------------
  // Auto-resolution (spec §4.4, phase 4): a parked, placeable request can
  // load itself — alongside always, displacement only when allowlisted.
  // -------------------------------------------------------------------------
  const seededDevices = (ledgerPath: string, freeMib: number): void => {
    // Full budget inputs: gpu total/reserved for the device gate AND a cpu
    // device for the host-RSS gate (unknown host free refuses the option).
    withLedger(ledgerPath, (l: PlacementLedger) => {
      l.devices = {
        gpu0: { kind: 'gpu', total_mib: 24576, free_mib: freeMib, reserved_mib: 1293, source: 'nvidia-smi' },
        cpu0: { kind: 'cpu', free_mib: 100_000, reserved_mib: 8192, source: 'MemAvailable' },
      };
    });
  };

  it('auto DISABLED by default: a placeable park stays not_resident, nothing scheduled', () => {
    const ledgerPath = freshLedger();
    seededDevices(ledgerPath, 23_000); // room to load alongside
    const enforced: string[] = [];
    const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, {
      loaded: loaded(),
      ledgerPath,
      auto: {
        policy: { enabled: false, allow_displace: [] },
        enforce: async (_r: ModelRegistry, model: string) => {
          enforced.push(model);
          return { ok: true, steps: [] };
        },
      },
    });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('not_resident');
    expect(enforced).toEqual([]);
  });

  it('auto enabled, room to load alongside: park auto_loading + background enforcement of the alongside option', async () => {
    const ledgerPath = freshLedger();
    seededDevices(ledgerPath, 23_000);
    const enforced: Array<{ model: string; kind: string }> = [];
    const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, {
      loaded: loaded(),
      ledgerPath,
      auto: {
        policy: { enabled: true, allow_displace: [] },
        enforce: async (_r: ModelRegistry, model: string, option: PlacementOption) => {
          enforced.push({ model, kind: option.kind });
          return { ok: true, steps: [] };
        },
      },
    });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('auto_loading');
    expect(answer.placement_id).toMatch(/^plc-/);
    await new Promise((r) => setTimeout(r, 20)); // let the background run finish
    expect(enforced).toEqual([{ model: 'qwen3.8-flash-next-iq3_s', kind: 'load_alongside' }]);
    // Success resolved the pending entry: the client's next retry forwards.
    expect(getPlacementPending(ledgerPath)).toEqual([]);
  });

  it('cold-start: an empty-devices ledger is probed at admit time, so the first request after boot can auto-load', async () => {
    // Without device facts every option refuses as "device not in ledger",
    // and the dashboard's 2s refresh does NOT populate them — only the
    // state route or a CLI run does. The first request after a dashboard
    // boot would park not_resident forever, never auto-loading, until an
    // operator happened to open the Models tab.
    const ledgerPath = freshLedger();
    const enforced: string[] = [];
    // The probe seam: real nvidia-smi/MemAvailable readings vary with live
    // machine state (a resident model can eat 17 GiB mid-suite); the test
    // pins the facts the option math consumes.
    const deviceProbe = () => ({
      gpu0: { kind: 'gpu' as const, total_mib: 24576, reserved_mib: 1293, free_mib: 23_000, source: 'nvidia-smi' },
      cpu0: { kind: 'cpu' as const, total_mib: 126944, reserved_mib: 8192, free_mib: 100_000, source: 'MemAvailable' },
    });
    const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code', cells: 4096 }, {
      loaded: loaded(), ledgerPath, deviceProbe,
      auto: {
        policy: { enabled: true, allow_displace: [] },
        enforce: async (_r: ModelRegistry, model: string) => {
          enforced.push(model);
          return { ok: true, steps: [] };
        },
      },
    });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('auto_loading');
    // The probe persisted real device facts (registry totals + live free)
    // for the option math that just ran.
    const persisted = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { devices: Record<string, unknown> };
    expect(Object.keys(persisted.devices)).toContain('gpu0');
    expect(Object.keys(persisted.devices)).toContain('cpu0');
    await new Promise((r) => setTimeout(r, 20));
    expect(enforced).toEqual(['qwen3.8-flash-next-iq3_s']);
  });

  it('cold-start probe throttle: a permanently failing probe spawns once per window, not once per admit', () => {
    // The admit endpoint is loopback-gated but unauthenticated; without a
    // retry window, a machine whose probe can never succeed (no driver,
    // wedged nvidia-smi) turns every admit into a subprocess spawn.
    // Fail-closed is still correct — every request parks — but bounded.
    const ledgerPath = freshLedger();
    let probeCalls = 0;
    const deviceProbe = () => {
      probeCalls += 1;
      throw new Error('nvidia-smi: command not found');
    };
    const call = () =>
      getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code', cells: 4096 }, {
        loaded: loaded(), ledgerPath, deviceProbe,
        auto: { policy: { enabled: true, allow_displace: [] } },
      });
    const first = call();
    const second = call(); // inside the same window: no re-probe
    expect(first.decision).toBe('park');
    expect(first.reason).toBe('not_resident'); // fail-closed, no facts
    expect(second.decision).toBe('park');
    expect(second.reason).toBe('not_resident');
    expect(second.placement_id).toBe(first.placement_id); // dedupe, same entry
    expect(probeCalls).toBe(1);
    // The ledger still has no device facts — nothing was persisted.
    const persisted = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { devices: Record<string, unknown> };
    expect(persisted.devices).toEqual({});
  });

  it('displacement auto-loads ONLY for allowlisted models; otherwise it parks for the operator', async () => {
    const ledgerPath = freshLedger();
    // A two-model registry: 'victim-27b' is the measured resident holding the
    // whole GPU; the requested flash-next is measured but not resident, so
    // the only viable option is to displace the victim. One withLedger
    // (nested ones self-deadlock on the advisory lock).
    const twoModels: ModelRegistry = {
      ...registry,
      models: {
        ...registry.models,
        'victim-27b': {
          display: 'Victim 27B',
          engine: 'llama',
          unit: 'uap-victim-server',
          advertises: ['victim-27b-id'],
          affinity: { device: ['gpu0'] },
          configs: {
            'llama-std': {
              unit: 'uap-victim-server',
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
      },
    };
    const loadedTwo = () => ({
      registry: twoModels,
      measuredFrom: new Map([
        ['qwen3.8-flash-next/strata-iq3_s', 'repo'],
        ['victim-27b/llama-std', 'repo'],
      ]),
      errors: [],
    });
    withLedger(ledgerPath, (l: PlacementLedger) => {
      l.devices = {
        gpu0: { kind: 'gpu', total_mib: 24576, free_mib: 1_000, reserved_mib: 1293, source: 'nvidia-smi' },
        cpu0: { kind: 'cpu', free_mib: 100_000, reserved_mib: 8192, source: 'MemAvailable' },
      };
      l.residents.push({
        model: 'victim-27b',
        config: 'llama-std',
        device: 'gpu0',
        unit: 'uap-victim-server',
        gpu_mib: 21812,
        host_rss_mib: 52857,
        state: 'hot',
        holders: [],
        since: new Date().toISOString(),
      });
    });
    const enforced: Array<{ model: string; kind: string }> = [];
    const auto = (allow: string[]) => ({
      policy: { enabled: true, allow_displace: allow },
      enforce: async (_r: ModelRegistry, model: string, option: PlacementOption) => {
        enforced.push({ model, kind: option.kind });
        return { ok: true, steps: [] };
      },
    });
    // An unknown model can never auto-load (nothing to enforce).
    const unknown = getPlacementAdmit(process.cwd(), { model_id: 'gpt-99', client: 'claude-code' }, {
      loaded: loadedTwo(),
      ledgerPath,
      auto: auto([]),
    });
    expect(unknown.reason).toBe('unknown_model');
    // Measured + displacement needed + NOT allowlisted → operator park.
    const notAllowed = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'codex' }, {
      loaded: loadedTwo(),
      ledgerPath,
      auto: auto(['some-other-model']),
    });
    expect(notAllowed.reason).toBe('not_resident');
    expect(enforced).toEqual([]);
    // Allowlisted (the model being LOADED is what's allowlisted) →
    // auto_loading with the displace option.
    const allowed = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'opencode' }, {
      loaded: loadedTwo(),
      ledgerPath,
      auto: auto(['qwen3.8-flash-next']),
    });
    expect(allowed.reason).toBe('auto_loading');
    await new Promise((r) => setTimeout(r, 20));
    expect(enforced).toEqual([{ model: 'qwen3.8-flash-next-iq3_s', kind: 'displace' }]);
  });

  it('retries of an auto_loading entry do not schedule a second run (the reason is kept)', async () => {
    const ledgerPath = freshLedger();
    seededDevices(ledgerPath, 23_000);
    let calls = 0;
    const enforce = async (): Promise<EnforceResult> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, steps: [] };
    };
    const first = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, {
      loaded: loaded(), ledgerPath, auto: { policy: { enabled: true, allow_displace: [] }, enforce },
    });
    expect(first.reason).toBe('auto_loading');
    // The retry while the run is in flight: same placement id, same reason,
    // and NO second run.
    const retry = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, {
      loaded: loaded(), ledgerPath, auto: { policy: { enabled: true, allow_displace: [] }, enforce },
    });
    expect(retry.placement_id).toBe(first.placement_id);
    expect(retry.reason).toBe('auto_loading');
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(1);
    expect(getPlacementPending(ledgerPath)).toEqual([]);
  });

  it('client/session identity strings are TRUNCATED before persisting (a flood must not grow the ledger)', () => {
    const ledgerPath = freshLedger();
    const longClient = 'c'.repeat(300);
    const longSession = 's'.repeat(300);
    const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: longClient, session: longSession }, { loaded: loaded(), ledgerPath });
    expect(answer.decision).toBe('park');
    const pending = getPlacementPending(ledgerPath);
    expect(pending[0].client?.length).toBe(128);
    expect(pending[0].session?.length).toBe(128);
    expect(pending[0].client).toBe('c'.repeat(128));
  });

  it('lock contention + nobody persisted: the reason does NOT promise an auto load that will never run', async () => {
    const ledgerPath = freshLedger();
    seededDevices(ledgerPath, 23_000); // room: autoPlan would exist
    const enforced: string[] = [];
    const { acquireLedgerLock, releaseLedgerLock } = await import('../../src/placement/ledger.js');
    expect(acquireLedgerLock(ledgerPath)).toBe(true);
    try {
      const answer = getPlacementAdmit(process.cwd(), { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, {
        loaded: loaded(),
        ledgerPath,
        auto: {
          policy: { enabled: true, allow_displace: [] },
          enforce: async (_r: ModelRegistry, model: string) => {
            enforced.push(model);
            return { ok: true, steps: [] };
          },
        },
      });
      expect(answer.decision).toBe('park');
      // The entry was never persisted, so no run will execute for this id —
      // the honest reason is not_resident, never auto_loading.
      expect(answer.reason).toBe('not_resident');
      expect(enforced).toEqual([]);
    } finally {
      releaseLedgerLock(ledgerPath);
    }
  });

  it('production wiring pin: the dashboard admit route injects NO auto opts (defaults resolve the real policy + enforcement)', () => {
    // The route at src/dashboard/server.ts is the production caller; if a
    // refactor starts passing its own auto opts, the default-opts path
    // these tests rely on no longer matches production.
    const serverSrc = readFileSync(join(process.cwd(), 'src', 'dashboard', 'server.ts'), 'utf-8');
    const call = serverSrc.slice(serverSrc.indexOf('getPlacementAdmit(cwd'));
    const callArgs = call.slice(0, call.indexOf(');'));
    expect(callArgs).toContain('model_id');
    // The route must forward the request's context need — dropping cells
    // here is exactly the bug that fail-closed-refused every small-pool
    // config (found live: the proxy sent cells, the ledger entry had none).
    expect(callArgs).toContain('cells');
    expect(callArgs).not.toContain('auto');
  });
});
