/**
 * Capability profile — a RUNTIME measurement of how much the deliverable
 * actually does, persisted like a visual baseline and compared across a run.
 *
 * WHY THIS EXISTS. Every other rung asks "does it run cleanly?". None asks
 * "does it still do as much?", and those are different questions with opposite
 * failure modes: a build can buy a clean verdict by doing LESS. Measured on
 * octopus_invaders_v4 (2026-08-19) — one run took the gate score 0% -> 100%
 * while the deliverable lost most of its function:
 *
 *     draw calls   12 -> 3       rAF loops    6 -> 2
 *     listeners     8 -> 3       frames/7s  419 -> 25
 *     bundle    65.8KB -> 25.8KB
 *
 * The acceptance judge scored that 8/9. The execution gate passed it: it DOES
 * render, it DOES tick, no console errors. `--keep-best`/no-regress
 * (src/delivery/snapshot.ts) could not catch it either, because that rolls back
 * on the GATE SCORE and the gate score went UP.
 *
 * WHAT THIS FILE IS AND IS NOT. It is the PURE half: the profile shape, the
 * comparison, the feedback, and the on-disk baseline. The MEASUREMENT lives in
 * execution-gate.ts, inside the browser session that rung already opens — see
 * the note on ordering below. Splitting it that way is deliberate and was the
 * main finding of architecture review:
 *
 *  - Ordering becomes STRUCTURAL rather than a convention. A profile only
 *    exists as a byproduct of a page that loaded and ticked, so it is
 *    impossible to grade the capability of a build that did not run. The old
 *    arrangement enforced that by putting a call in the right place, which is
 *    the kind of rule that survives exactly until someone moves the call.
 *  - It stops duplicating a browser launch, a 1.5s settle, and a verbatim copy
 *    of the start-click selector block. That copy had ALREADY drifted on
 *    introduction (it gained an ArrowLeft the execution gate does not send), and
 *    a drifted start-click means both sides measure the menu, agree, and the
 *    rung goes silently inert. This repo has shipped inert probes twice.
 *  - It makes the reading reachable from `uap verify`, not just from deliver. A
 *    deliver-only bar re-creates the Generator!=Evaluator divergence this
 *    codebase already records: the sessions that edit files directly never go
 *    through the convergence loop at all, and a direct-edit session is exactly
 *    what produced the recorded regression.
 *
 * FAILS OPEN, always. An unmeasurable page, an absent browser, a baseline that
 * never rendered — all return "no regression". You cannot regress from broken,
 * and a capability check that guesses is worse than none: it blocks working
 * deliveries on browser noise. Every threshold is deliberately loose; this
 * catches gutting, not drift.
 *
 * WHAT THIS IS NOT: a defence against a page that is deliberately lying.
 *
 * Say it plainly, because the numbers look like evidence and will be trusted as
 * evidence. The counters live INSIDE the page's own realm and count API
 * INVOCATIONS, not rendered output — so a page that wants a rich profile can
 * simply call the instrumented APIs. Measured against this exact code: a page
 * drawing a single 40x40 rect, by adding 64 no-op listeners, calling
 * `useProgram` 64 times on a null context, and issuing 5000 zero-area
 * `fillRect`s per frame, reported 5001 draws/frame, 64 shader programs, 64 event
 * types and 60fps. Nothing here detects that, and sealing more surfaces does not
 * converge: you cannot instrument a realm the adversary controls from inside it.
 * Closing that needs an out-of-realm oracle — screenshot pixels captured
 * host-side over CDP, which the visual gate already collects.
 *
 * So the honest claim is narrower than the motivating incident makes it sound.
 * The octopus regression was a model SIMPLIFYING under gate pressure, not a
 * model gaming a metric it knew about, and that is the case this catches: an
 * unintentional loss of function that every other rung reads as success. Treat a
 * clean capability verdict as "nothing obviously fell off", never as "the
 * deliverable was not gutted".
 *
 * What the hardening here DOES buy is that the gate cannot be turned off by
 * accident or by one line: the hooks are sealed under a per-run random key, the
 * pristine `querySelector`/`performance.now` are captured at install time (a
 * one-line override of either used to disable the whole reading), the baseline
 * is in the integrity capture, and no value from the page or from disk reaches a
 * threshold without coercion.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One capability reading of a running page. */
