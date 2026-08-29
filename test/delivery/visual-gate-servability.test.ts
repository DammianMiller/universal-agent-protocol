/**
 * Servability policy: the visual gate only grades files that are SERVABLE
 * from the project root.
 *
 * Observed on pay2u (2026-08-29): the discovered entry `apps/web/index.html`
 * is a Vite SPA SOURCE page — its stylesheet is a build artifact and its
 * root-absolute asset paths (`/vendor/*.woff2`, `/workers/fetch.worker.js`)
 * assume the app subdir is the docroot. Served from the project root those
 * requests fail, no canvas mounts, and the gate hard-failed the page on every
 * session stop — grading a serving mismatch, not the app. The page's real
 * artifact (CI-built dist/) is graded elsewhere.
 *
 * The policy: a page that would FAIL *and* has same-origin failed requests
 * missing on disk under the served root is reclassified as unservable —
 * skipped, loudly, instead of failed. External (CDN) failures keep the
 * vendor-the-dependency blocking semantics, and a local failure for a file
 * that EXISTS on disk (flaky abort, server hiccup) still fails.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runVisualGate,
  missingLocalAssets,
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

/** Fake browser reporting the given failed requests; page renders healthy. */
function fakeBrowser(failed: string[]): () => VisualBrowserDriver {
  return () => ({
    launch: async () => undefined,
    goto: async () => '200',
    waitForLoadState: async () => undefined,
    evaluate: async <T>() => {
      const cells = Array.from({ length: 16 }, (_, i) => `c${i % 8}${Math.floor(i / 8)}`);
      return probe(cells, 10, 0.4) as unknown as T;
    },
    screenshot: async (path: string) => writeFileSync(path, 'png'),
    getErrors: () => failed.map((message) => ({ kind: 'requestfailed', message })),
    close: async () => undefined,
  });
}

describe('missingLocalAssets (pure)', () => {
  it('returns same-origin paths missing on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-servability-'));
    try {
      const missing = missingLocalAssets(
        ['http://127.0.0.1:37151/apps/web/styles.css net::ERR_ABORTED'],
        dir
      );
      expect(missing).toEqual(['/apps/web/styles.css']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores external (CDN) URLs and local files that exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-servability-'));
    try {
      mkdirSync(join(dir, 'vendor'), { recursive: true });
      writeFileSync(join(dir, 'vendor', 'app.js'), '//');
      const missing = missingLocalAssets(
        [
          'https://cdn.jsdelivr.net/npm/three@0.163.0/build/three.module.js net::ERR_FAILED',
          'http://127.0.0.1:37151/vendor/app.js net::ERR_ABORTED',
        ],
        dir
      );
      expect(missing).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('URL-normalizes dot segments (stays under the root) and ignores unparseable entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uap-servability-'));
    try {
      // new URL() resolves `/../../etc/passwd` to `/etc/passwd` — which joins
      // UNDER projectRoot, so this is a normal missing-file result, not an
      // escape. Unparseable entries are skipped entirely.
      const missing = missingLocalAssets(
        ['http://127.0.0.1:37151/../../etc/passwd net::ERR_FAILED', 'not a url at all'],
        dir
      );
      expect(missing).toEqual(['/etc/passwd']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runVisualGate servability policy', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-visual-servability-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips (does not fail) a page whose same-origin assets are missing on disk', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas>');
    const verdict = await runVisualGate(dir, {
      browserFactory: fakeBrowser([
        'http://127.0.0.1:37151/apps/web/styles.css net::ERR_ABORTED',
        'http://127.0.0.1:37151/vendor/fa-solid-900.woff2 net::ERR_ABORTED',
      ]),
      samples: 2,
      intervalMs: 1,
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.pages[0].unservable).toBe(true);
    expect(verdict.pages[0].problems).toEqual([]);
    expect(verdict.pages[0].missingAssets).toContain('/apps/web/styles.css');
    expect(verdict.feedback).toContain('not servable raw');
  });

  it('still BLOCKS on external (CDN) failures — vendor pressure is preserved', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas>');
    const verdict = await runVisualGate(dir, {
      browserFactory: fakeBrowser([
        'https://cdn.jsdelivr.net/npm/three@0.163.0/build/three.module.js net::ERR_FAILED',
      ]),
      samples: 2,
      intervalMs: 1,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.pages[0].unservable).toBeFalsy();
    expect(verdict.pages[0].problems[0]).toMatch(/FAILED to load/i);
  });

  it('still fails a local request for a file that EXISTS on disk (flaky abort is not unservability)', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas>');
    writeFileSync(join(dir, 'app.js'), '// exists');
    const verdict = await runVisualGate(dir, {
      browserFactory: fakeBrowser(['http://127.0.0.1:37151/app.js net::ERR_ABORTED']),
      samples: 2,
      intervalMs: 1,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.pages[0].unservable).toBeFalsy();
  });

  it('marks the verdict skipped when EVERY discovered page is unservable', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas>');
    const verdict = await runVisualGate(dir, {
      browserFactory: fakeBrowser(['http://127.0.0.1:37151/dist/main.js net::ERR_FAILED']),
      samples: 2,
      intervalMs: 1,
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.skipped).toBe(true);
    expect(verdict.feedback).toContain('no servable entry pages');
  });

  it('keeps grading the servable pages when others are unservable', async () => {
    writeFileSync(join(dir, 'index.html'), '<canvas></canvas>');
    writeFileSync(join(dir, 'spa-source.html'), '<div id="root"></div>');
    // Per-page failures: the fake reports the missing local asset only while
    // visiting spa-source.html; index.html is served clean.
    const perPage = (): (() => VisualBrowserDriver) => () => {
      let current = '';
      return {
        launch: async () => undefined,
        goto: async (url: string) => {
          current = url;
          return '200';
        },
        waitForLoadState: async () => undefined,
        evaluate: async <T>() => {
          const cells = Array.from({ length: 16 }, (_, i) => `c${i % 8}${Math.floor(i / 8)}`);
          return probe(cells, 10, 0.4) as unknown as T;
        },
        screenshot: async (path: string) => writeFileSync(path, 'png'),
        getErrors: () =>
          current.includes('spa-source.html')
            ? [{ kind: 'requestfailed', message: 'http://127.0.0.1:37151/apps/web/styles.css net::ERR_ABORTED' }]
            : [],
        close: async () => undefined,
      };
    };
    const verdict = await runVisualGate(dir, {
      browserFactory: perPage(),
      samples: 2,
      intervalMs: 1,
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.skipped).toBe(false); // one page WAS graded
    const graded = verdict.pages.find((p) => p.file === 'index.html');
    const skipped = verdict.pages.find((p) => p.file === 'spa-source.html');
    expect(graded?.unservable).toBeFalsy();
    expect(graded?.problems).toEqual([]);
    expect(skipped?.unservable).toBe(true);
    expect(verdict.feedback).toContain('1 page(s) render');
    expect(verdict.feedback).toContain('not-servable page(s) skipped');
  });
});
