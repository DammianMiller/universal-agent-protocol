/**
 * Placement enforcement (spec §4.6) — the operator-approved swap sequence,
 * exercised against injectable deps: happy path, drift abort, drain timeout,
 * VRAM-not-back, failed start, rollback completeness (step 8 — the test the
 * spec demands: "The rollback must be exercised in tests against a
 * simulated failed start, not only in the success path"), reuse, load's
 * no-displacement rule, dismiss, and the Conflicts= drop-in writer.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  enforceOption,
  resolvePendingPlacement,
  dismissPendingPlacement,
  loadPlacement,
  unloadPlacement,
  writePlacementUnitDropins,
  type EnforceDeps,
  type EnforceTimeouts,
  type PlacementInflightEntry,
} from '../../src/placement/enforce.js';
import type { PlacementOption } from '../../src/placement/admission.js';
import { loadLedger, withLedger, type LedgerResident } from '../../src/placement/ledger.js';
import { loadModelRegistry, type ModelRegistry } from '../../src/placement/registry.js';

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
      endpoint: 'http://127.0.0.1:8080',
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
      endpoint: 'http://127.0.0.1:8080',
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

const timeouts: EnforceTimeouts = { drainMs: 20, startMs: 20, freeMs: 20, pollMs: 1 };

interface FakeOpts {
  active?: string[];
  inflight?: Record<string, number>;
  /** Targets whose in-flight view is UNKNOWN (proxy did not answer). */
  inflightUnknown?: boolean;
  freeBefore?: number;
  freeAfter?: number;
  serveIds?: string[];
  startFailsFor?: string;
  stopFailsFor?: string;
  healthOk?: boolean;
}

interface FakeCalls {
  stop: string[];
  start: string[];
  refresh: number;
}