export interface CapabilityProfile {
  /** False when nothing could be read — every comparison then passes. */
  measured: boolean;
  /** Why it could not be measured (only when measured === false). */
  reason?: CapabilityReason;
  /**
   * How long the steady-state window ACTUALLY lasted, read from the page's own
   * clock rather than assumed from the requested window.
   *
   * Load-bearing. The comparison needs a RATE, and a count is only a rate if
   * you know the interval — the two captures happen minutes apart, the window
   * length is env-tunable per capture, and the CDP round-trips that open and
   * close the window are not free. Comparing raw counts across two windows of
   * different length manufactures a regression of exactly their ratio.
   */
  elapsedMs: number;
  /** requestAnimationFrame callbacks that actually EXECUTED in the window. */
  frames: number;
  /** GL draw* + 2D paint calls in the window. */
  drawCalls: number;
  glDrawCalls: number;
  ctx2dDrawCalls: number;
  /** Distinct WebGL programs bound over the page's LIFETIME (see below). */
  programsUsed: number;
  /** Distinct event TYPES registered via addEventListener (page lifetime). */
  listenerTypes: number;
  /** Total addEventListener registrations (page lifetime). */
  listeners: number;
  /** Did the page have a <canvas> at all? */
  canvas: boolean;
  /**
   * Which driver produced this reading. Two drivers have completely different
   * frame-rate regimes, and the fallback is silent — so a baseline taken on
   * one and a candidate on the other is not a comparison, and must be refused
   * rather than reported.
   */
  driver?: string;
  /** Entry page measured, for the report. */
  entry?: string;
}

/** Why a profile could not be taken. Distinguished because they do not all mean
 *  the same thing — see `compareCapability`. */
export type CapabilityReason =
  | 'no-entry' // there is no web entry page NOW
  | 'no-browser' // nothing could drive a page
  | 'not-installed' // instrumentation did not take
  | 'no-reading' // the probe came back empty
  | 'error'; // anything else

export function unmeasured(reason: CapabilityReason, driver?: string): CapabilityProfile {
  return {
    measured: false,
    reason,
    elapsedMs: 0,
    frames: 0,
    drawCalls: 0,
    glDrawCalls: 0,
    ctx2dDrawCalls: 0,
    programsUsed: 0,
    listenerTypes: 0,
    listeners: 0,
    canvas: false,
    ...(driver ? { driver } : {}),
  };
}

/** Frames per second, from the page's own measured interval. */
export const fpsOf = (p: CapabilityProfile): number =>
  p.elapsedMs > 0 ? (p.frames * 1000) / p.elapsedMs : 0;
/** Draw calls per frame — a property of the SCENE, invariant to frame rate. */
export const drawsPerFrame = (p: CapabilityProfile): number =>
  p.frames > 0 ? p.drawCalls / p.frames : 0;

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Scene-content ratios. Loose on purpose: the target is a build that lost most
 * of its function, not one that lost a little. A tight threshold fails ordinary
 * refactors (batching draws, merging two shader programs) and teaches the loop
 * to pad its numbers back up, which is worse than not checking.
 */
const DRAW_RATIO = 0.6;
const PROGRAM_RATIO = 0.6;
const LISTENER_RATIO = 0.6;

/**
 * Frame rate is judged as an ABSOLUTE LIVENESS FLOOR, not a ratio — this is the
 * single most important calibration decision in the file.
 *
 * A ratio cannot work here. The baseline is taken before the run's first model
 * call; the candidate is taken minutes later on a box that is simultaneously
 * decoding tokens on the same GPU, under software WebGL, possibly alongside
 * other concurrent deliver tasks. Contention alone plausibly moves frame rate
 * by 2-4x. The ratio this file originally used (0.4) trips at 2.5x — inside the
 * noise, so it WOULD have misfired, blocking healthy turns and then telling the
 * model to "restore the missing behaviour" that was never missing.
 *
 * A floor is load-invariant in the way that matters. On the measured octopus
 * numbers — 59.9 fps healthy, 3.6 fps gutted — this fires with 2.8x of margin,
 * while a healthy page would have to fall below 10 fps (6x contention) to
 * false-fire. Same catch, 2.4x more headroom.
 */
const DEAD_FPS = 10;
const ALIVE_FPS = 30;

