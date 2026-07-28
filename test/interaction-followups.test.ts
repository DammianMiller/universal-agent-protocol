import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeniedPath } from '../src/delivery/execution-gate.js';
import { runInteractionGate } from '../src/delivery/interaction-gate.js';
import type { InteractionManifest } from '../src/delivery/interaction/types.js';
import { countByMessage, newErrorsSince, runProbe } from '../src/delivery/interaction/runner.js';
import type { InteractionDriver, ReadResult } from '../src/delivery/interaction/driver.js';
import type { Step } from '../src/delivery/interaction/types.js';

describe('static server denylist', () => {
  it('refuses dotfiles and dependency/VCS directories at any depth', () => {
    // The server roots at the PROJECT dir, so these would otherwise be 200s on
    // the same origin as a page whose JS was written by the model being graded.
    expect(isDeniedPath('.uap/proxy.env')).toBe(true);
    expect(isDeniedPath('.env')).toBe(true);
    expect(isDeniedPath('.git/config')).toBe(true);
    expect(isDeniedPath('sub/.git/config')).toBe(true);
    expect(isDeniedPath('node_modules/left-pad/index.js')).toBe(true);
    expect(isDeniedPath('.worktrees/1/x')).toBe(true);
  });

  it('leaves ordinary assets alone', () => {
    expect(isDeniedPath('index.html')).toBe(false);
    expect(isDeniedPath('js/game.js')).toBe(false);
    expect(isDeniedPath('assets/sprite.png')).toBe(false);
    // A dot INSIDE a filename is not a dotfile.
    expect(isDeniedPath('js/game.min.js')).toBe(false);
  });
});

describe('error attribution by count', () => {
  it('counts repeats rather than deduplicating by message', () => {
    const before = countByMessage(['boom', 'boom']);
    const driver = { errors: () => ['boom', 'boom', 'boom', 'other'] };
    // A deterministic error that re-fires every frame is identical to the first
    // occurrence, so set-membership filtering reported NONE and later probes
    // passed `noErrors` against a page that had just thrown.
    expect(newErrorsSince(driver, before)).toEqual(['boom', 'other']);
  });

  it('reports nothing when no error recurred', () => {
    const before = countByMessage(['boom']);
    expect(newErrorsSince({ errors: () => ['boom'] }, before)).toEqual([]);
  });
});

describe('per-assertion time windows', () => {
  class TimedDriver implements InteractionDriver {
    private started = Date.now();
    readAt: Record<string, number[]> = {};
    async start(): Promise<void> {}
    async runStep(_s: Step): Promise<void> {}
    async read(expr: string): Promise<unknown> {
      return (await this.readDetailed(expr)).value;
    }
    async readDetailed(expr: string): Promise<ReadResult> {
      const elapsed = Date.now() - this.started;
      (this.readAt[expr] ??= []).push(elapsed);
      // `flash` is TRANSIENT and then reverts, keyed off CALL COUNT rather than
      // wall clock so the test cannot flake under load: 1 on the baseline read,
      // 0 on the next (the short window), 1 thereafter (the long window).
      // Sampling it at the long deadline reads it as unchanged — the exact
      // false failure this fix removes.
      if (expr === 'flash') {
        const n = (this.readAt['flash'] ?? []).length;
        return { ok: true, value: n <= 1 ? 1 : n === 2 ? 0 : 1 };
      }
      return { ok: true, value: elapsed };
    }
    async inject(): Promise<void> {}
    errors(): string[] {
      return [];
    }
    async stop(): Promise<void> {}
  }

  it('samples a short window at its own deadline, not the longest one', async () => {
    const driver = new TimedDriver();
    const r = await runProbe(driver, {
      id: 'P-windows',
      requirementIds: [],
      mode: 'core',
      description: 'a transient change alongside a long-running rise',
      steps: [{ do: 'wait', ms: 10 }],
      asserts: [
        // Reverts after 250ms — sampling this at the 800ms window would read it
        // as unchanged and false-fail.
        { expect: 'changes', expr: 'flash', overMs: 120 },
        { expect: 'increases', expr: 'clock', overMs: 800 },
      ],
    });
    expect(r.passed).toBe(true);
    const flashReads = driver.readAt['flash'] ?? [];
    // Baseline plus one read at ~120ms — well before the 800ms window closes.
    expect(flashReads[flashReads.length - 1]).toBeLessThan(700);
  });

  it('still reports assertions in the manifest order, not the sampling order', async () => {
    const driver = new TimedDriver();
    const r = await runProbe(driver, {
      id: 'P-order',
      requirementIds: [],
      mode: 'core',
      description: 'long window declared first',
      steps: [{ do: 'wait', ms: 5 }],
      asserts: [
        { expect: 'increases', expr: 'clock', overMs: 300, label: 'declared-first' },
        { expect: 'changes', expr: 'flash', overMs: 100, label: 'declared-second' },
      ],
    });
    expect(r.assertions.map((a) => a.label)).toEqual(['declared-first', 'declared-second']);
  });
});

