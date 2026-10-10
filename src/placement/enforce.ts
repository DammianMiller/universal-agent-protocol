/**
 * Placement enforcement (spec §4.6) — the operator-approved swap sequence.
 *
 * Runs ONLY after an explicit operator yes (`uap models apply <id>
 * <option> --yes`, or the dashboard's resolve route). The sequence:
 * re-derive and refuse on drift → mark draining → drain → stop → verify the
 * VRAM actually came back → start → verify up and advertising → invalidate
 * the proxy's cached view → resolve the pending entry. Any failure after a
 * stop rolls back: the previous units are restarted rather than leaving the
 * machine with nothing loaded (step 8 — the step that decides whether this
 * feature is trustworthy).
 *
 * Every external effect is injectable (EnforceDeps) so the sequence is
 * testable against simulated failures, which the spec demands: "The
 * rollback must be exercised in tests against a simulated failed start, not
 * only in the success path."
 *
 * The drain/start/free timeouts ship as conservative defaults labelled
 * UNVALIDATED (spec §10.4): the enforcement time envelope is unmeasured
 * until the operator allows briefly taking the live backend down.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { computeOptions, type PlacementOption } from './admission.js';
import {
  loadLedger,
  residentTargetId,
  syncLedger,
  withLedger,
  placementLedgerPath,
  type LedgerDeviceState,
  type LedgerResident,
  type PlacementLedger,
} from './ledger.js';
import { gpuStatsByIndex, isUnitActive } from './probes.js';
import { loadModelRegistry, validUnitName, type ModelRegistry } from './registry.js';
import { previewStillValid } from './preview.js';
import { proxyBaseAndHeaders } from './proxy-env.js';

export interface EnforceStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface EnforceResult {
  ok: boolean;
  placementId?: string;
  steps: EnforceStep[];
  rolledBack?: boolean;
  error?: string;
}

export interface PlacementInflightEntry {
  client?: string | null;
  session?: string | null;
  started_at?: string;
}

/** All external effects, injectable for tests. */
export interface EnforceDeps {
  isUnitActive(unit: string): boolean;
  stopUnit(unit: string): Promise<void>;
  startUnit(unit: string): Promise<void>;
  /** GPU free MiB for a device like 'gpu0' (index N); null = unprobed. */
  gpuFreeMiB(device: string): number | null;
  /** Live in-flight requests for a target, from the proxy's loopback
   * endpoint (/internal/placement/inflight). NULL = unknown (proxy did
   * not answer) — never guessed: a 401 or a proxy restarted mid-drain
   * reads as busy, not idle. */
  inflightForTarget(target: string): Promise<PlacementInflightEntry[] | null>;
  httpGetJson(url: string): Promise<unknown | null>;
  /** POST the proxy's /internal/placement/refresh; false = not refreshed. */
  refreshProxy(): Promise<boolean>;
  /** Test seam: replaces syncLedger's live device probe (nvidia-smi +
   * MemAvailable vary with machine state; enforcement math must be
   * testable against deterministic facts). Absent = probe for real. */
  probeDevices?(registry: ModelRegistry): Record<string, LedgerDeviceState>;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
}

/** UNVALIDATED envelope defaults (spec §10.4) — conservative on purpose. */
export interface EnforceTimeouts {
  drainMs: number;
  startMs: number;
  freeMs: number;
  pollMs: number;
}

export function enforcementTimeouts(): EnforceTimeouts {
  return {
    drainMs: numEnv('UAP_PLACEMENT_DRAIN_MS', 60_000),
    startMs: numEnv('UAP_PLACEMENT_START_MS', 120_000),
    freeMs: numEnv('UAP_PLACEMENT_FREE_MS', 30_000),
    pollMs: numEnv('UAP_PLACEMENT_POLL_MS', 1_000),
  };
}

