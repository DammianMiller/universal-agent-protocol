/**
 * Capability regression gate.
 *
 * THE GAP IT CLOSES. Every other rung asks "does it run cleanly?"; a build can
 * answer yes by doing LESS. Measured on octopus_invaders_v4 (2026-08-19): one
 * run took the gate score 0% -> 100% while the deliverable lost most of its
 * function — draw calls 12 -> 3, listeners 8 -> 3, ~419 -> ~25 frames per 7s,
 * 65.8KB -> 25.8KB. The acceptance judge scored it 8/9, the execution gate
 * passed it, and --keep-best could not help because it rolls back on the GATE
 * SCORE, which had gone UP.
 *
 * Two of this file's earlier tests were VACUOUS and are called out below, so the
 * same mistake is not made again: an "unmeasured" fixture carrying the same
 * numbers as the baseline (so the measured flag was never load-bearing), and a
 * baseline getter returning a constant (so reading it at construction time
 * instead of call time — which would have disabled the whole feature — passed).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compareCapability,
  capabilityFeedback,
  capabilityNote,
  readCapabilityBaseline,
  readCapabilityCurrent,
  writeCapabilityBaseline,
  writeCapabilityCurrent,
  sanitizeProfile,
  unmeasured,
  fpsOf,
  drawsPerFrame,
  type CapabilityProfile,
} from '../../src/delivery/capability-profile.js';
import { buildMissionAcceptanceGate } from '../../src/delivery/mission-acceptance.js';

/** A healthy 60fps scene: 120 frames in 2s, 11 draws/frame, 5 shaders, 6 inputs. */
const profile = (over: Partial<CapabilityProfile> = {}): CapabilityProfile => ({
  measured: true,
  elapsedMs: 2000,
  frames: 120,
  drawCalls: 1320,
  glDrawCalls: 1320,
  ctx2dDrawCalls: 0,
  programsUsed: 5,
  listenerTypes: 6,
  listeners: 9,
  canvas: true,
  driver: 'instrumented',
  ...over,
});

/** The octopus regression at the ratios actually measured: all four metrics. */
const GUTTED = profile({
  frames: 7,
  drawCalls: 21,
  glDrawCalls: 21,
  programsUsed: 1,
  listenerTypes: 2,
  listeners: 3,
});

describe('compareCapability — catches a build that runs but does less', () => {
  it('flags the measured octopus regression', () => {
    const cmp = compareCapability(profile(), GUTTED);
    expect(cmp.regressed).toBe(true);
    const text = cmp.findings.join('\n');
    expect(text).toMatch(/render loop is no longer running at a usable rate/);
    expect(text).toMatch(/shader programs/);
    expect(text).toMatch(/event types/);
  });

  it('reports both raw numbers, never a score', () => {
    const text = capabilityFeedback(compareCapability(profile(), GUTTED));
    expect(text).toContain('5 -> 1'); // programs, verbatim
    expect(text).toContain('6 -> 2'); // event types, verbatim
    expect(text).toMatch(/60\.0 -> 3\.5 fps/);
  });

  it('says nothing at all when there is no regression', () => {
    // capabilityFeedback used to emit the full CAPABILITY REGRESSION banner with
    // an empty bullet list for a clean comparison.
    expect(capabilityFeedback(compareCapability(profile(), profile()))).toBe('');
  });

  it('passes an unchanged build, and one that does MORE', () => {
    expect(compareCapability(profile(), profile()).regressed).toBe(false);
    const richer = profile({ frames: 124, drawCalls: 7000, programsUsed: 8, listenerTypes: 9 });
    expect(compareCapability(profile(), richer).regressed).toBe(false);
  });
});

