/**
 * Placement routes for the dashboard (spec §4.3/§4.7).
 *
 * Reads are open, like every other dashboard read; the load/unload/resolve
 * mutation routes arrive with phase 3 enforcement and go through
 * mutationAuthorized(). One exception ships in phase 2: the admission
 * endpoint (`getPlacementAdmit` + POST /api/placement/admit) is a WRITE —
 * it appends pending entries to the ledger — but its caller is the proxy
 * (a local process with no dashboard token), so it is loopback-gated in
 * server.ts instead of token-gated, and its only write is the operator's
 * decision queue.
 */
import { randomBytes } from 'crypto';
import { isUnitActive } from '../placement/probes.js';
import {
  syncLedger,
  loadLedger,
  withLedger,
  placementLedgerPath,
  probeDeviceStates,
  residentTargetId,
  type LedgerPending,
  type PlacementLedger,
} from '../placement/ledger.js';
import {
  isMeasuredConfig,
  isPlaceable,
  loadModelRegistry,
  type ModelRegistry,
  type RegistryLoadResult,
} from '../placement/registry.js';
import { computeOptions } from '../placement/admission.js';
import {
  autoOptionFor,
  autoPolicyPath,
  loadAutoPolicy,
  scheduleAutoResolution,
  type AutoPolicy,
} from '../placement/auto.js';
import { enforceOption } from '../placement/enforce.js';

export interface PlacementModelSummary {
  model: string;
  display: string;
  engine?: string;
  unit?: string;
  service?: string;
  advertises: string[];
  configs: Array<{
    config: string;
    measured: boolean;
    resident_gpu_mib?: number;
    host_rss_mib?: number;
    context_pool_cells?: number;
    kv_resident_cells?: number;
    kv_kind?: string;
    measured_at?: string;
    measured_on?: string;
    source?: 'repo' | 'local';
  }>;
}

export interface PlacementStatePayload {
  updated_at?: string;
  devices: PlacementLedger['devices'];
  residents: PlacementLedger['residents'];
  pending: PlacementLedger['pending'];
  models: PlacementModelSummary[];
  registry_errors: string[];
  /** Phase-4 auto policy (§4.4.1): the UI is the operator's management
   * surface for it — enabled state + the displacement allowlist, exactly
   * what `uap models auto` prints. */
  auto: AutoPolicy;
}

function summarizeRegistry(loaded: RegistryLoadResult): PlacementModelSummary[] {
  return Object.entries(loaded.registry.models).map(([mKey, model]) => ({
    model: mKey,
    display: model.display,
    engine: model.engine,
    unit: model.unit,
    service: model.service,
    advertises: model.advertises ?? [],
    configs: Object.entries(model.configs).map(([cKey, cfg]) =>
      isMeasuredConfig(cfg)
        ? {
            config: cKey,
            measured: true,
            resident_gpu_mib: cfg.resident_gpu_mib,
            host_rss_mib: cfg.host_rss_mib,
            context_pool_cells: cfg.context_pool_cells,
            kv_resident_cells: cfg.kv_resident_cells,
            kv_kind: cfg.kv_kind,
            measured_at: cfg.measured_at,
            measured_on: cfg.measured_on,
            source: loaded.measuredFrom.get(`${mKey}/${cKey}`),
          }
        : { config: cKey, measured: false, unit: cfg.unit },
    ),
  }));
}

/** Full placement state: registry summary + synced ledger (devices from live
 * probes, residents reconciled from unit activity, pending parked requests). */
export function getPlacementState(
  projectDir: string,
  opts?: {
    loaded?: RegistryLoadResult;
    ledgerPath?: string;
    isActive?: (unit: string) => boolean;
    autoPolicyPath?: string;
  },
): PlacementStatePayload {
  const loaded = opts?.loaded ?? loadModelRegistry(projectDir);
  const ledgerPath = opts?.ledgerPath ?? placementLedgerPath();
  const ledger = syncLedger(loaded.registry, ledgerPath, opts?.isActive ?? isUnitActive);
  return {
    updated_at: ledger.updated_at,
    devices: ledger.devices,
    residents: ledger.residents,
    pending: ledger.pending,
    models: summarizeRegistry(loaded),
    registry_errors: loaded.errors,
    auto: loadAutoPolicy(opts?.autoPolicyPath ?? autoPolicyPath()),
  };
}