function fakeDeps(o: FakeOpts = {}): { deps: EnforceDeps; calls: FakeCalls; active: string[] } {
  const active = o.active ? [...o.active] : [];
  const calls: FakeCalls = { stop: [], start: [], refresh: 0 };
  let stopped = false;
  let clock = 0;
  const deps: EnforceDeps = {
    isUnitActive: (u) => active.includes(u),
    stopUnit: async (u) => {
      if (o.stopFailsFor === u) throw new Error(`simulated stop failure: ${u}`);
      calls.stop.push(u);
      stopped = true;
      active.splice(active.indexOf(u), 1);
    },
    startUnit: async (u) => {
      if (o.startFailsFor === u) throw new Error(`simulated start failure: ${u}`);
      calls.start.push(u);
      active.push(u);
    },
    gpuFreeMiB: () => (stopped ? (o.freeAfter ?? 23000) : o.freeBefore ?? 1000),
    inflightForTarget: async (t) => {
      // Unknown (null) is the fail-closed answer: a proxy restart mid-drain
      // or a token mismatch must never read as "idle".
      if (o.inflightUnknown) return null;
      return Array.from({ length: o.inflight?.[t] ?? 0 }, () => ({}) as PlacementInflightEntry);
    },
    httpGetJson: async (url) => {
      if (url.endsWith('/health')) return o.healthOk === false ? null : { status: 'ok' };
      return { data: (o.serveIds ?? ['qwen3.8-27b-mtp', 'qwen3.8-flash-next-iq3_s']).map((id) => ({ id })) };
    },
    refreshProxy: async () => {
      calls.refresh += 1;
      return true;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    nowMs: () => clock,
  };
  return { deps, calls, active };
}

let dir: string;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshEnv(): { dir: string; ledgerPath: string; repoPath: string } {
  dir = mkdtempSync(join(tmpdir(), 'placement-enforce-'));
  const ledgerPath = join(dir, 'placement.json');
  const repoPath = join(dir, 'model-registry.json');
  writeFileSync(repoPath, JSON.stringify(registry));
  return { dir, ledgerPath, repoPath };
}

function resident(model: string, config: string, unit: string, gpuMib: number): LedgerResident {
  return {
    model, config, device: 'gpu0', unit, state: 'hot',
    gpu_mib: gpuMib, host_rss_mib: 52857, holders: [], since: '2026-10-08T09:14:02Z',
  };
}

function park(ledgerPath: string, id: string, model: string): void {
  withLedger(ledgerPath, (l) => {
    l.devices = {
      gpu0: { kind: 'gpu', total_mib: 24576, free_mib: 1000, reserved_mib: 1293, source: 'nvidia-smi' },
      cpu0: { kind: 'cpu', total_mib: 126944, free_mib: 60000, reserved_mib: 8192, source: 'MemAvailable' },
    };
    l.residents.push(resident('qwen3.8-flash-next', 'strata-iq3_s', 'uap-strata-server', 21812));
    l.pending.push({
      id,
      requested_model: model,
      client: 'claude-code',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      reason: 'not_resident',
    });
  });
}

function optsFor(env: { ledgerPath: string; repoPath: string }, deps: EnforceDeps) {
  // One seam: unit activity rides on deps.isUnitActive (the fake's mutable
  // active list), not a second injectable predicate.
  return { ledgerPath: env.ledgerPath, repoPath: env.repoPath, deps, timeouts };
}

describe('placement enforcement', () => {
  it('reuse resolves the pending entry and touches no units', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-aaaaaa', 'qwen3.8-flash-next-iq3_s');
    const { deps, calls } = fakeDeps({ active: ['uap-strata-server'] });
    const result = await resolvePendingPlacement(env.dir, 'plc-aaaaaa', 1, {
      ...optsFor(env, deps),
    });
    expect(result.ok).toBe(true);
    expect(calls.stop).toEqual([]);
    expect(calls.start).toEqual([]);
    expect(loadLedger(env.ledgerPath).pending).toEqual([]);
  });

  it('displace happy path: drain, stop, verify-free, start, verify-up, refresh, resolve', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-bbbbbb', 'qwen3.8-27b-mtp');
    const { deps, calls } = fakeDeps({ active: ['uap-strata-server'] });
    const result = await resolvePendingPlacement(env.dir, 'plc-bbbbbb', 1, {
      ...optsFor(env, deps),
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual([
      'revalidate', 'mark-draining', 'drain', 'stop', 'verify-free', 'start', 'verify-up', 'refresh-proxy', 'resolve',
    ]);
    expect(calls.stop).toEqual(['uap-strata-server']);
    expect(calls.start).toEqual(['uap-llama-server']);
    expect(calls.refresh).toBe(1);
    expect(loadLedger(env.ledgerPath).pending).toEqual([]);
    // The ledger re-derived: the new resident is what runs now.
    expect(loadLedger(env.ledgerPath).residents.map((r) => `${r.model}/${r.config}`)).toEqual(['qwen3.8-27b/llama-mtp']);
  });

  it('victim-set drift aborts before touching anything', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-cccccc', 'qwen3.8-27b-mtp');
    // The operator approved DISPLACING strata (as `pending` printed it with
    // strata resident). By enforcement time the world moved: no displace
    // option exists any more (load-alongside fits with the victim gone), so
    // the approved option is re-derived away → abort, never act on it.
    const approved: PlacementOption = {
      kind: 'displace',
      model: 'qwen3.8-27b',
      config: 'llama-mtp',
      device: 'gpu0',
      cost_mib: 15200,
      victims: [resident('qwen3.8-flash-next', 'strata-iq3_s', 'uap-strata-server', 21812)],
    };
    const { deps, calls } = fakeDeps({ active: [] });
    const result = await enforceOption(
      loadModelRegistry(env.dir, { repoPath: env.repoPath }).registry,
      'qwen3.8-27b-mtp',
      approved,
      optsFor(env, deps),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('drift');
    expect(calls.stop).toEqual([]);
    expect(calls.start).toEqual([]);
    // The pending entry survives an abort.
    expect(loadLedger(env.ledgerPath).pending.length).toBe(1);
  });

  it('drain timeout rolls back with nothing stopped', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-dddddd', 'qwen3.8-27b-mtp');
    // The victim's target id is device:endpoint — the synced resident carries
    // the registry model's endpoint.
    const { deps, calls } = fakeDeps({ active: ['uap-strata-server'], inflight: { 'gpu0:http://127.0.0.1:8080': 1 } });
    const result = await resolvePendingPlacement(env.dir, 'plc-dddddd', 1, {
      ...optsFor(env, deps),
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('drain failed');
    expect(calls.stop).toEqual([]); // never stopped anything
  });

  it('VRAM did not come back → rollback restarts the victims', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-eeeeee', 'qwen3.8-27b-mtp');
    const { deps, calls } = fakeDeps({ active: ['uap-strata-server'], freeAfter: 1200 });
    const result = await resolvePendingPlacement(env.dir, 'plc-eeeeee', 1, {
      ...optsFor(env, deps),
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('VRAM did not come back');
    expect(calls.stop).toEqual(['uap-strata-server']);
    // Rollback restarted the victim; the new unit was never started.
    expect(calls.start).toEqual(['uap-strata-server']);
  });

  it('failed start rolls back and reports the steps (spec step 8)', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-ffffff', 'qwen3.8-27b-mtp');
    const { deps, calls } = fakeDeps({ active: ['uap-strata-server'], startFailsFor: 'uap-llama-server' });
    const result = await resolvePendingPlacement(env.dir, 'plc-ffffff', 1, {
      ...optsFor(env, deps),
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    const rollbackStep = result.steps.find((s) => s.name === 'rollback');
    expect(rollbackStep?.ok).toBe(true);
    expect(calls.start).toEqual(['uap-strata-server']); // victim restarted, new unit failed
    // The pending entry survives a failed enforcement.
    expect(loadLedger(env.ledgerPath).pending.length).toBe(1);
  });

  it('load refuses when only displacement would fit (displacement needs the pending path)', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-123456', 'qwen3.8-27b-mtp');
    const { deps } = fakeDeps({ active: ['uap-strata-server'] });
    const result = await loadPlacement(env.dir, 'qwen3.8-27b-mtp', optsFor(env, deps));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('non-displacing');
  });

  it('dismiss removes the parked request', () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-987654', 'qwen3.8-27b-mtp');
    expect(dismissPendingPlacement('plc-987654', { ledgerPath: env.ledgerPath }).dismissed).toBe(true);
    expect(loadLedger(env.ledgerPath).pending).toEqual([]);
    expect(dismissPendingPlacement('plc-987654', { ledgerPath: env.ledgerPath }).dismissed).toBe(false);
  });

  it('a pending request with no viable option refuses cleanly', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-nnnnnn', 'gpt-99');
    const { deps, calls } = fakeDeps({ active: ['uap-strata-server'] });
    const result = await resolvePendingPlacement(env.dir, 'plc-nnnnnn', 1, optsFor(env, deps));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('option 1 does not exist');
    expect(calls.stop).toEqual([]);
  });

  it('verify-up failure: rollback STOPS the started unit too (no two same-device residents)', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-uuuuuu', 'qwen3.8-27b-mtp');
    // The unit starts fine but never advertises the requested id.
    const { deps, calls } = fakeDeps({ active: ['uap-strata-server'], serveIds: ['something-else'] });
    const result = await resolvePendingPlacement(env.dir, 'plc-uuuuuu', 1, optsFor(env, deps));
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    // The victim was stopped, the new unit started, then rollback stopped the
    // new unit AND restarted the victim — leaving the new unit running would
    // leave two same-device residents (VRAM oversubscribed).
    expect(calls.stop).toEqual(['uap-strata-server', 'uap-llama-server']);
    expect(calls.start).toEqual(['uap-llama-server', 'uap-strata-server']);
  });

  it('in-flight view UNAVAILABLE (proxy did not answer) is BUSY, never "drained" (fail-closed)', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-kkkkkk', 'qwen3.8-27b-mtp');
    const { deps, calls } = fakeDeps({ active: ['uap-strata-server'], inflightUnknown: true });
    const result = await resolvePendingPlacement(env.dir, 'plc-kkkkkk', 1, optsFor(env, deps));
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('in-flight view unavailable');
    expect(calls.stop).toEqual([]); // never stopped anything on a guess
  });

  it('unload: drain, stop, verify-free, refresh — and a stop failure rolls back, never throws raw', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-unused', 'qwen3.8-flash-next-iq3_s');
    // Happy path first: the fake's active list keeps the ledger honest.
    const { deps, calls } = fakeDeps({ active: ['uap-strata-server'] });
    const result = await unloadPlacement(env.dir, 'qwen3.8-flash-next', optsFor(env, deps));
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual([
      'mark-draining', 'drain', 'stop', 'verify-free', 'refresh-proxy',
    ]);
    expect(calls.stop).toEqual(['uap-strata-server']);
    expect(loadLedger(env.ledgerPath).residents).toEqual([]);
  });

  it('unload: a stop failure reports FAIL and rolls back instead of throwing', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-unused2', 'qwen3.8-flash-next-iq3_s');
    const { deps, calls } = fakeDeps({
      active: ['uap-strata-server'],
      stopFailsFor: 'uap-strata-server',
    });
    const result = await unloadPlacement(env.dir, 'qwen3.8-flash-next', optsFor(env, deps));
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('stopping uap-strata-server failed');
    // Nothing was left marked draining by the failure path (rollback synced).
    expect(loadLedger(env.ledgerPath).residents.every((r) => r.state !== 'draining')).toBe(true);
    expect(calls.start).toEqual([]);
  });

  it('the approval signature: enforced victims must match the impact list the operator saw', async () => {
    const env = freshEnv();
    park(env.ledgerPath, 'plc-ssssss', 'qwen3.8-27b-mtp');
    const { deps, calls } = fakeDeps({ active: ['uap-strata-server'] });
    // Wrong signature (stale preview): refuse BEFORE enforcing anything.
    const stale = await resolvePendingPlacement(env.dir, 'plc-ssssss', 1, {
      ...optsFor(env, deps),
      expectedVictims: [{ model: 'qwen3.8-flash-next', config: 'some-other-config' }],
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain('victim set changed');
    expect(calls.stop).toEqual([]);
    expect(loadLedger(env.ledgerPath).pending.length).toBe(1);
    // Correct signature: enforces.
    const good = await resolvePendingPlacement(env.dir, 'plc-ssssss', 1, {
      ...optsFor(env, deps),
      expectedVictims: [{ model: 'qwen3.8-flash-next', config: 'strata-iq3_s' }],
    });
    expect(good.ok).toBe(true);
    expect(loadLedger(env.ledgerPath).pending).toEqual([]);
  });
});

