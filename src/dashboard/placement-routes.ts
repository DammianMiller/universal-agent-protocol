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
  opts?: { loaded?: RegistryLoadResult; ledgerPath?: string; isActive?: (unit: string) => boolean },
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

/** Admission decision for one gated request (spec §4.3).

 * Forward when a live resident already serves the requested id (reuse — no
 * operator decision needed); otherwise park, with a reason computed from the
 * registry (fail-closed doctrine: unmeasured/unknown refuse with a note) and
 * a pending entry in the ledger for the dashboard to surface.
 *
 * Reads the ledger WITHOUT a device-probe sync on purpose: the proxy holds a
 * 2s timeout on this call, and the dashboard's placement-state poll keeps
 * the ledger fresh. A resident that just died answers `forward` at worst —
 * the request then hits a dead upstream and the proxy's existing
 * upstream-unavailable machinery (529 + health wait) takes over, which is the
 * same fail-open direction the proxy's own read-only path takes. */
export function getPlacementAdmit(
  projectDir: string,
  request: PlacementAdmitRequest,
  opts?: { loaded?: RegistryLoadResult; ledgerPath?: string },
): PlacementAdmitAnswer {
  if (!request.model_id || typeof request.model_id !== 'string') {
    return { decision: 'park', reason: 'invalid_request' };
  }
  const loaded = opts?.loaded ?? loadModelRegistry(projectDir);
  const registry = loaded.registry;
  const ledgerPath = opts?.ledgerPath ?? placementLedgerPath();

  // Forward on reuse: a live resident serves this id. Draining residents
  // don't count — a swap is in flight.
  const resident = loadLedger(ledgerPath).residents.find(
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

  // Dedupe on (requested_model, client): an unexpired pending entry reuses
  // its id, so retries within the TTL do not multiply operator prompts or
  // ledger writes. Checked again under the lock (the authoritative one).
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PLACEMENT_PENDING_TTL_MS).toISOString();
  const clientKey = request.client ?? '';
  const matchesPending = (p: LedgerPending): boolean =>
    p.requested_model === request.model_id && (p.client ?? '') === clientKey && p.expires_at > now.toISOString();

  const existing = loadLedger(ledgerPath).pending.find(matchesPending);
  if (existing) {
    return { decision: 'park', placement_id: existing.id, reason: existing.reason ?? reason };
  }

  const pending: LedgerPending = {
    id: `plc-${randomBytes(3).toString('hex')}`,
    requested_model: request.model_id,
    client: request.client,
    session: request.session,
    created_at: now.toISOString(),
    expires_at: expiresAt,
    reason,
  };
  let placementId = pending.id;
  try {
    withLedger(ledgerPath, (ledger) => {
      // Prune expired entries while the authoritative ledger is held under
      // the lock: admits deliberately skip the (heavier, probe-running)
      // syncLedger refresh, so without this a parked-and-abandoned flood
      // could grow the pending list until the next dashboard poll or
      // `uap models` run.
      ledger.pending = ledger.pending.filter((p) => p.expires_at > now.toISOString());
      const again = ledger.pending.find(matchesPending);
      if (again) {
        placementId = again.id; // a concurrent admit won the write race
        return;
      }
      ledger.pending.push(pending);
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
    // yet) and say so.
    return { decision: 'park', placement_id: placementId, reason };
  }
  return { decision: 'park', placement_id: placementId, reason };
}
