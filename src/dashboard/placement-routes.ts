/**
 * Placement read routes for the dashboard (spec §4.7).
 *
 * Reads are open, like every other dashboard read; the mutation routes
 * (load/unload/resolve/dismiss) arrive with phase 3 enforcement and go
 * through mutationAuthorized(). This module is deliberately read-only so
 * the Models tab can ship before enforcement does.
 */
import { isUnitActive } from '../placement/probes.js';
import { syncLedger, loadLedger, placementLedgerPath, type PlacementLedger } from '../placement/ledger.js';
import {
  isMeasuredConfig,
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
