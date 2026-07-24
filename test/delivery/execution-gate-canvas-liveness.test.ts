import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runExecutionGate, type BrowserDriver } from '../../src/delivery/execution-gate.js';

/**
 * A fake browser whose evaluate() returns a canned canvas-render probe result,
 * so we can drive the render-loop-liveness logic deterministically without a
 * real chromium. addInitScript is a no-op (the counter is faked in the probe).
 */
function browserWithProbe(probe: Record<string, unknown>): () => BrowserDriver {
  return () => ({
    async launch() {},
    async goto() {
      return '200';
    },
    async waitForLoadState() {},
    getErrors() {
      return [];
    },
    async addInitScript() {},
    async evaluate<T>() {
      return probe as unknown as T;
    },
    async close() {},
  });
}

function writeCanvasApp(dir: string): void {
  writeFileSync(
    join(dir, 'index.html'),
    '<!DOCTYPE html><html><body><canvas id="c"></canvas><script src="game.js"></script></body></html>'
  );
  writeFileSync(join(dir, 'game.js'), 'document.querySelector("canvas");');
}

describe('execution gate — canvas render-loop liveness', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-canvas-'));
    writeCanvasApp(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('FAILS when the loop freezes on the primary interaction (animated then froze)', async () => {
    const r = await runExecutionGate(dir, {
      settleMs: 1,
      browserFactory: browserWithProbe({
        hasCanvas: true,
        nonUniformPixels: 40,
        rafLoad0: 93,
        rafLoad1: 135, // alive on load
        rafPostClick0: 123,
        rafPostClick1: 123, // froze after Start
      }),
    });
    expect(r.passed).toBe(false);
    expect(r.failureReason).toMatch(/FREEZES on the primary interaction/i);
    expect(r.outputTail).toMatch(/does not actually PLAY/i);
  });

  it('FAILS when a running loop renders a blank canvas', async () => {
    const r = await runExecutionGate(dir, {
      settleMs: 1,
      browserFactory: browserWithProbe({
        hasCanvas: true,
        nonUniformPixels: 0,
        rafLoad0: 5,
        rafLoad1: 9,
        rafPostClick0: 9,
        rafPostClick1: 14,
      }),
    });
    expect(r.passed).toBe(false);
    expect(r.failureReason).toMatch(/paints NOTHING|blank/i);
  });

  it('FAILS when a running loop paints nothing (blank while animating)', async () => {
    const r = await runExecutionGate(dir, {
      settleMs: 1,
      browserFactory: browserWithProbe({
        hasCanvas: true,
        nonUniformPixels: 0, // running but draws nothing
        rafLoad0: 20,
        rafLoad1: 55,
        rafPostClick0: 60,
        rafPostClick1: 95,
      }),
    });
    expect(r.passed).toBe(false);
    expect(r.failureReason).toMatch(/paints NOTHING|blank/i);
  });

  it('PASSES a one-shot render (rendered content, no continuous loop — not a dead loop)', async () => {
    const r = await runExecutionGate(dir, {
      settleMs: 1,
      browserFactory: browserWithProbe({
        hasCanvas: true,
        nonUniformPixels: 3000,
        rafLoad0: 1,
        rafLoad1: 1, // one deferred draw, then no continuous loop
        rafPostClick0: 1,
        rafPostClick1: 1,
      }),
    });
    expect(r.passed).toBe(true);
  });

  it('PASSES a healthy loop that keeps animating through the interaction', async () => {
    const r = await runExecutionGate(dir, {
      settleMs: 1,
      browserFactory: browserWithProbe({
        hasCanvas: true,
        nonUniformPixels: 5000,
        rafLoad0: 30,
        rafLoad1: 75,
        rafPostClick0: 80,
        rafPostClick1: 130,
      }),
    });
    expect(r.passed).toBe(true);
  });

  it('PASSES a legitimately STATIC canvas app (rAF never used — not a dead loop)', async () => {
    const r = await runExecutionGate(dir, {
      settleMs: 1,
      browserFactory: browserWithProbe({
        hasCanvas: true,
        nonUniformPixels: 4000,
        rafLoad0: 0,
        rafLoad1: 0,
        rafPostClick0: 0,
        rafPostClick1: 0,
      }),
    });
    expect(r.passed).toBe(true);
  });
});
