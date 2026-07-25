/**
 * Probe runner — drives one probe and judges its assertions.
 *
 * Time-based assertions (`increases`, `changes`) capture their baseline BEFORE
 * the probe's input runs and read again after. That ordering is what makes
 * "hold fire for 20 seconds → the score rose" expressible: sampling only after
 * the input stops would measure a game that is no longer being played.
 */

import { flattenSteps } from './manifest.js';
import type { InteractionDriver, ReadResult } from './driver.js';
import { delay } from './driver.js';
import type { Assertion, AssertionResult, Probe, ProbeResult, Step } from './types.js';

export const DEFAULT_PROBE_TIMEOUT_MS = 120_000;

/** Guard against a manifest asking for an effectively infinite loop. */
export const MAX_REPEAT = 10_000;

/**
 * Expand `repeat` blocks HERE rather than in each driver.
 *
 * When expansion lived in the web driver, every other adapter silently dropped
 * repeat blocks: the probe drove no input at all and then still reported a pass
 * whenever its assertion happened to hold anyway. A gate that quietly stops
 * driving input is worse than no gate, because it reports success.
 */
export async function dispatchStep(driver: InteractionDriver, step: Step): Promise<void> {
  if (step.do === 'repeat') {
    const times = Math.max(0, Math.min(step.times, MAX_REPEAT));
    for (let i = 0; i < times; i++) {
      for (const inner of step.steps) await dispatchStep(driver, inner);
    }
    return;
  }
  await driver.runStep(step);
}

function label(a: Assertion, index: number): string {
  if ('label' in a && a.label) return a.label;
  switch (a.expect) {
    case 'noErrors':
      return 'no runtime errors';
    case 'truthy':
      return `${a.expr} is truthy`;
    case 'equals':
      return `${a.expr} === ${JSON.stringify(a.value)}`;
    case 'gte':
      return `${a.expr} >= ${a.value}`;
    case 'lte':
      return `${a.expr} <= ${a.value}`;
    case 'increases':
      return `${a.expr} increases${a.by ? ` by >= ${a.by}` : ''}`;
    case 'changes':
      return `${a.expr} changes`;
    default:
      return `assertion #${index + 1}`;
  }
}

function show(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s;
  } catch {
    return String(v);
  }
}

/** True when the assertion needs a reading taken before the input runs. */
export function needsBaseline(a: Assertion): a is Extract<Assertion, { expect: 'increases' | 'changes' }> {
  return a.expect === 'increases' || a.expect === 'changes';
}

/**
 * Pure judgement for one assertion given its observations — the interesting
 * logic, unit-testable without a browser.
 */
export function judgeAssertion(
  a: Assertion,
  index: number,
  observed: {
    value?: unknown;
    baseline?: unknown;
    errors?: string[];
    /** Set when the observation expression did not resolve. */
    unresolved?: string;
  }
): AssertionResult {
  const name = label(a, index);
  // A probe that observes something the artifact does not expose has told us
  // nothing about the artifact. Report it as a broken probe so the fix lands on
  // the manifest instead of on working code.
  if (observed.unresolved && a.expect !== 'noErrors') {
    return {
      label: name,
      passed: false,
      unresolved: true,
      expected: 'an observable the artifact exposes',
      observed: observed.unresolved,
    };
  }
  switch (a.expect) {
    case 'noErrors': {
      const errs = observed.errors ?? [];
      return {
        label: name,
        passed: errs.length === 0,
        expected: 'no runtime errors',
        observed: errs.length === 0 ? 'none' : errs.slice(0, 3).join(' | '),
      };
    }
    case 'truthy':
      return {
        label: name,
        passed: Boolean(observed.value),
        expected: 'truthy',
        observed: show(observed.value),
      };
    case 'equals':
      return {
        label: name,
        passed: JSON.stringify(observed.value) === JSON.stringify(a.value),
        expected: show(a.value),
        observed: show(observed.value),
      };
    case 'gte': {
      const v = Number(observed.value);
      return {
        label: name,
        passed: Number.isFinite(v) && v >= a.value,
        expected: `>= ${a.value}`,
        observed: show(observed.value),
      };
    }
    case 'lte': {
      const v = Number(observed.value);
      return {
        label: name,
        passed: Number.isFinite(v) && v <= a.value,
        expected: `<= ${a.value}`,
        observed: show(observed.value),
      };
    }
    case 'increases': {
      const start = Number(observed.baseline);
      const end = Number(observed.value);
      const by = a.by ?? 1;
      const ok = Number.isFinite(start) && Number.isFinite(end) && end - start >= by;
      return {
        label: name,
        passed: ok,
        expected: `rise of >= ${by} within ${a.overMs}ms`,
        observed: `${show(observed.baseline)} → ${show(observed.value)}`,
      };
    }
    case 'changes': {
      const ok = JSON.stringify(observed.baseline) !== JSON.stringify(observed.value);
      return {
        label: name,
        passed: ok,
        expected: `different value within ${a.overMs}ms`,
        observed: `${show(observed.baseline)} → ${show(observed.value)}`,
      };
    }
    default:
      return {
        label: name,
        passed: false,
        expected: 'a known assertion kind',
        observed: `unsupported: ${String((a as { expect?: string }).expect)}`,
      };
  }
}

