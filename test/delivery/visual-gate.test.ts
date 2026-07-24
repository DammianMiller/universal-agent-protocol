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
  driveStartInteraction,
  START_POINTER,
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

/** Is this evaluate() call the start-interaction driver (not a pixel probe)? */
function isStartInteraction(script: unknown): boolean {
  return typeof script === 'string' && /dispatchEvent|KeyboardEvent/.test(script);
}
/** The pointer (click) half of the interaction. */
function isPointerInteraction(script: unknown): boolean {
  return typeof script === 'string' && /MouseEvent|pointerdown/.test(script);
}
/** The keyboard fallback half of the interaction. */
function isKeysInteraction(script: unknown): boolean {
  return typeof script === 'string' && /KeyboardEvent/.test(script);
}

/** Scripted fake browser: returns queued probe payloads per evaluate call.
 * The start-interaction evaluate() is answered with 'ok' and does NOT consume a
 * probe — mirroring the real browser, where interaction and pixel-probe are
 * distinct calls. */
function fakeBrowser(probes: string[], errors: Array<{ kind: string; message: string }> = []): () => VisualBrowserDriver {
  return () => {
    let i = 0;
    return {
      launch: async () => undefined,
      goto: async () => '200',
      waitForLoadState: async () => undefined,
      // CYCLE the probe frames (an animating game returns a fresh frame each
      // probe), so consecutive samples differ regardless of how many probes the
      // gate fires — including the "did the click start it?" check between the
      // pointer and keyboard fallback.
      evaluate: async <T,>(script?: unknown) =>
        (isStartInteraction(script) ? 'ok' : probes[i++ % probes.length]) as unknown as T,
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
    // Menu evidence frame + 2 sampled playing frames.
    expect(verdict.pages[0].screenshots.length).toBe(3);
    expect(existsSync(verdict.pages[0].screenshots[0])).toBe(true);
    expect(visualRuntimeNote(verdict)).toContain('renders+animates OK');
  });

  /**
   * A game whose canvas is near-black on the MENU but colourful+animating once
   * you press start. Before the start-interaction driver, the gate only ever
   * saw the menu and false-failed it as a blank render (octopus_invaders_v3,
   * 2026-07-21: execution PASS, vision 8/10, floor FAIL on a dark title screen).
   */
  function fakeGameBrowser(menuProbe: string, playingProbes: string[]): () => VisualBrowserDriver {
    let started = false;
    let interacted = false;
    const factory = () => {
      let i = 0;
      return {
        launch: async () => undefined,
        goto: async () => '200',
        waitForLoadState: async () => undefined,
        evaluate: async <T,>(script?: unknown) => {
          if (isStartInteraction(script)) {
            started = true;
            interacted = true;
            return 'ok' as unknown as T;
          }
          // An animating game returns a fresh frame each probe — CYCLE the
          // playing frames (not clamp) so consecutive samples always differ.
          // Robust to the extra "did the click start it?" probe the gate now
          // fires between the pointer and keyboard fallback.
          return (started ? playingProbes[i++ % playingProbes.length] : menuProbe) as unknown as T;
        },
        screenshot: async (path: string) => writeFileSync(path, 'png'),
        getErrors: () => [],
        close: async () => undefined,
      };
    };
    (factory as unknown as { wasDriven: () => boolean }).wasDriven = () => interacted;
    return factory;
  }

  it('drives a start interaction so a menu→playing game passes on its PLAYING state', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas><script>requestAnimationFrame(function(){});</script>');
    const blackCells = Array.from({ length: 16 }, () => '0,0,0');
    const menu = probe(blackCells, 1, 1.0); // near-black title screen — would false-fail
    const cellsA = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const cellsB = Array.from({ length: 16 }, (_, i) => (i < 8 ? `c${i}` : `x${i}`));
    const factory = fakeGameBrowser(menu, [probe(cellsA, 10, 0.4), probe(cellsB, 10, 0.4)]);
    const verdict = await runVisualGate(dir, { browserFactory: factory, samples: 2, intervalMs: 1 });
    expect((factory as unknown as { wasDriven: () => boolean }).wasDriven()).toBe(true);
    expect(verdict.skipped).toBe(false);
    expect(verdict.passed).toBe(true);
  });

  it('does NOT drive interaction on a canvas-less DOM page', async () => {
    // No <canvas> → not an interactive scene with a start screen to leave.
    writeFileSync(join(dir, 'index.html'), '<div id="app">static content</div>');
    const cells = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const factory = fakeGameBrowser(probe(cells, 10, 0.4), [probe(cells, 10, 0.4)]);
    await runVisualGate(dir, { browserFactory: factory, samples: 2, intervalMs: 1 });
    expect((factory as unknown as { wasDriven: () => boolean }).wasDriven()).toBe(false);
  });

  it('DOES drive interaction for a bundled game (canvas in HTML, rAF only in the bundle)', async () => {
    // The entry HTML has a <canvas> and loads an external bundle; requestAnimation-
    // Frame lives in the bundle, not the HTML. Gating on canvas (not rAF-in-HTML)
    // is what lets the fix reach bundled/minified games.
    writeFileSync(join(dir, 'index.html'), '<canvas id="game"></canvas><script src="bundle.js"></script>');
    const blackCells = Array.from({ length: 16 }, () => '0,0,0');
    const cellsA = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const cellsB = Array.from({ length: 16 }, (_, i) => (i < 8 ? `c${i}` : `x${i}`));
    const factory = fakeGameBrowser(probe(blackCells, 1, 1.0), [probe(cellsA, 10, 0.4), probe(cellsB, 10, 0.4)]);
    const verdict = await runVisualGate(dir, { browserFactory: factory, samples: 2, intervalMs: 1 });
    expect((factory as unknown as { wasDriven: () => boolean }).wasDriven()).toBe(true);
    expect(verdict.passed).toBe(true);
  });

  it('a genuinely blank game (blank even after start) still fails — the fix does not mask real bugs', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas><script>requestAnimationFrame(function(){});</script>');
    const blackCells = Array.from({ length: 16 }, () => '0,0,0');
    const menu = probe(blackCells, 1, 1.0);
    // Playing state is ALSO black — a real broken render.
    const factory = fakeGameBrowser(menu, [probe(blackCells, 1, 1.0), probe(blackCells, 1, 1.0)]);
    const verdict = await runVisualGate(dir, { browserFactory: factory, samples: 2, intervalMs: 1 });
    expect(verdict.passed).toBe(false);
  });

  /**
   * A fake that records which interaction halves fired and only "starts" the
   * game on the chosen trigger ('click' | 'keys'), so we can prove the
   * click-first / keys-only-if-still-blank flow (follow-up: Space=pause).
   */
  function fakeTriggerBrowser(startOn: 'click' | 'keys', playing: string[], blank: string) {
    const fired = { pointer: false, keys: false };
    let started = false;
    let p = 0;
    const factory = () => ({
      launch: async () => undefined,
      goto: async () => '200',
      waitForLoadState: async () => undefined,
      evaluate: async <T,>(script?: unknown) => {
        if (isPointerInteraction(script)) {
          fired.pointer = true;
          if (startOn === 'click') started = true;
          return 'ok' as unknown as T;
        }
        if (isKeysInteraction(script)) {
          fired.keys = true;
          if (startOn === 'keys') started = true;
          return 'ok' as unknown as T;
        }
        // Animating game: cycle playing frames so consecutive samples differ.
        return (started ? playing[p++ % playing.length] : blank) as unknown as T;
      },
      screenshot: async (path: string) => writeFileSync(path, 'png'),
      getErrors: () => [],
      close: async () => undefined,
    });
    (factory as unknown as { fired: typeof fired }).fired = fired;
    return factory;
  }

  it('skips the keyboard fallback when the click already started the game (Space=pause guard)', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas><script>requestAnimationFrame(function(){});</script>');
    const cells = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const cellsB = Array.from({ length: 16 }, (_, i) => (i < 8 ? `c${i}` : `x${i}`));
    const factory = fakeTriggerBrowser('click', [probe(cells, 10, 0.4), probe(cellsB, 10, 0.4)], probe(Array(16).fill('0,0,0'), 1, 1.0));
    await runVisualGate(dir, { browserFactory: factory, samples: 2, intervalMs: 1 });
    const fired = (factory as unknown as { fired: { pointer: boolean; keys: boolean } }).fired;
    expect(fired.pointer).toBe(true);
    expect(fired.keys).toBe(false); // click started it → never risk Space=pause
  });

  it('falls back to keys when the click did NOT start the game', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas><script>requestAnimationFrame(function(){});</script>');
    const cells = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const cellsB = Array.from({ length: 16 }, (_, i) => (i < 8 ? `c${i}` : `x${i}`));
    const factory = fakeTriggerBrowser('keys', [probe(cells, 10, 0.4), probe(cellsB, 10, 0.4)], probe(Array(16).fill('0,0,0'), 1, 1.0));
    const verdict = await runVisualGate(dir, { browserFactory: factory, samples: 2, intervalMs: 1 });
    const fired = (factory as unknown as { fired: { pointer: boolean; keys: boolean } }).fired;
    expect(fired.pointer).toBe(true);
    expect(fired.keys).toBe(true); // click didn't start it → keyboard fallback fires
    expect(verdict.passed).toBe(true); // keys started the game → judged on playing state
  });

  it('captures a menu screenshot as evidence, separate from the floor-judged frames', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas><script>requestAnimationFrame(function(){});</script>');
    const blackCells = Array.from({ length: 16 }, () => '0,0,0');
    const cellsA = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const cellsB = Array.from({ length: 16 }, (_, i) => (i < 8 ? `c${i}` : `x${i}`));
    const factory = fakeGameBrowser(probe(blackCells, 1, 1.0), [probe(cellsA, 10, 0.4), probe(cellsB, 10, 0.4)]);
    const verdict = await runVisualGate(dir, { browserFactory: factory, samples: 2, intervalMs: 1 });
    // menu evidence + 2 playing samples; the menu frame is FIRST in the evidence.
    expect(verdict.pages[0].screenshots.length).toBe(3);
    expect(verdict.pages[0].screenshots[0]).toMatch(/-menu\.png$/);
    // The near-black menu did NOT drag the verdict down — floor is judged on play.
    expect(verdict.passed).toBe(true);
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

describe('driveStartInteraction (extracted — click-vs-keys in isolation)', () => {
  /** Minimal evaluate-only stub: records the scripts it was handed and answers
   *  the post-click probe with a "started" or "still blank" payload. */
  function evalStub(startedAfterClick: boolean) {
    const seen: string[] = [];
    const started = probe(Array.from({ length: 16 }, (_, i) => `c${i}`), 10, 0.4);
    const blank = probe(Array(16).fill('0,0,0'), 1, 1.0);
    return {
      seen,
      browser: {
        evaluate: async <T,>(script?: unknown) => {
          const s = String(script ?? '');
          seen.push(s);
          if (isStartInteraction(s)) return 'ok' as unknown as T;
          return (startedAfterClick ? started : blank) as unknown as T;
        },
      } as Pick<VisualBrowserDriver, 'evaluate'>,
    };
  }

  it('skips the keyboard fallback when the click started the game', async () => {
    const { browser, seen } = evalStub(true);
    const r = await driveStartInteraction(browser, { timeoutMs: 1000, settleMs: 1 });
    expect(r.pointerFired).toBe(true);
    expect(r.startedAfterPointer).toBe(true);
    expect(r.keysFired).toBe(false);
    expect(seen.some((s) => isKeysInteraction(s))).toBe(false);
  });

  it('fires the keyboard fallback when the click left the canvas blank', async () => {
    const { browser, seen } = evalStub(false);
    const r = await driveStartInteraction(browser, { timeoutMs: 1000, settleMs: 1 });
    expect(r.pointerFired).toBe(true);
    expect(r.startedAfterPointer).toBe(false);
    expect(r.keysFired).toBe(true);
    expect(seen.some((s) => isKeysInteraction(s))).toBe(true);
  });

  it('never throws when the page rejects synthetic events', async () => {
    const browser = {
      evaluate: async () => {
        throw new Error('evaluate blew up');
      },
    } as unknown as Pick<VisualBrowserDriver, 'evaluate'>;
    const r = await driveStartInteraction(browser, { timeoutMs: 50, settleMs: 1 });
    expect(r.pointerFired).toBe(false); // threw before the pointer could land
    expect(r.keysFired).toBe(false);
  });

  it('treats a probe failure as not-started and still tries the keys', async () => {
    let calls = 0;
    const browser = {
      evaluate: async <T,>(script?: unknown) => {
        calls++;
        if (isStartInteraction(String(script ?? ''))) return 'ok' as unknown as T;
        throw new Error('probe failed');
      },
    } as unknown as Pick<VisualBrowserDriver, 'evaluate'>;
    const r = await driveStartInteraction(browser, { timeoutMs: 50, settleMs: 1 });
    expect(r.startedAfterPointer).toBe(false);
    expect(r.keysFired).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3); // pointer, probe, keys
  });
});

