/**
 * Visual gate: the rendered-truth check — blank canvases, static rAF scenes,
 * and runtime errors observed while WATCHING the artifact are real failures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runVisualGate,
  judgePage,
  motionBetween,
  discoverEntryPages,
  visualRuntimeNote,
  type VisualBrowserDriver,
} from '../../src/delivery/visual-gate.js';

function probe(cells: string[], distinct: number, dominant: number): string {
  return JSON.stringify({
    canvas: true,
    readable: true,
    cells,
    distinctColors: distinct,
    dominantRatio: dominant,
  });
}

/** Scripted fake browser: returns queued probe payloads per evaluate call. */
function fakeBrowser(probes: string[], errors: Array<{ kind: string; message: string }> = []): () => VisualBrowserDriver {
  return () => {
    let i = 0;
    return {
      launch: async () => undefined,
      goto: async () => '200',
      waitForLoadState: async () => undefined,
      evaluate: async <T,>() => probes[Math.min(i++, probes.length - 1)] as unknown as T,
      screenshot: async (path: string) => writeFileSync(path, 'png'),
      getErrors: () => errors,
      close: async () => undefined,
    };
  };
}

describe('judgePage (pure verdict)', () => {
  const base = {
    file: 'index.html',
    loaded: true,
    hasCanvas: true,
    distinctColors: 12,
    dominantRatio: 0.5,
    motionRatio: 0.2,
    expectsAnimation: true,
    runtimeErrors: [] as string[],
    screenshots: [] as string[],
  };

  it('passes a healthy animated canvas', () => {
    expect(judgePage(base)).toEqual([]);
  });

  it('fails a blank canvas', () => {
    const problems = judgePage({ ...base, distinctColors: 1, dominantRatio: 1 });
    expect(problems.join(' ')).toContain('below the visual floor');
  });

  it('fails a STATIC scene that promises animation', () => {
    const problems = judgePage({ ...base, motionRatio: 0 });
    expect(problems.join(' ')).toContain('not animating enough');
  });

  it('allows a static page that never promised animation', () => {
    expect(judgePage({ ...base, motionRatio: 0, expectsAnimation: false })).toEqual([]);
  });

  it('fails on runtime errors observed during the window', () => {
    const problems = judgePage({ ...base, runtimeErrors: ['TypeError: boom'] });
    expect(problems.join(' ')).toContain('runtime error');
  });
});

describe('motionBetween', () => {
  it('measures the changed-cell fraction', () => {
    expect(motionBetween(['a', 'b', 'c', 'd'], ['a', 'b', 'x', 'y'])).toBe(0.5);
    expect(motionBetween(['a'], ['a'])).toBe(0);
    expect(motionBetween(undefined, ['a'])).toBe(0);
  });
});

describe('runVisualGate (integration with fake browser)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-visual-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes an animating scene and saves screenshots', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas><script>requestAnimationFrame(function(){});</script>');
    const cellsA = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const cellsB = Array.from({ length: 16 }, (_, i) => (i < 8 ? `c${i}` : `x${i}`));
    const verdict = await runVisualGate(dir, {
      browserFactory: fakeBrowser([probe(cellsA, 10, 0.4), probe(cellsB, 10, 0.4)]),
      samples: 2,
      intervalMs: 1,
    });
    expect(verdict.skipped).toBe(false);
    expect(verdict.passed).toBe(true);
    expect(verdict.pages[0].motionRatio).toBe(0.5);
    expect(verdict.pages[0].screenshots.length).toBe(2);
    expect(existsSync(verdict.pages[0].screenshots[0])).toBe(true);
    expect(visualRuntimeNote(verdict)).toContain('renders+animates OK');
  });

  it('fails a static rAF scene with actionable feedback', async () => {
    writeFileSync(join(dir, 'scene.html'), '<canvas></canvas><script>requestAnimationFrame(tick)</script>');
    const cells = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const verdict = await runVisualGate(dir, {
      browserFactory: fakeBrowser([probe(cells, 10, 0.4), probe(cells, 10, 0.4)]),
      samples: 2,
      intervalMs: 1,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.feedback).toContain('not animating enough');
  });

  it('fails open (skipped) when no browser can launch', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas>');
    const verdict = await runVisualGate(dir, {
      browserFactory: () => {
        throw new Error('no chromium');
      },
    });
    expect(verdict.skipped).toBe(true);
    expect(verdict.passed).toBe(true);
    expect(verdict.feedback).toContain('skipped');
  });

  it('discovers entry pages with index.html first', () => {
    writeFileSync(join(dir, 'zeta.html'), 'x');
    writeFileSync(join(dir, 'index.html'), 'x');
    writeFileSync(join(dir, 'alpha.html'), 'x');
    expect(discoverEntryPages(dir)).toEqual(['index.html', 'alpha.html', 'zeta.html']);
  });
});

