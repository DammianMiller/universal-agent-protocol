/**
 * LLM Self-Tuning — the real-time adaptor (P4).
 *
 * Offline tuning (P0-P3) finds a good STATIC config. This closes the last gap:
 * per-session adaptation from LIVE signals, for the failures a static config
 * can't foresee (design §Phase 4). It maps four session signals to conservative,
 * hot-reloadable adjustments and emits them on the adaptation-signal channel the
 * proxy reads per request:
 *
 *   - tool-use failure rate ↑           → escalate this turn to the judge (fusion)
 *   - per-turn quality ↓                → escalate this turn to the judge (fusion)
 *   - context-window utilization ↑      → converge sooner (lower recon threshold)
 *   - RECON no-write streak ↑           → force synthesis / deliver now
 *
 * `computeAdaptation` is pure and returns null when everything is nominal (no
 * signal written → the proxy keeps its startup config). Emission is opt-in
 * (`enabled`, default from UAP_REALTIME_ADAPT) so it can never perturb a session
 * that didn't ask for it.
 */

import {
  AdaptationSignal,
  writeAdaptationSignal,
} from '../coordination/adaptation-signal.js';
import { loadUapConfigRaw } from '../utils/config-loader.js';
import { FlagConfig, flagValue } from './flags.js';

/** Live session signals (any subset). Absent fields are treated as nominal. */
export interface SessionSignals {
  /** Fraction of recent tool calls that failed / were malformed (0-1). */
  toolFailureRate?: number;
  /** Fraction of the context window in use (0-1), e.g. from GET /v1/context. */
  contextUtilization?: number;
  /** Consecutive no-write ("RECON") turns. */
  reconStreak?: number;
  /** Recent per-turn composite quality estimate (0-100). */
  turnQuality?: number;
}

/** Breach thresholds. Defaults are conservative — adapt only on a real signal. */
export interface AdaptationThresholds {
  /** Escalate when tool-failure rate exceeds this. Default 0.35. */
  toolFailureRate?: number;
  /** Converge sooner when context utilization exceeds this. Default 0.85. */
  contextUtilization?: number;
  /** Force synthesis when the no-write streak exceeds this. Default 25. */
  reconStreak?: number;
  /** Escalate when turn quality drops below this. Default 45. */
  turnQualityFloor?: number;
}

const DEFAULTS: Required<AdaptationThresholds> = {
  toolFailureRate: 0.35,
  contextUtilization: 0.85,
  reconStreak: 25,
  turnQualityFloor: 45,
};

/**
 * Map live signals + the current config to an adaptation signal, or null when
 * nothing breaches a threshold. Pure and deterministic.
 */
export function computeAdaptation(
  sessionId: string,
  signals: SessionSignals,
  current: FlagConfig,
  now: number,
  thresholds: AdaptationThresholds = {},
): AdaptationSignal | null {
  const thr = { ...DEFAULTS, ...thresholds };
  const reasons: string[] = [];
  const out: AdaptationSignal = { ts: now, sessionId, reason: '' };

  // Quality / reliability degradation → escalate this turn to the judge.
  if (signals.toolFailureRate != null && signals.toolFailureRate > thr.toolFailureRate) {
    out.escalate = true;
    out.recipe = 'fusion';
    reasons.push(`tool-failure ${(signals.toolFailureRate * 100).toFixed(0)}% > ${(thr.toolFailureRate * 100).toFixed(0)}%`);
  }
  if (signals.turnQuality != null && signals.turnQuality < thr.turnQualityFloor) {
    out.escalate = true;
    out.recipe = 'fusion';
    reasons.push(`turn-quality ${signals.turnQuality.toFixed(0)} < ${thr.turnQualityFloor}`);
  }

  // Context pressure → converge sooner (lower the recon threshold live).
  if (signals.contextUtilization != null && signals.contextUtilization > thr.contextUtilization) {
    const cur = Number(flagValue(current, 'PROXY_RECON_CONVERGENCE_THRESHOLD')) || 40;
    out.reconThreshold = Math.max(20, Math.min(cur, Math.round(cur * 0.5)));
    reasons.push(`ctx ${(signals.contextUtilization * 100).toFixed(0)}% > ${(thr.contextUtilization * 100).toFixed(0)}% → recon≤${out.reconThreshold}`);
  }

  // RECON loop → force synthesis / deliver now.
  if (signals.reconStreak != null && signals.reconStreak > thr.reconStreak) {
    out.forceSynthesis = true;
    reasons.push(`recon-streak ${signals.reconStreak} > ${thr.reconStreak}`);
  }

  if (reasons.length === 0) return null; // nominal — do not emit
  out.reason = reasons.join('; ');
  return out;
}