describe('compareCapability — the false positives it must NOT produce', () => {
  it('does not fire on frame-rate contention, only on a liveness floor', () => {
    // THE CALIBRATION THAT MATTERS. The baseline is taken before the run's first
    // model call; the candidate minutes later on a box decoding tokens on the
    // same GPU under software WebGL. A 0.4 RATIO trips at 2.5x, inside that
    // noise. Same scene at a third of the frame rate is not a regression.
    const contended = profile({ frames: 40, drawCalls: 440 });
    expect(fpsOf(contended)).toBeCloseTo(20, 0);
    const cmp = compareCapability(profile(), contended);
    // Assert on FINDINGS, not just `regressed`. 40/120 is a 0.33 ratio, so a
    // ratio-based frames check WOULD flag this — and the two-finding block rule
    // would then hide that from a `regressed === false` assertion. Testing the
    // finding list is what makes floor-vs-ratio observable.
    expect(cmp.findings).toEqual([]);
    expect(cmp.regressed).toBe(false);
  });

  it('does fire when the loop drops below a usable rate', () => {
    const dead = profile({ frames: 8, drawCalls: 88, programsUsed: 1 });
    const cmp = compareCapability(profile(), dead);
    expect(cmp.findings.join('\n')).toMatch(/no longer running at a usable rate/);
  });

  it('does not treat a setInterval loop as zero draws per frame', () => {
    // MEASURED FALSE POSITIVE. A setInterval render loop never touches
    // requestAnimationFrame, so frames reads 0 while draws keep counting.
    // Dividing by a floored 1 turned draws-per-frame into draws-per-window, and
    // a setInterval -> rAF refactor (an IMPROVEMENT) reported
    // "draw calls per frame dropped 100%: 6300 -> 21".
    const timerLoop = profile({ frames: 0, drawCalls: 6300, glDrawCalls: 6300 });
    const rafLoop = profile({ frames: 120, drawCalls: 6300, glDrawCalls: 6300 });
    const cmp = compareCapability(timerLoop, rafLoop);
    expect(cmp.findings.join('\n')).not.toMatch(/draw calls per frame/);
    expect(cmp.regressed).toBe(false);
  });

  it('requires TWO metrics to drop before it blocks', () => {
    // A lone metric has legitimate ways to fall: merging five shaders into an
    // uber-shader, switching a per-entity draw path to an instanced one,
    // delegating event handling. Blocking on one, with feedback that says
    // "restore the missing behaviour", asks the model to undo a correct
    // optimisation. The recorded regression dropped all four at once.
    const oneDrop = profile({ programsUsed: 1 });
    const cmp = compareCapability(profile(), oneDrop);
    expect(cmp.findings).toHaveLength(1);
    expect(cmp.regressed).toBe(false);
    // …but it is still reported, as evidence rather than a block.
    expect(capabilityNote(cmp)).toMatch(/not blocking/);
    expect(capabilityNote(cmp)).toMatch(/shader programs/);
  });

  it('tolerates ordinary consolidation', () => {
    const refactored = profile({ programsUsed: 4, drawCalls: 960, listenerTypes: 5, frames: 116 });
    expect(compareCapability(profile(), refactored).regressed).toBe(false);
  });

  it('pins the baseline-was-alive precondition for the liveness floor', () => {
    // ALIVE_FPS is what stops a slideshow-rate baseline (say 12fps) making any
    // dip below 10 a "regression". Without it, a low-fps app can never recover.
    const slow = profile({ frames: 24 }); // 12 fps baseline
    const slower = profile({ frames: 16, programsUsed: 5, listenerTypes: 6 }); // 8 fps
    expect(compareCapability(slow, slower).findings).toEqual([]);
  });

  it('can be switched off entirely', () => {
    const prev = process.env.UAP_CAPABILITY;
    process.env.UAP_CAPABILITY = '0';
    try {
      const cmp = compareCapability(profile(), GUTTED);
      expect(cmp.regressed).toBe(false);
      expect(cmp.skipped).toMatch(/disabled/);
    } finally {
      if (prev === undefined) delete process.env.UAP_CAPABILITY;
      else process.env.UAP_CAPABILITY = prev;
    }
  });

  it('refuses to compare readings from different browser drivers', () => {
    // The driver fallback is silent, and two drivers have completely different
    // frame-rate regimes — that is not a comparison, it is a coin flip.
    // Round-tripped through DISK, because that is how production gets its
    // profiles: sanitizeProfile is the only path in, and dropping `driver`
    // there made this guard permanently dead while an in-memory version of this
    // test stayed green.
    const dir = mkdtempSync(join(tmpdir(), 'uap-cap-drv-'));
    try {
      writeCapabilityBaseline(dir, profile({ driver: 'playwright' }));
      writeCapabilityCurrent(dir, { ...GUTTED, driver: 'WebBrowser' });
      const cmp = compareCapability(readCapabilityBaseline(dir), readCapabilityCurrent(dir));
      expect(cmp.regressed).toBe(false);
      expect(cmp.skipped).toMatch(/different browser drivers/);
      // …and the skip must be SAYABLE, or an inert check looks like a healthy one.
      expect(capabilityNote(cmp)).toMatch(/did not run/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compareCapability — fails open, except where it must not', () => {
  it('skips when the CURRENT reading is unmeasurable', () => {
    // NOT VACUOUS, unlike the version this replaces. The old fixture was
    // `profile({ measured: false })` — numerically IDENTICAL to the baseline —
    // so `regressed === false` held whether or not the measured flag was
    // consulted at all, and deleting the current-side check passed the suite.
    // A real unmeasured profile is all ZEROS, which trips every threshold.
    const un = unmeasured('error', 'instrumented');
    const cmp = compareCapability(profile(), un);
    expect(cmp.regressed).toBe(false);
    expect(cmp.skipped).toMatch(/not measurable/);
  });

  it('skips with no baseline', () => {
    expect(compareCapability(null, profile()).regressed).toBe(false);
    expect(compareCapability(unmeasured('no-entry'), profile()).regressed).toBe(false);
  });

  it('but a VANISHED entry page is a regression, not an excuse', () => {
    // Deleting index.html is the most complete regression possible, and the
    // naive "either side unmeasured -> skip" rule forgave it outright.
    const cmp = compareCapability(profile({ entry: 'index.html' }), unmeasured('no-entry'));
    expect(cmp.regressed).toBe(true);
    expect(cmp.findings.join()).toMatch(/entry page is GONE/);
  });

  it('you cannot regress from broken', () => {
    const dead = profile({ frames: 0, drawCalls: 0, glDrawCalls: 0, programsUsed: 0, listenerTypes: 0 });
    const cmp = compareCapability(dead, GUTTED);
    expect(cmp.regressed).toBe(false);
    expect(cmp.skipped).toMatch(/never rendered/);
  });

  it('ignores metrics too small for a ratio to mean anything', () => {
    const tiny = profile({ frames: 20, drawCalls: 8, programsUsed: 1, listenerTypes: 2 });
    const tinier = profile({ frames: 18, drawCalls: 1, programsUsed: 0, listenerTypes: 1 });
    // Assert the FINDING LIST, not `regressed`. Each floor produces at most one
    // finding, and the two-finding block rule hides a missing floor behind
    // `regressed === false` — so with the weaker assertion, deleting any of
    // MIN_PROGRAMS / MIN_LISTENER_TYPES / MIN_DRAWS_PER_FRAME left the suite green.
    expect(compareCapability(tiny, tinier).findings).toEqual([]);
  });
});

describe('sanitizeProfile — the page under test is untrusted', () => {
  it('rejects NaN and Infinity, which typeof calls numbers', () => {
    // MEASURED: a NaN baseline propagated through every threshold (`NaN < floor`
    // is false, `NaN >= base*ratio` is false) and produced "dropped NaN%"
    // findings on EVERY turn — a permanent, unactionable block.
    const p = sanitizeProfile({ measured: true, frames: NaN, glDrawCalls: Infinity, elapsedMs: 2000 });
    expect(p?.frames).toBe(0);
    expect(p?.glDrawCalls).toBe(0);
    const cmp = compareCapability(profile(), p);
    expect(cmp.findings.join()).not.toMatch(/NaN/);
  });

  it('clamps an absurd magnitude a hostile page could report', () => {
    const p = sanitizeProfile({ measured: true, frames: 1e15, elapsedMs: 2000 });
    expect(p?.frames).toBeLessThanOrEqual(10_000_000);
  });

  it('rejects negatives, non-numbers and non-objects', () => {
    expect(sanitizeProfile({ measured: true, frames: -5 })?.frames).toBe(0);
    expect(sanitizeProfile({ measured: true, frames: '120' })?.frames).toBe(0);
    expect(sanitizeProfile(null)).toBeNull();
    expect(sanitizeProfile({ frames: 1 })).toBeNull(); // no measured flag
  });

  it('derives drawCalls from its parts so one cannot be dropped silently', () => {
    // Mutating `drawCalls: gl + ctx` to `drawCalls: gl` used to break nothing:
    // every fixture set ctx2dDrawCalls to 0, and the gate would then read every
    // 2D-canvas deliverable as zero draws forever.
    const p = sanitizeProfile({ measured: true, glDrawCalls: 40, ctx2dDrawCalls: 600 });
    expect(p?.drawCalls).toBe(640);
  });
});

describe('capability baseline persistence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-cap-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips a profile through disk', () => {
    expect(writeCapabilityCurrent(dir, profile())).toBe(true);
    const back = readCapabilityCurrent(dir);
    expect(back?.frames).toBe(120);
    expect(drawsPerFrame(back!)).toBeCloseTo(11, 5);
  });

  it('returns null rather than throwing on missing or corrupt files', () => {
    expect(readCapabilityBaseline(dir)).toBeNull();
    mkdirSync(join(dir, '.uap', 'capability'), { recursive: true });
    writeFileSync(join(dir, '.uap', 'capability', 'baseline.json'), '{not json');
    expect(readCapabilityBaseline(dir)).toBeNull();
  });

  it('sanitizes on READ, so a tampered baseline file cannot poison a run', () => {
    mkdirSync(join(dir, '.uap', 'capability'), { recursive: true });
    writeFileSync(
      join(dir, '.uap', 'capability', 'baseline.json'),
      JSON.stringify({ measured: true, frames: 1e20, elapsedMs: 1, glDrawCalls: -3 })
    );
    const b = readCapabilityBaseline(dir);
    expect(b?.frames).toBeLessThanOrEqual(10_000_000);
    expect(b?.glDrawCalls).toBe(0);
  });

  it('baseline and current are separate files', () => {
    writeCapabilityBaseline(dir, profile());
    writeCapabilityCurrent(dir, GUTTED);
    expect(compareCapability(readCapabilityBaseline(dir), readCapabilityCurrent(dir)).regressed).toBe(true);
  });
});

describe('mission acceptance — capability is judged only after the build RUNS', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    primary: true,
    specs: { resolve: () => 'spec', breaker: () => ({ check: (_s: string, v: unknown) => v }) },
    judgeExecutor: (async () => '{}') as never,
    note: () => undefined,
    visualGate: async () => ({ skipped: true, passed: true, structural: false, pages: [] }),
    interactionGate: async () => ({ skipped: true, passed: true, feedback: '' }),
    visionReview: async () => null,
    userPathsNote: () => null,
    judge: async () => ({ passed: true, score: 9, criteria: [] }),
    ...over,
  });

  it('blocks a turn that gutted the deliverable', async () => {
    const gate = buildMissionAcceptanceGate(
      deps({
        executionGate: async () => ({ passed: true, exitCode: 0, outputTail: '', durationMs: 1 }),
        capabilityBaseline: () => profile(),
        capabilityCurrent: () => GUTTED,
      }) as never
    );
    const r = await gate('/tmp/x', undefined as never);
    expect(r.passed).toBe(false);
    expect(r.feedback).toMatch(/CAPABILITY REGRESSION/);
    expect(r.feedback).toMatch(/Do NOT simplify the app further/);
  });

  it('does NOT read a capability verdict for a build that failed to run', async () => {
    // Ordering rule this file states for every observation gate. A crashed build
    // draws nothing and listens for nothing, so comparing it reports a capability
    // collapse on top of the execution failure — two verdicts for one bug, the
    // second misleading.
    const cur = vi.fn(() => GUTTED);
    const gate = buildMissionAcceptanceGate(
      deps({
        executionGate: async () => ({ passed: false, exitCode: 1, outputTail: 'boom', durationMs: 1 }),
        capabilityBaseline: () => profile(),
        capabilityCurrent: cur,
      }) as never
    );
    const r = await gate('/tmp/x', undefined as never);
    expect(r.feedback).toMatch(/EXECUTION FAILED/);
    expect(cur).not.toHaveBeenCalled();
  });

  it('reads the baseline at CALL time, not construction time', async () => {
    // NOT VACUOUS, unlike the version this replaces. Every earlier test passed a
    // CONSTANT getter, so hoisting the read out of the returned closure — which
    // in production disables the entire feature, because deliver pins the
    // baseline long after the gate is built — failed nothing.
    let baseline: CapabilityProfile | null = null;
    const gate = buildMissionAcceptanceGate(
      deps({
        executionGate: async () => ({ passed: true, exitCode: 0, outputTail: '', durationMs: 1 }),
        capabilityBaseline: () => baseline,
        capabilityCurrent: () => GUTTED,
      }) as never
    );
    baseline = profile(); // pinned AFTER construction, as deliver.ts does
    const r = await gate('/tmp/x', undefined as never);
    expect(r.passed).toBe(false);
    expect(r.feedback).toMatch(/CAPABILITY REGRESSION/);
  });

  it('yields to the interaction gate when BOTH would fire', async () => {
    // Ordering pin. Both verdicts can be true on one turn, and the interaction
    // gate's is strictly more useful: it names WHICH promised behaviour broke,
    // where this one names a magnitude. Reporting the magnitude first sends the
    // next turn after a number instead of a defect.
    const gate = buildMissionAcceptanceGate(
      deps({
        executionGate: async () => ({ passed: true, exitCode: 0, outputTail: '', durationMs: 1 }),
        interactionGate: async () => ({
          skipped: false,
          passed: false,
          feedback: 'INTERACTION FAILED — the fire control does nothing',
        }),
        capabilityBaseline: () => profile(),
        capabilityCurrent: () => GUTTED,
      }) as never
    );
    const r = await gate('/tmp/x', undefined as never);
    expect(r.passed).toBe(false);
    expect(r.feedback).toMatch(/INTERACTION FAILED/);
    expect(r.feedback).not.toMatch(/CAPABILITY REGRESSION/);
  });

  it('lets a healthy turn through to the judge', async () => {
    const gate = buildMissionAcceptanceGate(
      deps({
        executionGate: async () => ({ passed: true, exitCode: 0, outputTail: '', durationMs: 1 }),
        capabilityBaseline: () => profile(),
        capabilityCurrent: () => profile(),
      }) as never
    );
    expect((await gate('/tmp/x', undefined as never)).passed).toBe(true);
  });

  it('passes a single-metric drop through to the judge as evidence', async () => {
    const seen: string[] = [];
    const gate = buildMissionAcceptanceGate(
      deps({
        executionGate: async () => ({ passed: true, exitCode: 0, outputTail: '', durationMs: 1 }),
        capabilityBaseline: () => profile(),
        capabilityCurrent: () => profile({ programsUsed: 1 }),
        judge: async (a: { runtimeNote?: string }) => {
          seen.push(a.runtimeNote ?? '');
          return { passed: true, score: 9, criteria: [] };
        },
      }) as never
    );
    const r = await gate('/tmp/x', undefined as never);
    expect(r.passed).toBe(true);
    expect(seen.join()).toMatch(/Capability note \(not blocking\)/);
  });
});
