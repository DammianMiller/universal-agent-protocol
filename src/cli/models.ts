/**
 * `uap models` — model placement surface (spec §4.7).
 *
 *   validate — registry (repo + machine-local merge) ↔ capacity-policy
 *              cross-check, provenance per measured config. Read-only.
 *   measure  — record the LIVE backend's footprint into
 *              ~/.uap/model-registry.json. Fails closed on anything
 *              unverifiable.
 *   status   — sync + print the placement ledger: devices (probe fact),
 *              residents, headroom.
 *   pending  — list parked placement requests awaiting the operator, with
 *              ranked options (1-based, what `apply` takes).
 *   apply    — the explicit operator yes: prints the impact list first,
 *              then enforces (drain → stop → verify-free → start → verify
 *              → refresh), rolling back on any failure. --yes required.
 *   dismiss  — refuse a parked request; the client falls back on expiry.
 *   load     — operator-initiated load; reuse/load-alongside only, never
 *              displacement (displacement needs the pending path).
 *   unload   — drain, stop, verify-free, refresh for a model's residents.
 *   units    — write Conflicts= drop-ins for same-device units (systemd
 *              itself then refuses two same-device residents).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  REGISTRY_VERSION,
  configCostMiB,
  isMeasuredConfig,
  loadModelRegistry,
  validateRegistry,
  type ModelRegistry,
} from '../placement/registry.js';
import {
  gpuComputeMiB,
  gpuStatsByIndex,
  hostRssMiB,
  hostTotalMiB,
  listeningPortPid,
  unitCgroupPids,
  unitMainPid,
  isUnitActive,
} from '../placement/probes.js';
import {
  loadLedger,
  placementLedgerPath,
  residentTargetId,
  syncLedger,
  type LedgerResident,
  type PlacementLedger,
} from '../placement/ledger.js';
import { computeOptions } from '../placement/admission.js';
import { buildVictimPreviews } from '../placement/preview.js';
import {
  resolvePendingPlacement,
  dismissPendingPlacement,
  loadPlacement,
  unloadPlacement,
  writePlacementUnitDropins,
  fetchProxyInflight,
} from '../placement/enforce.js';
import {
  autoPolicyPath,
  loadAutoPolicy,
  saveAutoPolicy,
  type AutoPolicy,
} from '../placement/auto.js';
import { loadPolicy } from '../capacity/probe.js';
import { looksLikeStrataMetrics, parseStrataEngine } from '../inference/strata.js';

const PROBE_TIMEOUT_MS = 5000;

function fail(msg: string): never {
  throw new Error(msg);
}

async function fetchMetrics(endpoint: string): Promise<unknown> {
  const url = `${endpoint.replace(/\/+$/, '')}/metrics`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function endpointPort(endpoint: string): number | null {
  try {
    return new URL(endpoint).port ? Number(new URL(endpoint).port) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export interface ModelsValidateOptions {
  projectDir?: string;
  repoPath?: string;
  localPath?: string;
}

export async function modelsValidateCommand(opts: ModelsValidateOptions = {}): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const loaded = loadModelRegistry(projectDir, { repoPath: opts.repoPath, localPath: opts.localPath });
  for (const err of loaded.errors) console.error(`registry error: ${err}`);
  let findings: ReturnType<typeof validateRegistry> = [];
  try {
    const { policy } = loadPolicy(projectDir);
    findings = validateRegistry(loaded.registry, policy);
  } catch (err) {
    console.error(`capacity policy unavailable: ${(err as Error).message}`);
  }

  console.log(`repo registry:   ${loaded.repoPath}${existsSync(loaded.repoPath) ? '' : '  (missing)'}`);
  console.log(`local registry:  ${loaded.localPath}${existsSync(loaded.localPath) ? '' : '  (missing — no measured footprints on this machine)'}`);
  console.log('');
  for (const [dKey, dev] of Object.entries(loaded.registry.devices)) {
    const total = dev.total_mib !== undefined ? `${dev.total_mib} MiB` : 'total unmeasured';
    const reserved = dev.reserved_mib !== undefined ? `, ${dev.reserved_mib} MiB reserved` : ', reserve unmeasured';
    console.log(`device ${dKey}: ${dev.kind}, ${total}${reserved}`);
  }
  console.log('');
  for (const [mKey, model] of Object.entries(loaded.registry.models)) {
    console.log(`${model.display}  (${mKey})`);
    for (const [cKey, cfg] of Object.entries(model.configs)) {
      if (isMeasuredConfig(cfg)) {
        const src = loaded.measuredFrom.get(`${mKey}/${cKey}`);
        const cost = configCostMiB(cfg, cfg.kv_resident_cells);
        console.log(`  ${cKey}: measured — ${cfg.resident_gpu_mib} MiB GPU, ${cfg.host_rss_mib} MiB RSS, kv ${cfg.kv_kind ?? '?'} (${cfg.kv_resident_cells}/${cfg.context_pool_cells} cells) [${src}]` + (cost === null ? '  cost above pool: unknown' : ''));
      } else {
        console.log(`  ${cKey}: unmeasured — fails closed (servable if resident, never loadable)`);
      }
    }
  }
  console.log('');
  if (findings.length > 0) {
    for (const f of findings) console.error(`${f.severity === 'error' ? 'ERROR' : 'WARN '}  ${f.scope}: ${f.message}`);
  } else {
    console.log('validate: no findings');
  }
  const errors = loaded.errors.length + findings.filter((f) => f.severity === 'error').length;
  return errors > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------------

export interface ModelsMeasureOptions {
  model?: string;
  config?: string;
  endpoint?: string;
  device?: string;
  projectDir?: string;
  repoPath?: string;
  localPath?: string;
  dryRun?: boolean;
}

interface MeasureTarget {
  modelKey: string;
  configKey: string;
  registry: ModelRegistry;
}

/** Find the registry entry the live backend's advertised model id maps to.
 * Exactly one match or explicit --model/--config; ambiguity is an error, not
 * a guess — attributing a measurement to the wrong entry poisons the
 * registry. */
