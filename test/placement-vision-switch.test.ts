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
import { getPlacementAdmit, getPlacementPreview, resetColdProbeForTests } from '../src/dashboard/placement-routes.js';
import { listAttention } from '../src/delivery/attention.js';
import { modelsApplyCommand } from '../src/cli/models.js';
import { resolvePendingPlacement, type EnforceDeps, type EnforceTimeouts, type PlacementInflightEntry } from '../src/placement/enforce.js';
import { ModelEntrySchema } from '../src/placement/registry.js';
import type { ModelRegistry } from '../src/placement/registry.js';
import { loadLedger, withLedger, type LedgerResident } from '../src/placement/ledger.js';
import { resetAutoSchedulerForTests, type AutoPolicy } from '../src/placement/auto.js';
import * as autoPolicyModule from '../src/placement/auto.js';

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
  // Hermeticity, same class as the attention kill switch above: the admit's
  // auto fallback reads the OPERATOR's real ~/.uap/placement-auto.json — a
  // policy enabled live (mid-032-validation) flipped every "parks
  // vision_encoder_oom" assertion into vision_auto_loading. Tests that
  // exercise auto behavior pass an explicit policy; every other admit must
  // see a disabled one.
  vi.spyOn(autoPolicyModule, 'loadAutoPolicy').mockReturnValue({
    enabled: false,
    allow_displace: [],
  });
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

  it('an off-allowlist reason on a NON-resident ask behaves exactly like an absent one', () => {
    const ledgerPath = freshLedger([inklingResident()]); // basalt-27b not resident
    const bogus = getPlacementAdmit(
      process.cwd(),
      { model_id: 'basalt-27b', client: 'byok-droid', reason: 'not_resident_please' },
      { loaded, ledgerPath },
    );
    expect(bogus.decision).toBe('park');
    expect(bogus.reason).toBe('not_resident');
    expect(bogus.placement_id).toBeDefined();
    // The same ask without the reason dedupes onto the same entry — the
    // bogus string never minted a second, differently-shaped park.
    const plain = getPlacementAdmit(
      process.cwd(),
      { model_id: 'basalt-27b', client: 'byok-droid' },
      { loaded, ledgerPath },
    );
    expect(plain.reason).toBe('not_resident');
    expect(plain.placement_id).toBe(bogus.placement_id);
    expect(loadLedger(ledgerPath).pending.length).toBe(1);
  });

  it('a pre-upgrade pending entry (no capability field) never satisfies a vision ask', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    withLedger(ledgerPath, (l) => {
      l.pending.push({
        id: 'plc-legacy',
        requested_model: 'basalt-27b',
        client: 'byok-droid',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        reason: 'not_resident',
      });
    });
    // The vision ask must mint a FRESH entry, not ride the capability-less
    // one (its options are load options, not switch options).
    const vision = getPlacementAdmit(process.cwd(), visionAsk, { loaded, ledgerPath });
    expect(vision.placement_id).not.toBe('plc-legacy');
    expect(vision.reason).toBe('vision_encoder_oom');
    // The legacy entry still dedupes plain asks — both live side by side.
    const plain = getPlacementAdmit(
      process.cwd(),
      { model_id: 'basalt-27b', client: 'byok-droid' },
      { loaded, ledgerPath },
    );
    expect(plain.placement_id).toBe('plc-legacy');
    const pending = loadLedger(ledgerPath).pending;
    expect(pending.filter((p) => p.capability === 'vision').length).toBe(1);
    expect(pending.filter((p) => p.capability === undefined).length).toBe(1);
  });
});