describe('visual gate: non-final epics downgrade richness failures to advisory (run J, 2026-07-17)', () => {
  const saveFlag = () => {
    const prev = process.env.UAP_EPIC_NONFINAL;
    return () => {
      if (prev === undefined) delete process.env.UAP_EPIC_NONFINAL;
      else process.env.UAP_EPIC_NONFINAL = prev;
    };
  };

  it('a blank-canvas scaffold passes advisory on a non-final epic but fails on the final epic', async () => {
    const restore = saveFlag();
    const dir = mkdtempSync(join(tmpdir(), 'uap-vis-nf-'));
    try {
      // Static page with a canvas nothing draws on: 1 distinct color.
      writeFileSync(
        join(dir, 'index.html'),
        '<!doctype html><html><body style="margin:0"><canvas id="game" width="64" height="64"></canvas></body></html>'
      );
      process.env.UAP_EPIC_NONFINAL = '1';
      const nonFinal = await runVisualGate(dir);
      if (!nonFinal.skipped) {
        expect(nonFinal.passed).toBe(true);
        expect(nonFinal.feedback).toContain('NA: non-final epic');
      }
      process.env.UAP_EPIC_NONFINAL = '0';
      const final = await runVisualGate(dir);
      if (!final.skipped) {
        expect(final.passed).toBe(false); // final epic judges the floor for real
      }
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('visual gate: the browser is always closed (leak regression, 2026-07-20)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-visual-leak-'));
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas><script>requestAnimationFrame(function(){});</script>');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A live 4h deliver run leaked 11 headless Chromium instances (~33 GB RSS) and
   * kept a SIGTERM'd process alive, because `browser` was scoped INSIDE the page
   * loop: a throw after launch skipped the close, hit the outer catch, and
   * returned `skipped: true` — silently disabling the gate while leaking.
   */
  it('closes the browser when getErrors() throws mid-iteration', async () => {
    let closed = 0;
    const exploding = (): VisualBrowserDriver => ({
      launch: async () => undefined,
      goto: async () => '200',
      waitForLoadState: async () => undefined,
      evaluate: async <T,>() => probe([], 1, 1) as unknown as T,
      screenshot: async (path: string) => writeFileSync(path, 'png'),
      getErrors: () => {
        throw new Error('browser crashed');
      },
      close: async () => {
        closed++;
      },
    });

    const verdict = await runVisualGate(dir, { browserFactory: exploding, samples: 1, intervalMs: 1 });

    // The gate still degrades gracefully...
    expect(verdict.skipped).toBe(true);
    // ...but it must NOT leak the browser process while doing so.
    expect(closed).toBe(1);
  });

  it('closes the browser exactly once on the normal path', async () => {
    let closed = 0;
    const counting = (): VisualBrowserDriver => ({
      launch: async () => undefined,
      goto: async () => '200',
      waitForLoadState: async () => undefined,
      evaluate: async <T,>() => probe(Array.from({ length: 16 }, (_, i) => `c${i}`), 10, 0.4) as unknown as T,
      screenshot: async (path: string) => writeFileSync(path, 'png'),
      getErrors: () => [],
      close: async () => {
        closed++;
      },
    });

    await runVisualGate(dir, { browserFactory: counting, samples: 1, intervalMs: 1 });
    expect(closed).toBe(1);
  });
});