function resolveMeasureTarget(registry: ModelRegistry, liveModel: string | undefined, modelKey: string | undefined, configKey: string | undefined): MeasureTarget {
  const wantExplicit = modelKey !== undefined || configKey !== undefined;
  if (wantExplicit && (modelKey === undefined || configKey === undefined)) {
    fail('--model and --config must be given together');
  }
  if (modelKey !== undefined && configKey !== undefined) {
    const entry = registry.models[modelKey]?.configs[configKey];
    if (!entry) fail(`no registry config '${modelKey}/${configKey}'`);
    const advertises = registry.models[modelKey].advertises ?? [];
    if (liveModel && advertises.length > 0 && !advertises.includes(liveModel)) {
      fail(`live backend advertises '${liveModel}' but ${modelKey} advertises [${advertises.join(', ')}] — refusing to attribute this measurement`);
    }
    return { modelKey, configKey, registry };
  }
  const matches: MeasureTarget[] = [];
  for (const [mKey, model] of Object.entries(registry.models)) {
    if (!liveModel) continue;
    if ((model.advertises ?? []).includes(liveModel)) {
      const configKeys = Object.keys(model.configs);
      for (const cKey of configKeys) matches.push({ modelKey: mKey, configKey: cKey, registry });
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) fail(`no registry entry advertises '${liveModel ?? '?'}' — pass --model <key> --config <key> to attribute the measurement`);
  fail(`ambiguous: ${matches.map((m) => `${m.modelKey}/${m.configKey}`).join(', ')} all advertise '${liveModel}' — pass --model and --config`);
}

export async function modelsMeasureCommand(opts: ModelsMeasureOptions = {}): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const loaded = loadModelRegistry(projectDir, { repoPath: opts.repoPath, localPath: opts.localPath });
  for (const err of loaded.errors) console.error(`registry error: ${err}`);
  if (loaded.errors.length > 0) return 1;

  const endpoint = opts.endpoint ?? 'http://127.0.0.1:8080';
  const metrics = await fetchMetrics(endpoint).catch((err: Error) => fail(`${err.message} — is the backend live? measure only works against a resident backend`));
  if (!looksLikeStrataMetrics(metrics)) fail(`${endpoint}/metrics is not a strata metrics document — v1 measure supports strata-kind backends only`);
  const { engine } = parseStrataEngine(metrics);
  if (engine.maxContext === undefined) fail('/metrics engine.max_context missing — refusing to guess the context pool');
  if (engine.kvResident === undefined) fail('/metrics engine.kv_resident missing — refusing to guess the resident KV pool');
  if (engine.model === undefined) fail('/metrics engine.model missing — cannot attribute the measurement');

  const target = resolveMeasureTarget(loaded.registry, engine.model, opts.model, opts.config);
  const model = loaded.registry.models[target.modelKey];
  const entry = model.configs[target.configKey];

  const unit = entry.unit ?? model.unit;
  const port = endpointPort(endpoint);
  // Prefer the unit's whole cgroup (multi-process backends), then MainPID,
  // then the port listener (unit-less single-process backends).
  const mainPid = unit ? unitMainPid(unit) : null;
  const pids = (unit ? unitCgroupPids(unit) : null) ?? (mainPid ? [mainPid] : null) ?? (port ? [listeningPortPid(port) as number] : []);
  if (pids.length === 0) fail(`cannot find the backend processes (unit '${unit ?? 'none'}', port ${port ?? '?'}) — nothing to measure`);

  const residentGpu = gpuComputeMiB(pids);
  if (residentGpu === null) fail(`nvidia-smi shows no GPU memory held by [${pids.join(', ')}] — refusing to record zero; is the backend on the GPU?`);
  const rss = hostRssMiB(pids);
  if (rss === null) fail(`no /proc/<pid>/status readable for [${pids.join(', ')}] — refusing to guess host RSS`);

  const device = opts.device ?? Object.entries(loaded.registry.devices).find(([, d]) => d.kind === 'gpu')?.[0] ?? 'gpu0';
  // Identity fields (unit/profile/service/...) come from the merged entry so
  // the measured write never drops how the config was found.
  const measured = {
    engine: entry.engine,
    unit: entry.unit,
    profile: entry.profile,
    service: entry.service,
    note: entry.note,
    flags: entry.flags,
    rails: entry.rails,
    resident_gpu_mib: residentGpu,
    host_rss_mib: rss,
    context_pool_cells: engine.maxContext,
    kv_resident_cells: engine.kvResident,
    kv_kind: engine.kv,
    measured_at: new Date().toISOString(),
    measured_on: device,
  };

  console.log(`${target.modelKey}/${target.configKey} (${pids.join(', ')}${unit ? `, unit ${unit}` : ''}):`);
  console.log(`  resident_gpu_mib: ${residentGpu}`);
  console.log(`  host_rss_mib:     ${rss}`);
  console.log(`  context_pool:     ${engine.maxContext} cells, kv ${engine.kv ?? '?'} resident ${engine.kvResident}`);

  // Device facts (spec §4.1.1): the gpu reserve is DERIVED — capacity minus
  // free minus the backend's own compute apps — so unattributed graphics
  // memory lands in the reserve whether or not a PID owns it. The cpu
  // reserve is the documented spec floor, not a measurement.
  const deviceFacts: Record<string, unknown> = {};
  const gpuIdx = /^gpu(\d+)$/.exec(device);
  if (gpuIdx) {
    const stats = gpuStatsByIndex().get(Number(gpuIdx[1]));
    if (stats?.total_mib !== undefined && stats?.free_mib !== undefined) {
      const reserved = Math.max(0, stats.total_mib - stats.free_mib - residentGpu);
      deviceFacts[device] = {
        kind: 'gpu',
        total_mib: stats.total_mib,
        reserved_mib: reserved,
        reserve_reason: `derived: total ${stats.total_mib} − free ${stats.free_mib} − backend compute apps ${residentGpu}; captures desktop + unattributed graphics memory`,
      };
      console.log(`  ${device}: total ${stats.total_mib} MiB, derived reserve ${reserved} MiB (desktop + graphics)`);
    }
  }
  const hostTotal = hostTotalMiB();
  if (hostTotal !== null) {
    deviceFacts.cpu0 = {
      kind: 'cpu',
      total_mib: hostTotal,
      reserved_mib: 8192,
      reserve_reason: 'spec §4.1 floor: page cache and the TS side must survive a 52 GiB engine attach',
    };
    console.log(`  cpu0: total ${hostTotal} MiB, reserve 8192 MiB (spec floor)`);
  }

  if (opts.dryRun) {
    console.log('dry-run: nothing written');
    return 0;
  }

  const localPath = loaded.localPath;
  let localDoc: { version?: number; devices?: ModelRegistry['devices']; models?: ModelRegistry['models'] } = {};
  if (existsSync(localPath)) {
    localDoc = JSON.parse(readFileSync(localPath, 'utf-8')) as typeof localDoc;
  }
  if (localDoc.version !== undefined && localDoc.version !== REGISTRY_VERSION) {
    fail(`${localPath}: unsupported version ${localDoc.version} (expected ${REGISTRY_VERSION}) — refusing to clobber`);
  }
  localDoc.version = REGISTRY_VERSION;
  localDoc.models = localDoc.models ?? {};
  if (Object.keys(deviceFacts).length > 0) {
    localDoc.devices = { ...localDoc.devices, ...deviceFacts } as typeof localDoc.devices;
  }
  const localModel = (localDoc.models[target.modelKey] = localDoc.models[target.modelKey] ?? { display: model.display, configs: {} });
  localModel.configs = localModel.configs ?? {};
  localModel.configs[target.configKey] = measured;

  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, `${JSON.stringify(localDoc, null, 2)}\n`);
  console.log(`written: ${localPath}`);
  console.log('next: uap models validate');
  return 0;
}