/** Parked requests only — the operator's decision queue. */
export function getPlacementPending(ledgerPath: string = placementLedgerPath()): PlacementLedger['pending'] {
  return loadLedger(ledgerPath).pending;
}

/** Ranked options + victim previews for a requested model — the same
 * computation the phase-2 proxy gate and phase-3 preview routes use. */
export function getPlacementPreview(
  projectDir: string,
  requestedModel: string,
  opts?: { cells?: number; taskKind?: string; registry?: ModelRegistry; ledgerPath?: string },
): ReturnType<typeof computeOptions> {
  const registry = opts?.registry ?? loadModelRegistry(projectDir).registry;
  const ledger = loadLedger(opts?.ledgerPath ?? placementLedgerPath());
  return computeOptions(registry, ledger, requestedModel, { cells: opts?.cells, taskKind: opts?.taskKind });
}

// ---------------------------------------------------------------------------
// Admission (spec §4.3): the proxy's controller endpoint
// ---------------------------------------------------------------------------

export interface PlacementAdmitRequest {
  model_id: string;
  client?: string;
  session?: string;
  /** The request's context need in cells (tokens + generation headroom),
   * estimated by the proxy from the request body. The admission cost is
   * per-request (spec §4.4): cost(config, cells). Without it the controller
   * assumes the 32,768-cell default, which fail-closed-refuses every config
   * whose measured KV pool is smaller — a 16k-max-context backend could
   * never be placed for a 1.5k-token request. Sanitized: an absent,
   * non-finite, or non-positive value falls back to the default. */
  cells?: number;
}

export interface PlacementAdmitAnswer {
  decision: 'forward' | 'park';
  /** forward: the resident's target identity (device:endpoint) — keys the
   * proxy's per-target semaphore budget. Never the model name. */
  target_id?: string;
  /** park: the pending id the 409 body carries (`plc-xxxx`). */
  placement_id?: string;
  /** park: machine reason; the 409 body forwards it verbatim. */
  reason?: string;
}

/** How long a parked request stays deduped in the OPERATOR-PROMPT sense: the
 * ledger's pending entry. (The proxy's own in-memory burst map is much
 * shorter — see the proxy's _PLACEMENT_BURST_DEDUPE_SECS — so a resolved
 * placement forwards on the very next request; this window only bounds how
 * long one operator prompt lives.) */
export const PLACEMENT_PENDING_TTL_MS = 120_000;

/** Does this resident serve the requested wire id? A resident serves it when
 * the registry model it was loaded from advertises the id (or the model or
 * config key matches — config keys are valid ids too). */
function residentServes(
  resident: PlacementLedger['residents'][number],
  modelId: string,
  registry: ModelRegistry,
): boolean {
  if (resident.model === modelId || resident.config === modelId) return true;
  return (registry.models[resident.model]?.advertises ?? []).includes(modelId);
}

/** Cold-start probe throttle: how often the admit path retries a device
 * probe while the ledger has no device facts. The window bounds a
 * permanently failing probe (missing driver, wedged nvidia-smi) to one
 * subprocess spawn per window instead of one per admit. */
const COLD_PROBE_RETRY_MS = 10_000;
let coldProbeLastAt = 0;
/** Test seam: the throttle window is process state; tests reset it so
 * they don't depend on each other's probe timing. */
export function resetColdProbeForTests(): void {
  coldProbeLastAt = 0;
}

/** Admission decision for one gated request (spec §4.3).

 * Forward when a live resident already serves the requested id (reuse — no
 * operator decision needed); otherwise park, with a reason computed from the
 * registry (fail-closed doctrine: unmeasured/unknown refuse with a note) and
 * a pending entry in the ledger for the dashboard to surface.
 *
 * Reads the ledger without the probe-heavy syncLedger refresh on purpose: the
 * proxy holds a 2s timeout on this call, and the dashboard's placement-state
 * poll keeps the ledger fresh. ONE bounded exception: a ledger with NO device
 * facts (fresh boot, nothing ever synced) probes devices — nvidia-smi +
 * MemAvailable, no unit or inflight probes, at most once per retry window —
 * because "device not in ledger"
 * would otherwise refuse every option and the first request after a boot
 * could never auto-load. A resident that just died answers `forward` at
 * worst — the request then hits a dead upstream and the proxy's existing
 * upstream-unavailable machinery (529 + health wait) takes over, which is the
 * same fail-open direction the proxy's own read-only path takes. */