describe('preview drift: a vision entry previews by ENTRY, not by model', () => {
  // Quality-review blocker: the pending card previewed via
  // ?model=<requested> while Apply enforced optionsForPending — a vision
  // park showed the starved arm's own load/reuse options and Apply then
  // enforced a DIFFERENT list (and its victim-drift check would refuse
  // with a list the operator never saw). ?placement=<id> previews the
  // exact list apply will enforce.
  const visionAsk = { model_id: 'inkling2', client: 'byok-droid', reason: 'vision_encoder_oom' };

  it('model-scoped preview offers the starved arm; placement-scoped previews the switch list apply enforces', () => {
    // A cpu-encoder variant of the starved arm: vision-capable, so the
    // model-scoped preview offers its own reuse — the drift class.
    const cpuEncoderArm: ModelRegistry = {
      ...registry,
      models: {
        ...registry.models,
        'inkling2': { ...registry.models['inkling2']!, vision: 'cpu' },
      },
    };
    const cpuLoaded = { registry: cpuEncoderArm, measuredFrom: new Map(), errors: [] };
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(process.cwd(), visionAsk, { loaded: cpuLoaded, ledgerPath });
    expect(answer.reason).toBe('vision_encoder_oom');
    // The OLD surface (by model) — what the dashboard used to fetch.
    const byModel = getPlacementPreview(process.cwd(), 'inkling2', {
      registry: cpuEncoderArm, ledgerPath,
    });
    expect(byModel.options.some((o) => o.model === 'inkling2' && o.kind === 'reuse')).toBe(true);
    // The NEW surface (by entry) — what the pending card + apply share.
    const byEntry = getPlacementPreview(process.cwd(), 'inkling2', {
      registry: cpuEncoderArm, ledgerPath, placementId: answer.placement_id,
    });
    expect(byEntry.options.every((o) => o.model !== 'inkling2')).toBe(true);
    // And it IS the apply list — byte-identical to optionsForPending.
    const entry = loadLedger(ledgerPath).pending.find((p) => p.id === answer.placement_id)!;
    expect(byEntry).toEqual(optionsForPending(cpuEncoderArm, loadLedger(ledgerPath), entry));
  });

  it('a resolved-or-expired placement id previews as a clear not-found, not a stale list', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const stale = getPlacementPreview(process.cwd(), 'inkling2', {
      registry, ledgerPath, placementId: 'plc-gone',
    });
    expect(stale.matched).toBe(false);
    expect(stale.notes[0]).toContain('plc-gone not found');
  });
});

describe('attention rail: a vision park is a visible, correctly-shaped ask', () => {
  const visionAsk = { model_id: 'inkling2', client: 'byok-droid', reason: 'vision_encoder_oom' };

  it('actionable when a switch target exists — the ask names the apply command and the option count', () => {
    delete process.env.UAP_ATTENTION_OFF;
    const ledgerPath = freshLedger([inklingResident()]);
    // projectDir = the temp dir, so the ask writes under it (hermetic),
    // mirroring the dashboard-routes attention pattern.
    const answer = getPlacementAdmit(dir, visionAsk, { loaded, ledgerPath });
    expect(answer.decision).toBe('park');
    const items = listAttention(dir);
    expect(items.length).toBe(1);
    expect(items[0]!.source).toBe(`placement:${answer.placement_id}`);
    expect(items[0]!.title).toBe('Vision parked: inkling2 (image encoder OOM)');
    // gpu free 505 MiB with the starved arm resident → both basalt arms
    // displace → 2 switch options.
    expect(items[0]!.detail).toContain('cannot encode images right now');
    expect(items[0]!.detail).toContain('2 vision-capable switch option(s) registered');
    expect(items[0]!.detail).toContain(`uap models apply ${answer.placement_id} <n>`);
    // The safe default remains expiry — approving is a choice, never owed.
    expect(items[0]!.safeDefault?.decision).toContain('expire');
  });

  it('plain no-option ask when no vision-capable arm is registered', () => {
    delete process.env.UAP_ATTENTION_OFF;
    const noVision: ModelRegistry = {
      ...registry,
      models: {
        'inkling2': registry.models['inkling2']!, // dynamic — not a target
        'text-only-arm': registry.models['text-only-arm']!, // no vision field
      },
    };
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(
      dir, visionAsk,
      { loaded: { registry: noVision, measuredFrom: new Map(), errors: [] }, ledgerPath },
    );
    expect(answer.reason).toBe('vision_encoder_oom');
    const items = listAttention(dir);
    expect(items.length).toBe(1);
    expect(items[0]!.title).toBe('Vision parked: inkling2 (image encoder OOM)');
    // Not actionable: nothing to approve — it must not invite a decision
    // that cannot be made.
    expect(items[0]!.detail).toContain('No registered option serves it');
    expect(items[0]!.detail).not.toContain('uap models apply');
  });
});