// ---------------------------------------------------------------------------
// status / pending
// ---------------------------------------------------------------------------

export interface ModelsStatusOptions {
  projectDir?: string;
  repoPath?: string;
  localPath?: string;
  ledgerPath?: string;
}

function printLedger(ledger: PlacementLedger): void {
  for (const [dKey, dev] of Object.entries(ledger.devices)) {
    const free = dev.free_mib !== undefined ? `${dev.free_mib} MiB free` : 'free unprobed';
    const total = dev.total_mib !== undefined ? `${dev.total_mib} MiB total` : 'total unmeasured';
    const reserved = dev.reserved_mib !== undefined ? `, ${dev.reserved_mib} reserved` : ', reserve unmeasured';
    console.log(`device ${dKey}: ${dev.kind}, ${total}, ${free}${reserved}  [${dev.source ?? '?'}]`);
  }
  console.log('');
  if (ledger.residents.length === 0) {
    console.log('residents: none');
  }
  for (const r of ledger.residents) {
    const gpu = r.gpu_mib !== undefined ? `, ${r.gpu_mib} MiB GPU` : ', GPU unknown';
    const rss = r.host_rss_mib !== undefined ? `, ${r.host_rss_mib} MiB RSS` : '';
    console.log(`resident ${r.model}/${r.config}  ${r.state} on ${r.device}${gpu}${rss}${r.unit ? `  (${r.unit})` : ''}`);
  }
  console.log('');
  console.log(ledger.pending.length === 0 ? 'pending: none' : `pending: ${ledger.pending.length}`);
  for (const p of ledger.pending) {
    console.log(`  ${p.id} ${p.requested_model} (client ${p.client ?? '?'}, expires ${p.expires_at}) — ${p.reason ?? 'parked'}`);
  }
}

