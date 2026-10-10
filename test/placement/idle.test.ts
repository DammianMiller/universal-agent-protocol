/**
 * Idle-resident sweep (spec §4.4.2) — the consent-gated reverse of
 * auto-load: after the armed idle window with no gated use, an
 * `unload_allow`-listed resident is unloaded by the same machinery as
 * `uap models unload`. The tests pin the doctrine in order:
 *
 *  - OFF by default: no `unload_idle_after_secs` → the sweep is a no-op.
 *  - Consent per model: a resident not on `unload_allow` is never touched.
 *  - No clock yet → the sweep SEEDS it (arming can't evict a resident
 *    for being idle before the policy watched it).
 *  - Recently used → untouched.
 *  - Unknown endpoint state (ss can't answer) → REFUSED, never guessed.
 *  - Established connections (a client past the gate) → clock reset.
 *  - Idle + consented + quiet → unloadPlacement runs, with the unload
 *    refusal and a mid-sweep fault contained (never throws).
 *
 * Plus the policy parse for the new knobs and the admit-forward usage
 * touch that keeps the clock honest.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  sweepIdleResidents,
  idleUnloadArmed,
  resetIdleSweepForTests,
  IDLE_UNLOAD_COOLDOWN_MS,
} from '../../src/placement/idle.js';
import {
  loadAutoPolicy,
  saveAutoPolicy,
  MIN_UNLOAD_IDLE_SECS,
  type AutoPolicy,
} from '../../src/placement/auto.js';
import { withLedger, loadLedger, type PlacementLedger } from '../../src/placement/ledger.js';
import { getPlacementAdmit } from '../../src/dashboard/placement-routes.js';
import { loadModelRegistry, type ModelRegistry } from '../../src/placement/registry.js';
import type { EnforceResult } from '../../src/placement/enforce.js';

let dir: string;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  resetIdleSweepForTests(); // module-local cooldown map must not leak between cases
});

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'placement-idle-'));
  return dir;
}

const registry: ModelRegistry = {
  version: 1,
  devices: { gpu0: { kind: 'gpu', total_mib: 24576, reserved_mib: 1293 } },
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

function seededLedger(path: string, model = 'qwen3.8-flash-next', endpoint = 'http://192.168.1.165:8080/v1'): void {
  withLedger(path, (l: PlacementLedger) => {
    l.residents.push({
      model,
      config: 'strata-iq3_s',
      device: 'gpu0',
      endpoint,
      state: 'hot',
      holders: [],
      since: new Date().toISOString(),
    });
  });
}

const armedPolicy = (over: Partial<AutoPolicy> = {}): AutoPolicy => ({
  enabled: true,
  allow_displace: [],
  unload_idle_after_secs: 60,
  unload_allow: ['qwen3.8-flash-next'],
  ...over,
});

const okUnload = async (): Promise<EnforceResult> => ({ ok: true, steps: [] });
const refusedUnload = async (): Promise<EnforceResult> => ({
  ok: false,
  steps: [{ step: 'drain', ok: false, detail: 'in-flight generation' }],
});
const noConns = (): number => 0;
const busyConns = (): number => 2;
const unknownConns = (): number | null => null;

describe('idle-unload policy parse (§4.4.2)', () => {
  it('a pre-§4.4.2 policy loads to its exact old shape (no phantom knobs)', () => {
    const d = freshDir();
    const path = join(d, 'policy.json');
    writeFileSync(path, '{"enabled": true, "allow_displace": ["m-27b"]}');
    expect(loadAutoPolicy(path)).toEqual({ enabled: true, allow_displace: ['m-27b'] });
  });

  it('round-trips the idle knobs', () => {
    const d = freshDir();
    const path = join(d, 'policy.json');
    saveAutoPolicy(armedPolicy(), path);
    expect(loadAutoPolicy(path)).toEqual(armedPolicy());
  });

  it('an idle window under the floor is dropped (fail-closed to off); a non-array allowlist is dropped too', () => {
    const d = freshDir();
    const path = join(d, 'policy.json');
    writeFileSync(path, '{"enabled": true, "allow_displace": [], "unload_idle_after_secs": 5, "unload_allow": ["m"]}');
    const underFloor = loadAutoPolicy(path);
    expect(underFloor.unload_idle_after_secs).toBeUndefined(); // under the floor → the timer is off
    expect(underFloor.unload_allow).toEqual(['m']); // a VALID allowlist survives the bad timer
    writeFileSync(path, '{"enabled": true, "allow_displace": [], "unload_idle_after_secs": 300, "unload_allow": "m"}');
    const badList = loadAutoPolicy(path);
    expect(badList.unload_idle_after_secs).toBe(300); // a valid timer survives the bad allowlist
    expect(badList.unload_allow).toBeUndefined(); // non-array → dropped
  });

  it('idleUnloadArmed requires window, floor, and consent — all three', () => {
    expect(idleUnloadArmed(armedPolicy())).toBe(true);
    expect(idleUnloadArmed(armedPolicy({ unload_idle_after_secs: undefined }))).toBe(false);
    expect(idleUnloadArmed(armedPolicy({ unload_allow: [] }))).toBe(false);
    expect(idleUnloadArmed(armedPolicy({ unload_idle_after_secs: MIN_UNLOAD_IDLE_SECS - 1 }))).toBe(false);
  });
});

describe('sweepIdleResidents', () => {
  it('is a NO-OP when the policy does not arm it (no idle window, or no allowlist)', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    const calls: string[] = [];
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: { enabled: true, allow_displace: [] }, // no unload knobs
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual([]);
    expect(result.unloaded).toEqual([]);
    const result2 = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy({ unload_allow: [] }), // window but nobody consented
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual([]);
    expect(result2.unloaded).toEqual([]);
  });

  it('never touches a resident that is not on the unload allowlist', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath, 'qwen3.8-flash-next');
    // usage long past — without consent this must not matter
    withLedger(ledgerPath, (l) => { l.usage['qwen3.8-flash-next'] = Date.now() - 3_600_000; });
    const calls: string[] = [];
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy({ unload_allow: ['some-other-model'] }),
      establishedConns: noConns,
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual([]);
    expect(result.unloaded).toEqual([]);
  });

  it('seeds the clock on first observation instead of evicting (no usage record)', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    const calls: string[] = [];
    const before = Date.now();
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual([]);
    const after = loadLedger(ledgerPath);
    expect(after.usage['qwen3.8-flash-next']).toBeGreaterThanOrEqual(before);
    // The seeded clock survives a sweepLedger-style resident rebuild too:
    // the next sweep uses the seed, not a fresh one.
    const result2 = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual([]);
    expect(result2.unloaded).toEqual([]);
  });

  it('skips a recently used resident (the gated usage clock works)', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    withLedger(ledgerPath, (l) => { l.usage['qwen3.8-flash-next'] = Date.now() - 10_000; });
    const calls: string[] = [];
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual([]);
    expect(result.unloaded).toEqual([]);
  });

  it('REFUSES to unload when the endpoint state is unknown (ss cannot answer)', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    withLedger(ledgerPath, (l) => { l.usage['qwen3.8-flash-next'] = Date.now() - 3_600_000; });
    const calls: string[] = [];
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: unknownConns,
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual([]);
    expect(result.unloaded).toEqual([]);
  });

  it('resets the clock for established connections (a client past the gate)', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    const stale = Date.now() - 3_600_000;
    withLedger(ledgerPath, (l) => { l.usage['qwen3.8-flash-next'] = stale; });
    const calls: string[] = [];
    const before = Date.now();
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: busyConns,
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual([]);
    expect(result.unloaded).toEqual([]);
    expect(result.deferred).toEqual(['qwen3.8-flash-next']);
    expect(loadLedger(ledgerPath).usage['qwen3.8-flash-next']).toBeGreaterThanOrEqual(before);
  });

  it('unloads an idle, consented, quiet resident through unloadPlacement', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    withLedger(ledgerPath, (l) => { l.usage['qwen3.8-flash-next'] = Date.now() - 3_600_000; });
    const calls: string[] = [];
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: async (p, m) => { calls.push([p, m].join(':')); return okUnload(); },
    });
    expect(calls).toEqual([`${d}:qwen3.8-flash-next`]);
    expect(result.unloaded).toEqual(['qwen3.8-flash-next']);
  });

  it('records a refused unload (in-flight generation) and never throws; a mid-sweep fault is contained too', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    withLedger(ledgerPath, (l) => { l.usage['qwen3.8-flash-next'] = Date.now() - 3_600_000; });
    const refused = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: refusedUnload,
    });
    expect(refused.unloaded).toEqual([]);
    const threw = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: async () => { throw new Error('systemd exploded'); },
    });
    expect(threw.unloaded).toEqual([]);
  });

  it('skips draining residents (a swap is in flight — not the sweep\'s business)', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    withLedger(ledgerPath, (l) => {
      l.residents.push({
        model: 'qwen3.8-flash-next',
        config: 'strata-iq3_s',
        device: 'gpu0',
        endpoint: 'http://192.168.1.165:8080/v1',
        state: 'draining',
        holders: [],
        since: new Date().toISOString(),
      });
      l.usage['qwen3.8-flash-next'] = Date.now() - 3_600_000;
    });
    const calls: string[] = [];
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual([]);
    expect(result.checked).toBe(0); // draining is not even examined
  });

  it('skips any non-hot resident state (future warming/paused states are never a guess)', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    // warming is not produced by any current writer; cast through the same
    // push the fixtures use so the schema evolution is exercised anyway.
    withLedger(ledgerPath, (l) => {
      l.residents.push({
        model: 'qwen3.8-flash-next',
        config: 'strata-iq3_s',
        device: 'gpu0',
        endpoint: 'http://192.168.1.165:8080/v1',
        state: 'warming',
        holders: [],
        since: new Date().toISOString(),
      } as Parameters<typeof l.residents.push>[0]);
      l.usage['qwen3.8-flash-next'] = Date.now() - 3_600_000;
    });
    const calls: string[] = [];
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual([]);
    expect(result.checked).toBe(0);
  });

  it('skips a model with a non-expired pending entry (demand exists — never race the park/auto-load)', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    withLedger(ledgerPath, (l) => {
      l.usage['qwen3.8-flash-next'] = Date.now() - 3_600_000;
      l.pending.push({
        id: 'plc-1',
        requested_model: 'qwen3.8-flash-next',
        client: 'claude-code',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        reason: 'auto_loading',
      });
    });
    const calls: string[] = [];
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual([]);
    expect(result.unloaded).toEqual([]);
  });

  it('proceeds once the pending entry has EXPIRED (stale demand is not demand)', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    withLedger(ledgerPath, (l) => {
      l.usage['qwen3.8-flash-next'] = Date.now() - 3_600_000;
      l.pending.push({
        id: 'plc-2',
        requested_model: 'qwen3.8-flash-next',
        client: 'claude-code',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() - 1_000).toISOString(),
        reason: 'not_resident',
      });
    });
    const calls: string[] = [];
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(calls).toEqual(['qwen3.8-flash-next']);
    expect(result.unloaded).toEqual(['qwen3.8-flash-next']);
  });

  it('a successful unload CLEARS the usage entry — a reload gets a fresh window, not a stale clock', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    withLedger(ledgerPath, (l) => { l.usage['qwen3.8-flash-next'] = Date.now() - 3_600_000; });
    const calls: string[] = [];
    const result = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: async (p, m) => { calls.push(m); return okUnload(); },
    });
    expect(result.unloaded).toEqual(['qwen3.8-flash-next']);
    expect(calls).toEqual(['qwen3.8-flash-next']);
    expect(loadLedger(ledgerPath).usage['qwen3.8-flash-next']).toBeUndefined();
  });

  it('prunes usage residue for models with no live resident', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    withLedger(ledgerPath, (l) => {
      l.usage['model-long-gone'] = Date.now() - 10 * 3_600_000;
      l.usage['model-live'] = Date.now();
      l.residents.push({
        model: 'model-live',
        config: 'cfg',
        device: 'gpu0',
        endpoint: 'http://127.0.0.1:8080/v1',
        state: 'hot',
        holders: [],
        since: new Date().toISOString(),
      });
    });
    await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy({ unload_allow: ['model-live'] }),
      establishedConns: noConns,
      unload: okUnload,
    });
    const usage = loadLedger(ledgerPath).usage;
    expect(usage['model-long-gone']).toBeUndefined();
    expect(usage['model-live']).toBeGreaterThan(0);
  });

  it('a refused unload parks the model in a failure cooldown; a later success clears it', async () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    withLedger(ledgerPath, (l) => { l.usage['qwen3.8-flash-next'] = Date.now() - 3_600_000; });
    let attempts = 0;
    const countingUnload = async (): Promise<EnforceResult> => {
      attempts += 1;
      return attempts === 1 ? refusedUnload() : okUnload();
    };
    // Tick 1: refused → cooldown armed, nothing unloaded.
    const t1 = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: countingUnload,
    });
    expect(t1.unloaded).toEqual([]);
    expect(attempts).toBe(1);
    // Tick 2 (same wall clock): cooldown active → the sweep does not even
    // try; a churn cycle would otherwise drain/stop the backend every 60s.
    const t2 = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: countingUnload,
    });
    expect(t2.unloaded).toEqual([]);
    expect(attempts).toBe(1); // still just the one attempt
    // Tick 3 after the cooldown lapses: tries again, succeeds, and the
    // cooldown is cleared (a later refuse would re-arm it from scratch).
    const future = (): number => Date.now() + IDLE_UNLOAD_COOLDOWN_MS + 1_000;
    const t3 = await sweepIdleResidents(d, {
      ledgerPath,
      policy: armedPolicy(),
      establishedConns: noConns,
      unload: countingUnload,
      now: future,
    });
    expect(attempts).toBe(2);
    expect(t3.unloaded).toEqual(['qwen3.8-flash-next']);
  });
});

describe('admit forward touches the usage clock', () => {
  it('a gated forward records last-used for the resident model', () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    seededLedger(ledgerPath);
    const loaded = loadModelRegistry('', { repoPath: '', localPath: join(d, 'absent.json') });
    const before = Date.now();
    const answer = getPlacementAdmit(d, { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, {
      loaded: { ...loaded, registry, measuredFrom: new Map(), errors: [] },
      ledgerPath,
    });
    expect(answer.decision).toBe('forward');
    expect(loadLedger(ledgerPath).usage['qwen3.8-flash-next']).toBeGreaterThanOrEqual(before);
  });

  it('a park does NOT touch the clock — only a served forward counts as use', () => {
    const d = freshDir();
    const ledgerPath = join(d, 'placement.json');
    // No resident: the request parks (reason not_resident).
    const loaded = loadModelRegistry('', { repoPath: '', localPath: join(d, 'absent.json') });
    const answer = getPlacementAdmit(d, { model_id: 'qwen3.8-flash-next-iq3_s', client: 'claude-code' }, {
      loaded: { ...loaded, registry, measuredFrom: new Map(), errors: [] },
      ledgerPath,
    });
    expect(answer.decision).toBe('park');
    expect(loadLedger(ledgerPath).usage).toEqual({});
  });
});