describe('start interaction clicks real DOM start CONTROLS (2026-07-22)', () => {
  /** Capture the scripts the gate evaluates so the capability can be asserted
   *  without a real DOM (the end-to-end proof is the headless A/B run). */
  function capture() {
    const scripts: string[] = [];
    return {
      scripts,
      browser: {
        evaluate: async <T,>(script?: unknown) => {
          scripts.push(String(script ?? ''));
          return (isStartInteraction(script) ? 'ok' : probe(Array(16).fill('0,0,0'), 1, 1.0)) as unknown as T;
        },
      } as Pick<VisualBrowserDriver, 'evaluate'>,
    };
  }

  it('the pointer script targets buttons and start-labelled elements, and calls native click()', async () => {
    const { browser, scripts } = capture();
    await driveStartInteraction(browser, { timeoutMs: 500, settleMs: 1 });
    const pointer = scripts.find((s) => isPointerInteraction(s)) ?? '';
    // Events dispatched at the canvas/body can never reach a <button> (bubbling
    // goes UP), so the control itself must be targeted, and native click() is
    // what runs an inline onclick= handler.
    expect(pointer).toMatch(/querySelectorAll\(\s*'button/);
    expect(pointer).toMatch(/role="button"/);
    expect(pointer).toMatch(/\.click\(\)/);
    expect(pointer).toMatch(/start\|play\|begin/);
  });

  it('does NOT target anchors — clicking one could navigate away from the page under test', async () => {
    const { browser, scripts } = capture();
    await driveStartInteraction(browser, { timeoutMs: 500, settleMs: 1 });
    const pointer = scripts.find((s) => isPointerInteraction(s)) ?? '';
    expect(pointer).not.toMatch(/querySelectorAll\([^)]*\ba\b[^)]*\)/);
  });
});