export async function modelsStatusCommand(opts: ModelsStatusOptions = {}): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const loaded = loadModelRegistry(projectDir, { repoPath: opts.repoPath, localPath: opts.localPath });
  for (const err of loaded.errors) console.error(`registry error: ${err}`);
  if (loaded.errors.length > 0) return 1;
  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  const ledger = syncLedger(loaded.registry, ledgerPath, isUnitActive);
  printLedger(ledger);
  return 0;
}

export async function modelsPendingCommand(opts: ModelsStatusOptions = {}): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  const ledger = loadLedger(ledgerPath);
  if (ledger.pending.length === 0) {
    console.log('no pending placement requests');
    return 0;
  }
  const loaded = loadModelRegistry(projectDir, { repoPath: opts.repoPath, localPath: opts.localPath });
  const now = Date.now();
  for (const p of ledger.pending) {
    const expires = new Date(p.expires_at).getTime();
    console.log(`${p.id}  ${p.requested_model}`);
    console.log(`  client ${p.client ?? '?'}${p.session ? `, session ${p.session}` : ''}${p.pid ? `, pid ${p.pid}` : ''}`);
    console.log(`  parked ${p.created_at}, expires ${p.expires_at} (${expires > now ? `${Math.round((expires - now) / 1000)}s left` : 'EXPIRED'})`);
    console.log(`  reason: ${p.reason ?? 'parked'}`);
    // Options are per-request (spec §4.4): recompute against the context the
    // parked request actually needs, when the proxy recorded it — the 32k
    // default would fail-closed-refuse a small-pool config that fits fine.
    const options = computeOptions(loaded.registry, ledger, p.requested_model, { cells: p.cells }).options;
    if (options.length === 0) {
      console.log('  no viable option (unmeasured, unknown cost, or nothing fits)');
    }
    options.forEach((o, i) => {
      const victims = o.victims ?? [];
      const impact = victims.length
        ? ` — displaces ${victims.map((v) => `${v.model}/${v.config}`).join(', ')}`
        : '';
      console.log(`  option ${i + 1}: ${o.kind} ${o.model}/${o.config} on ${o.device}${impact}`);
    });
  }
  console.log('');
  console.log('resolve: uap models apply <id> <option> --yes   |   refuse: uap models dismiss <id>');
  return 0;
}

