/**
 * Text-only engine arms inside vision-capable families (the squid5090
 * class): an image-bearing request must never forward to an arm whose
 * effective vision is 'none' — squid5090 has no image parser at all, so
 * the image blocks would be silently dropped and the model would answer
 * hallucinated text over HTTP 200 (live-probed 2026-11-25: a 1x1-pixel
 * image answered a confident "Skull" description).
 *
 * The registry carries the capability at CONFIG level (a family's arms
 * differ: basalt inkling2 serves vision dynamic, squid5090 serves none),
 * the proxy tells the controller the request carries an image
 * (carries_image), and the admit parks the request with a switch that
 * stays INSIDE the family — the family's image-capable arm advertises the
 * same wire ids, so the client's retry re-resolves in place instead of
 * ping-ponging across families.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeOptions, optionsForPending, visionCapableConfigs } from '../src/placement/admission.js';
import { getPlacementAdmit, resetColdProbeForTests } from '../src/dashboard/placement-routes.js';
import { effectiveVision, ModelEntrySchema, ConfigEntrySchema } from '../src/placement/registry.js';
import type { ModelRegistry } from '../src/placement/registry.js';
import { loadLedger, withLedger, type LedgerResident } from '../src/placement/ledger.js';
import { resetAutoSchedulerForTests, type AutoPolicy } from '../src/placement/auto.js';
import * as autoPolicyModule from '../src/placement/auto.js';
import {
  resolvePendingPlacement,
  type EnforceDeps,
  type EnforceTimeouts,
} from '../src/placement/enforce.js';
import { listAttention } from '../src/delivery/attention.js';

// The live 5090 fleet shape this round ships: the inkling2 family with TWO
// engine arms — basalt 0.5.7 on the native NVFP4-MX8 pack (vision
// dynamic, the family default) and squid5090 on the original HF
// checkpoint (config-level vision "none", text-only by design).
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
      advertises: ['Inkling 2 Mini', 'qwen3.8-flash-next-alias'],
      affinity: { device: ['gpu0'] },
      vision: 'dynamic',
      configs: {
        'nvfp4-mx8': {
          engine: 'basalt',
          unit: 'uap-basalt-inkling2-server',
          resident_gpu_mib: 28212,
          host_rss_mib: 17480,
          context_pool_cells: 1048576,
          kv_resident_cells: 1048576,
          kv_kind: 'fp8',
          measured_at: '2026-11-25T14:05:00Z',
          measured_on: 'gpu0',
        },
        'squid-fp8': {
          engine: 'squid5090',
          unit: 'uap-squid-inkling2-server',
          vision: 'none',
          resident_gpu_mib: 24200,
          host_rss_mib: 8000,
          context_pool_cells: 524288,
          kv_resident_cells: 524288,
          kv_kind: 'q4',
          measured_at: '2026-11-25T18:05:00Z',
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
          resident_gpu_mib: 28406,
          host_rss_mib: 60740,
          context_pool_cells: 262144,
          kv_resident_cells: 262144,
          kv_kind: 'int8',
          measured_at: '2026-11-25T04:14:42Z',
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
  dir = mkdtempSync(join(tmpdir(), 'placement-text-only-'));
  const ledgerPath = join(dir, 'placement.json');
  withLedger(ledgerPath, (l) => {
    l.devices = {
      gpu0: { kind: 'gpu', total_mib: 32607, free_mib: 400, reserved_mib: 512, source: 'nvidia-smi' },
      cpu0: { kind: 'cpu', total_mib: 182000, free_mib: 76000, reserved_mib: 8192, source: 'MemAvailable' },
    };
    l.residents.push(...residents);
  });
  return ledgerPath;
}

function residentOf(model: string, config: string, unit: string, gpuMib: number): LedgerResident {
  return {
    model, config, device: 'gpu0', unit, state: 'hot',
    gpu_mib: gpuMib, host_rss_mib: 17480, holders: [], since: '2026-11-25T18:14:02Z',
  };
}

const squidResident = (): LedgerResident =>
  residentOf('inkling2', 'squid-fp8', 'uap-squid-inkling2-server', 24200);

const autoOff: AutoPolicy = { enabled: false, allow_displace: [] };
const autoInkling: AutoPolicy = { enabled: true, allow_displace: ['inkling2'] };

// Hermeticity, the placement-vision-switch suite's rules: the attention
// rail is off, the auto fallback sees a disabled policy unless a test
// passes an explicit one, and the scheduler's process state never leaks
// between cases.
const savedAttentionOff = process.env.UAP_ATTENTION_OFF;
beforeEach(() => {
  process.env.UAP_ATTENTION_OFF = '1';
  resetAutoSchedulerForTests();
  resetColdProbeForTests();
  vi.restoreAllMocks();
  vi.spyOn(autoPolicyModule, 'loadAutoPolicy').mockReturnValue(autoOff);
});
afterEach(() => {
  if (savedAttentionOff === undefined) delete process.env.UAP_ATTENTION_OFF;
  else process.env.UAP_ATTENTION_OFF = savedAttentionOff;
});

describe('config-level vision override', () => {
  it('accepts the capability vocabulary at config level and rejects anything else', () => {
    for (const vision of ['none', 'cpu', 'gpu', 'dynamic'] as const) {
      // The unmeasured shape (a config entry is always one of the union's
      // two members; vision rides configIdentity in both).
      expect(ConfigEntrySchema.parse({ status: 'unmeasured', vision }).vision).toBe(vision);
      // The measured shape carries it too — a `measure` write never drops
      // the capability the arm declared.
      expect(
        ConfigEntrySchema.parse({
          vision,
          resident_gpu_mib: 1, host_rss_mib: 1, context_pool_cells: 1,
          kv_resident_cells: 1, measured_at: '2026-11-25T00:00:00Z', measured_on: 'gpu0',
        }).vision,
      ).toBe(vision);
    }
    expect(ConfigEntrySchema.parse({ status: 'unmeasured' }).vision).toBeUndefined();
    expect(() => ConfigEntrySchema.parse({ status: 'unmeasured', vision: 'telepathy' })).toThrow();
    // Model level unchanged: the family default the config overrides.
    expect(ModelEntrySchema.parse({ display: 'x', configs: {}, vision: 'dynamic' }).vision).toBe('dynamic');
  });

  it('resolves the effective vision config-first, then family, then none', () => {
    const fam = registry.models['inkling2']!;
    expect(effectiveVision(fam, fam.configs['squid-fp8'])).toBe('none'); // the override
    expect(effectiveVision(fam, fam.configs['nvfp4-mx8'])).toBe('dynamic'); // family fallback
    expect(effectiveVision(fam)).toBe('dynamic'); // family only
    expect(effectiveVision({ display: 'x', configs: {} })).toBe('none'); // absent = never a capability
  });

  it('keeps switch targets honest under the override: a none-config in a cpu family is no target, a cpu-config in a dynamic family is', () => {
    const overridden: ModelRegistry = {
      ...registry,
      models: {
        'inkling2': {
          ...registry.models['inkling2']!,
          vision: 'cpu', // family says capable...
          configs: {
            'squid-fp8': { ...registry.models['inkling2']!.configs['squid-fp8']!, vision: 'none' }, // ...arm says not
            'nvfp4-mx8': { ...registry.models['inkling2']!.configs['nvfp4-mx8']! },
          },
        },
        'basalt-fn': {
          ...registry.models['basalt-fn']!,
          vision: 'dynamic', // family says encoder-OOM class...
          configs: {
            'nvfp4-dq6': { ...registry.models['basalt-fn']!.configs['nvfp4-dq6']!, vision: 'cpu' }, // ...arm says capable
          },
        },
      },
    };
    const targets = visionCapableConfigs(overridden).map((c) => `${c.model}/${c.config}`).sort();
    // squid-fp8 never a target despite the cpu family (its config override
    // wins); the family default still admits the basalt arm that did not
    // override; basalt-fn's config lifts it OUT of its encoder-OOM family.
    expect(targets).toEqual(['basalt-fn/nvfp4-dq6', 'inkling2/nvfp4-mx8'].sort());
    expect(targets).not.toContain('inkling2/squid-fp8');
  });

  it('image-capable candidates include dynamic arms (they encode; OOM is a memory event) and exclude none', () => {
    // The PRODUCTION predicate: computeOptions with capability 'image' —
    // the one filter the admit, pending, apply, and auto paths share
    // (no separate whole-registry enumeration to drift from it). A roomy
    // ledger so the fit math never hides a candidate.
    const ledgerPath = freshLedger();
    withLedger(ledgerPath, (l) => {
      l.devices.gpu0.free_mib = 30000;
    });
    const ledger = loadLedger(ledgerPath);
    const inkling = computeOptions(registry, ledger, 'Inkling 2 Mini', { capability: 'image' });
    expect(inkling.options.map((o) => `${o.model}/${o.config}`)).toEqual(['inkling2/nvfp4-mx8']);
    // The family's own text-only arm is excluded by the filter itself even
    // though it advertises the same id and would fit.
    expect(inkling.options.map((o) => `${o.model}/${o.config}`)).not.toContain('inkling2/squid-fp8');
    // Cross-family: another family's advertised id resolves its own
    // image-capable arm the same way (the filter is per-request-id, not
    // inkling-specific).
    const fn = computeOptions(registry, ledger, 'qwen3.8-fn-basalt-nvfp4', { capability: 'image' });
    expect(fn.options.map((o) => `${o.model}/${o.config}`)).toEqual(['basalt-fn/nvfp4-dq6']);
  });
});

describe('image-bearing requests against a text-only resident', () => {
  it('parks the image request and auto-switches WITHIN the family, never forwards to the text-only arm', async () => {
    const ledgerPath = freshLedger([squidResident()]);
    const enforce = vi.fn(async () => ({ ok: true, steps: [] }));
    const answer = getPlacementAdmit(dir, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      session: 's1',
      cells: 4096,
      carries_image: true,
    }, { loaded, ledgerPath, auto: { policy: autoInkling, enforce: enforce as never } });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('vision_auto_loading');
    // The switch stays inside the family: the approved option is the
    // image-capable config of the REQUESTED model, displacing the text-only
    // resident — never a forward into the silent drop.
    await new Promise((r) => setImmediate(r));
    await vi.waitFor(() => expect(enforce).toHaveBeenCalledTimes(1));
    expect(enforce.mock.calls[0]![1]).toBe('inkling2');
    const option = enforce.mock.calls[0]![2] as { model: string; config: string; kind: string };
    expect(option.model).toBe('inkling2');
    expect(option.config).toBe('nvfp4-mx8');
    expect(option.kind).toBe('displace');
    // The auto run's ENFORCEMENT CONTEXT: the family image class, never the
    // OOM shape — a cross-registry candidate set (capability 'vision' +
    // excludeReuseOf) would lack inkling2/nvfp4-mx8 and refuse the family's
    // own switch as "drift", parking every image request forever.
    expect(enforce.mock.calls[0]![3]).toMatchObject({ capability: 'image' });
    expect((enforce.mock.calls[0]![3] as { excludeReuseOf?: string }).excludeReuseOf).toBeUndefined();
  });

  it('forwards TEXT requests to the same resident — the text-only arm still serves text', () => {
    const ledgerPath = freshLedger([squidResident()]);
    const answer = getPlacementAdmit(dir, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      session: 's1',
      cells: 4096,
    }, { loaded, ledgerPath });
    expect(answer.decision).toBe('forward');
  });

  it('parks WITHOUT auto when the family has no measured image-capable config (fail-closed)', async () => {
    const unmeasuredFamily: ModelRegistry = {
      ...registry,
      models: {
        ...registry.models,
        'inkling2': {
          ...registry.models['inkling2']!,
          configs: {
            'squid-fp8': registry.models['inkling2']!.configs['squid-fp8']!,
            'nvfp4-mx8': { engine: 'basalt', unit: 'uap-basalt-inkling2-server', status: 'unmeasured' },
          },
        },
      },
    };
    const unmeasuredLoaded = { ...loaded, registry: unmeasuredFamily };
    const ledgerPath = freshLedger([squidResident()]);
    const enforce = vi.fn(async () => ({ ok: true, steps: [] }));
    const answer = getPlacementAdmit(dir, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      session: 's1',
      cells: 4096,
      carries_image: true,
    }, { loaded: unmeasuredLoaded, ledgerPath, auto: { policy: autoInkling, enforce: enforce as never } });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('vision_text_only_arm');
    await new Promise((r) => setImmediate(r));
    expect(enforce).not.toHaveBeenCalled();
  });

  it('the pending entry re-derives FAMILY options, not cross-registry switch targets', () => {
    const ledgerPath = freshLedger([squidResident()]);
    getPlacementAdmit(dir, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      session: 's1',
      cells: 4096,
      carries_image: true,
    }, { loaded, ledgerPath, auto: { policy: autoOff } });
    const pending = loadLedger(ledgerPath).pending[0]!;
    // The 'image' class (not the OOM 'vision' class): the candidates are
    // the family's image-capable configs.
    expect(pending.capability).toBe('image');
    expect(pending.reason).toBe('vision_text_only_arm');
    const family = optionsForPending(registry, loadLedger(ledgerPath), pending).options;
    expect(family.map((o) => `${o.model}/${o.config}`)).toEqual(['inkling2/nvfp4-mx8']);
    expect(family.every((o) => o.kind === 'displace')).toBe(true);
  });

  it('an image retry dedupes onto the parked entry; a TEXT retry after the park still forwards', () => {
    const ledgerPath = freshLedger([squidResident()]);
    const ask = {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      session: 's1',
      cells: 4096,
      carries_image: true,
    };
    const first = getPlacementAdmit(dir, ask, { loaded, ledgerPath, auto: { policy: autoOff } });
    expect(first.decision).toBe('park');
    // The retry inside the TTL re-parks with the SAME placement id — one
    // pending entry, not a flood (the dedupe key carries the capability
    // class, so only image retries hit it).
    const retry = getPlacementAdmit(dir, ask, { loaded, ledgerPath, auto: { policy: autoOff } });
    expect(retry.decision).toBe('park');
    expect(retry.placement_id).toBe(first.placement_id);
    expect(loadLedger(ledgerPath).pending).toHaveLength(1);
    // A TEXT request for the same model+client keys the plain identity
    // class: the resident still serves text, the park entry stays untouched.
    const text = getPlacementAdmit(dir, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      session: 's1',
      cells: 4096,
    }, { loaded, ledgerPath });
    expect(text.decision).toBe('forward');
    expect(loadLedger(ledgerPath).pending).toHaveLength(1);
  });

  it('a COLD image park carries the image capability class — the operator apply list stays image-scoped', () => {
    const ledgerPath = freshLedger([]); // nothing resident: the cold class
    const answer = getPlacementAdmit(dir, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      session: 's1',
      cells: 4096,
      carries_image: true,
    }, { loaded, ledgerPath, auto: { policy: autoOff } });
    expect(answer.decision).toBe('park');
    const pending = loadLedger(ledgerPath).pending[0]!;
    // Without the class, optionsForPending recomputes from the FULL config
    // set and would offer loading the text-only squid arm for a park minted
    // by an image request — the exact wrong resolution.
    expect(pending.capability).toBe('image');
    const options = optionsForPending(registry, loadLedger(ledgerPath), pending).options;
    expect(options.map((o) => `${o.model}/${o.config}`)).toEqual(['inkling2/nvfp4-mx8']);
    expect(options.map((o) => `${o.model}/${o.config}`)).not.toContain('inkling2/squid-fp8');
  });

  it('forwards an image request to an unmeasured-but-RESIDENT image-capable arm (fail-closed to load, fail-open to a capable resident)', () => {
    const unmeasured: ModelRegistry = {
      ...registry,
      models: {
        ...registry.models,
        'inkling2': {
          ...registry.models['inkling2']!,
          configs: {
            'squid-fp8': registry.models['inkling2']!.configs['squid-fp8']!,
            'nvfp4-mx8': { engine: 'basalt', unit: 'uap-basalt-inkling2-server', status: 'unmeasured' },
          },
        },
      },
    };
    const ledgerPath = freshLedger([residentOf('inkling2', 'nvfp4-mx8', 'uap-basalt-inkling2-server', 29050)]);
    const answer = getPlacementAdmit(dir, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      cells: 4096,
      carries_image: true,
    }, { loaded: { ...loaded, registry: unmeasured }, ledgerPath });
    expect(answer.decision).toBe('forward');
  });

  it('an image-bearing cold request auto-loads only an image-capable config of the model', async () => {
    const ledgerPath = freshLedger([]); // nothing resident
    const enforce = vi.fn(async () => ({ ok: true, steps: [] }));
    const answer = getPlacementAdmit(dir, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      session: 's1',
      cells: 4096,
      carries_image: true,
    }, { loaded, ledgerPath, auto: { policy: autoInkling, enforce: enforce as never } });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('auto_loading');
    await new Promise((r) => setImmediate(r));
    await vi.waitFor(() => expect(enforce).toHaveBeenCalledTimes(1));
    const option = enforce.mock.calls[0]![2] as { model: string; config: string };
    expect(option.config).toBe('nvfp4-mx8'); // never squid-fp8 for an image
    // Same enforcement context as the resident-switch case: family image
    // class, no excludeReuseOf.
    expect(enforce.mock.calls[0]![3]).toMatchObject({ capability: 'image' });
    expect((enforce.mock.calls[0]![3] as { excludeReuseOf?: string }).excludeReuseOf).toBeUndefined();
  });

  it('refuses with the honest note when the family is all text-only', () => {
    const allTextOnly: ModelRegistry = {
      ...registry,
      models: {
        ...registry.models,
        'inkling2': {
          ...registry.models['inkling2']!,
          vision: 'none',
          configs: { 'squid-fp8': registry.models['inkling2']!.configs['squid-fp8']! },
        },
      },
    };
    const ledgerPath = freshLedger([squidResident()]);
    const result = computeOptions(allTextOnly, loadLedger(ledgerPath), 'inkling2', { capability: 'image' });
    expect(result.matched).toBe(false);
    // The family IS registered — every arm text-only — so the refusal says
    // the capability class, not "not in registry".
    expect(result.reason).toBe('no_image_capable_config');
    expect(result.notes[0]).toContain('no image-capable config');
  });
});

describe('the operator apply path resolves a text-only park to the family image arm', () => {
  const timeouts: EnforceTimeouts = { drainMs: 20, startMs: 20, freeMs: 20, pollMs: 1 };

  /** The vision-switch suite's fakeDeps shape, on THIS fixture's numbers:
   * the squid unit holds 24200 MiB; stopping it returns the card's room. */
  function fakeDeps(): { deps: EnforceDeps; started: string[] } {
    const started: string[] = [];
    const active = ['uap-squid-inkling2-server'];
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
      gpuFreeMiB: () => (stopped ? 31600 : 400),
      inflightForTarget: async () => [],
      httpGetJson: async (url) =>
        url.endsWith('/health')
          ? { status: 'ok' }
          : { data: [{ id: 'Inkling 2 Mini' }, { id: 'qwen3.8-fn-basalt-nvfp4' }] },
      refreshProxy: async () => true,
      sleep: async (ms) => {
        clock += ms;
      },
      nowMs: () => clock,
      probeDevices: () => ({
        gpu0: { kind: 'gpu', total_mib: 32607, free_mib: 400, reserved_mib: 512, source: 'nvidia-smi' },
        cpu0: { kind: 'cpu', total_mib: 182000, free_mib: 76000, reserved_mib: 8192, source: 'MemAvailable' },
      }),
    };
    return { deps, started };
  }

  it('resolvePendingPlacement applies the family IMAGE arm, not a cross-registry switch', async () => {
    const ledgerPath = freshLedger([squidResident()]);
    withLedger(ledgerPath, (l) => {
      l.pending.push({
        id: 'plc-t1t1t1',
        requested_model: 'inkling2',
        client: 'claude-code',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        reason: 'vision_text_only_arm',
        capability: 'image',
        cells: 4096,
      });
    });
    const repoPath = join(dir, 'model-registry.json');
    writeFileSync(repoPath, JSON.stringify(registry));
    const { deps, started } = fakeDeps();
    const result = await resolvePendingPlacement(process.cwd(), 'plc-t1t1t1', 1, {
      ledgerPath,
      repoPath,
      localPath: join(dir, 'no-local-overlay.json'),
      deps,
      timeouts,
    });
    expect(result.ok).toBe(true);
    // The family's image arm — never the text-only squid unit again, and
    // never basalt-fn (the cross-registry cpu/gpu switch class the OOM
    // park uses; it does not advertise the asked id).
    expect(started).toEqual(['uap-basalt-inkling2-server']);
    expect(loadLedger(ledgerPath).pending.some((p) => p.id === 'plc-t1t1t1')).toBe(false);
  });
});