describe('START_POINTER dismisses intro overlays so the judge grades the app, not the veil (2026-07-23)', () => {
  /** Extract and compile the ACTUAL start-text regex the gate ships, so the
   *  test exercises the real pattern rather than a copy. */
  function shippedStartRe(): RegExp {
    const m = START_POINTER.match(/var startRe = \/(.+?)\/i;/);
    if (!m) throw new Error('startRe not found in START_POINTER');
    // In the TS template string a literal `\b` is written `\\b`; unescape it.
    return new RegExp(m[1].replace(/\\\\/g, '\\'), 'i');
  }

  it('matches intro prompts ANYWHERE — the anchored ^start… missed "CLICK TO START"', () => {
    const re = shippedStartRe();
    expect(re.test('CLICK TO START')).toBe(true); // the exact octopus prompt
    expect(re.test('Press to play')).toBe(true);
    expect(re.test('Tap to begin')).toBe(true);
    expect(re.test('PRESS TO CONTINUE')).toBe(true);
    expect(re.test('Play')).toBe(true);
  });

  it('does NOT fire on "restart" or unrelated copy (word boundaries guard false hits)', () => {
    const re = shippedStartRe();
    expect(re.test('please restart later')).toBe(false);
    expect(re.test('Displaying results')).toBe(false);
    expect(re.test('Loading…')).toBe(false);
  });

  it('detects a full-screen clickable overlay by geometry + cursor (text not required)', () => {
    // The octopus veil: a dark full-screen #start-screen whose "CLICK TO START"
    // prompt lives in a CHILD, so the veil element itself has no start text —
    // it is identified by covering the viewport AND inviting a click.
    expect(START_POINTER).toMatch(/cursor !== 'pointer'/); // must invite a click
    expect(START_POINTER).toMatch(/vw \* 0\.6/); // covers >= 60% width
    expect(START_POINTER).toMatch(/vh \* 0\.6/); // covers >= 60% height
    // and the overlay is actually clicked (isOverlay path skips the text check)
    expect(START_POINTER).toMatch(/overlays\.forEach\(function \(el\) \{ clickEl\(el, true\); \}\)/);
  });

  it('still never targets anchors, and excludes the canvas/body/html from overlays', () => {
    expect(START_POINTER).not.toMatch(/querySelectorAll\([^)]*\ba\b[^)]*\)/);
    expect(START_POINTER).toMatch(/tagName === 'CANVAS' \|\| el\.tagName === 'BODY' \|\| el\.tagName === 'HTML'/);
  });
});