/** Below these, a metric is too small for a ratio to mean anything. */
const MIN_DRAWS_PER_FRAME = 0.5;
const MIN_PROGRAMS = 2;
const MIN_LISTENER_TYPES = 3;

/**
 * How many metrics must drop before the turn is BLOCKED.
 *
 * One is too few. Each metric has a legitimate way to fall on its own: merging
 * five shaders into an uber-shader takes programs 5->1; switching a per-entity
 * draw path to an instanced one legitimately collapses draws-per-frame; moving
 * to delegated event handling collapses listener types. Blocking on any single
 * one of those, with feedback that says "restore the missing behaviour", asks
 * the model to undo a correct optimisation.
 *
 * Two is enough to catch the thing this exists for: the recorded regression
 * dropped ALL FOUR at once. A lone drop is still reported — as a note the judge
 * sees, not a block.
 */
const BLOCK_AT_FINDINGS = 2;

// ---------------------------------------------------------------------------
// Comparison (pure)
// ---------------------------------------------------------------------------

export interface CapabilityComparison {
  /** True only when enough measured, material drops were found to block. */
  regressed: boolean;
  /** Why it could not judge, when it could not. */
  skipped?: string;
  /** One line per metric that dropped, with both raw numbers. */
  findings: string[];
  /** Every metric, before -> after, for the report. */
  table: string[];
}

/**
 * Compare a post-run profile against the pre-run baseline. PURE — unit-tested
 * without a browser.
 */
export function compareCapability(
  baseline: CapabilityProfile | null | undefined,
  current: CapabilityProfile | null | undefined
): CapabilityComparison {
  const none = (skipped: string): CapabilityComparison => ({ regressed: false, skipped, findings: [], table: [] });

  if (!capabilityEnabled()) return none('capability check disabled (UAP_CAPABILITY=0)');
  if (!baseline?.measured) return none('no capability baseline to compare against');

  // A vanished entry page is the MOST complete regression possible, and the
  // naive "either side unmeasured -> skip" rule forgave it outright: delete
  // index.html and the reading becomes 'no-entry', which used to read as
  // "cannot measure". Everything else that cannot be measured is an
  // ENVIRONMENT failure and must still fail open.
  if (!current?.measured) {
    // Corroborated: the baseline must itself name the page that has vanished.
    // Otherwise a single string written to current.json asserts the existence of
    // something that was never measured, and that assertion bypasses the
    // two-finding rule to block every turn.
    if (current?.reason === 'no-entry' && baseline.entry) {
      return {
        regressed: true,
        findings: ['the web entry page is GONE — there is no longer a page to run'],
        table: [`entry: ${baseline.entry ?? '(a page)'} -> (none)`],
      };
    }
    return none(`capability not measurable now (${current?.reason ?? 'unknown'})`);
  }

  // Two drivers have different frame-rate regimes and the fallback is silent.
  if (baseline.driver && current.driver && baseline.driver !== current.driver) {
    return none(`different browser drivers (${baseline.driver} then ${current.driver}) — not comparable`);
  }

  // You cannot regress from broken. A baseline that never rendered and never
  // ticked gives every candidate an infinite improvement ratio.
  if (baseline.frames === 0 && baseline.drawCalls === 0) {
    return none('baseline never rendered — nothing to regress from');
  }

  const bFps = fpsOf(baseline);
  const cFps = fpsOf(current);
  const bDpf = drawsPerFrame(baseline);
  const cDpf = drawsPerFrame(current);

  const table = [
    `frame rate: ${bFps.toFixed(1)} -> ${cFps.toFixed(1)} fps (${baseline.frames} frames in ${baseline.elapsedMs}ms -> ${current.frames} in ${current.elapsedMs}ms)`,
    `draw calls per frame: ${bDpf.toFixed(2)} -> ${cDpf.toFixed(2)} (${baseline.drawCalls} -> ${current.drawCalls} total)`,
    `shader programs used: ${baseline.programsUsed} -> ${current.programsUsed}`,
    `event types handled: ${baseline.listenerTypes} -> ${current.listenerTypes}`,
  ];

  const findings: string[] = [];
  const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const ratioCheck = (label: string, base: number, cur: number, floor: number, ratio: number, unit: string): void => {
    if (!Number.isFinite(base) || !Number.isFinite(cur)) return;
    if (base < floor) return; // too small to judge
    if (cur >= base * ratio) return;
    const pct = Math.round((1 - cur / base) * 100);
    findings.push(`${label} dropped ${pct}%: ${fmt(base)} -> ${fmt(cur)} ${unit}`);
  };

  // Liveness: an absolute floor, not a ratio (see DEAD_FPS).
  if (Number.isFinite(bFps) && Number.isFinite(cFps) && bFps >= ALIVE_FPS && cFps < DEAD_FPS) {
    findings.push(
      `the render loop is no longer running at a usable rate: ${bFps.toFixed(1)} -> ${cFps.toFixed(1)} fps`
    );
  }

  // Draws-per-frame is only meaningful when BOTH sides actually drove rAF. A
  // page whose loop is setInterval never touches requestAnimationFrame, so it
  // reads 0 frames while still drawing — and dividing by a floored 1 turned
  // draws-per-frame into draws-per-window, a number ~300x too large. Measured:
  // a setInterval -> rAF refactor (an IMPROVEMENT) reported "draw calls per
  // frame dropped 100%: 6300 -> 21".
  if (baseline.frames > 0 && current.frames > 0) {
    ratioCheck('draw calls per frame', bDpf, cDpf, MIN_DRAWS_PER_FRAME, DRAW_RATIO, 'per frame');
  }
  ratioCheck('distinct shader programs', baseline.programsUsed, current.programsUsed, MIN_PROGRAMS, PROGRAM_RATIO, 'programs');
  ratioCheck('distinct event types handled', baseline.listenerTypes, current.listenerTypes, MIN_LISTENER_TYPES, LISTENER_RATIO, 'types');

  return { regressed: findings.length >= BLOCK_AT_FINDINGS, findings, table };
}

