/**
 * Placement auto-resolution (spec §4.4.1, phase 4): the fail-closed policy,
 * the option pick (runnability gates included), and the background
 * enforcement — ONE run per requested model, single-flight machine-wide,
 * pending resolved on success, auto_failed + cooldown on failure, and the
 * run NEVER rejects (a ledger-write throw must not kill the controller).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  autoOptionFor,
  loadAutoPolicy,
  saveAutoPolicy,
  scheduleAutoResolution,
  autoPolicyPath,
  resetAutoSchedulerForTests,
  DEFAULT_AUTO_POLICY,
} from '../../src/placement/auto.js';
import {
  withLedger,
  loadLedger,
  placementLedgerPath,
  acquireLedgerLock,
  releaseLedgerLock,
} from '../../src/placement/ledger.js';
import type { PlacementOption } from '../../src/placement/admission.js';
import type { ModelRegistry } from '../../src/placement/registry.js';
import type { EnforceResult } from '../../src/placement/enforce.js';

let dir: string;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  resetAutoSchedulerForTests(); // process-local maps must not leak between cases
});

const registry: ModelRegistry = {
  version: 1,
  devices: { gpu0: { kind: 'gpu', total_mib: 24576, reserved_mib: 1293 } },
  models: {},
};

const option = (kind: 'reuse' | 'load_alongside' | 'displace', model: string): PlacementOption => ({
  kind,
  model,
  config: 'cfg',
  device: 'gpu0',
  cost_mib: 1000,
  victims: [],
});

const seededPending = (ledgerPath: string, id: string, model: string): void => {
  withLedger(ledgerPath, (l) => {
    l.pending.push({
      id,
      requested_model: model,
      client: 'claude-code',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      reason: 'auto_loading',
    });
  });
};

describe('auto policy', () => {
  it('defaults to DISABLED when the policy file is missing (opt-in, fail-closed)', () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    expect(loadAutoPolicy(join(dir, 'absent.json'))).toEqual(DEFAULT_AUTO_POLICY);
    expect(DEFAULT_AUTO_POLICY.enabled).toBe(false);
    expect(DEFAULT_AUTO_POLICY.allow_displace).toEqual([]);
  });

  it('a corrupt policy file fails closed to disabled, never a guess', () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const path = join(dir, 'policy.json');
    writeFileSync(path, '{ not json');
    expect(loadAutoPolicy(path)).toEqual({ enabled: false, allow_displace: [] });
  });

  it('wrong-TYPED fields fail closed too (string "true", non-array allowlist, numeric enabled)', () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const path = join(dir, 'policy.json');
    writeFileSync(path, '{"enabled": "true", "allow_displace": "m"}');
    expect(loadAutoPolicy(path)).toEqual({ enabled: false, allow_displace: [] });
    writeFileSync(path, '{"enabled": 1}');
    expect(loadAutoPolicy(path)).toEqual({ enabled: false, allow_displace: [] });
  });

  it('save/load round-trips the allowlist', () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const path = join(dir, 'policy.json');
    saveAutoPolicy({ enabled: true, allow_displace: ['qwen3.8-27b'] }, path);
    expect(loadAutoPolicy(path)).toEqual({ enabled: true, allow_displace: ['qwen3.8-27b'] });
  });

  it('the policy path honors the UAP_PLACEMENT_AUTO env override', () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const override = join(dir, 'override.json');
    const prev = process.env.UAP_PLACEMENT_AUTO;
    try {
      process.env.UAP_PLACEMENT_AUTO = override;
      expect(autoPolicyPath()).toBe(override);
      // The production default is the operator home file.
      delete process.env.UAP_PLACEMENT_AUTO;
      expect(autoPolicyPath()).toContain(join('.uap', 'placement-auto.json'));
    } finally {
      if (prev === undefined) delete process.env.UAP_PLACEMENT_AUTO;
      else process.env.UAP_PLACEMENT_AUTO = prev;
    }
  });
});

describe('autoOptionFor', () => {
  it('disabled policy: never auto-loads, not even alongside', () => {
    expect(autoOptionFor([option('load_alongside', 'm')], { enabled: false, allow_displace: [] }, 'm')).toBeNull();
  });

  it('enabled: prefers the non-displacing option (nothing evicted)', () => {
    const pick = autoOptionFor(
      [option('displace', 'm'), option('load_alongside', 'm')],
      { enabled: true, allow_displace: ['m'] },
      'm',
    );
    expect(pick?.kind).toBe('load_alongside');
  });

  it('displacement only for allowlisted models; otherwise it parks for the operator', () => {
    expect(autoOptionFor([option('displace', 'm')], { enabled: true, allow_displace: [] }, 'm')).toBeNull();
    expect(autoOptionFor([option('displace', 'm')], { enabled: true, allow_displace: ['other'] }, 'm')).toBeNull();
    const pick = autoOptionFor([option('displace', 'm')], { enabled: true, allow_displace: ['m'] }, 'm');
    expect(pick?.kind).toBe('displace');
  });

  it('no options at all (unmeasured): never auto-loads', () => {
    expect(autoOptionFor([], { enabled: true, allow_displace: ['m'] }, 'm')).toBeNull();
  });

  it('a model whose run is IN FLIGHT is not re-picked (rotated client ids mint no second run)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const ledgerPath = join(dir, 'placement.json');
    seededPending(ledgerPath, 'plc-cccccc', 'm');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = async (): Promise<EnforceResult> => {
      await gate;
      return { ok: true, steps: [] };
    };
    scheduleAutoResolution(registry, 'm', option('load_alongside', 'm'), 'plc-cccccc', {
      ledgerPath,
      enforce: slow,
    });
    await new Promise((r) => setTimeout(r, 10)); // the run registers
    // The same model parks for the operator while its run is alive — no
    // matter which client id (or placement id) asks again.
    expect(autoOptionFor([option('load_alongside', 'm')], { enabled: true, allow_displace: [] }, 'm')).toBeNull();
    release?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(autoOptionFor([option('load_alongside', 'm')], { enabled: true, allow_displace: [] }, 'm')).not.toBeNull();
  });

  it('a FAILED model is in cooldown: no oscillation until the window passes; success clears it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const ledgerPath = join(dir, 'placement.json');
    seededPending(ledgerPath, 'plc-dddddd', 'm');
    const failing = async (): Promise<EnforceResult> => ({ ok: false, steps: [], error: 'boom' });
    scheduleAutoResolution(registry, 'm', option('load_alongside', 'm'), 'plc-dddddd', {
      ledgerPath,
      enforce: failing,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(loadLedger(ledgerPath).pending[0].reason).toBe('auto_failed');
    // The cooldown refuses a re-pick for the SAME model…
    expect(autoOptionFor([option('load_alongside', 'm')], { enabled: true, allow_displace: [] }, 'm')).toBeNull();
    // …while a different model is unaffected.
    expect(autoOptionFor([option('load_alongside', 'n')], { enabled: true, allow_displace: [] }, 'n')).not.toBeNull();
    // And a success for the model clears the cooldown.
    const okRun = async (): Promise<EnforceResult> => ({ ok: true, steps: [] });
    scheduleAutoResolution(registry, 'm', option('load_alongside', 'm'), 'plc-dddddd', {
      ledgerPath,
      enforce: okRun,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(autoOptionFor([option('load_alongside', 'm')], { enabled: true, allow_displace: [] }, 'm')).not.toBeNull();
  });
});

describe('scheduleAutoResolution', () => {
  it('ONE run per requested MODEL (fresh placement ids collapse); success resolves the entry', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const ledgerPath = join(dir, 'placement.json');
    seededPending(ledgerPath, 'plc-aaaaaa', 'qwen3.8-27b');
    seededPending(ledgerPath, 'plc-999999', 'qwen3.8-27b'); // a rotated-client twin
    const enforced: string[] = [];
    const fakeEnforce = async (_r: ModelRegistry, model: string): Promise<EnforceResult> => {
      enforced.push(model);
      return { ok: true, steps: [] };
    };
    scheduleAutoResolution(registry, 'qwen3.8-27b', option('load_alongside', 'qwen3.8-27b'), 'plc-aaaaaa', {
      ledgerPath,
      enforce: fakeEnforce,
    });
    // A different placement id for the SAME model schedules NOTHING: the
    // client-supplied identity can mint fresh ids at request rate, so the
    // id is no dedupe at all — the model is.
    scheduleAutoResolution(registry, 'qwen3.8-27b', option('load_alongside', 'qwen3.8-27b'), 'plc-999999', {
      ledgerPath,
      enforce: fakeEnforce,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(enforced).toEqual(['qwen3.8-27b']); // exactly one
    // The ORIGINAL entry is resolved by its run; the rotated twin never
    // had a run, so it survives for its own TTL self-heal (not extended:
    // the refused schedule returns before the extension).
    expect(loadLedger(ledgerPath).pending.map((p) => p.id)).toEqual(['plc-999999']);
  });

  it('single-flight: a second model\'s run waits for the first (no concurrent machine mutations)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const ledgerPath = join(dir, 'placement.json');
    seededPending(ledgerPath, 'plc-111111', 'a');
    seededPending(ledgerPath, 'plc-222222', 'b');
    const events: string[] = [];
    const slowFor = (model: string, ms: number) => async (): Promise<EnforceResult> => {
      events.push(`start:${model}`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`end:${model}`);
      return { ok: true, steps: [] };
    };
    scheduleAutoResolution(registry, 'a', option('load_alongside', 'a'), 'plc-111111', {
      ledgerPath,
      enforce: slowFor('a', 30),
    });
    scheduleAutoResolution(registry, 'b', option('load_alongside', 'b'), 'plc-222222', {
      ledgerPath,
      enforce: slowFor('b', 1),
    });
    await new Promise((r) => setTimeout(r, 60));
    // Never interleaved: b's enforcement starts only after a ends.
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('the park answer returns BEFORE any enforcement: the run yields first', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const ledgerPath = join(dir, 'placement.json');
    seededPending(ledgerPath, 'plc-333333', 'm');
    let enforceStarted = false;
    const marker = async (): Promise<EnforceResult> => {
      enforceStarted = true;
      return { ok: true, steps: [] };
    };
    scheduleAutoResolution(registry, 'm', option('load_alongside', 'm'), 'plc-333333', {
      ledgerPath,
      enforce: marker,
    });
    // The admission answer is built and returned synchronously; the run's
    // synchronous prefix (device probes, systemctl is-active, the ledger
    // lock) must not run inline in the admit handler.
    expect(enforceStarted).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(enforceStarted).toBe(true);
  });

  it('scheduling EXTENDS the entry past the 120s operator-prompt TTL (the run must outlive its entry)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const ledgerPath = join(dir, 'placement.json');
    seededPending(ledgerPath, 'plc-444444', 'm');
    const before = new Date(loadLedger(ledgerPath).pending[0].expires_at).getTime();
    const gate = new Promise<void>(() => {}); // never resolves: we only need the extension
    scheduleAutoResolution(registry, 'm', option('load_alongside', 'm'), 'plc-444444', {
      ledgerPath,
      enforce: async () => gate as unknown as EnforceResult,
    });
    const after = new Date(loadLedger(ledgerPath).pending[0].expires_at).getTime();
    // Enforced envelope: drain+stops+verify+start exceeds 120s, and the
    // auto window must cover it or a mid-run expiry mints a second run.
    expect(after - before).toBeGreaterThanOrEqual(8 * 60_000);
  });

  it('a failed auto attempt marks the pending entry auto_failed; a THROWING enforcement is caught too', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const ledgerPath = join(dir, 'placement.json');
    seededPending(ledgerPath, 'plc-bbbbbb', 'qwen3.8-27b');
    const fakeEnforce = async (): Promise<EnforceResult> => ({ ok: false, steps: [], error: 'simulated failure' });
    scheduleAutoResolution(registry, 'qwen3.8-27b', option('displace', 'qwen3.8-27b'), 'plc-bbbbbb', {
      ledgerPath,
      enforce: fakeEnforce,
    });
    await new Promise((r) => setTimeout(r, 20));
    const pending = loadLedger(ledgerPath).pending;
    expect(pending.length).toBe(1); // survives for the operator
    expect(pending[0].reason).toBe('auto_failed');
    // A throwing enforcement (not a clean failure) is caught the same way.
    resetAutoSchedulerForTests();
    const throwing = async (): Promise<EnforceResult> => {
      throw new Error('boom');
    };
    scheduleAutoResolution(registry, 'qwen3.8-27b', option('displace', 'qwen3.8-27b'), 'plc-bbbbbb', {
      ledgerPath,
      enforce: throwing,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(loadLedger(ledgerPath).pending[0].reason).toBe('auto_failed');
  });

  it('a THROWING LEDGER WRITE inside the run never rejects (an unhandled rejection would kill the controller)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'placement-auto-'));
    const ledgerPath = join(dir, 'placement.json');
    seededPending(ledgerPath, 'plc-eeeeee', 'm');
    const ok = async (): Promise<EnforceResult> => ({ ok: true, steps: [] });
    scheduleAutoResolution(registry, 'm', option('load_alongside', 'm'), 'plc-eeeeee', {
      ledgerPath,
      enforce: ok,
    });
    // Hold the ledger lock so the run's post-enforcement write throws.
    expect(acquireLedgerLock(ledgerPath)).toBe(true);
    try {
      await new Promise((r) => setTimeout(r, 30)); // the run lands in the catch, not a rejection
    } finally {
      releaseLedgerLock(ledgerPath);
    }
    // The process is still standing (vitest fails the suite on an unhandled
    // rejection) and the entry self-heals via TTL expiry.
    expect(loadLedger(ledgerPath).pending.length).toBe(1);
  });

  it('uses the default ledger path when none is given', () => {
    // Only proves the default resolves (the real home ledger is never touched
    // by these tests — every other case injects ledgerPath).
    expect(placementLedgerPath()).toContain('placement.json');
  });
});