describe('served-artifact transparency', () => {
  it('reports which entry point was actually driven', async () => {
    // findWebEntry prefers the SHALLOWEST entry, so a stray index.html at the
    // project root silently shadows the real deliverable in a subdirectory and
    // every probe then fails against the wrong artifact. The report has to name
    // what it drove.
    const dir = mkdtempSync(join(tmpdir(), 'uap-served-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><canvas></canvas>');
    const manifest: InteractionManifest = {
      version: 1,
      kind: 'web',
      entry: 'index.html',
      specHash: 'x',
      generatedAt: '2026-07-26T00:00:00.000Z',
      requirements: [{ id: 'R1', text: 'it works' }],
      probes: [
        {
          id: 'P1',
          requirementIds: ['R1'],
          mode: 'core',
          description: 'trivial',
          steps: [{ do: 'wait', ms: 1 }],
          asserts: [{ expect: 'truthy', expr: 'ok' }],
        },
      ],
    };
    let ticks = 0;
    const driver = {
      start: async () => {},
      runStep: async () => {},
      read: async (expr: string) => {
        if (expr.includes('__uapWatch')) {
          ticks += 60;
          return JSON.stringify({ ticks, errors: [], values: {} });
        }
        return true;
      },
      readDetailed: async () => ({ ok: true, value: true }),
      inject: async () => {},
      errors: () => [],
      stop: async () => {},
    };
    const v = await runInteractionGate(dir, { manifest, driverFactory: () => driver });
    expect(v.feedback).toContain('served:');
    expect(v.feedback).toContain('index.html');
  });
});

describe('runner robustness', () => {
  it('keeps assertions already judged when a later read throws', async () => {
    // Without the flush the report says "0/1 passed" and lists nothing at all.
    let calls = 0;
    const driver: InteractionDriver = {
      start: async () => {},
      runStep: async () => {},
      read: async () => true,
      readDetailed: async () => {
        calls += 1;
        if (calls > 1) throw new Error('page crashed');
        return { ok: true, value: true };
      },
      inject: async () => {},
      errors: () => [],
      stop: async () => {},
    };
    const r = await runProbe(driver, {
      id: 'P-partial',
      requirementIds: [],
      mode: 'core',
      description: 'second read explodes',
      steps: [{ do: 'wait', ms: 1 }],
      asserts: [
        { expect: 'truthy', expr: 'first', label: 'first' },
        { expect: 'truthy', expr: 'second', label: 'second' },
      ],
    });
    expect(r.passed).toBe(false);
    expect(r.assertions.map((a) => a.label)).toEqual(['first']);
    expect(r.errors.join()).toContain('page crashed');
  });

  it('reports errors again when the buffer was cleared mid-probe', async () => {
    const before = countByMessage(['a', 'a', 'b']);
    // Buffer shrank: a naive count-diff would report NOTHING new.
    expect(newErrorsSince({ errors: () => ['a'] }, before)).toEqual(['a']);
  });

  it('collapses a flood of identical errors into a counted line', async () => {
    const before = countByMessage([]);
    const flood = Array.from({ length: 40 }, () => 'boom');
    const out = newErrorsSince({ errors: () => flood }, before);
    expect(out.length).toBeLessThan(10);
    expect(out.join()).toContain('x40 occurrences');
  });
});