/**
 * The sentence the model is given. Verbatim numbers, no score: a percentage is
 * what stalled the run this whole class of gate came from — the model needs to
 * know WHAT it deleted, not how badly it is doing.
 */
export function capabilityFeedback(cmp: CapabilityComparison): string {
  if (!cmp.regressed) return '';
  return [
    'CAPABILITY REGRESSION — the app still runs, but it now DOES LESS than the build you started from.',
    '',
    ...cmp.findings.map((f) => `- ${f}`),
    '',
    'Measured before your changes vs now:',
    ...cmp.table.map((t) => `  ${t}`),
    '',
    'This is not a rendering-cleanliness problem: a smaller, emptier app renders perfectly cleanly.',
    'Something that used to be drawn, animated, or responded to is no longer there. Restore the',
    'missing behaviour — the features, entities, effects and input handling from the original build —',
    'without reintroducing errors. Do NOT simplify the app further to make gates pass.',
  ].join('\n');
}

/**
 * What to say when the check did NOT block: a single-metric drop, or the reason
 * it declined to judge at all.
 *
 * The skip half is the important half. `skipped` used to be returned and read by
 * nobody — not the acceptance gate, not the keep-best veto, not verify — so a
 * check that had silently disarmed itself (a driver swap mid-run, a vanished
 * baseline, an unmeasurable page) was indistinguishable from one that ran and
 * found nothing. That is exactly the inert-rung failure this module's header
 * warns about, reproduced in the module's own output.
 */
export function capabilityNote(cmp: CapabilityComparison): string {
  if (cmp.skipped) return `Capability check did not run: ${cmp.skipped}.`;
  if (cmp.regressed || cmp.findings.length === 0) return '';
  return `Capability note (not blocking): ${cmp.findings.join('; ')}.`;
}

/** True when the check produced no opinion — callers should SAY so, not assume health. */
export const capabilityInactive = (cmp: CapabilityComparison): boolean => Boolean(cmp.skipped);

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * On-disk layout, mirroring `.uap/visual/` (see visual-baseline.ts):
 *   .uap/capability/current.json   written by the execution gate every run
 *   .uap/capability/baseline.json  pinned pre-run, or by `uap verify --approve`
 *
 * Disk is what makes this reachable from BOTH sides. The execution gate often
 * runs in a spawned runner (synthesizeExecutionRung), so a return value does
 * not cross that boundary — the visual gate has the same constraint and solves
 * it the same way, with files. It also survives `--resume`, where an in-memory
 * baseline would be re-taken from the already-modified tree.
 */
