/**
 * Adaptation signal (cross-process): the LLM-Self-Tuning real-time adaptor (P4)
 * writes per-session flag adjustments that the serving proxy consumes per
 * request. This is the ONLY live channel — the proxy freezes its PROXY_* env at
 * startup and exposes no reload endpoint, so mid-session tuning must ride a
 * file-signal exactly like the recipe signal (which the proxy already reads via
 * `load_reactor_signal`). Keyed by session id, plus a rolling latest.json. Fails
 * open: absent/stale signal → the proxy keeps its startup config.
 *
 * The proxy side reads this via `load_adaptation_signal` in
 * tools/agents/scripts/confidence_escalation.py (opt-in, PROXY_REALTIME_ADAPT).
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface AdaptationSignal {
  /** Unix seconds; the proxy TTLs stale signals. */
  ts: number;
  sessionId: string;
  /** Force this recipe for the window (e.g. 'fusion' to escalate quality). */
  recipe?: string;
  /** Escalate this turn to the judge model regardless of confidence. */
  escalate?: boolean;
  /** Live override of PROXY_RECON_CONVERGENCE_THRESHOLD (converge sooner). */
  reconThreshold?: number;
  /** Force synthesis / deliver now (break an exploration/RECON loop). */
  forceSynthesis?: boolean;
  /** Human-readable reason (audit). */
  reason: string;
}

export function adaptationSignalDir(dir?: string): string {
  return (
    dir ||
    process.env.UAP_ADAPTATION_SIGNAL_DIR ||
    join(homedir(), '.cache', 'uap', 'adaptation-signals')
  );
}

/** Persist an adaptation signal (per-session file + rolling latest.json). */
export function writeAdaptationSignal(sig: AdaptationSignal, dir?: string): void {
  try {
    const d = adaptationSignalDir(dir);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const data = JSON.stringify(sig);
    const safeId = sig.sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || 'session';
    writeFileSync(join(d, `${safeId}.json`), data);
    writeFileSync(join(d, 'latest.json'), data);
  } catch {
    /* fail open — the proxy keeps its startup config */
  }
}