export interface RunProbeOptions {
  timeoutMs?: number;
  /** Written to when the probe wants an evidence screenshot. */
  evidencePath?: string;
}

/** Marks a probe that blew its wall-clock bound rather than failing on merit. */
export const PROBE_TIMEOUT_MARKER = 'probe exceeded its time budget';

class ProbeTimeout extends Error {}

/**
 * Bound a probe's wall clock. `repeat` blocks are legal up to MAX_REPEAT
 * iterations, so a single probe can otherwise run for hours — and on the Stop
 * hook that means an outer `timeout` kills the process mid-probe, skipping the
 * `finally` that reaps the browser. An unbounded gate is a session-wedging
 * hazard, not just a slow one.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout(PROBE_TIMEOUT_MARKER)), ms);
        // Never hold the event loop open just for the watchdog timer.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run one probe end to end. Never throws: a driver failure becomes a FAILING
 * result rather than an exception, because an interaction gate that crashes is
 * indistinguishable from one that passed.
 */
export async function runProbe(
  driver: InteractionDriver,
  probe: Probe,
  opts: RunProbeOptions = {}
): Promise<ProbeResult> {
  const started = Date.now();
  const base: Omit<ProbeResult, 'passed' | 'assertions' | 'errors' | 'durationMs'> = {
    probeId: probe.id,
    description: probe.description,
    mode: probe.mode,
    requirementIds: probe.requirementIds ?? [],
  };

  // Defence in depth: manifest validation already rejects this, but a manifest
  // could be hand-edited between validation and execution.
  if (probe.mode !== 'accelerated' && flattenSteps(probe.steps).some((s) => s.do === 'inject')) {
    return {
      ...base,
      passed: false,
      assertions: [
        {
          label: 'probe integrity',
          passed: false,
          expected: 'no state injection outside accelerated probes',
          observed: 'probe injects the state it then asserts',
        },
      ],
      errors: [],
      durationMs: Date.now() - started,
    };
  }

  const errorsBefore = new Set(driver.errors());
  const baselines = new Map<number, unknown>();
  const assertions: AssertionResult[] = [];

  // Prefer the detailed read so an unresolvable observable is reported as a
  // broken probe; drivers that only implement `read` degrade to the old
  // behaviour rather than failing.
  const readDetailed = async (expr: string): Promise<ReadResult> =>
    driver.readDetailed ? driver.readDetailed(expr) : { ok: true, value: await driver.read(expr) };

  try {
    // Baselines first — before any input runs.
    for (let i = 0; i < probe.asserts.length; i++) {
      const a = probe.asserts[i];
      if (needsBaseline(a)) baselines.set(i, (await readDetailed(a.expr)).value);
    }

    const budget = probe.timeoutMs ?? opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    await withTimeout(
      (async () => {
        for (const step of probe.steps) await dispatchStep(driver, step);
      })(),
      budget
    );

    // Honour each time-based assertion's observation window even when the input
    // finished sooner.
    const longestWindow = probe.asserts.reduce(
      (max, a) => (needsBaseline(a) ? Math.max(max, a.overMs) : max),
      0
    );
    const elapsed = Date.now() - started;
    if (longestWindow > elapsed) await delay(longestWindow - elapsed);

    const newErrors = driver.errors().filter((e) => !errorsBefore.has(e));
    for (let i = 0; i < probe.asserts.length; i++) {
      const a = probe.asserts[i];
      const read = a.expect === 'noErrors' ? { ok: true } : await readDetailed(a.expr);
      assertions.push(
        judgeAssertion(a, i, {
          value: read.value,
          baseline: baselines.get(i),
          errors: newErrors,
          ...(read.ok ? {} : { unresolved: read.error ?? 'expression did not resolve' }),
        })
      );
    }

    if (opts.evidencePath && driver.capture) await driver.capture(opts.evidencePath);

    return {
      ...base,
      passed: assertions.every((r) => r.passed),
      assertions,
      errors: newErrors,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      ...base,
      passed: false,
      assertions,
      errors: [`probe execution failed: ${String(e).slice(0, 300)}`],
      durationMs: Date.now() - started,
    };
  }
}