// ---------------------------------------------------------------------------
// apply / dismiss / load / unload / units — the operator's mutation surface
// ---------------------------------------------------------------------------

export interface ModelsApplyOptions extends ModelsStatusOptions {
  placementId?: string;
  option?: number;
  yes?: boolean;
}

export async function modelsApplyCommand(opts: ModelsApplyOptions = {}): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const placementId = opts.placementId ?? '';
  const option = Number(opts.option);
  if (!placementId || !Number.isInteger(option) || option < 1) {
    console.error('usage: uap models apply <placement-id> <option> [--yes]');
    return 1;
  }
  const ledgerPath = opts.ledgerPath ?? placementLedgerPath();
  const pending = loadLedger(ledgerPath).pending.find((p) => p.id === placementId);
  if (!pending) {
    console.error(`no pending placement ${placementId} (run: uap models pending)`);
    return 1;
  }
  const loaded = loadModelRegistry(projectDir, { repoPath: opts.repoPath, localPath: opts.localPath });
  // The operator approves the option list the PARKED REQUEST computed against
  // its own context need (recorded in the entry) — not the 32k default, which
  // can refuse a config that serves this request fine.
  const options = computeOptions(loaded.registry, loadLedger(ledgerPath), pending.requested_model, {
    cells: pending.cells,
  }).options;
  const approved = options[option - 1];
  if (!approved) {
    console.error(`option ${option} does not exist (1-${options.length})`);
    return 1;
  }
  // Print the impact list first (spec §4.7): the operator approves KNOWING
  // what is killed. In-flight is the proxy's live view when it answers;
  // otherwise the honest `unknown`.
  if (approved.victims?.length) {
    const inflightMap = await fetchProxyInflight();
    const inflightOf = (victim: LedgerResident): boolean | 'unknown' => {
      if (inflightMap === null) return 'unknown';
      const entries = inflightMap.get(residentTargetId(victim));
      return entries !== undefined ? entries.length > 0 : 'unknown';
    };
    console.log('impact:');
    for (const v of buildVictimPreviews(loaded.registry, approved.victims, inflightOf)) {
      console.log(`  ${v.model}/${v.config} on ${v.device}: ${v.consequence} (frees ${v.frees_gpu_mib} MiB GPU)`);
    }
  } else {
    console.log(`impact: none (${approved.kind} ${approved.model}/${approved.config})`);
  }
  if (!opts.yes) {
    console.log('');
    console.log(`confirm: uap models apply ${placementId} ${option} --yes`);
    return 1;
  }
  // The approval signature: what is enforced must be exactly what the
  // impact list above showed (a recomputed drift between print and enforce
  // refuses instead of displacing a set the operator never saw).
  const result = await resolvePendingPlacement(projectDir, placementId, option, {
    ledgerPath,
    expectedVictims: (approved.victims ?? []).map((v) => ({ model: v.model, config: v.config })),
  });
  for (const s of result.steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  if (!result.ok) {
    console.error(`enforcement failed${result.rolledBack ? ' (rolled back)' : ''}: ${result.error}`);
    return 1;
  }
  console.log('placement applied; the parked client is served on its next retry');
  return 0;
}

export async function modelsDismissCommand(opts: { placementId?: string; ledgerPath?: string } = {}): Promise<number> {
  const placementId = opts.placementId ?? '';
  if (!placementId) {
    console.error('usage: uap models dismiss <placement-id>');
    return 1;
  }
  const { dismissed } = dismissPendingPlacement(placementId, { ledgerPath: opts.ledgerPath });
  console.log(dismissed ? `dismissed ${placementId}; the client falls back on its next retry` : `no pending placement ${placementId}`);
  return dismissed ? 0 : 1;
}

export async function modelsLoadCommand(opts: { model?: string } & ModelsStatusOptions = {}): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const model = opts.model ?? '';
  if (!model) {
    console.error('usage: uap models load <model-key>');
    return 1;
  }
  const result = await loadPlacement(projectDir, model, { ledgerPath: opts.ledgerPath });
  for (const s of result.steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  return 0;
}

export async function modelsUnloadCommand(opts: { model?: string } & ModelsStatusOptions = {}): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const model = opts.model ?? '';
  if (!model) {
    console.error('usage: uap models unload <model-key>');
    return 1;
  }
  const result = await unloadPlacement(projectDir, model, { ledgerPath: opts.ledgerPath });
  for (const s of result.steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  return 0;
}