/** Opt-out, matching every other gate in this subsystem. Off means the profile
 *  is never written and every comparison declines. */
export const capabilityEnabled = (): boolean =>
  !['0', 'false', 'off', 'no'].includes((process.env.UAP_CAPABILITY ?? '').trim().toLowerCase());

export const CAPABILITY_DIR = join('.uap', 'capability');
export const currentPath = (root: string): string => join(root, CAPABILITY_DIR, 'current.json');
export const baselinePath = (root: string): string => join(root, CAPABILITY_DIR, 'baseline.json');

function readProfile(path: string): CapabilityProfile | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return sanitizeProfile(raw);
  } catch {
    return null;
  }
}

function writeProfile(path: string, profile: CapabilityProfile): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop any previous run's reading. Called at the START of every execution-gate
 * run so `current.json` exists only when THIS run measured something — see the
 * comment at that call site for what staleness cost.
 */
export function invalidateCapabilityCurrent(root: string): void {
  try {
    if (existsSync(currentPath(root))) rmSync(currentPath(root), { force: true });
  } catch {
    /* fail-soft: a stale reading is better than a crashed gate */
  }
}

/**
 * Drop a baseline this run could not re-pin.
 *
 * A baseline is only meaningful for the tree it was taken from. Left in place
 * across runs it becomes a reading of a DIFFERENT app: a run that pins 14
 * draws/frame on a rich game, followed later by an unrelated run on a
 * deliberately simpler project, blocks every turn against a stale number — and
 * the operator has to know about an --approve flag to escape. Better to have no
 * opinion than a confidently wrong one.
 */
export function invalidateCapabilityBaseline(root: string): void {
  try {
    if (existsSync(baselinePath(root))) rmSync(baselinePath(root), { force: true });
  } catch {
    /* fail-soft */
  }
}

export const readCapabilityBaseline = (root: string): CapabilityProfile | null => readProfile(baselinePath(root));
export const readCapabilityCurrent = (root: string): CapabilityProfile | null => readProfile(currentPath(root));
export const writeCapabilityCurrent = (root: string, p: CapabilityProfile): boolean => writeProfile(currentPath(root), p);
export const writeCapabilityBaseline = (root: string, p: CapabilityProfile): boolean => writeProfile(baselinePath(root), p);

/**
 * Coerce an untrusted reading into a profile, or null.
 *
 * EVERY number here is attacker-controllable: the page under test is code a
 * model just wrote, and it can replace the read-back hook. `typeof x ===
 * 'number'` is not validation — `typeof NaN` and `typeof Infinity` are both
 * 'number', and a NaN baseline propagates through every threshold comparison
 * (`NaN < floor` is false, `NaN >= base*ratio` is false) to produce
 * "dropped NaN%" findings on EVERY turn: a permanent, unactionable block.
 * Measured before this guard existed.
 */
const REASONS: readonly CapabilityReason[] = ['no-entry', 'no-browser', 'not-installed', 'no-reading', 'error'];

export function sanitizeProfile(raw: unknown): CapabilityProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  // A page cannot be trusted to report a plausible magnitude either; the cap is
  // far above any real reading (60fps for a minute is 3600 frames).
  const CAP = 10_000_000;
  const num = (k: string): number => {
    const v = o[k];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, CAP) : 0;
  };
  if (typeof o.measured !== 'boolean') return null;
  const gl = num('glDrawCalls');
  const ctx = num('ctx2dDrawCalls');
  return {
    measured: o.measured,
    // Validated against the union, not cast into it. This is the only string
    // read from disk that steers control flow (see the no-entry branch in
    // compareCapability), so an unrecognised value must become "no reason"
    // rather than a verdict.
    ...(REASONS.includes(o.reason as CapabilityReason) ? { reason: o.reason as CapabilityReason } : {}),
    elapsedMs: num('elapsedMs'),
    frames: num('frames'),
    drawCalls: gl + ctx,
    glDrawCalls: gl,
    ctx2dDrawCalls: ctx,
    programsUsed: num('programsUsed'),
    listenerTypes: num('listenerTypes'),
    listeners: num('listeners'),
    canvas: o.canvas === true,
    ...(typeof o.driver === 'string' ? { driver: o.driver } : {}),
    ...(typeof o.entry === 'string' ? { entry: o.entry } : {}),
  };
}
