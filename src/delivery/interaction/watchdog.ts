/**
 * Interaction watchdog — invariants that hold for EVERY probe, checked
 * independently of what any individual probe asserts.
 *
 * Probes prove the promised behaviour. The watchdog catches the failures nobody
 * thought to write a probe for: the loop stops ticking, an uncaught error fires,
 * a tracked number goes NaN, a collection grows without bound. Tonight's fatal
 * defect (`player.takeDamage is not a function`) is exactly the first class —
 * one uncaught throw, the rAF loop never rescheduled, and every later frame was
 * a frozen copy of the last good one, which no screenshot can distinguish from a
 * paused game.
 */

import type { WatchdogReport } from './types.js';

/**
 * Injected before any page script runs. Wraps requestAnimationFrame to count
 * ticks and records uncaught errors. Deliberately defensive: a page that
 * replaces rAF or throws during setup must not break the watchdog itself.
 *
 * SELF-INVOKED — `addInitScript` evaluates the string as source, so a bare
 * function expression would construct a function and discard it. That mistake
 * is invisible at runtime: the counters simply never appear, every sample falls
 * back to `ticks: 0`, `everTicked` stays false and `loopAlive` is unconditionally
 * true — the frozen-loop detection this gate exists for silently never fires.
 * Matches RAF_INSTRUMENT in execution-gate.ts, which is self-invoked for the
 * same reason.
 */
export const DEFAULT_WATCH_GLOBAL = '__uapWatch';

/**
 * Build the init script under a caller-chosen global name.
 *
 * The name is randomised per run because the page can otherwise DEFEAT its own
 * watchdog: `window.__uapWatch = {ticks: 1e9, errors: []}` forges liveness and
 * empties the error list, and the `if (already defined) return` guard means a
 * page that predefines the global blocks instrumentation outright. Randomising
 * is not a security boundary — it raises the cost of a targeted forge, while
 * the authoritative error channel remains Playwright-side, out of page reach.
 */
export function buildWatchdogInitScript(globalName: string = DEFAULT_WATCH_GLOBAL): string {
  return WATCHDOG_INIT_SCRIPT.split(DEFAULT_WATCH_GLOBAL).join(globalName);
}

export const WATCHDOG_INIT_SCRIPT = `(function () {
  try {
    if (window.__uapWatch) return;
    var w = { ticks: 0, errors: [], startedAt: Date.now() };
    window.__uapWatch = w;
    var raf = window.requestAnimationFrame;
    if (typeof raf === 'function') {
      window.requestAnimationFrame = function (cb) {
        return raf.call(window, function (t) {
          w.ticks++;
          return cb(t);
        });
      };
    }
    window.addEventListener('error', function (e) {
      try { w.errors.push('uncaught: ' + (e && e.message ? e.message : String(e))); } catch (x) {}
    });
    window.addEventListener('unhandledrejection', function (e) {
      try { w.errors.push('unhandledrejection: ' + String(e && e.reason)); } catch (x) {}
    });
  } catch (x) {
    /* the watchdog must never break the page it observes */
  }
})()`;

/**
 * Read one watchdog sample. `watchExprs` are artifact expressions yielding
 * numbers (collection sizes, key state fields) — the miner supplies them, and
 * each one that goes NaN or grows without bound becomes a defect.
 */
/**
 * NaN cannot survive the JSON transport — `JSON.stringify(NaN)` is `null`, so a
 * corrupted field arrives indistinguishable from "not present" and the NaN check
 * can never fire in production. Encode it explicitly and decode on the way back.
 */
export const NAN_SENTINEL = '__uap_NaN__';

export function watchdogSampleScript(
  watchExprs: string[],
  globalName: string = DEFAULT_WATCH_GLOBAL
): string {
  const entries = watchExprs
    .map((e) => {
      const key = JSON.stringify(e);
      return `    try { var v = (${e}); vals[${key}] = (typeof v === 'number' && v !== v) ? ${JSON.stringify(NAN_SENTINEL)} : v; } catch (x) { vals[${key}] = null; }`;
    })
    .join('\n');
  return `(function () {
  var w = window[${JSON.stringify(globalName)}] || { ticks: 0, errors: [] };
  var vals = {};
${entries}
  return JSON.stringify({ ticks: w.ticks, errors: w.errors.slice(0, 20), values: vals });
})`;
}

export interface WatchdogSample {
  ticks: number;
  errors: string[];
  values: Record<string, number | null>;
  /**
   * Which uninterrupted run of the artifact this sample belongs to. Per-probe
   * page reloads restart every counter, so growth may only be compared inside
   * one segment — across a reload the endpoints do not bracket a continuous run.
   */
  segment?: number;
}

export function parseWatchdogSample(raw: unknown): WatchdogSample | null {
  try {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const parsed = JSON.parse(text) as WatchdogSample;
    if (!parsed || typeof parsed !== 'object') return null;
    const values: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(parsed.values ?? {})) {
      values[k] = (v as unknown) === NAN_SENTINEL ? Number.NaN : (v as number | null);
    }
    return {
      ticks: Number(parsed.ticks) || 0,
      errors: Array.isArray(parsed.errors) ? parsed.errors.map(String) : [],
      values,
    };
  } catch {
    return null;
  }
}