describe('wire ids resolve through the registry (full automation)', () => {
  // Backends serve human-readable wire ids ("Inkling 2 Mini") that the raw
  // charset gate refuses — the exact class that parked every inkling
  // request as invalid_request when the gate turned on live. The registry's
  // advertises table is the trust anchor: an off-charset id that EXACTLY
  // matches an advertised entry resolves to the registry model key, and
  // only the KEY flows into the ledger and attention text.
  const wireRegistry: ModelRegistry = {
    ...registry,
    models: {
      ...registry.models,
      'inkling2': {
        ...registry.models['inkling2']!,
        advertises: ['Inkling 2 Mini', 'inkling2-mini-basalt-nvfp4'],
      },
      // A LATER registry entry also carries wire ids — the scan must walk
      // the whole table, not stop at the first model (the degenerate case
      // every earlier test hit: inkling2 happens to be first).
      'basalt-fn': {
        ...registry.models['basalt-fn']!,
        advertises: ['Qwen3.8 Flash Next Basalt', 'qwen3.8-fn-basalt-nvfp4'],
      },
    },
  };
  const wireLoaded = { registry: wireRegistry, measuredFrom: new Map(), errors: [] };
  const wireAsk = { model_id: 'Inkling 2 Mini', client: 'byok-droid' };

  it('forwards a resident ask made by the space-containing wire id', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(process.cwd(), wireAsk, { loaded: wireLoaded, ledgerPath });
    // The decisive regression: this was invalid_request before the uplift.
    expect(answer.decision).toBe('forward');
  });

  it('resolves through a LATER registry entry — the scan walks the whole table', () => {
    // The first entry (inkling2) advertises neither of basalt-fn's wire
    // ids; restricting the scan to it would park this as invalid_request.
    const ledgerPath = freshLedger();
    const answer = getPlacementAdmit(
      process.cwd(),
      { model_id: 'Qwen3.8 Flash Next Basalt', client: 'byok-droid' },
      { loaded: wireLoaded, ledgerPath },
    );
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('not_resident'); // resolved: basalt-fn, known but not resident
    expect(loadLedger(ledgerPath).pending[0]?.requested_model).toBe('basalt-fn');
  });

  it('pins first-match-wins when two models advertise the same wire id', () => {
    // Documented resolution for advertises collisions (registry hygiene is
    // the fix, not the scanner): the first model in registry order wins.
    const ambLoaded = {
      registry: {
        ...wireRegistry,
        models: {
          ...wireRegistry.models,
          'basalt-fn': {
            ...wireRegistry.models['basalt-fn']!,
            advertises: [...wireRegistry.models['basalt-fn']!.advertises ?? [], 'Shared Wire Id'],
          },
          'inkling2': {
            ...wireRegistry.models['inkling2']!,
            advertises: ['Inkling 2 Mini', 'inkling2-mini-basalt-nvfp4', 'Shared Wire Id'],
          },
        },
      } as ModelRegistry,
      measuredFrom: new Map(),
      errors: [],
    };
    const ledgerPath = freshLedger();
    const answer = getPlacementAdmit(
      process.cwd(),
      { model_id: 'Shared Wire Id', client: 'byok-droid' },
      { loaded: ambLoaded, ledgerPath },
    );
    expect(answer.reason).toBe('not_resident');
    // inkling2 precedes basalt-fn in the fixture's key order.
    expect(loadLedger(ledgerPath).pending[0]?.requested_model).toBe('inkling2');
  });

  it('an off-charset registry KEY parks invalid_request — the guard on resolved keys', () => {
    // The resolution re-checks the RESOLVED key against the charset gate:
    // a registry that names a model by an off-charset key (operator-side
    // misconfiguration) must not launder that key into the queue text.
    const offLoaded = {
      registry: {
        ...wireRegistry,
        models: { 'Inkling 2': { ...registry.models['inkling2']!, advertises: ['inkling2-alias'] } },
      } as ModelRegistry,
      measuredFrom: new Map(),
      errors: [],
    };
    const ledgerPath = freshLedger();
    const answer = getPlacementAdmit(
      process.cwd(),
      { model_id: 'inkling2-alias', client: 'byok-droid' },
      { loaded: offLoaded, ledgerPath },
    );
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('invalid_request');
    // No queue write: the hostile framing never becomes durable.
    expect(loadLedger(ledgerPath).pending.length).toBe(0);
  });

  it('an off-charset registry key asked DIRECTLY parks invalid_request too', () => {
    // The entry condition must not exempt a key just because the registry
    // happens to contain it: an off-charset key flows raw into
    // pending.requested_model and the attention title otherwise. It enters
    // the scan like any other id and parks either way (resolved or raw).
    const offLoaded = {
      registry: {
        ...wireRegistry,
        models: { 'Inkling 2': { ...registry.models['inkling2']!, advertises: ['inkling2-alias'] } },
      } as ModelRegistry,
      measuredFrom: new Map(),
      errors: [],
    };
    const ledgerPath = freshLedger();
    const answer = getPlacementAdmit(
      process.cwd(),
      { model_id: 'Inkling 2', client: 'byok-droid' },
      { loaded: offLoaded, ledgerPath },
    );
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('invalid_request');
    expect(loadLedger(ledgerPath).pending.length).toBe(0);
  });

  it('a non-resident wire-id park keys the pending entry by the REGISTRY id', () => {
    const ledgerPath = freshLedger(); // inkling not resident
    const answer = getPlacementAdmit(process.cwd(), wireAsk, { loaded: wireLoaded, ledgerPath });
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('not_resident'); // was invalid_request
    const entry = loadLedger(ledgerPath).pending[0]!;
    // The operator surface names registry keys — the entry must carry one.
    expect(entry.requested_model).toBe('inkling2');
    // And the wire-id ask dedupes against a registry-key ask (same entry).
    const byKey = getPlacementAdmit(
      process.cwd(),
      { model_id: 'inkling2', client: 'byok-droid' },
      { loaded: wireLoaded, ledgerPath },
    );
    expect(byKey.placement_id).toBe(answer.placement_id);
  });

  it('a vision ask via the wire id parks with the switch context keyed by the registry id', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(
      process.cwd(),
      { ...wireAsk, reason: 'vision_encoder_oom' },
      { loaded: wireLoaded, ledgerPath },
    );
    expect(answer.reason).toBe('vision_encoder_oom');
    const vision = loadLedger(ledgerPath).pending.find((p) => p.capability === 'vision')!;
    expect(vision.requested_model).toBe('inkling2');
  });

  it('an unregistered off-charset id still parks invalid_request — no ledger write', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(
      process.cwd(),
      { model_id: 'Inkling <script> 2 Mini', client: 'byok-droid' },
      { loaded: wireLoaded, ledgerPath },
    );
    // The injection property is unchanged: only registry-declared strings
    // resolve, and a hostile id parks before any durable write.
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('invalid_request');
    expect(loadLedger(ledgerPath).pending.length).toBe(0);
  });

  it('the attention ask carries the registry key, never the raw wire id', () => {
    delete process.env.UAP_ATTENTION_OFF;
    const ledgerPath = freshLedger(); // not resident → lingering park → ask
    getPlacementAdmit(dir, wireAsk, { loaded: wireLoaded, ledgerPath });
    const items = listAttention(dir);
    expect(items.length).toBe(1);
    // Charset-safe queue text: the wire id (with spaces) never reaches the
    // session-start prompt through the queue's trusted framing.
    expect(items[0]!.title).toBe('Placement parked: inkling2');
    expect(items[0]!.detail).toContain("'inkling2'");
  });

  it('a charset-safe ADVERTISED id resolves too — the exclusion math keys on registry ids', () => {
    // The class the API review flagged: "inkling2-mini-basalt-nvfp4" passes
    // the charset gate, so it previously flowed RAW — excludeReuseOf
    // compared it against candidate KEYS and no-oped, and a vision park on
    // a vision-marked arm could auto-"switch" back to itself. Uniform
    // resolution closes it: the alias resolves to the key.
    const cpuEncoderArm: ModelRegistry = {
      ...registry,
      models: {
        ...registry.models,
        'inkling2': { ...registry.models['inkling2']!, vision: 'cpu' },
      },
    };
    const cpuLoaded = { registry: cpuEncoderArm, measuredFrom: new Map(), errors: [] };
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(
      process.cwd(),
      { model_id: 'inkling2-mini-basalt-nvfp4', client: 'byok-droid', reason: 'vision_encoder_oom' },
      { loaded: cpuLoaded, ledgerPath },
    );
    expect(answer.reason).toBe('vision_encoder_oom');
    const vision = loadLedger(ledgerPath).pending.find((p) => p.capability === 'vision')!;
    expect(vision.requested_model).toBe('inkling2'); // the KEY, not the alias
    // The decisive regression: the starved arm is excluded from its own
    // resolution list (the raw alias would no-op the exclusion and offer
    // the arm's own reuse as the auto-switch).
    const options = optionsForPending(cpuEncoderArm, loadLedger(ledgerPath), vision).options;
    expect(options.every((o) => o.model !== 'inkling2' || o.kind !== 'reuse')).toBe(true);
  });

  it('a charset-safe advertised id forwards on the resident (plain ask)', () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(
      process.cwd(),
      { model_id: 'inkling2-mini-basalt-nvfp4', client: 'byok-droid' },
      { loaded: wireLoaded, ledgerPath },
    );
    expect(answer.decision).toBe('forward');
  });

  it('a charset-safe UNREGISTERED id keeps its unknown_model class', () => {
    // Uniform resolution must not swallow the class distinction: an id that
    // passes the charset gate but matches nothing the registry declares
    // parks as unknown_model (a placement decision), not invalid_request.
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(
      process.cwd(),
      { model_id: 'gpt-5-turbo', client: 'byok-droid' },
      { loaded: wireLoaded, ledgerPath },
    );
    expect(answer.decision).toBe('park');
    expect(answer.reason).toBe('unknown_model');
  });

  it('the AUTO path threads the resolved key — the switch enforces by registry id', async () => {
    // The mutation the suite could not catch pre-review: threading
    // request.model_id raw into scheduleAutoResolution/excludeReuseOf passes
    // every other test, but the auto run's step-0 re-derive keys on the wire
    // id and flags the switch as drift, and the no-oped exclusion offers the
    // starved arm's own reuse as the "switch" — full automation breaks for
    // wire-id asks only. Pinned here: the model named to the enforcement and
    // the capability context are the registry KEY, and the option picked is
    // the OTHER arm's displace, never the starved arm's own reuse.
    const ledgerPath = freshLedger([inklingResident()]);
    const policy: AutoPolicy = { enabled: true, allow_displace: ['basalt-fn'] };
    const enforce = vi.fn().mockResolvedValue({ ok: true, steps: [] });
    const answer = getPlacementAdmit(
      process.cwd(),
      { model_id: 'Inkling 2 Mini', client: 'byok-droid', reason: 'vision_encoder_oom' },
      { loaded: wireLoaded, ledgerPath, auto: { policy, enforce } },
    );
    expect(answer.reason).toBe('vision_auto_loading');
    await new Promise((r) => setTimeout(r, 20)); // scheduleAutoResolution yields a tick
    expect(enforce).toHaveBeenCalledTimes(1);
    expect(enforce).toHaveBeenCalledWith(
      expect.anything(), // the registry
      'inkling2', // the RESOLVED key — never the raw wire id
      expect.objectContaining({ kind: 'displace', model: 'basalt-fn' }),
      expect.objectContaining({ capability: 'vision', excludeReuseOf: 'inkling2' }),
    );
  });
});

