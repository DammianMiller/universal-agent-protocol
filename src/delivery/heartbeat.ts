/**
 * The deliver heartbeat: one integer, and the two questions asked of it.
 *
 * WHY THIS IS ITS OWN MODULE
 * These helpers lived in `src/cli/deliver.ts`, which imports `await-run.ts` —
 * so `await-run.ts` could not import them back without a cycle. Follow now
 * needs the heartbeat to answer "is this run MOVING", and the alternative was a
 * second inline parser of the same file. That is the shape that already bit this
 * project: `acquireDeliverLock` judged the holder by PID-liveness alone, and
 * after a PID wrap an eleven-day-old lock named an unrelated live process, so
 * every later deliver in that project deferred forever (see the reasoning on
 * `isDeliverLockAbandoned` in src/cli/deliver.ts).
 *
 * One reader, one meaning — but note this is NOT yet true across the whole
 * system, and claiming otherwise would be the same unmeasured assurance this
 * work exists to remove. Two other readers of these files remain:
 * `delivery_enforcement.py` still judges the lock with a bare `os.kill(pid, 0)`
 * and no heartbeat check, and `deliver_autoroute.py` reads the heartbeat with
 * its own copy of the wedge threshold (kept equal to DEFAULT_WEDGE_TIMEOUT_S
 * below by a parity test — it defaulted to 600 against this file's 1800 until
 * 2026-07-31, so the two disagreed for any heartbeat aged 600-1800s).
 *
 * THE CONTRACT (language-agnostic — `.claude/hooks/deliver_autoroute.py` reads
 * it too): `.uap/deliver.heartbeat` holds a single unix-epoch-seconds integer,
 * rewritten each convergence iteration and on each executor tool call.
 */
import { mkdirSync, openSync, writeSync, closeSync, renameSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Default wedge timeout (seconds). Override with UAP_DELIVER_WEDGE_TIMEOUT.
 * Deliberately generous (30 min): the heartbeat only advances between
 * convergence iterations, and one turn on a slow local model (generation + the
 * full gate ladder) can legitimately take many minutes. The timeout must sit
 * comfortably above the worst-case single-turn latency so a healthy-but-slow
 * run is never mistaken for a wedged one and reclaimed out from under itself.
 */
export const DEFAULT_WEDGE_TIMEOUT_S = 1800;

/** Resolve the wedge timeout in seconds (env override, else the default). */
export function wedgeTimeoutS(): number {
  const raw = process.env.UAP_DELIVER_WEDGE_TIMEOUT;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WEDGE_TIMEOUT_S;
}

/**
 * Interval for heartbeating DURING a model generation (ms). The per-tool-call
 * stamp goes silent for the whole length of one completion — 5–15 minutes on a
 * local model with a large prompt — and every external reader (followers,
 * impatient client agents, wedge heuristics) concluded "dead" from exactly
 * that silence: three separate clients tried to kill or clear a healthy
 * mid-generation run on 2026-08-15/16. Override with
 * UAP_GENERATION_HEARTBEAT_MS; values <= 0 disable the ticker.
 */
export const DEFAULT_GENERATION_HEARTBEAT_MS = 30_000;

export function generationHeartbeatMs(): number {
  const raw = process.env.UAP_GENERATION_HEARTBEAT_MS;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : DEFAULT_GENERATION_HEARTBEAT_MS;
}

/**
 * Start a ticker that calls `beat` every `intervalMs` until stopped — the
 * "still decoding" signal for the duration of one model call. Returns the stop
 * function; a non-positive interval returns a no-op. unref'd so the ticker can
 * never keep the process alive by itself.
 */
export function startGenerationTicker(beat: () => void, intervalMs: number): () => void {
  if (!(intervalMs > 0)) return () => {};
  // A throwing beat must not become a recurring uncaughtException — the
  // ticker is best-effort observability, never a failure source.
  const t = setInterval(() => { try { beat(); } catch { /* best-effort */ } }, intervalMs);
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
}

/**
 * Stamp the current epoch-seconds into `.uap/deliver.heartbeat`, ATOMICALLY
 * (write a temp file then rename over the target). A plain truncate-in-place
 * write leaves the file momentarily empty, and a concurrent reader would parse
 * `""` as 0 (epoch 1970) and wrongly conclude the holder is wedged. Best-effort.
 */
export function updateDeliverHeartbeat(projectRoot: string): void {
  try {
    const dir = join(projectRoot, '.uap');
    mkdirSync(dir, { recursive: true });
    const hbPath = join(dir, 'deliver.heartbeat');
    const tmp = `${hbPath}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w');
    writeSync(fd, String(Math.floor(Date.now() / 1000)));
    closeSync(fd);
    renameSync(tmp, hbPath);
  } catch { /* non-fatal — lock path falls back to PID-liveness only */ }
}

/**
 * Read the heartbeat epoch-seconds, or null if absent/unreadable/non-positive.
 * Rejecting non-positive values guards against a torn read (empty file parses
 * to 0) being treated as a real 1970 timestamp.
 */
export function readDeliverHeartbeat(projectRoot: string): number | null {
  try {
    const v = Number(readFileSync(join(projectRoot, '.uap', 'deliver.heartbeat'), 'utf8').trim());
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

/**
 * Age of the heartbeat in seconds, or null when there is none to age.
 *
 * This is the only signal that separates "slow but working" from "stuck", which
 * is the distinction a caller polling a long run actually needs. A negative age
 * (clock skew, or a holder on another machine) is clamped to 0 rather than
 * reported as a future timestamp.
 */
export function heartbeatAgeS(
  projectRoot: string,
  nowS: number = Math.floor(Date.now() / 1000),
): number | null {
  const hb = readDeliverHeartbeat(projectRoot);
  if (hb === null) return null;
  return Math.max(0, nowS - hb);
}

/**
 * True when the lock holder is alive but WEDGED — its heartbeat is older than
 * the wedge timeout. A MISSING heartbeat is not wedged (the holder may be
 * starting up), so this returns false in that case and the caller keeps
 * deferring to PID-liveness.
 */
export function isDeliverHolderWedged(
  projectRoot: string,
  nowS: number = Math.floor(Date.now() / 1000),
): boolean {
  // Routed through heartbeatAgeS rather than recomputing `nowS - hb`, so the
  // verdict FOLLOW reports and the decision the LOCK makes are provably the
  // same predicate with the same skew policy. Two functions in this file
  // computing "wedged" slightly differently is the divergence this module was
  // created to prevent, one level down.
  const age = heartbeatAgeS(projectRoot, nowS);
  return age !== null && age > wedgeTimeoutS();
}