describe('attention rail: a text-only-arm park is a visible, correctly-shaped ask', () => {
  it('actionable when the family has an image-capable arm — the ask names the apply command', () => {
    delete process.env.UAP_ATTENTION_OFF;
    const ledgerPath = freshLedger([squidResident()]);
    const answer = getPlacementAdmit(dir, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      cells: 4096,
      carries_image: true,
    }, { loaded, ledgerPath, auto: { policy: autoOff } });
    expect(answer.decision).toBe('park');
    const items = listAttention(dir);
    expect(items.length).toBe(1);
    expect(items[0]!.source).toBe(`placement:${answer.placement_id}`);
    expect(items[0]!.title).toBe('Vision parked: inkling2 (text-only serving arm)');
    // The detail says what actually broke — the ARM is text-only, not the
    // request wrong or the memory short — and names the operator's apply.
    expect(items[0]!.detail).toContain('TEXT-ONLY');
    expect(items[0]!.detail).toContain('1 image-capable switch option(s) registered');
    expect(items[0]!.detail).toContain(`uap models apply ${answer.placement_id} <n>`);
    expect(items[0]!.safeDefault?.decision).toContain('expire');
  });

  it('plain no-option ask when the family has no image-capable arm at all', () => {
    delete process.env.UAP_ATTENTION_OFF;
    const textOnlyFamily: ModelRegistry = {
      ...registry,
      models: {
        ...registry.models,
        'inkling2': {
          ...registry.models['inkling2']!,
          configs: { 'squid-fp8': registry.models['inkling2']!.configs['squid-fp8']! },
        },
      },
    };
    const ledgerPath = freshLedger([squidResident()]);
    const answer = getPlacementAdmit(dir, {
      model_id: 'Inkling 2 Mini',
      client: 'claude-code',
      cells: 4096,
      carries_image: true,
    }, { loaded: { ...loaded, registry: textOnlyFamily }, ledgerPath, auto: { policy: autoOff } });
    expect(answer.decision).toBe('park');
    const items = listAttention(dir);
    expect(items.length).toBe(1);
    expect(items[0]!.title).toBe('Vision parked: inkling2 (text-only serving arm)');
    // Not actionable: nothing to approve — it must not invite a decision
    // that cannot be made.
    expect(items[0]!.detail).toContain('No registered option serves it');
    expect(items[0]!.detail).not.toContain('uap models apply');
  });
});
