/**
 * The supervisor loop: observe → assess → decide → persist, debounced and
 * periodic.
 *
 * Assessments run AT MOST every debounceMs (state-change triggered) and AT
 * LEAST every intervalMs (heartbeat). State persists per run at
 * `.uap/supervise/<runId>/state.json` (atomic tmp+rename, mode 0600) and every
 * cycle appends a v-stamped record to `events.jsonl` (mode 0600).
 *
 * Action side effects are deliberately minimal — the supervisor watches, it
 * does not drive:
 *   STOP      → requestStop(): the cooperative STOP file the deliver loop
 *               already polls. NEVER a signal, never a kill.
 *   RETRY     → consumes one retry from the budget (recorded).
 *   ESCALATE  → event + console warning only, once per streak; after
 *               MAX_SUPPRESSED_ESCALATIONS unanswered repeats the loop gives
 *               up with a final 'escalation unanswered' event.
 *   VERIFY    → recorded; bounded by cfg.maxVerify (policy-side).
 *   FINISH/CONTINUE → recorded, nothing else.
 *
 * Path discipline: every directory the supervisor writes through is lstat'd
 * and realpath-checked first — a symlinked `.uap/supervise/<runId>` or
 * `.uap/deliver-runs/<runId>` (a planted redirect) throws SupervisorError
 * instead of writing outside the project.
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { join, sep } from 'path';
import { deliverRunsDir, requestStop } from '../delivery/run-state.js';
import { assessAll, type ClassifierLike } from './assess.js';
import { loadSupervisorConfig, SupervisorError } from './config.js';
import { collectObservation, runStateMtimeMs } from './observe.js';
import { decide, effectiveMaxMinutes } from './policy.js';
import type {
  Decision,
  DimensionAssessment,
  Observation,
  SupervisorAction,
  SupervisorConfig,
  SupervisorState,
} from './types.js';

export const SUPERVISE_STATE_VERSION = 1;
/** Consecutive unanswered ESCALATEs before the watcher gives up. */
export const MAX_SUPPRESSED_ESCALATIONS = 20;
const TERMINAL_STATUSES = new Set(['delivered', 'failed', 'interrupted']);

export interface SupervisorEvent {
  v: 1;
  ts: string;
  runId: string;
  kind: 'assessment' | 'action';
  action: SupervisorAction;
  reason: string;
  /** True when the action was a repeat of the last one and side effects were skipped. */
  suppressed?: boolean;
  evidence: Record<string, unknown>;
  /** Dimension name → value AND who asserted it (heuristic | classifier). */
  dimensions: Record<string, { value: boolean | number; source: 'heuristic' | 'classifier' }>;
}

export function superviseDir(projectRoot: string, runId: string): string {
  return join(projectRoot, '.uap', 'supervise', runId);
}

export function supervisorStatePath(projectRoot: string, runId: string): string {
  return join(superviseDir(projectRoot, runId), 'state.json');
}

export function supervisorEventsPath(projectRoot: string, runId: string): string {
  return join(superviseDir(projectRoot, runId), 'events.jsonl');
}

/**
 * Refuse to write through anything but a plain directory INSIDE baseDir.
 * lstat (not stat) so symlinks are seen as symlinks — including broken ones,
 * which existsSync reports as missing. Throws SupervisorError.
 */
function ensureContainedDir(baseDir: string, dir: string, label: string): void {
  for (const p of [baseDir, dir]) {
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(p);
    } catch {
      st = undefined; // absent — will be created below
    }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) {
      throw new SupervisorError(`${label}: refusing non-plain-directory path ${p}`);
    }
  }
  mkdirSync(dir, { recursive: true });
  const realBase = realpathSync(baseDir);
  const realDir = realpathSync(dir);
  if (realDir !== realBase && !realDir.startsWith(realBase + sep)) {
    throw new SupervisorError(`${label}: ${dir} escapes ${baseDir}`);
  }
}

function ensureSuperviseDir(projectRoot: string, runId: string): void {
  ensureContainedDir(join(projectRoot, '.uap', 'supervise'), superviseDir(projectRoot, runId), 'supervisor state');
}

function ensureDeliverRunDir(projectRoot: string, runId: string): void {
  ensureContainedDir(deliverRunsDir(projectRoot), join(deliverRunsDir(projectRoot), runId), 'deliver run');
}

export function freshSupervisorState(runId: string, nowIso: string): SupervisorState {
  return {
    version: SUPERVISE_STATE_VERSION,
    runId,
    startedAt: nowIso,
    updatedAt: nowIso,
    assessments: 0,
    retries: 0,
    verifyCount: 0,
    suppressedEscalations: 0,
    lastAction: null,
    lastActionAt: null,
  };
}