function numEnv(key: string, dflt: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

export function defaultEnforceDeps(opts?: { proxyBaseUrl?: string; proxyToken?: string }): EnforceDeps {
  const { base: proxyBase, headers: authorizedHeaders } = proxyBaseAndHeaders(opts ?? {});
  const systemd = (unit: string, verb: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!validUnitName(unit)) {
        reject(new Error(`refusing systemctl --user ${verb}: invalid unit name ${JSON.stringify(unit)}`));
        return;
      }
      try {
        // 30s cap: the dashboard event loop serves the loopback admit the
        // proxy polls, so a hung systemctl job must not freeze it forever.
        execFileSync('systemctl', ['--user', verb, '--', unit], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        });
        resolve();
      } catch (err) {
        reject(new Error(`systemctl --user ${verb} ${unit} failed: ${(err as Error).message}`));
      }
    });
  return {
    isUnitActive,
    stopUnit: (unit) => systemd(unit, 'stop'),
    startUnit: (unit) => systemd(unit, 'start'),
    gpuFreeMiB: (device) => {
      const idx = /^gpu(\d+)$/.exec(device);
      return idx ? gpuStatsByIndex().get(Number(idx[1]))?.free_mib ?? null : null;
    },
    inflightForTarget: async (target) => {
      try {
        const resp = await fetch(`${proxyBase}/internal/placement/inflight`, {
          headers: authorizedHeaders,
          signal: AbortSignal.timeout(2000),
        });
        if (!resp.ok) return null; // unknown, not "idle": a 401 is a mismatched token
        const data = (await resp.json()) as { targets?: Record<string, PlacementInflightEntry[]> };
        // A 200 is authoritative: a missing key = no request ever hit that
        // target through this proxy = idle.
        return data.targets?.[target] ?? [];
      } catch {
        return null; // unknown: proxy down/restarted mid-drain — never guessed
      }
    },
    httpGetJson: async (url) => {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return null;
        return await resp.json();
      } catch {
        return null;
      }
    },
    refreshProxy: async () => {
      try {
        const resp = await fetch(`${proxyBase}/internal/placement/refresh`, {
          method: 'POST',
          headers: authorizedHeaders,
          signal: AbortSignal.timeout(2000),
        });
        return resp.ok;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    nowMs: () => Date.now(),
  };
}

export interface EnforceOpts {
  ledgerPath?: string;
  deps?: EnforceDeps;
  timeouts?: EnforceTimeouts;
  /** Registry paths, threaded to loadModelRegistry (defaults: the project's
   * config/model-registry.json merged with ~/.uap/model-registry.json). */
  repoPath?: string;
  localPath?: string;
  /** The request's context need in cells. Step 0 re-derives the approved
   * option from live state, and the cost is per-request (spec §4.4): with
   * the 32k default a small-pool config's cost is unknown, the re-derive
   * finds nothing, and a cells-correct option is refused as "drift" — the
   * load never runs. */
  cells?: number;
}

function loadRegistry(projectDir: string, opts: EnforceOpts): ModelRegistry {
  return loadModelRegistry(projectDir, { repoPath: opts.repoPath, localPath: opts.localPath }).registry;
}

function step(steps: EnforceStep[], name: string, ok: boolean, detail?: string): void {
  steps.push(ok ? { name, ok: true, ...(detail ? { detail } : {}) } : { name, ok: false, detail });
}

const sameResident = (a: { model: string; config: string }, b: { model: string; config: string }): boolean =>
  a.model === b.model && a.config === b.config;

/** The §4.6 sequence for ONE approved option. Re-derives the option from live
 * state and refuses on drift (a preview that lies is worse than none). */
