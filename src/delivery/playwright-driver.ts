/**
 * A BrowserDriver backed by playwright-core.
 *
 * WHY THIS EXISTS. The execution gate's browser rung runs on cloakbrowser, and
 * when that cannot start the gate falls back to the vm-dom harness — a set of
 * stubbed browser globals with no graphics implementation behind them. For an
 * ordinary DOM app that fallback is fine. For a WebGL app it is actively
 * misleading: `getContext('webgl2')` yields a stub, every shader "fails" to
 * compile, and `getShaderInfoLog()` returns undefined.
 *
 * Measured (octopus_invaders_v4, 2026-08-18): a run logged
 * `Shader compile error: undefined` FIFTY times — all byte-identical, because
 * the string came from the page's own error handler and the info log it printed
 * was empty. The model was told its shaders were broken, given no diagnostic to
 * act on, and asked to fix them again. It cannot converge on that: the failure
 * is an artefact of the harness, not of the code under test.
 *
 * playwright-core is already a dependency and its bundled Chromium does real
 * WebGL2. Verified on this machine before writing any of this:
 *   { ctx: true, compiled: true, log: "", renderer: "WebKit WebGL",
 *     floatFBO: true }   for a `#version 300 es` shader, with NO extra flags —
 * so the SwiftShader arguments this was first assumed to need are unnecessary.
 *
 * Used as the rung BETWEEN cloakbrowser and vm-dom: a real browser is always a
 * better oracle than a stub, and the stub stays as the last resort so a machine
 * with no browser at all still gets a verdict.
 */
import type { BrowserDriver } from './execution-gate.js';

type PageLike = {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  waitForLoadState(state?: string): Promise<void>;
  evaluate<T>(fn: unknown, arg?: unknown): Promise<T>;
  addInitScript(script: unknown): Promise<void>;
  on(event: string, handler: (arg: never) => void): void;
};

/**
 * Build a driver, or null when playwright-core is unavailable.
 *
 * Never throws: an absent optional dependency must degrade to the next rung,
 * not take the gate down with it.
 */
export async function loadPlaywrightDriver(): Promise<BrowserDriver | null> {
  let chromium: { launch(opts?: Record<string, unknown>): Promise<unknown> };
  try {
    ({ chromium } = (await import('playwright-core')) as never);
  } catch {
    return null;
  }

  let browser: { newPage(): Promise<PageLike>; close(): Promise<void> } | null = null;
  let page: PageLike | null = null;
  const errors: Array<{ kind: string; message: string }> = [];

  return {
    async launch(opts: Record<string, unknown> = {}) {
      browser = (await chromium.launch({ headless: opts.headless !== false })) as {
        newPage(): Promise<PageLike>;
        close(): Promise<void>;
      };
      const p = await browser.newPage();
      page = p;
      // Console errors and uncaught exceptions are the signal the gate reads.
      // A WebGL app reports shader problems through console.error, so losing
      // these would reproduce the very blindness this driver exists to fix.
      p.on('console', (m: never) => {
        const msg = m as unknown as { type(): string; text(): string };
        if (msg.type() === 'error') errors.push({ kind: 'console', message: msg.text() });
      });
      p.on('pageerror', (e: never) => {
        errors.push({ kind: 'pageerror', message: String((e as unknown as Error)?.message ?? e) });
      });
      return browser;
    },
    async goto(url: string) {
      await page?.goto(url, { waitUntil: 'load' });
      return url;
    },
    async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load') {
      await page?.waitForLoadState(state);
    },
    getErrors() {
      return errors.slice();
    },
    async evaluate<T>(script: string | ((arg: unknown) => unknown)): Promise<T> {
      if (!page) throw new Error('playwright driver: evaluate before launch');
      return page.evaluate<T>(script as never);
    },
    async addInitScript(script: string) {
      await page?.addInitScript(script as never);
    },
    async close() {
      try {
        await browser?.close();
      } catch {
        /* a browser that will not close must not fail the gate */
      }
      browser = null;
      page = null;
    },
  };
}