export interface EmitOptions extends AdaptationThresholds {
  /** Explicit master switch. Default: auto-on unless opted out (env/config). */
  enabled?: boolean;
  /** Project dir for the config opt-out check. Default process.cwd(). */
  cwd?: string;
  /** Signal directory override (tests). */
  dir?: string;
  /** "now" in unix seconds (host may lack Date). */
  now?: number;
}

/**
 * True when real-time adaptation is enabled. AUTO-ON by default; opt out via
 * either `UAP_REALTIME_ADAPT` (0/false/off) or `.uap.json` `realtimeAdapt.enabled:
 * false`. Precedence: explicit arg → env (if set) → config → default(true).
 * The emitter is the effective master switch — with it off, no signal is written
 * so the proxy has nothing to honor, regardless of PROXY_REALTIME_ADAPT.
 */
export function realtimeAdaptEnabled(explicit?: boolean, cwd?: string): boolean {
  if (explicit !== undefined) return explicit;
  const v = (process.env.UAP_REALTIME_ADAPT ?? '').toLowerCase();
  if (v) return v === '1' || v === 'true' || v === 'on' || v === 'yes';
  try {
    const raw = loadUapConfigRaw(cwd ?? process.cwd()) as
      | { realtimeAdapt?: { enabled?: boolean } }
      | null;
    if (raw?.realtimeAdapt?.enabled === false) return false;
  } catch {
    /* fall through to default */
  }
  return true; // auto-on
}

/**
 * Compute + emit an adaptation signal for a session. No-op (returns null) when
 * disabled or when nothing breaches a threshold. Never throws.
 */
export function emitAdaptation(
  sessionId: string,
  signals: SessionSignals,
  current: FlagConfig,
  opts: EmitOptions = {},
): AdaptationSignal | null {
  if (!realtimeAdaptEnabled(opts.enabled, opts.cwd)) return null;
  const now = opts.now ?? Date.now() / 1000;
  const sig = computeAdaptation(sessionId, signals, current, now, opts);
  if (sig) {
    try {
      writeAdaptationSignal(sig, opts.dir);
    } catch {
      /* fail open */
    }
  }
  return sig;
}

/**
 * Best-effort read of the proxy's per-session context state (GET /v1/context) to
 * populate `contextUtilization`. Injectable fetch for tests. Returns {} on any
 * failure (the adaptor treats missing signals as nominal).
 */
export async function fetchSessionContext(
  endpoint?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Pick<SessionSignals, 'contextUtilization'>> {
  const base = (endpoint ?? process.env.UAP_INFERENCE_ENDPOINT ?? 'http://localhost:4000/v1').replace(/\/$/, '');
  try {
    const res = await fetchImpl(`${base}/context`);
    if (!res.ok) return {};
    const data = (await res.json()) as { utilization?: number; used?: number; window?: number };
    let util = data.utilization;
    if (util == null && data.used != null && data.window) util = data.used / data.window;
    return util != null ? { contextUtilization: Math.max(0, Math.min(1, util)) } : {};
  } catch {
    return {};
  }
}