export async function enforceOption(
  registry: ModelRegistry,
  requestedModel: string,
  approved: PlacementOption,
  opts: EnforceOpts = {},
): Promise<EnforceResult> {
  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  const deps = opts.deps ?? defaultEnforceDeps();
  const timeouts = opts.timeouts ?? enforcementTimeouts();
  const steps: EnforceStep[] = [];
  const ledger: PlacementLedger = syncLedger(
    registry,
    ledgerPath,
    deps.isUnitActive,
    deps.probeDevices ? { deviceProbe: deps.probeDevices } : undefined,
  );
  const victims = approved.victims ?? [];
  const fail = (error: string, rolledBack?: boolean): EnforceResult => ({ ok: false, steps, error, ...(rolledBack ? { rolledBack: true } : {}) });

  // Step 0 — re-derive the approved option from live state; abort on drift.
  // Per-request cost (spec §4.4): re-derive against the SAME context need
  // the option was computed for (opts.cells), or a small-pool config whose
  // option existed for a 2k-cell request "drifts" under the 32k default.
  const rederived = computeOptions(registry, ledger, requestedModel, { cells: opts.cells }).options.find(
    (o) => o.kind === approved.kind && o.model === approved.model && o.config === approved.config,
  );
  if (!rederived) {
    step(steps, 'revalidate', false, 'the approved option no longer exists in live state');
    return fail('approved option drifted: re-run `uap models pending` and approve again');
  }
  if (approved.kind === 'displace' && !previewStillValid(approved.victims ?? [], rederived.victims ?? [])) {
    step(steps, 'revalidate', false, 'victim set differs from what was approved');
    return fail('victim set drifted since approval: aborting rather than acting on a stale preview');
  }
  // A victim already marked draining means another enforcement is in
  // progress on it — refuse rather than silently skipping a VRAM holder.
  const alreadyDraining = victims.filter((v) => v.state === 'draining');
  if (alreadyDraining.length > 0) {
    step(steps, 'revalidate', false, 'a victim is already draining (concurrent enforcement?)');
    return fail(`victim ${alreadyDraining.map((v) => `${v.model}/${v.config}`).join(',')} is already draining — refusing to run a concurrent enforcement`);
  }
  step(steps, 'revalidate', true, approved.kind);

  // Reuse: already resident — nothing to load, nothing to displace.
  if (approved.kind === 'reuse') {
    step(steps, 'resolve', true, 'resident already serves the request');
    return { ok: true, steps };
  }

  // Steps 1-2 — mark draining, then wait for live generations to finish.
  const liveVictims = ledger.residents.filter((r) => victims.some((v) => sameResident(v, r)));
  if (liveVictims.length !== victims.length) {
    step(steps, 'mark-draining', false, 'a victim is no longer resident');
    return fail('victim set drifted: a victim stopped being resident before enforcement');
  }
  withLedger(ledgerPath, (l) => {
    for (const r of l.residents) {
      if (victims.some((v) => sameResident(v, r))) r.state = 'draining';
    }
  });
  step(steps, 'mark-draining', true, victims.map((v) => `${v.model}/${v.config}`).join(', '));

  const drained = await drain(deps, timeouts, liveVictims);
  step(steps, 'drain', drained.ok, drained.detail);
  if (!drained.ok) return await rollback(registry, ledgerPath, opts, steps, [], `drain failed: ${drained.detail}`, { drainedVictims: liveVictims });

  // Step 3-4 — stop, then verify the VRAM actually came back. The free
  // baseline is read BEFORE the first stop (a snapshot taken after the
  // stops would diff post-stop against post-stop and never see the delta),
  // and the in-flight view is re-checked ONE last time right before the
  // first stop — a request admitted into the drain's poll gap must not be
  // cut silently (spec §4.6 step 2).
  const byDevice = new Map<string, number>();
  for (const v of liveVictims) {
    if (v.gpu_mib) byDevice.set(v.device, (byDevice.get(v.device) ?? 0) + v.gpu_mib);
  }
  const freeBefore = new Map<string, number | null>();
  for (const device of byDevice.keys()) freeBefore.set(device, deps.gpuFreeMiB(device));
  const lastCheck = await allTargetsIdle(deps, liveVictims);
  if (!lastCheck.ok) {
    step(steps, 'stop', false, lastCheck.detail);
    return await rollback(registry, ledgerPath, opts, steps, [], `refusing to stop: ${lastCheck.detail}`, { drainedVictims: liveVictims });
  }

  const stoppedUnits: string[] = [];
  for (const v of liveVictims) {
    if (!v.unit) {
      return await rollback(registry, ledgerPath, opts, steps, stoppedUnits, `victim ${v.model}/${v.config} has no systemd unit — cannot be displaced (never treated as zero cost)`, { drainedVictims: liveVictims });
    }
    try {
      await deps.stopUnit(v.unit);
    } catch (err) {
      step(steps, 'stop', false, (err as Error).message);
      return await rollback(registry, ledgerPath, opts, steps, stoppedUnits, `stopping ${v.unit} failed: ${(err as Error).message}`, { drainedVictims: liveVictims });
    }
    stoppedUnits.push(v.unit);
  }
  step(steps, 'stop', true, stoppedUnits.join(', '));

  const freeOk = await verifyFreed(deps, timeouts, byDevice, freeBefore);
  step(steps, 'verify-free', freeOk.ok, freeOk.detail);
  if (!freeOk.ok) return await rollback(registry, ledgerPath, opts, steps, stoppedUnits, `VRAM did not come back: ${freeOk.detail} (orphaned engine?)`, { drainedVictims: liveVictims });

  // Step 5 — start the approved config's unit.
  const model = registry.models[approved.model];
  const cfg = model?.configs[approved.config];
  const newUnit = cfg?.unit ?? model?.unit;
  if (!newUnit) {
    return await rollback(registry, ledgerPath, opts, steps, stoppedUnits, `config ${approved.model}/${approved.config} has no systemd unit to start`, { drainedVictims: liveVictims });
  }
  try {
    await deps.startUnit(newUnit);
  } catch (err) {
    step(steps, 'start', false, (err as Error).message);
    return await rollback(registry, ledgerPath, opts, steps, stoppedUnits, `starting ${newUnit} failed: ${(err as Error).message}`, { drainedVictims: liveVictims });
  }
  step(steps, 'start', true, newUnit);

  // Step 6 — poll health, then the advertised ids: the load-bearing check
  // is that the requested model is actually servable now. (Deep
  // metricsMustMatch drift stays `uap doctor`'s check.)
  const endpoint = (model?.endpoint ?? '').replace(/\/$/, '');
  const upOk = await waitForUp(deps, timeouts, newUnit, endpoint, requestedModel, model?.advertises ?? []);
  step(steps, 'verify-up', upOk.ok, upOk.detail);
  if (!upOk.ok) {
    // The new unit is RUNNING but wrong: rollback must stop it too, or the
    // machine ends up with two same-device residents (VRAM oversubscribed)
    // — a partial-enforcement variant of the step-8 outcome.
    return await rollback(registry, ledgerPath, opts, steps, stoppedUnits, `new unit did not come up serving the request: ${upOk.detail}`, { startedUnit: newUnit, drainedVictims: liveVictims });
  }

  // Step 7 — invalidate the proxy's cached view, then resolve + sync.
  const refreshed = await deps.refreshProxy();
  step(steps, 'refresh-proxy', refreshed, refreshed ? 'proxy caches invalidated' : 'proxy unreachable (no caches to invalidate)');
  syncLedger(registry, ledgerPath, deps.isUnitActive);
  step(steps, 'resolve', true, 'ledger synced, pending resolved by the caller');
  return { ok: true, steps };
}