/**
 * Load persisted supervisor state, or a fresh one. A MISSING file is normal
 * (first watch); a file that EXISTS but is unparseable or invalid is not —
 * warn loudly, then recover fresh (fail closed means never silently dropping
 * the retry/verify budgets a previous watcher already spent).
 */
export function loadSupervisorState(
  projectRoot: string,
  runId: string,
  nowIso: string,
  warn: (message: string) => void = () => {}
): SupervisorState {
  const path = supervisorStatePath(projectRoot, runId);
  if (!existsSync(path)) return freshSupervisorState(runId, nowIso);
  const fresh = (): SupervisorState => {
    warn(`supervisor: ${path} exists but is invalid — starting fresh (budgets reset); investigate the corrupt file`);
    return freshSupervisorState(runId, nowIso);
  };
  let parsed: SupervisorState;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as SupervisorState;
  } catch {
    return fresh();
  }
  if (!parsed || parsed.version !== SUPERVISE_STATE_VERSION || typeof parsed.retries !== 'number') {
    return fresh();
  }
  parsed.runId = runId; // directory name is the identity, never the payload
  // Fields added after the first shipped state shape default, never reject.
  if (typeof parsed.verifyCount !== 'number') parsed.verifyCount = 0;
  if (typeof parsed.suppressedEscalations !== 'number') parsed.suppressedEscalations = 0;
  return parsed;
}

/**
 * Persist state atomically (tmp + rename), mode 0600 — the embedded
 * lastDecision can carry log-tail evidence. Fail-soft (false) on ordinary IO
 * errors; SupervisorError (path discipline) always propagates.
 */
