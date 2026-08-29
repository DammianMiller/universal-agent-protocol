/**
 * Visual gate page exclusion: `.uap/visual-targets.json` can remove a
 * discovered entry page from the gate entirely.
 *
 * Why: some entry pages are not servable raw. A framework SPA's source
 * index.html (Vite/CRA/…) references module scripts and absolute asset paths
 * that only resolve in the built dist/ — served from the project root every
 * asset 404s, no canvas ever mounts, and the page can NEVER pass no matter
 * how correct the app is. Without an exclusion the only way to green was to
 * weaken the whole gate; with it the project declares "this entry is graded
 * elsewhere" (CI e2e against the built artifact) and keeps the gate strict
 * for everything else.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runVisualGate,
  isPageExcluded,
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

/** Fake browser that records every URL it is asked to visit. */
function recordingBrowser(visited: string[]): () => VisualBrowserDriver {
  return () => ({
    launch: async () => undefined,
    goto: async (url: string) => {
      visited.push(url);
      return '200';
    },
    waitForLoadState: async () => undefined,
    evaluate: async <T>() => {
      const cells = Array.from({ length: 16 }, (_, i) => `c${i % 8}${Math.floor(i / 8)}`);
      return probe(cells, 10, 0.4) as unknown as T;
    },
    screenshot: async (path: string) => writeFileSync(path, 'png'),
    getErrors: () => [],
    close: async () => undefined,
  });
}

function writeTargets(dir: string, targets: unknown): void {
  mkdirSync(join(dir, '.uap'), { recursive: true });
  writeFileSync(join(dir, '.uap', 'visual-targets.json'), JSON.stringify(targets));
}

describe('isPageExcluded', () => {
  it('matches a top-level exclude list entry', () => {
    expect(isPageExcluded('apps/web/index.html', { exclude: ['apps/web/index.html'] })).toBe(true);
    expect(isPageExcluded('apps/marketing/index.html', { exclude: ['apps/web/index.html'] })).toBe(false);
  });

  it('matches a per-page exclude flag', () => {
    expect(isPageExcluded('a.html', { pages: { 'a.html': { exclude: true } } })).toBe(true);
    expect(isPageExcluded('a.html', { pages: { 'a.html': { minDistinctColors: 8 } } })).toBe(false);
    expect(isPageExcluded('a.html', {})).toBe(false);
  });
});

describe('runVisualGate with excluded pages', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-visual-exclude-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('never renders the excluded page and passes on the rest', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas>');
    writeFileSync(join(dir, 'spa-source.html'), '<div id="root"></div>');
    writeTargets(dir, { exclude: ['spa-source.html'] });

    const visited: string[] = [];
    const verdict = await runVisualGate(dir, {
      browserFactory: recordingBrowser(visited),
      samples: 2,
      intervalMs: 1,
    });

    expect(verdict.skipped).toBe(false);
    expect(verdict.passed).toBe(true);
    expect(verdict.pages.map((p) => p.file)).toEqual(['index.html']);
    expect(visited.some((u) => u.includes('spa-source.html'))).toBe(false);
  });

  it('supports the per-page exclude flag too', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas>');
    writeFileSync(join(dir, 'spa-source.html'), '<div id="root"></div>');
    writeTargets(dir, { pages: { 'spa-source.html': { exclude: true } } });

    const visited: string[] = [];
    const verdict = await runVisualGate(dir, {
      browserFactory: recordingBrowser(visited),
      samples: 2,
      intervalMs: 1,
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.pages.map((p) => p.file)).toEqual(['index.html']);
    expect(visited.some((u) => u.includes('spa-source.html'))).toBe(false);
  });

  it('skips (passes) when every discovered page is excluded, and says so', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas>');
    writeTargets(dir, { exclude: ['index.html'] });

    const visited: string[] = [];
    const verdict = await runVisualGate(dir, {
      browserFactory: recordingBrowser(visited),
      samples: 2,
      intervalMs: 1,
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.skipped).toBe(true);
    expect(verdict.feedback).toContain('excluded via .uap/visual-targets.json');
    expect(visited).toEqual([]);
  });

  it('an excluded blank page cannot fail the gate (the SPA-source scenario)', async () => {
    // The excluded page would hard-fail (blank, no canvas); the kept page is
    // healthy. Pre-exclusion this verdict was a blocking failure.
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas>');
    writeFileSync(join(dir, 'spa-source.html'), '<div id="root"></div>');
    writeTargets(dir, { exclude: ['spa-source.html'] });

    const verdict = await runVisualGate(dir, {
      browserFactory: recordingBrowser([]),
      samples: 2,
      intervalMs: 1,
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.pages).toHaveLength(1);
  });
});