export async function modelsUnitsCommand(opts: ModelsStatusOptions = {}): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const loaded = loadModelRegistry(projectDir, { repoPath: opts.repoPath, localPath: opts.localPath });
  const { written, dir } = writePlacementUnitDropins(loaded.registry);
  if (written.length === 0) {
    console.log('no same-device unit pairs in the registry; nothing to write');
    return 0;
  }
  for (const w of written) console.log(`wrote ${w}`);
  console.log(`(Conflicts= drop-ins in ${dir}; the operator's unit files are untouched)`);
  return 0;
}

export interface ModelsAutoOptions {
  enable?: boolean;
  disable?: boolean;
  /** Comma-separated registry model keys to (dis)allow for auto displacement. */
  allowDisplace?: string;
  disallowDisplace?: string;
  yes?: boolean;
  policyPath?: string;
}

export function modelsAutoCommand(opts: ModelsAutoOptions = {}): number {
  const path = opts.policyPath ?? autoPolicyPath();
  const policy = loadAutoPolicy(path);
  if (opts.enable === true && opts.disable === true) {
    console.error('--enable and --disable are mutually exclusive; pick one');
    return 1;
  }
  const wantsChange =
    opts.enable === true || opts.disable === true || !!opts.allowDisplace || !!opts.disallowDisplace;
  if (!wantsChange) {
    console.log(`auto-load: ${policy.enabled ? 'enabled' : 'disabled'} (${path})`);
    console.log('  non-displacing options (load-alongside) load automatically when the policy is enabled');
    console.log(`  auto-displacement allowlist: ${policy.allow_displace.length ? policy.allow_displace.join(', ') : '(empty — displacement always parks for the operator)'}`);
    return 0;
  }
  const next: AutoPolicy = { ...policy, allow_displace: [...policy.allow_displace] };
  if (opts.enable === true) next.enabled = true;
  if (opts.disable === true) next.enabled = false;
  const parseList = (v: string): string[] => v.split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.allowDisplace) {
    const adding = parseList(opts.allowDisplace);
    if (!opts.yes) {
      console.log('auto-displacement means: a parked request for these models UNLOADS the current');
      console.log('resident(s) — the minimal set that makes room, re-evaluated at load time — and');
      console.log('loads the requested one WITHOUT an operator prompt between them.');
      console.log(`models: ${adding.join(', ')}`);
      console.log(`confirm: uap models auto --allow-displace ${opts.allowDisplace} --yes`);
      return 1;
    }
    for (const m of adding) if (!next.allow_displace.includes(m)) next.allow_displace.push(m);
    console.log(`auto-displacement allowed for: ${next.allow_displace.join(', ')}`);
  }
  if (opts.disallowDisplace) {
    for (const m of parseList(opts.disallowDisplace)) {
      next.allow_displace = next.allow_displace.filter((x) => x !== m);
    }
    console.log(`auto-displacement allowed for: ${next.allow_displace.join(', ') || '(none)'}`);
  }
  saveAutoPolicy(next, path);
  console.log(`auto-load: ${next.enabled ? 'enabled' : 'disabled'} (policy written to ${path})`);
  console.log('the dashboard controller picks the policy up on its next admission (no restart needed)');
  return 0;
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export type ModelsAction =
  | 'validate'
  | 'measure'
  | 'status'
  | 'pending'
  | 'apply'
  | 'dismiss'
  | 'load'
  | 'unload'
  | 'units'
  | 'auto';

export async function modelsCommand(action: ModelsAction, opts: Record<string, unknown>): Promise<number> {
  if (action === 'validate') return modelsValidateCommand(opts as ModelsValidateOptions);
  if (action === 'measure') return modelsMeasureCommand(opts as ModelsMeasureOptions);
  if (action === 'status') return modelsStatusCommand(opts as ModelsStatusOptions);
  if (action === 'apply') return modelsApplyCommand(opts as ModelsApplyOptions);
  if (action === 'dismiss') return modelsDismissCommand(opts as { placementId?: string; ledgerPath?: string });
  if (action === 'load') return modelsLoadCommand(opts as { model?: string } & ModelsStatusOptions);
  if (action === 'unload') return modelsUnloadCommand(opts as { model?: string } & ModelsStatusOptions);
  if (action === 'units') return modelsUnitsCommand(opts as ModelsStatusOptions);
  if (action === 'auto') return modelsAutoCommand(opts as ModelsAutoOptions);
  return modelsPendingCommand(opts as ModelsStatusOptions);
}