describe('CLI: uap models pending/apply carry the vision switch context', () => {
  const visionAsk = { model_id: 'inkling2', client: 'byok-droid', reason: 'vision_encoder_oom' };
  const timeouts: EnforceTimeouts = { drainMs: 20, startMs: 20, freeMs: 20, pollMs: 1 };

  it('modelsApplyCommand resolves a vision park by switching arms (option 1 = the ranked switch)', async () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(process.cwd(), visionAsk, { loaded, ledgerPath });
    expect(answer.reason).toBe('vision_encoder_oom');
    const repoPath = join(dir, 'model-registry.json');
    writeFileSync(repoPath, JSON.stringify(registry));
    const { deps, started } = fakeDepsCli();
    const rc = await modelsApplyCommand({
      projectDir: process.cwd(),
      ledgerPath,
      repoPath,
      localPath: join(dir, 'no-local-overlay.json'),
      placementId: answer.placement_id,
      option: 1,
      yes: true,
      enforce: { repoPath, localPath: join(dir, 'no-local-overlay.json'), deps, timeouts },
    });
    expect(rc).toBe(0);
    // The SWITCH ran through the CLI path: starved arm stopped, the
    // vision-cpu arm started — a plain load of inkling2 would restart
    // the same unit instead.
    expect(started).toEqual(['uap-basalt-fn-server']);
    expect(loadLedger(ledgerPath).pending.length).toBe(0);
  });

  it('modelsApplyCommand refuses an out-of-range option without touching anything', async () => {
    const ledgerPath = freshLedger([inklingResident()]);
    const answer = getPlacementAdmit(process.cwd(), visionAsk, { loaded, ledgerPath });
    const repoPath = join(dir, 'model-registry.json');
    writeFileSync(repoPath, JSON.stringify(registry));
    const { deps, started } = fakeDepsCli();
    const rc = await modelsApplyCommand({
      projectDir: process.cwd(),
      ledgerPath,
      repoPath,
      localPath: join(dir, 'no-local-overlay.json'),
      placementId: answer.placement_id,
      option: 99,
      yes: true,
      enforce: { deps, timeouts },
    });
    expect(rc).toBe(1);
    expect(started).toEqual([]);
    expect(loadLedger(ledgerPath).pending.length).toBe(1);
  });

  // The resolve describe's fakeDeps, but with the switch pre-armed (the CLI
  // test's registry file pin lives in `dir`, which freshLedger re-mints).
  function fakeDepsCli(): { deps: EnforceDeps; started: string[] } {
    const started: string[] = [];
    const active = ['uap-basalt-inkling2-server'];
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
      gpuFreeMiB: () => (stopped ? 31505 : 505),
      inflightForTarget: async () => [],
      httpGetJson: async (url) =>
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