describe('placement unit drop-ins (Conflicts= edges)', () => {
  it('same-device units conflict with each other; unit names gain .service', () => {
    const unitsDir = join(mkdtempSync(join(tmpdir(), 'placement-units-')), 'user');
    const { written } = writePlacementUnitDropins(registry, { userUnitsDir: unitsDir });
    expect(written.length).toBe(2);
    const strata = readFileSync(join(unitsDir, 'uap-strata-server.service.d', '50-uap-placement.conf'), 'utf-8');
    expect(strata).toContain('Conflicts=uap-llama-server.service');
    expect(strata).not.toContain('uap-strata-server.service'); // never conflicts with itself
    const llama = readFileSync(join(unitsDir, 'uap-llama-server.service.d', '50-uap-placement.conf'), 'utf-8');
    expect(llama).toContain('Conflicts=uap-strata-server.service');
    // Drop-ins only: no unit files are authored.
    expect(existsSync(join(unitsDir, 'uap-strata-server.service'))).toBe(false);
  });

  it('units on different devices do not conflict, and stale drop-ins are removed (reconciled)', () => {
    const unitsDir = join(mkdtempSync(join(tmpdir(), 'placement-units2-')), 'user');
    const split: ModelRegistry = {
      ...registry,
      models: {
        'qwen3.8-flash-next': { ...registry.models['qwen3.8-flash-next'], affinity: { device: ['gpu0'] } },
        'qwen3.8-27b': { ...registry.models['qwen3.8-27b'], affinity: { device: ['gpu1'] } },
      },
    };
    // First: the conflicting registry writes both drop-ins.
    writePlacementUnitDropins(registry, { userUnitsDir: unitsDir });
    expect(existsSync(join(unitsDir, 'uap-strata-server.service.d', '50-uap-placement.conf'))).toBe(true);
    // Then the registry changes (no shared device): the orphan Conflicts=
    // must be REMOVED, not left to brick a legitimate future start.
    const { written, removed } = writePlacementUnitDropins(split, { userUnitsDir: unitsDir });
    expect(written).toEqual([]);
    expect(removed.length).toBe(2);
    expect(existsSync(join(unitsDir, 'uap-strata-server.service.d', '50-uap-placement.conf'))).toBe(false);
  });

  it('a malicious registry unit name never reaches a path or drop-in content (fail-closed)', () => {
    const unitsDir = join(mkdtempSync(join(tmpdir(), 'placement-units3-')), 'user');
    // Path traversal and line injection, both through the registry (which a
    // cloned repo can ship in config/model-registry.json).
    for (const unit of ['../evil', 'uap-evil\n[Service]\nExecStart=/tmp/evil', 'uap/evil']) {
      const poisoned: ModelRegistry = {
        ...registry,
        models: {
          'qwen3.8-27b': { ...registry.models['qwen3.8-27b'], unit },
        },
      };
      expect(() => writePlacementUnitDropins(poisoned, { userUnitsDir: unitsDir })).toThrow(/invalid unit name/);
    }
    // And the registry LOADER rejects the same names before they ever load.
    const env = freshEnv();
    const poisonedPath = join(env.dir, 'bad-registry.json');
    writeFileSync(
      poisonedPath,
      JSON.stringify({
        models: {
          'qwen3.8-27b': {
            display: 'Qwen3.8 27B',
            unit: 'uap-evil\n[Service]\nExecStart=/tmp/evil',
            affinity: { device: ['gpu0'] },
            configs: {},
          },
        },
      }),
    );
    // And the registry LOADER fails closed on the same names: the error is
    // recorded and the poisoned model never merges into the live view.
    const loadedBad = loadModelRegistry(env.dir, {
      repoPath: poisonedPath,
      localPath: join(env.dir, 'none.json'),
    });
    expect(loadedBad.errors.some((e) => e.includes('invalid systemd unit name'))).toBe(true);
    expect(loadedBad.registry.models['qwen3.8-27b']).toBeUndefined();
  });
});