export function getPlacementAdmit(
  projectDir: string,
  request: PlacementAdmitRequest,
  opts?: {
    loaded?: RegistryLoadResult;
    ledgerPath?: string;
    /** Auto-resolution seam (phase 4): the policy is injected for tests;
     * `enforce` replaces the background enforcement entirely. */
    auto?: { policy?: AutoPolicy; enforce?: typeof enforceOption };
    /** Test seam for the cold-start device probe (nvidia-smi + MemAvailable
     * readings vary with live machine state; tests need deterministic facts). */
    deviceProbe?: typeof probeDeviceStates;
  },
): PlacementAdmitAnswer {
  if (!request.model_id || typeof request.model_id !== 'string') {
    return { decision: 'park', reason: 'invalid_request' };
  }
  // Request-driven context need: the proxy's honest estimate, clamped to
  // positive integers; anything off-shape degrades to the computeOptions
  // default rather than being trusted (the proxy is a local process, but
  // the ledger persists what it says, so it is validated anyway).
  const cells =
    typeof request.cells === 'number' && Number.isInteger(request.cells) && request.cells > 0
      ? request.cells
      : undefined;
  const loaded = opts?.loaded ?? loadModelRegistry(projectDir);
  const registry = loaded.registry;
  const ledgerPath = opts?.ledgerPath ?? placementLedgerPath();
  // One read feeds the resident check, the auto option math, and the
  // dedupe scan (the locked write below re-reads — it must see the
  // authoritative state).
  const ledger = loadLedger(ledgerPath);

  // Cold-start device facts: the admit path deliberately skips the heavy
  // syncLedger refresh (unit probes, inflight asks), but a ledger with NO
  // device facts refuses every option as "device not in ledger" — the
  // first request after a dashboard boot could never auto-load, no matter
  // the cells. Probe devices once (nvidia-smi + MemAvailable) only when
  // the ledger has none. A failing or empty probe keeps the fail-closed
  // refusal and is retried at most once per COLD_PROBE_RETRY_MS window —
  // the loopback admit endpoint must not become a subprocess-spawn
  // amplifier on a machine where the probe can never succeed.
  if (Object.keys(ledger.devices).length === 0) {
    const now = Date.now();
    if (now - coldProbeLastAt >= COLD_PROBE_RETRY_MS) {
      coldProbeLastAt = now;
      try {
        const devices = (opts?.deviceProbe ?? probeDeviceStates)(registry);
        withLedger(ledgerPath, (l) => {
          l.devices = devices;
        });
        ledger.devices = devices;
      } catch (err) {
        // No facts, no options — the park reason says not_resident. Log
        // it: a permanently failing probe would otherwise fail silently
        // on every first-request window.
        console.warn(
          `[placement] cold-start device probe failed (retry in ${Math.round(COLD_PROBE_RETRY_MS / 1000)}s):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // Forward on reuse: a live resident serves this id. Draining residents
  // don't count — a swap is in flight.
  const resident = ledger.residents.find(
    (r) => r.state !== 'draining' && residentServes(r, request.model_id, registry),
  );
  if (resident) {
    return { decision: 'forward', target_id: residentTargetId(resident) };
  }

  // Park. The reason comes from the registry, never a guess: unknown model,
  // known but unmeasured (fail closed), or known+measured but not loaded.
  const modelEntry =
    registry.models[request.model_id] ??
    Object.values(registry.models).find((m) => (m.advertises ?? []).includes(request.model_id));
  let reason = 'not_resident';
  if (!modelEntry) {
    reason = 'unknown_model';
  } else if (!Object.values(modelEntry.configs).some(isPlaceable)) {
    reason = 'no_measured_config';
  }

  // Auto-resolution (phase 4): a known, placeable model that is not
  // resident can load ITSELF — alongside always (nothing evicted), by
  // displacement only for operator-allowlisted models. The park reason
  // becomes auto_loading; the client's retry is the protocol and forwards
  // once the load completes. Unmeasured/unknown models never auto-load,
  // and neither does a model in its failure cooldown or past the
  // in-flight cap — autoOptionFor gates all of it so the reason never
  // promises a run that will be refused.
  let autoPlan: ReturnType<typeof autoOptionFor> = null;
  if (reason === 'not_resident') {
    const options = computeOptions(registry, ledger, request.model_id, { cells }).options;
    autoPlan = autoOptionFor(options, opts?.auto?.policy ?? loadAutoPolicy(), request.model_id);
    if (autoPlan) reason = 'auto_loading';
  }

  // Dedupe on (requested_model, client): an unexpired pending entry reuses
  // its id, so retries within the TTL do not multiply operator prompts or
  // ledger writes. Checked again under the lock (the authoritative one).
  // client/session are CLIENT-SUPPLIED identity strings — truncated
  // before persisting so a flood cannot grow the ledger the dashboard
  // rewrites on every admit (the full value never matters downstream).
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PLACEMENT_PENDING_TTL_MS).toISOString();
  const client = request.client ? request.client.slice(0, 128) : undefined;
  const session = request.session ? request.session.slice(0, 128) : undefined;
  const clientKey = client ?? '';
  const matchesPending = (p: LedgerPending): boolean =>
    p.requested_model === request.model_id && (p.client ?? '') === clientKey && p.expires_at > now.toISOString();

  const existing = ledger.pending.find(matchesPending);
  if (existing) {
    // No re-scheduling on the dedupe path: the entry's auto run is either
    // in flight (the run map dedupes by requested model) or already
    // finished (its reason says so). A stale `auto_loading` entry whose
    // run died with the process self-heals: it expires after the TTL and
    // the next admit creates a fresh entry with a fresh run.
    return { decision: 'park', placement_id: existing.id, reason: existing.reason ?? reason };
  }

  const pending: LedgerPending = {
    id: `plc-${randomBytes(3).toString('hex')}`,
    requested_model: request.model_id,
    client,
    session,
    created_at: now.toISOString(),
    expires_at: expiresAt,
    reason,
    cells,
  };
  let placementId = pending.id;
  let raceWinnerReason: string | undefined;
  try {
    withLedger(ledgerPath, (l) => {
      // Prune expired entries while the authoritative ledger is held under
      // the lock: admits deliberately skip the (heavier, probe-running)
      // syncLedger refresh, so without this a parked-and-abandoned flood
      // could grow the pending list until the next dashboard poll or
      // `uap models` run.
      l.pending = l.pending.filter((p) => p.expires_at > now.toISOString());
      const again = l.pending.find(matchesPending);
      if (again) {
        placementId = again.id; // a concurrent admit won the write race
        raceWinnerReason = again.reason;
        return;
      }
      l.pending.push(pending);
    });
  } catch {
    // Ledger lock contention fails the WRITE, not the decision: the request
    // still parks. The lock's most likely holder is the dashboard's own
    // 2s state poll (syncLedger takes the same advisory lock), so before
    // falling back to the unpersisted id, re-read for a concurrent admit
    // that DID win the lock — its pending entry is the one `uap models
    // pending` will show, so the client's 409 should carry THAT id.
    const concurrent = loadLedger(ledgerPath).pending.find(matchesPending);
    if (concurrent) {
      return { decision: 'park', placement_id: concurrent.id, reason: concurrent.reason ?? reason };
    }
    // Nobody persisted this ask: answer with our id anyway (the operator
    // sees the 409 in the client; the dashboard has no pending row for it
    // yet) and say so. No auto scheduling: the entry is not persisted, so
    // a resolved pending would have nothing to remove — and the reason
    // must not promise a load that will never run.
    return { decision: 'park', placement_id: placementId, reason: autoPlan ? 'not_resident' : reason };
  }
  if (autoPlan && placementId === pending.id) {
    // Our entry won the race and auto-load applies: fire the background
    // enforcement for exactly this placement id (a concurrent winner
    // schedules its own). The client retries on the floor and forwards
    // once the load lands.
    scheduleAutoResolution(registry, request.model_id, autoPlan, placementId, {
      ledgerPath,
      // The run's step-0 re-derive must see the same context need the
      // option was computed against, or a small-pool load refuses itself.
      cells,
      enforce: opts?.auto?.enforce,
    });
    return { decision: 'park', placement_id: placementId, reason };
  }
  if (raceWinnerReason !== undefined) {
    // A concurrent admit won the write race: its entry (and its auto run,
    // if any) is the real state — report ITS reason, not our locally
    // computed one (which may promise a load the winner never scheduled).
    return { decision: 'park', placement_id: placementId, reason: raceWinnerReason };
  }
  return { decision: 'park', placement_id: placementId, reason };
}
