/**
 * Impact preview (spec §4.5): the victim list the operator sees BEFORE
 * committing, and the re-derivation check enforcement uses AFTER the yes.
 *
 * Nothing in this view is advisory-only: enforcement re-derives the same
 * victim set and refuses to proceed if it differs from what the operator
 * approved. A preview that lies is worse than no preview.
 *
 * In-flight status is `unknown` in phase 1: the proxy exposes no live
 * request state yet (the phase-2 in-flight-per-target endpoint supplies it).
 * The preview must say unknown rather than guess "idle".
 */
import { isMeasuredConfig, type ModelRegistry } from './registry.js';
import type { LedgerResident } from './ledger.js';

export type InFlight = 'unknown' | boolean;

export interface VictimPreview {
  model: string;
  config: string;
  device: string;
  state: LedgerResident['state'];
  holders: string[];
  inflight: InFlight;
  /** MiB the eviction returns to the device; unknown → undefined. */
  frees_gpu_mib: number;
  /** MiB the eviction returns to host RAM; unknown → undefined. */
  frees_host_mib?: number;
  /** Measured cost of loading this config back, if the registry knows it. */
  reload_cost_mib?: number;
  /** Human consequence from the spec §4.5 table. */
  consequence: string;
}

/** Consequence table, spec §4.5. */
function consequenceFor(state: LedgerResident['state'], inflight: InFlight): string {
  if (state === 'warming') return 'load wasted; VRAM returns on stop';
  if (state === 'paused') return 'already offloaded; restore path lost';
  if (inflight === true) return 'active generation aborted; context lost';
  if (inflight === false) return 'session idle; context lost; reload needed';
  return 'context lost; reload needed (in-flight unknown until the proxy endpoint lands)';
}

/** Build the victim preview for a displace option. */
export function buildVictimPreviews(
  registry: ModelRegistry,
  victims: LedgerResident[],
  inflightOf: (victim: LedgerResident) => InFlight = () => 'unknown',
): VictimPreview[] {
  return victims.map((v) => {
    const cfg = registry.models[v.model]?.configs[v.config];
    return {
      model: v.model,
      config: v.config,
      device: v.device,
      state: v.state,
      holders: v.holders,
      inflight: inflightOf(v),
      frees_gpu_mib: v.gpu_mib ?? 0,
      frees_host_mib: v.host_rss_mib,
      reload_cost_mib: cfg && isMeasuredConfig(cfg) ? cfg.resident_gpu_mib : undefined,
      consequence: consequenceFor(v.state, inflightOf(v)),
    };
  });
}

/** Stable signature of a victim set — what the operator approved and what
 * enforcement re-derives must produce the same string, or enforcement
 * aborts. Order-insensitive; content-sensitive. */
export function victimSignature(victims: Array<{ model: string; config: string }>): string {
  return victims
    .map((v) => `${v.model}/${v.config}`)
    .sort()
    .join(',');
}

/** The enforcement-time check: re-derive the victims from live state and
 * refuse when the set the operator approved no longer matches. A mismatch
 * means the world moved between preview and commit — abort, re-ask. */
export function previewStillValid(
  approved: Array<{ model: string; config: string }>,
  rederived: Array<{ model: string; config: string }>,
): boolean {
  return victimSignature(approved) === victimSignature(rederived);
}