/** One in-flight check across every victim target; used as the FINAL check
 * immediately before the first stop. Unknown (null) reads as busy. */
async function allTargetsIdle(deps: EnforceDeps, victims: LedgerResident[]): Promise<{ ok: boolean; detail: string }> {
  for (const v of victims) {
    const inflight = await deps.inflightForTarget(residentTargetId(v));
    if (inflight === null) return { ok: false, detail: `in-flight view unavailable for ${v.model}/${v.config} (proxy unreachable) — refusing to guess` };
    if (inflight.length > 0) return { ok: false, detail: `a generation is still in flight on ${v.model}/${v.config}` };
  }
  return { ok: true, detail: 'all targets idle' };
}

async function drain(deps: EnforceDeps, t: EnforceTimeouts, victims: LedgerResident[]): Promise<{ ok: boolean; detail: string }> {
  const deadline = deps.nowMs() + t.drainMs;
  const targets = victims.map((v) => residentTargetId(v));
  for (;;) {
    const busy: string[] = [];
    const unknown: string[] = [];
    for (const target of targets) {
      const inflight = await deps.inflightForTarget(target);
      // Unknown (null) is BUSY, not idle: a proxy restart mid-drain, or a
      // token mismatch, must never read as "drained" (fail-closed, §4.6).
      if (inflight === null) unknown.push(target);
      else if (inflight.length > 0) busy.push(target);
    }
    if (busy.length === 0 && unknown.length === 0) {
      return { ok: true, detail: 'in-flight generations finished' };
    }
    if (deps.nowMs() >= deadline) {
      const why = busy.length ? `still in flight on ${busy.join(',')}` : `in-flight view unavailable for ${unknown.join(',')}`;
      return { ok: false, detail: `${why} (UNVALIDATED envelope)` };
    }
    await deps.sleep(t.pollMs);
  }
}

/** Verify the VRAM actually came back (spec §4.6 step 4). The baseline is
 * snapshotted by the CALLER before the stops — the whole point is the
 * before/after delta, and an orphaned engine outside systemd (the recorded
 * failure mode) leaves free flat after a clean unit stop. */