/** Does this expression observe the SIZE of a collection (vs a counter)? */
export function isCollectionSize(expr: string): boolean {
  return /\.(length|size)\s*$/.test(expr) || /\.(length|size)\b/.test(expr);
}

export interface WatchdogOptions {
  /** Minimum ticks in the final window before the loop counts as alive. */
  minTicks?: number;
  /** Growth factor over the first sample that counts as unbounded. */
  growthFactor?: number;
  /** Absolute floor before growth is even considered (ignore tiny collections). */
  growthFloor?: number;
}

/**
 * Pure verdict from the observed samples. Kept free of IO so the interesting
 * judgements are unit-testable without a browser.
 */
export function judgeWatchdog(
  samples: WatchdogSample[],
  driverErrors: string[] = [],
  opts: WatchdogOptions = {}
): WatchdogReport {
  const minTicks = opts.minTicks ?? 1;
  const growthFactor = opts.growthFactor ?? 20;
  const growthFloor = opts.growthFloor ?? 500;

  const errors = [...new Set([...samples.flatMap((s) => s.errors), ...driverErrors])];

  const first = samples[0];
  const last = samples[samples.length - 1];
  const prev = samples.length >= 2 ? samples[samples.length - 2] : first;
  // Ticks in the FINAL window: a loop that ran for two seconds and then died
  // still has a large cumulative count, so only the last interval is evidence
  // that it is alive NOW.
  const ticksObserved = last && prev ? Math.max(0, last.ticks - prev.ticks) : 0;
  // A page with no rAF at all (a form, a static doc) legitimately never ticks.
  // Only claim the loop is dead when it demonstrably ticked earlier.
  const everTicked = (last?.ticks ?? 0) > 0;
  // TWO samples minimum. With one, `prev === last`, the delta is 0 by
  // construction, and any artifact that ever ticked is declared dead — so a
  // single dropped watchdog read would fail a perfectly healthy build. Liveness
  // is a claim about change over time and needs two points to make.
  const loopAlive = samples.length < 2 || !everTicked || ticksObserved >= minTicks;

  // NaN over EVERY sample, not just the last. Judging only the final sample
  // meant a field corrupted during any earlier probe was wiped by the next
  // page reload and never seen — the check silently became "did the LAST probe
  // produce NaN".
  const nanSet = new Set<string>();
  for (const s of samples) {
    for (const [key, v] of Object.entries(s.values)) {
      if (typeof v === 'number' && Number.isNaN(v)) nanSet.add(key);
    }
  }
  const nanFields = [...nanSet];

  // Growth compared only WITHIN a contiguous segment: across a reload the
  // start and end points belong to different runs of the artifact, so the
  // comparison is meaningless (and a real leak measured over one short probe
  // never crosses the floor).
  const growth = new Map<string, string>();
  const bySegment = new Map<number, WatchdogSample[]>();
  for (const s of samples) {
    const seg = s.segment ?? 0;
    if (!bySegment.has(seg)) bySegment.set(seg, []);
    (bySegment.get(seg) as WatchdogSample[]).push(s);
  }
  for (const group of bySegment.values()) {
    const a = group[0];
    const b = group[group.length - 1];
    if (!a || !b || a === b) continue;
    for (const key of Object.keys(b.values)) {
      // Growth means "a COLLECTION grew without bound". An ordinary counter —
      // a score, a frame number, elapsed time — is supposed to climb, and
      // flagging it reports a leak in a working game (observed: score 0 →
      // 38 060 reported as unbounded growth). Only size-like observations
      // qualify; every watched value is still checked for NaN.
      if (!isCollectionSize(key)) continue;
      const start = a.values[key];
      const end = b.values[key];
      if (
        typeof start === 'number' &&
        typeof end === 'number' &&
        !Number.isNaN(end) &&
        end > growthFloor &&
        end > Math.max(1, start) * growthFactor
      ) {
        growth.set(key, `${key}: ${start} → ${end}`);
      }
    }
  }
  const unboundedGrowth = [...growth.values()];

  return { errors, loopAlive, ticksObserved, nanFields, unboundedGrowth };
}

/** True when the watchdog saw something that should fail the gate. */
export function watchdogFailed(r: WatchdogReport): boolean {
  return r.errors.length > 0 || !r.loopAlive || r.nanFields.length > 0 || r.unboundedGrowth.length > 0;
}

export function watchdogSummary(r: WatchdogReport): string {
  const lines: string[] = [];
  if (r.errors.length > 0) {
    lines.push(`✗ runtime errors (${r.errors.length}): ${r.errors.slice(0, 5).join(' | ')}`);
  }
  if (!r.loopAlive) {
    lines.push(
      `✗ the main loop STOPPED — ${r.ticksObserved} frame(s) in the final sampling window. ` +
        `An uncaught error inside a requestAnimationFrame callback stops the loop being ` +
        `rescheduled; every later frame is a frozen copy of the last good one, which looks ` +
        `identical to a working paused screen in a screenshot.`
    );
  }
  if (r.nanFields.length > 0) lines.push(`✗ NaN in tracked state: ${r.nanFields.join(', ')}`);
  if (r.unboundedGrowth.length > 0) {
    lines.push(`✗ unbounded growth (leak): ${r.unboundedGrowth.join(', ')}`);
  }
  return lines.join('\n');
}
