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
import { enqueueAttention } from '../delivery/attention.js';
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
  effectiveVision,
  isMeasuredConfig,
  isPlaceable,
  loadModelRegistry,
  type ModelRegistry,
  type RegistryLoadResult,
} from '../placement/registry.js';
import { computeOptions, optionsForPending } from '../placement/admission.js';
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
 * computation the phase-2 proxy gate and phase-3 preview routes use.
 *
 * `placementId` (uplift: dynamic vision switching) previews THE PENDING
 * ENTRY: options come from `optionsForPending`, so the list the operator
 * previews is the list `uap models apply` / the resolve route will enforce —
 * same cells, same capability class. A vision park previewed by model
 * instead would show the starved arm's own reuse/load options (the arm IS
 * resident) while Apply enforces a DIFFERENT vision option, and the
 * `expectedVictims` drift check would refuse the apply with a
 * victim-set-changed error for a list the UI never showed. */
export function getPlacementPreview(
  projectDir: string,
  requestedModel: string,
  opts?: {
    cells?: number;
    taskKind?: string;
    registry?: ModelRegistry;
    ledgerPath?: string;
    placementId?: string;
  },
): ReturnType<typeof computeOptions> {
  const registry = opts?.registry ?? loadModelRegistry(projectDir).registry;
  const ledgerPath = opts?.ledgerPath ?? placementLedgerPath();
  const ledger = loadLedger(ledgerPath);
  if (opts?.placementId !== undefined) {
    const pending = ledger.pending.find((p) => p.id === opts.placementId);
    if (!pending) {
      return {
        requested: requestedModel,
        matched: false,
        reason: 'not_in_registry',
        options: [],
        notes: [`pending placement ${opts.placementId} not found (expired or resolved)`],
      };
    }
    return optionsForPending(registry, ledger, pending);
  }
  return computeOptions(registry, ledger, requestedModel, {
    cells: opts?.cells,
    taskKind: opts?.taskKind,
  });
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
  /** Park CLASS, sent by the proxy on a response-side park (the upstream
   * answered, so the proxy — not the controller — knows why). Closed
   * allowlist: only 'vision_encoder_oom' is honored, everything else is
   * ignored and the admission reason is derived as usual. The value is
   * never persisted free-form; the ledger records the structured
   * `capability` field, not this string. */
  reason?: string;
  /** True when the client's request carries an image block (the proxy
   * walks the body once and knows). An image-bearing request never
   * FORWARDS to a text-only arm (config-level vision 'none'): that
   * forward would silently drop the image and answer from the text alone
   * with HTTP 200 — the exact silent-degradation class this fleet
   * refuses (live-probed on squid5090: a 1x1-pixel image answered a
   * hallucinated description, no error). Instead the resident is skipped
   * and the park resolves by switching to the requested model's
   * IMAGE-CAPABLE configs ('cpu'/'gpu'/'dynamic' — 'dynamic' can encode;
   * the encoder-OOM class is a memory event, not a capability gap), so
   * the client's retry lands on an arm that can actually encode. */
  carries_image?: boolean;
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

/** Model ids are opaque tokens, not prose. The registry's own ids never
 * leave [A-Za-z0-9._-]. An id that fails this class of check can still be
 * legitimate: backends serve human-readable WIRE ids ("Inkling 2 Mini"),
 * and those resolve to registry keys through the exact-match `advertises`
 * scan in getPlacementAdmit BEFORE this gate decides — the registry is the
 * trust anchor, and only its own keys ever flow into operator-facing
 * attention-queue text (title/detail) and from there into the session-start
 * prompt. An id that matches nothing the registry declared parks as
 * invalid_request BEFORE any queue write, so a hostile id can never become
 * a durable, self-reasserting injection channel wearing the queue's
 * trusted framing. */
const MODEL_ID_RE = /^[A-Za-z0-9._-]+$/;

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
  if (typeof request.model_id !== 'string' || !request.model_id) {
    return { decision: 'park', reason: 'invalid_request' };
  }
  // The registry loads BEFORE the charset gate because it IS the gate's
  // trust anchor for the id itself. Backends serve wire ids the registry
  // declares in `advertises` — human-readable ones ("Inkling 2 Mini",
  // spaces and all) that the raw charset check refuses, AND charset-safe
  // alias ids ("inkling2-mini-basalt-nvfp4") that pass it. BOTH resolve
  // to the registry model key here through the same EXACT-match scan, so
  // the id that flows everywhere downstream (resident check, options,
  // excludeReuseOf, pending entry, attention text) is uniform: every
  // comparison is key-to-key and the operator's apply surface never sees
  // a wire id. The injection property in MODEL_ID_RE's docstring holds
  // unchanged — only strings the registry declared resolve, only keys
  // reach the queue text. (A charset-safe id the registry does not
  // declare flows RAW: unknown_model is its decision class downstream,
  // not invalid_request.)
  const loaded = opts?.loaded ?? loadModelRegistry(projectDir);
  const registry = loaded.registry;
  let requested = request.model_id;
  // Off-charset registry keys enter the scan too (asked directly they
  // resolve or park either way) — the condition below is the ONLY split
  // between "already the right id" and "needs resolution".
  if (registry.models[requested] === undefined || !MODEL_ID_RE.test(requested)) {
    const advertised = Object.entries(registry.models).find(([, m]) =>
      (m.advertises ?? []).includes(requested),
    );
    const resolvedKey = advertised?.[0];
    if (resolvedKey !== undefined) {
      if (!MODEL_ID_RE.test(resolvedKey)) {
        return { decision: 'park', reason: 'invalid_request' };
      }
      requested = resolvedKey;
    } else if (!MODEL_ID_RE.test(requested)) {
      // Off-charset AND declared by no registry model: the injection class.
      return { decision: 'park', reason: 'invalid_request' };
    }
  }
  // Request-driven context need: the proxy's honest estimate, clamped to
  // positive integers; anything off-shape degrades to the computeOptions
  // default rather than being trusted (the proxy is a local process, but
  // the ledger persists what it says, so it is validated anyway).
  const cells =
    typeof request.cells === 'number' && Number.isInteger(request.cells) && request.cells > 0
      ? request.cells
      : undefined;
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

  // A vision-encoder-OOM park (proxy response-side classification): the
  // requested arm IS resident and serving text, but its image encoder
  // cannot get device memory. The resident-forward branch below is exactly
  // the bug in that case — it would forward straight back into the
  // failure — so a vision park skips it: the resolution is a SWITCH, and
  // the options come from the registry's vision-capable arms, never from
  // the requested model's own configs.
  const visionOom = request.reason === 'vision_encoder_oom';

  // A text-only resident (config-level vision 'none') is the OTHER class
  // that must not forward: an image-bearing request would arrive, the
  // engine would drop the image blocks on the floor, and the client would
  // read a confident text-only answer as the model having SEEN the image
  // (live-probed on squid5090: 1x1 pixel -> "Skull", HTTP 200). Unlike the
  // OOM park this one is decided BEFORE the forward, from the registry's
  // capability facts — carries_image is the proxy's body walk, the
  // registry's vision field is the fleet's declared truth, and neither is
  // a guess. The resident still serves TEXT for this id (no park for
  // text requests), so only the image-bearing request class diverts.
  const carriesImage = request.carries_image === true;
  const servingResident = visionOom
    ? undefined
    : ledger.residents.find(
        (r) => r.state !== 'draining' && residentServes(r, requested, registry),
      );
  const residentTextOnly =
    carriesImage &&
    servingResident !== undefined &&
    effectiveVision(
      registry.models[servingResident.model] ?? { display: '', configs: {} },
      registry.models[servingResident.model]?.configs[servingResident.config],
    ) === 'none';

  // Forward on reuse: a live resident serves this id. Draining residents
  // don't count — a swap is in flight.
  const resident = residentTextOnly ? undefined : servingResident;
  if (resident) {
    // Idle-sweep clock (§4.4.2): a gated request just used this model.
    // Fail-soft by design — the touch only delays a future idle unload,
    // it must never block or slow the forward the proxy is waiting on
    // (2s admit timeout). Two layers keep that promise: the SHORT lock fuse
    // (250ms) bounds a contention stall, and the catch turns a lost touch
    // into a later unload — the conservative direction either way.
    try {
      withLedger(ledgerPath, (l) => {
        l.usage[resident.model] = Date.now();
      }, { lockTimeoutMs: 250 });
    } catch {
      /* advisory clock only — see above */
    }
    return { decision: 'forward', target_id: residentTargetId(resident) };
  }

  // Park. The reason comes from the registry, never a guess: unknown model,
  // known but unmeasured (fail closed), or known+measured but not loaded.
  // A vision park keeps its own reason — the requested model's registry
  // state is irrelevant, the failure is about its encoder (OOM) or its
  // capability (text-only), not its load.
  let reason: string = visionOom
    ? 'vision_encoder_oom'
    : residentTextOnly
      ? 'vision_text_only_arm'
      : 'not_resident';
  if (!visionOom && !residentTextOnly) {
    // The resolution above guarantees `requested` is a registry key or an
    // unregistered charset-safe id — never a raw advertised alias — so
    // the direct lookup is the only one that can fire.
    const modelEntry = registry.models[requested];
    if (!modelEntry) {
      reason = 'unknown_model';
    } else if (!Object.values(modelEntry.configs).some(isPlaceable)) {
      reason = 'no_measured_config';
    }
  }

  // Auto-resolution (phase 4): a known, placeable model that is not
  // resident can load ITSELF — alongside always (nothing evicted), by
  // displacement only for operator-allowlisted models. The park reason
  // becomes auto_loading; the client's retry is the protocol and forwards
  // once the load completes. Unmeasured/unknown models never auto-load,
  // and neither does a model in its failure cooldown or past the
  // in-flight cap — autoOptionFor gates all of it so the reason never
  // promises a run that will be refused.
  // For a vision park the auto target is a DIFFERENT arm: the
  // vision-capable options (load_alongside first, displacement of the
  // starved arm only for allowlisted models — the same standing-consent
  // rule, now guarding a switch as well as a load). The starved arm is
  // never a reuse candidate: reusing it resolves nothing. A text-only
  // resident's park is the same shape with a different candidate set:
  // the requested model's IMAGE-CAPABLE configs (the family's own
  // vision arm — 'dynamic' encodes; only the OOM class distrusts it),
  // so the retry switches within the family instead of across it.
  let visionOptionCount = 0;
  let autoPlan: ReturnType<typeof autoOptionFor> = null;
  if (visionOom) {
    const options = computeOptions(registry, ledger, requested, {
      cells,
      capability: 'vision',
      excludeReuseOf: requested,
    }).options;
    visionOptionCount = options.length;
    autoPlan = autoOptionFor(options, opts?.auto?.policy ?? loadAutoPolicy(), requested);
    // A DISTINCT reason, additive per the §4.3 contract: the generic
    // auto_loading message says "model X is being loaded" — false for a
    // switch, where a DIFFERENT vision-capable arm is loaded and the
    // starved one may be displaced. The 409 body says what is happening.
    if (autoPlan) reason = 'vision_auto_loading';
  } else if (residentTextOnly) {
    const options = computeOptions(registry, ledger, requested, {
      cells,
      capability: 'image',
    }).options;
    visionOptionCount = options.length;
    autoPlan = autoOptionFor(options, opts?.auto?.policy ?? loadAutoPolicy(), requested);
    if (autoPlan) reason = 'vision_auto_loading';
  } else if (reason === 'not_resident') {
    // An image-bearing request that is not resident auto-loads only an
    // image-capable config of the requested model — never the family's
    // text-only arm (that load would forward the image into the same
    // silent drop the resident check above exists to prevent).
    const options = computeOptions(registry, ledger, requested, {
      cells,
      ...(carriesImage ? { capability: 'image' as const } : {}),
    }).options;
    autoPlan = autoOptionFor(options, opts?.auto?.policy ?? loadAutoPolicy(), requested);
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
  // A vision park and a not-resident park for the same (model, client) are
  // DIFFERENT decisions — one wants a switch, the other a load — so the
  // dedupe key carries the capability class too. The text-only park is
  // the same capability class ('vision'): an image retry must hit the
  // image park, while a TEXT retry for the same model must forward —
  // the resident still serves text.
  const capabilityKey = visionOom || residentTextOnly ? 'vision' : '';
  const matchesPending = (p: LedgerPending): boolean =>
    p.requested_model === requested &&
    (p.client ?? '') === clientKey &&
    (p.capability ?? '') === capabilityKey &&
    p.expires_at > now.toISOString();

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
    // The registry key (wire ids resolved above): the operator's apply
    // surface names registry keys, so the entry must too.
    requested_model: requested,
    client,
    session,
    created_at: now.toISOString(),
    expires_at: expiresAt,
    reason,
    cells,
    // Both vision-class parks carry the structured capability — the CLI's
    // pending list recomputes a vision entry's SWITCH options, and the
    // proxy's image-burst dedupe keys on it.
    ...(visionOom || residentTextOnly ? { capability: 'vision' as const } : {}),
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
    // must not promise a load that will never run. A vision park keeps
    // its own class here too: 'not_resident' would say the arm is not
    // loaded (it is) and point the client at an apply step for an entry
    // that was never persisted.
    return {
      decision: 'park',
      placement_id: placementId,
      reason: autoPlan
        ? visionOom
          ? 'vision_encoder_oom'
          : residentTextOnly
            ? 'vision_text_only_arm'
            : 'not_resident'
        : reason,
    };
  }
  if (autoPlan && placementId === pending.id) {
    // Our entry won the race and auto-load applies: fire the background
    // enforcement for exactly this placement id (a concurrent winner
    // schedules its own). The client retries on the floor and forwards
    // once the load lands.
    scheduleAutoResolution(registry, requested, autoPlan, placementId, {
      ledgerPath,
      // The run's step-0 re-derive must see the same context need the
      // option was computed against, or a small-pool load refuses itself.
      cells,
      enforce: opts?.auto?.enforce,
      // A vision run re-derives against the vision-capable candidate set,
      // not the requested model's — its approved option loads a DIFFERENT
      // arm, and the model-scoped re-derivation would flag exactly that as
      // "drift" and refuse its own switch. A text-only park's switch
      // re-derives against the requested model's IMAGE-CAPABLE configs
      // (same drift protection, family-scoped: the switch target is the
      // same model key under a different config); an image-bearing
      // not-resident load re-derives the same way so the run cannot
      // "drift" onto the text-only config it was never offered.
      ...(visionOom
        ? { capability: 'vision' as const, excludeReuseOf: requested }
        : residentTextOnly || carriesImage
          ? { capability: 'image' as const }
          : {}),
    });
    return { decision: 'park', placement_id: placementId, reason };
  }
  if (raceWinnerReason !== undefined) {
    // A concurrent admit won the write race: its entry (and its auto run,
    // if any) is the real state — report ITS reason, not our locally
    // computed one (which may promise a load the winner never scheduled).
    return { decision: 'park', placement_id: placementId, reason: raceWinnerReason };
  }
  // P3 — the ask that lingers: our pending entry landed, nothing auto-loads
  // it, and the only outcomes are the operator applying an option or the
  // TTL expiring. That is exactly an attention item (ask instead of
  // silently lingering). Best-effort by construction: enqueueAttention is
  // fail-open end-to-end and UAP_ATTENTION_OFF disables the rail — the
  // admit path's 2s budget must never feel this.
  //
  // The item's grace deadline is PINNED to the pending entry's expiry: a
  // generic 300s grace would outlive the 120s TTL and advertise an
  // actionable swap for a pending that is already dead — and a sweep
  // adopting "let it expire" before the expiry would be a false record.
  // `not_resident` is the only load-park reason with options to apply; a
  // vision park (either class) is actionable when a capable switch target
  // exists. The no-option reasons (unknown_model, no_measured_config, a
  // vision park with no capable arm) ask the operator to LOOK, not to
  // decide — the detail says so plainly.
  const visionPark = visionOom || residentTextOnly;
  const actionable = reason === 'not_resident' || (visionPark && visionOptionCount > 0);
  enqueueAttention(projectDir, {
    kind: 'review-request',
    title: visionOom
      ? `Vision parked: ${requested} (image encoder OOM)`
      : residentTextOnly
        ? `Vision parked: ${requested} (text-only serving arm)`
        : `Placement parked: ${requested}`,
    detail: actionable
      ? visionOom
        ? `The resident arm '${requested}' cannot encode images right now (its image encoder cannot get device memory). ${visionOptionCount} vision-capable switch option(s) registered. Approve a switch with: uap models apply ${pending.id} <n> — or do nothing.`
        : residentTextOnly
          ? `An image-bearing request wants '${requested}' but the serving arm is TEXT-ONLY (vision 'none'): forwarding would silently drop the image. ${visionOptionCount} image-capable switch option(s) registered. Approve a switch with: uap models apply ${pending.id} <n> — or do nothing.`
          : `A gated request wants '${requested}' (reason: ${reason}, placement ${pending.id}). Approve a swap with: uap models apply ${pending.id} <n> — or do nothing.`
      : `A gated request wants '${requested}' (reason: ${reason}, placement ${pending.id}). No registered option serves it — nothing to approve; it expires on its own.`,
    source: `placement:${pending.id}`,
    expiresAt: pending.expires_at,
    safeDefault: {
      decision: 'allow the parked request to expire',
      rationale: 'the placement TTL is the default: the client falls back cleanly and nothing is loaded or evicted',
    },
  });
  return { decision: 'park', placement_id: placementId, reason };
}
