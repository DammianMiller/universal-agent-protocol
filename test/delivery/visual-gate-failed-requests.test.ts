/**
 * A page whose dependency never downloaded must be told SO — not "blank canvas".
 *
 * The browser has always captured `requestfailed`, but the visual gate filtered
 * getErrors() down to `pageerror` only and threw the rest away. So when a model
 * built an app that loads Three.js from a CDN, the headless validation browser
 * (no network) couldn't fetch it, the page rendered blank, and the gate reported:
 *
 *   "canvas renders below the visual floor (0 distinct colors < 3 required,
 *    dominant color covers 100%)"
 *
 * …which sent the model off rewriting its RENDERER. It rebuilt the same
 * CDN-dependent app three times in one session, because nothing ever told it the
 * dependency simply had not loaded. The blank canvas was a CONSEQUENCE, not the
 * cause — so the failed request must be reported FIRST.
 */
import { describe, it, expect } from 'vitest';
import { judgePage, type PageVisualReport } from '../../src/delivery/visual-gate.js';

/** A page that renders blank ONLY because its CDN dependency never downloaded. */
function cdnStarvedPage(overrides: Partial<PageVisualReport> = {}): Omit<PageVisualReport, 'problems'> {
  return {
    file: 'index.html',
    loaded: true,
    hasCanvas: true,
    distinctColors: 0,      // ← blank…
    dominantRatio: 1,       // ← …because the framework never loaded
    motionRatio: 0,
    expectsAnimation: true,
    runtimeErrors: [],
    failedRequests: ['https://cdn.jsdelivr.net/npm/three@0.163.0/build/three.module.js'],
    screenshots: [],
    ...overrides,
  } as Omit<PageVisualReport, 'problems'>;
}

describe('visual gate: failed external resources are reported (not swallowed)', () => {
  it('names the failed URL instead of only blaming the blank canvas', () => {
    const problems = judgePage(cdnStarvedPage());
    const joined = problems.join(' | ');
    expect(joined).toMatch(/FAILED to load/i);
    expect(joined).toContain('three.module.js'); // the model can see WHAT failed
  });

  it('reports the failed request FIRST — the blank canvas is a consequence, not the cause', () => {
    const problems = judgePage(cdnStarvedPage());
    expect(problems[0]).toMatch(/FAILED to load/i);
  });

  it('tells the model what to actually DO (vendor it) and what NOT to do (rewrite the renderer)', () => {
    const first = judgePage(cdnStarvedPage())[0];
    expect(first).toMatch(/NO NETWORK/i);
    expect(first).toMatch(/VENDOR/i);
    expect(first).toMatch(/not rewrite the rendering/i);
  });

  it('summarizes when many resources fail', () => {
    const first = judgePage(
      cdnStarvedPage({ failedRequests: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] })
    )[0];
    expect(first).toContain('5 external resource(s) FAILED');
    expect(first).toContain('+2 more');
  });

  it('a healthy page with no failed requests is unaffected', () => {
    const problems = judgePage(
      cdnStarvedPage({ failedRequests: [], distinctColors: 8, dominantRatio: 0.3, motionRatio: 0.5 })
    );
    expect(problems.join(' ')).not.toMatch(/FAILED to load/i);
  });

  it('a genuinely-blank page with NO failed requests still reports the blank canvas', () => {
    // The blank-canvas verdict must survive — we only reordered the diagnosis.
    const problems = judgePage(cdnStarvedPage({ failedRequests: [] }));
    expect(problems.join(' ')).toMatch(/distinct colors|visual floor|blank/i);
  });
});