export function saveSupervisorState(projectRoot: string, state: SupervisorState): boolean {
  try {
    ensureSuperviseDir(projectRoot, state.runId);
    const path = supervisorStatePath(projectRoot, state.runId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch (err) {
    if (err instanceof SupervisorError) throw err;
    return false;
  }
}

/** Append one v-stamped event record (file created mode 0600). Fail-soft, except SupervisorError. */
export function appendSupervisorEvent(projectRoot: string, runId: string, event: SupervisorEvent): boolean {
  try {
    ensureSuperviseDir(projectRoot, runId);
    appendFileSync(supervisorEventsPath(projectRoot, runId), JSON.stringify(event) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return true;
  } catch (err) {
    if (err instanceof SupervisorError) throw err;
    return false;
  }
}

/**
 * The assessment cadence, PURE: a state change may trigger an assessment once
 * the debounce has elapsed; a heartbeat forces one once the interval has.
 */
export function shouldAssess(args: {
  changed: boolean;
  sinceLastMs: number;
  debounceMs: number;
  intervalMs: number;
}): boolean {
  if (args.sinceLastMs >= args.intervalMs) return true;
  return args.changed && args.sinceLastMs >= args.debounceMs;
}

export interface RunSupervisorOpts {
  projectRoot: string;
  /** Run id or 'latest'. */
  runId: string;
  once?: boolean;
  classifier?: ClassifierLike;
  /** Injected config (tests); defaults to the packaged reviewed policy. */
  config?: SupervisorConfig;
  /** CLI --interval-ms override; clamped to >= debounceMs. */
  intervalOverrideMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Sink for ESCALATE/STOP warnings; defaults to console.warn. */
  warn?: (message: string) => void;
  /** Called after every cycle (CLI prints); not called for suppressed repeats. */
  onDecision?: (decision: Decision, obs: Observation) => void;
  /** Safety bound for tests; default unlimited. */
  maxCycles?: number;
}

export interface SupervisorResult {
  runId: string;
  decision: Decision;
  cycles: number;
  statePath: string;
  eventsPath: string;
}

export async function runSupervisor(opts: RunSupervisorOpts): Promise<SupervisorResult> {
  const baseCfg = opts.config ?? loadSupervisorConfig();
  const cfg: SupervisorConfig =
    opts.intervalOverrideMs !== undefined
      ? (() => {
          if (!Number.isFinite(opts.intervalOverrideMs) || opts.intervalOverrideMs <= 0) {
            throw new SupervisorError(`--interval-ms must be a positive number (got ${opts.intervalOverrideMs})`);
          }
          return { ...baseCfg, intervalMs: Math.max(baseCfg.debounceMs, Math.floor(opts.intervalOverrideMs)) };
        })()
      : baseCfg;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const tickMs = Math.min(cfg.debounceMs, 1000);

  // Resolve 'latest' and fail fast when there is nothing to watch.
  const first = collectObservation(opts.projectRoot, opts.runId, now);
  if (!first) {
    throw new SupervisorError(`no deliver run '${opts.runId}' under ${opts.projectRoot}`);
  }
  const runId = first.runId;
  const state = loadSupervisorState(opts.projectRoot, runId, new Date(now()).toISOString(), warn);

  let lastAssessAt = 0;
  let lastMtime = runStateMtimeMs(opts.projectRoot, runId);
  let cycles = 0;
  let decision: Decision | undefined;
  let lastStatus: string = first.status;

  const applyDecision = (d: Decision, dims: DimensionAssessment[]): void => {
    const ts = new Date(now()).toISOString();
    const firstOfStreak = d.action !== state.lastAction;
    const suppressed = !firstOfStreak && (d.action === 'ESCALATE' || d.action === 'FINISH');
    if (!suppressed) {
      if (d.action === 'STOP') {
        ensureDeliverRunDir(opts.projectRoot, runId);
        requestStop(opts.projectRoot, runId);
        if (firstOfStreak) warn(`supervisor: STOP ${runId} — ${d.reason} (cooperative stop file written; no signals sent)`);
      } else if (d.action === 'RETRY') {
        state.retries += 1;
      } else if (d.action === 'VERIFY') {
        state.verifyCount += 1;
      } else if (d.action === 'ESCALATE') {
        warn(`supervisor: ESCALATE ${runId} — ${d.reason}`);
      }
    }
    // Budget bookkeeping: verifyCount resets when test evidence reappears;
    // the unanswered-escalation streak counts consecutive suppressed repeats.
    if (!dims.some((x) => x.name === 'verification-pending' && x.value === true)) {
      state.verifyCount = 0;
    }
    if (suppressed && d.action === 'ESCALATE') {
      state.suppressedEscalations += 1;
    } else {
      state.suppressedEscalations = 0;
    }
    state.assessments += 1;
    state.lastAction = d.action;
    state.lastActionAt = ts;
    state.lastDecision = d;
    state.updatedAt = ts;
    saveSupervisorState(opts.projectRoot, state);
    const dimensions: SupervisorEvent['dimensions'] = {};
    for (const dim of dims) {
      dimensions[dim.name] = { value: dim.value, source: dim.source };
    }
    appendSupervisorEvent(opts.projectRoot, runId, {
      v: 1,
      ts,
      runId,
      kind: d.action === 'CONTINUE' ? 'assessment' : 'action',
      action: d.action,
      reason: d.reason,
      ...(suppressed ? { suppressed: true } : {}),
      evidence: d.evidence,
      dimensions,
    });
  };

  const cycle = (): Decision => {
    const obs = collectObservation(opts.projectRoot, runId, now);
    if (!obs) throw new SupervisorError(`deliver run '${runId}' vanished mid-supervision`);
    const dims = assessAll(obs, cfg, opts.classifier);
    // An operator-raised deliver budget outranks the static policy number.
    const policyCfg: SupervisorConfig = {
      ...cfg,
      maxMinutes: effectiveMaxMinutes(cfg, opts.projectRoot),
    };
    const d = decide(obs, dims, state, policyCfg);
    applyDecision(d, dims);
    cycles += 1;
    lastAssessAt = now();
    lastStatus = obs.status;
    opts.onDecision?.(d, obs);
    return d;
  };

  for (;;) {
    const mtime = runStateMtimeMs(opts.projectRoot, runId);
    const changed = mtime !== lastMtime;
    if (changed) lastMtime = mtime;
    const sinceLast = lastAssessAt === 0 ? Number.POSITIVE_INFINITY : now() - lastAssessAt;
    if (shouldAssess({ changed, sinceLastMs: sinceLast, debounceMs: cfg.debounceMs, intervalMs: cfg.intervalMs })) {
      decision = cycle();
      if (opts.once) break;
      if (decision.action === 'STOP' || decision.action === 'FINISH') break;
      if (TERMINAL_STATUSES.has(lastStatus)) break;
      if (state.suppressedEscalations >= MAX_SUPPRESSED_ESCALATIONS) {
        // The escalation went unanswered for the whole bound — stop watching
        // rather than filling the ledger forever. The final event says why.
        appendSupervisorEvent(opts.projectRoot, runId, {
          v: 1,
          ts: new Date(now()).toISOString(),
          runId,
          kind: 'action',
          action: 'ESCALATE',
          reason: 'escalation unanswered',
          evidence: { suppressedEscalations: state.suppressedEscalations },
          dimensions: {},
        });
        warn(`supervisor: ESCALATE ${runId} unanswered after ${MAX_SUPPRESSED_ESCALATIONS} repeats — detaching watcher`);
        break;
      }
      if (opts.maxCycles !== undefined && cycles >= opts.maxCycles) break;
    }
    await sleep(tickMs);
  }

  if (!decision) throw new SupervisorError('supervisor exited without assessing');
  return {
    runId,
    decision,
    cycles,
    statePath: supervisorStatePath(opts.projectRoot, runId),
    eventsPath: supervisorEventsPath(opts.projectRoot, runId),
  };
}