async function verifyFreed(
  deps: EnforceDeps,
  t: EnforceTimeouts,
  byDevice: Map<string, number>,
  before: Map<string, number | null>,
): Promise<{ ok: boolean; detail: string }> {
  if (byDevice.size === 0) return { ok: true, detail: 'no GPU cost to verify' };
  const deadline = deps.nowMs() + t.freeMs;
  for (;;) {
    const pending: string[] = [];
    const unprobed: string[] = [];
    for (const [device, freed] of byDevice) {
      const free = deps.gpuFreeMiB(device);
      const base = before.get(device) ?? null;
      if (free === null || base === null) {
        unprobed.push(device); // trust the unit stop, but SAY it
        continue;
      }
      if (free < base + freed * 0.9) pending.push(device);
    }
    // Unmeasured = refuse (spec doctrine): with no device probed at all,
    // "free recovered" would be a vacuous pass.
    if (unprobed.length === byDevice.size) {
      return { ok: false, detail: `no device could be probed (${unprobed.join(',')}) — refusing to verify-free by trust alone` };
    }
    if (pending.length === 0) {
      return {
        ok: true,
        detail: unprobed.length
          ? `device free recovered; unprobed (trusted the unit stop): ${unprobed.join(',')}`
          : 'device free recovered',
      };
    }
    if (deps.nowMs() >= deadline) {
      return { ok: false, detail: `free did not recover on ${pending.join(',')} (expected ~${[...byDevice.values()].join('/')} MiB back)` };
    }
    await deps.sleep(t.pollMs);
  }
}

async function waitForUp(
  deps: EnforceDeps,
  t: EnforceTimeouts,
  unit: string,
  endpoint: string,
  requestedModel: string,
  advertises: string[],
): Promise<{ ok: boolean; detail: string }> {
  const deadline = deps.nowMs() + t.startMs;
  for (;;) {
    const active = deps.isUnitActive(unit);
    const health = endpoint ? await deps.httpGetJson(`${endpoint}/health`) : null;
    const models = endpoint ? ((await deps.httpGetJson(`${endpoint}/v1/models`)) as { data?: Array<{ id?: string; aliases?: string[] }> } | null) : null;
    const ids = (models?.data ?? []).flatMap((m) => [m.id ?? '', ...(m.aliases ?? [])]);
    const serves = ids.length > 0 && (ids.includes(requestedModel) || advertises.some((a) => ids.includes(a)));
    if (active && health && serves) return { ok: true, detail: 'healthy and advertising the requested id' };
    if (deps.nowMs() >= deadline) {
      return { ok: false, detail: `active=${active} health=${health ? 'ok' : 'fail'} serves=${serves} after ${t.startMs}ms (UNVALIDATED envelope)` };
    }
    await deps.sleep(t.pollMs);
  }
}

/** Step 8 — restart the previous resident set rather than leaving the
 * machine with nothing loaded. Best-effort per unit, loudly reported.
 * A unit STARTED during the failed sequence is stopped first: leaving it
 * running alongside the restarted previous set would oversubscribe the
 * device — the partial-enforcement variant of the outcome step 8 exists
 * to prevent. */
async function rollback(
  registry: ModelRegistry,
  ledgerPath: string,
  opts: EnforceOpts,
  steps: EnforceStep[],
  stoppedUnits: string[],
  error: string,
  extras: { startedUnit?: string; drainedVictims?: Array<{ model: string; config: string }> } = {},
): Promise<EnforceResult> {
  const { startedUnit, drainedVictims = [] } = extras;
  const deps = opts.deps ?? defaultEnforceDeps();
  const restarted: string[] = [];
  const failed: string[] = [];
  const stopFailed: string[] = [];
  if (startedUnit) {
    try {
      await deps.stopUnit(startedUnit);
    } catch {
      stopFailed.push(startedUnit);
    }
  }
  for (const unit of stoppedUnits) {
    try {
      await deps.startUnit(unit);
      restarted.push(unit);
    } catch {
      failed.push(unit);
    }
  }
  const rollbackErrors = [...stopFailed.map((u) => `${u} did not stop`), ...failed.map((u) => `${u} did not restart`)];
  step(
    steps,
    'rollback',
    rollbackErrors.length === 0,
    rollbackErrors.length
      ? `failed: ${rollbackErrors.join(',')}`
      : `${startedUnit ? `stopped ${startedUnit}, ` : ''}restarted ${restarted.join(',')}`,
  );
  syncLedger(registry, ledgerPath, deps.isUnitActive);
  // The sequence is OVER: clear this sequence's draining markers (the
  // syncLedger preserve exists for CONCURRENT reads mid-drain, not for a
  // ledger leak after the rollback restored the previous residents — a
  // stale marker would keep refusing admission forever).
  if (drainedVictims.length > 0) {
    withLedger(ledgerPath, (l) => {
      for (const r of l.residents) {
        if (r.state === 'draining' && drainedVictims.some((v) => v.model === r.model && v.config === r.config)) {
          r.state = 'hot';
        }
      }
    });
  }
  return {
    ok: false,
    steps,
    error: rollbackErrors.length
      ? `${error}; ROLLBACK INCOMPLETE: ${rollbackErrors.join(',')}`
      : `${error}; rolled back to the previous residents`,
    rolledBack: true,
  };
}

/** Best-effort live in-flight map from the proxy's loopback
 * /internal/placement/inflight, for victim previews at the approval moment
 * (spec §4.5): the operator sees "active generation aborted" versus "session
 * idle" honestly. NULL when the proxy does not answer — unknown, never a
 * guessed "idle". */
export async function fetchProxyInflight(
  opts: { proxyBaseUrl?: string; proxyToken?: string } = {},
): Promise<Map<string, PlacementInflightEntry[]> | null> {
  const { base, headers } = proxyBaseAndHeaders(opts);
  try {
    const resp = await fetch(`${base}/internal/placement/inflight`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { targets?: Record<string, PlacementInflightEntry[]> };
    return new Map(Object.entries(data.targets ?? {}));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Operator entry points (CLI + dashboard call the same functions)
// ---------------------------------------------------------------------------

/** Resolve a parked request: find its pending entry, recompute options,
 * pick option #optionIndex (1-based, as `uap models pending` prints them),
 * enforce, and remove the pending entry on success.
 *
 * `expectedVictims` is the approval signature: the victim list the operator
 * actually SAW (the impact list the CLI printed, or the dashboard preview).
 * When provided, enforcement refuses if the recomputed option's victims
 * differ — "option N" can silently mean a different swap minutes after the
 * preview, and this feature never displaces what the operator did not see
 * (spec §4.5: a preview that lies is worse than no preview). */
export async function resolvePendingPlacement(
  projectDir: string,
  placementId: string,
  optionIndex: number,
  opts: EnforceOpts & { expectedVictims?: Array<{ model: string; config: string }> } = {},
): Promise<EnforceResult> {
  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  const ledger = loadLedger(ledgerPath);
  const pending = ledger.pending.find((p) => p.id === placementId);
  if (!pending) return { ok: false, steps: [], error: `no pending placement ${placementId}` };
  const loaded = loadRegistry(projectDir, opts);
  // Options are per-request (spec §4.4): recompute against the context the
  // parked request needs (recorded by the proxy in the pending entry) — the
  // 32k default fail-closed-refuses a small-pool config whose cost is known
  // for THIS request, and then the operator's `apply N` could never reach
  // the option `pending` just printed for the same entry.
  const options = computeOptions(loaded, loadLedger(ledgerPath), pending.requested_model, {
    cells: pending.cells,
  }).options;
  const approved = options[optionIndex - 1];
  if (!approved) {
    return { ok: false, steps: [], error: `option ${optionIndex} does not exist (1-${options.length}); re-run \`uap models pending\`` };
  }
  if (opts.expectedVictims) {
    const actual = (approved.victims ?? []).map((v) => ({ model: v.model, config: v.config }));
    const expected = opts.expectedVictims.map((v) => ({ model: v.model, config: v.config }));
    const same =
      actual.length === expected.length &&
      expected.every((e) => actual.some((a) => a.model === e.model && a.config === e.config));
    if (!same) {
      return {
        ok: false,
        steps: [],
        error: `the option's victim set changed since the impact list you approved (${actual.map((v) => `${v.model}/${v.config}`).join(', ') || 'no victims'} now); re-run \`uap models pending\` and approve again`,
      };
    }
  }
  const result = await enforceOption(loaded, pending.requested_model, approved, {
    ...opts,
    cells: pending.cells,
  });
  if (result.ok) {
    withLedger(ledgerPath, (l) => {
      l.pending = l.pending.filter((p) => p.id !== placementId);
    });
  }
  return { ...result, placementId };
}

/** Refuse a parked request: the client gets a clean fallback on expiry. */
export function dismissPendingPlacement(
  placementId: string,
  opts: { ledgerPath?: string } = {},
): { dismissed: boolean } {
  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  // Presence, not length: a concurrent append during the dismissal must not
  // misreport a successful removal as a failure.
  const existed = loadLedger(ledgerPath).pending.some((p) => p.id === placementId);
  withLedger(ledgerPath, (l) => {
    l.pending = l.pending.filter((p) => p.id !== placementId);
  });
  return { dismissed: existed };
}

/** Operator-initiated load: same gate, but NEVER displacement — pick the
 * best non-displacing option (reuse, then load_alongside) and refuse if
 * only displacement would fit. Displacement always needs the pending path. */
export async function loadPlacement(
  projectDir: string,
  modelKey: string,
  opts: EnforceOpts = {},
): Promise<EnforceResult> {
  const loaded = loadRegistry(projectDir, opts);
  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  const options = computeOptions(loaded, loadLedger(ledgerPath), modelKey).options;
  const approved = options.find((o) => o.kind !== 'displace');
  if (!approved) {
    return { ok: false, steps: [], error: 'no non-displacing option fits; displacement requires a pending request and an explicit operator approval' };
  }
  return enforceOption(loaded, modelKey, approved, opts);
}

/** Operator-initiated unload: every live resident of the model is drained,
 * stopped, verified free, and the proxy view refreshed. */
export async function unloadPlacement(
  projectDir: string,
  modelKey: string,
  opts: EnforceOpts = {},
): Promise<EnforceResult> {
  const loaded = loadRegistry(projectDir, opts);
  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  const deps = opts.deps ?? defaultEnforceDeps();
  const timeouts = opts.timeouts ?? enforcementTimeouts();
  const steps: EnforceStep[] = [];
  const ledger = syncLedger(loaded, ledgerPath, deps.isUnitActive);
  const residents = ledger.residents.filter((r) => r.model === modelKey);
  if (residents.length === 0) return { ok: false, steps, error: `no live residents of ${modelKey}` };
  withLedger(ledgerPath, (l) => {
    for (const r of l.residents) if (r.model === modelKey) r.state = 'draining';
  });
  step(steps, 'mark-draining', true, residents.map((r) => `${r.model}/${r.config}`).join(', '));
  const drained = await drain(deps, timeouts, residents);
  step(steps, 'drain', drained.ok, drained.detail);
  if (!drained.ok) {
    return await rollback(loaded, ledgerPath, opts, steps, [], `drain failed: ${drained.detail}`, { drainedVictims: residents });
  }
  const stopped: string[] = [];
  const byDevice = new Map<string, number>();
  for (const r of residents) {
    if (r.gpu_mib) byDevice.set(r.device, (byDevice.get(r.device) ?? 0) + r.gpu_mib);
  }
  const freeBefore = new Map<string, number | null>();
  for (const device of byDevice.keys()) freeBefore.set(device, deps.gpuFreeMiB(device));
  // Final in-flight check right before the first stop — same guard as the
  // displacement path (a request admitted into the drain's poll gap).
  const lastCheck = await allTargetsIdle(deps, residents);
  if (!lastCheck.ok) {
    step(steps, 'stop', false, lastCheck.detail);
    return await rollback(loaded, ledgerPath, opts, steps, [], `refusing to stop: ${lastCheck.detail}`, { drainedVictims: residents });
  }
  // Guarded like the displacement path: a stop failure rolls the already
  // stopped units back instead of throwing raw through the CLI/dashboard.
  for (const r of residents) {
    if (!r.unit) return await rollback(loaded, ledgerPath, opts, steps, stopped, `resident ${r.config} has no unit`, { drainedVictims: residents });
    try {
      await deps.stopUnit(r.unit);
    } catch (err) {
      step(steps, 'stop', false, (err as Error).message);
      return await rollback(loaded, ledgerPath, opts, steps, stopped, `stopping ${r.unit} failed: ${(err as Error).message}`, { drainedVictims: residents });
    }
    stopped.push(r.unit);
  }
  step(steps, 'stop', true, stopped.join(', '));
  const freed = await verifyFreed(deps, timeouts, byDevice, freeBefore);
  step(steps, 'verify-free', freed.ok, freed.detail);
  if (!freed.ok) return await rollback(loaded, ledgerPath, opts, steps, stopped, freed.detail, { drainedVictims: residents });
  const refreshed = await deps.refreshProxy();
  step(steps, 'refresh-proxy', refreshed, refreshed ? 'proxy caches invalidated' : 'proxy unreachable');
  syncLedger(loaded, ledgerPath, deps.isUnitActive);
  return { ok: true, steps };
}

// ---------------------------------------------------------------------------
// Tracked unit edges: Conflicts= drop-ins derived from the registry
// ---------------------------------------------------------------------------

/** Write `Conflicts=` drop-ins for every registry-named unit so the
 * systemd graph itself refuses two same-device residents (the machine-local
 * graph today knows nothing about placement). Drop-ins, not unit rewrites:
 * the operator's unit files stay theirs. Unit names are validated BEFORE
 * any path or content is built from them — the registry comes from the
 * repo's config/, and a name carrying `../` or a newline must never reach
 * a file path, the drop-in content, or systemctl. Stale drop-ins (a unit
 * whose registry conflicts disappeared, or a unit gone from the registry)
 * are removed so orphan Conflicts= can't brick a legitimate future start.
 * Best-effort daemon-reload. */
export function writePlacementUnitDropins(
  registry: ModelRegistry,
  opts: { userUnitsDir?: string } = {},
): { written: string[]; removed: string[]; dir: string } {
  const dir = opts.userUnitsDir ?? join(homedir(), '.config', 'systemd', 'user');
  const unitsByDevice = new Map<string, Set<string>>();
  // A KNOWN systemd suffix is kept as-is; anything else gets .service.
  // (The old `u.includes('.')` heuristic treated 'llama.server' as a
  // suffixed name and never added the suffix.)
  const SUFFIXED = /\.(service|socket|target|timer|path|slice|scope)$/;
  const unitOf = (u: string): string => {
    if (!validUnitName(u)) {
      throw new Error(`refusing to write drop-ins: invalid unit name ${JSON.stringify(u)} (registry unit names must match ${'/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/ with no .. or /'})`);
    }
    return SUFFIXED.test(u) ? u : `${u}.service`;
  };
  for (const model of Object.values(registry.models)) {
    const units = new Set<string>(model.unit ? [unitOf(model.unit)] : []);
    for (const cfg of Object.values(model.configs)) if (cfg.unit) units.add(unitOf(cfg.unit));
    for (const device of model.affinity?.device ?? []) {
      const set = unitsByDevice.get(device) ?? new Set<string>();
      units.forEach((u) => set.add(u));
      unitsByDevice.set(device, set);
    }
  }
  const conflictsOf = new Map<string, Set<string>>();
  for (const units of unitsByDevice.values()) {
    for (const unit of units) {
      const set = conflictsOf.get(unit) ?? new Set<string>();
      units.forEach((other) => { if (other !== unit) set.add(other); });
      conflictsOf.set(unit, set);
    }
  }
  const written: string[] = [];
  for (const [unit, conflicts] of conflictsOf) {
    if (conflicts.size === 0) continue;
    const dropinDir = join(dir, `${unit}.d`);
    mkdirSync(dropinDir, { recursive: true });
    const path = join(dropinDir, '50-uap-placement.conf');
    writeFileSync(
      path,
      [
        '# Generated by uap models units (operator-directed model placement,',
        '# spec §4.3): units whose residents share a device conflict, so',
        '# systemd itself refuses two same-device residents. Safe to delete.',
        '[Unit]',
        `Conflicts=${[...conflicts].join(' ')}`,
        '',
      ].join('\n'),
    );
    written.push(path);
  }
  // Reconcile: remove OUR drop-ins for units that no longer conflict —
  // an orphan Conflicts= line fails legitimate future starts with a
  // confusing error (start failure → rollback → placement bricked).
  const removed: string[] = [];
  const conflictingUnits = new Set(
    [...conflictsOf.entries()].filter(([, c]) => c.size > 0).map(([u]) => u),
  );
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.d')) continue;
    const dropin = join(dir, entry.name, '50-uap-placement.conf');
    if (!conflictingUnits.has(entry.name.replace(/\.d$/, ''))) {
      try {
        rmSync(dropin, { force: true });
        removed.push(dropin);
      } catch {
        /* best-effort reconciliation */
      }
    }
  }
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch {
    /* best-effort: next systemctl call reloads anyway */
  }
  return { written, removed, dir };
}
