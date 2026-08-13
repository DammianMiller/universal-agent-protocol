/**
 * A browser that never finishes launching must SKIP, not hang.
 *
 * `runVisualGate` is written to fail open: if the browser cannot start it
 * returns `skipped: true` and the delivery carries on. But the launch itself
 * had no bound — `await browser.launch({ headless: true })` — so a browser that
 * hangs (first-run download, no display, a wedged binary) never reaches that
 * path. It simply waits.
 *
 * That is the whole of the `visual-gate` flake seen five times in one day: the
 * test finishes in 7.3s locally, three runs out of three, and dies at exactly
 * 60111ms in CI — the vitest budget, not a failure. It blocked a version bump
 * and two CI runs. In a real delivery the same hang would stall a turn.
 *
 * Raising the test's budget would have moved the symptom. Bounding the launch
 * fixes it where it happens, and reuses the skip path that already exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runVisualGate, DEFAULT_LAUNCH_TIMEOUT_MS } from '../../src/delivery/visual-gate.js';

function page(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uap-vis-timeout-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body><canvas id="c"></canvas></body></html>');
  return dir;
}

describe('a hanging browser launch', () => {
  it('skips instead of hanging, and says why', async () => {
    const dir = page();
    try {
      const started = Date.now();
      const res = await runVisualGate(dir, {
        launchTimeoutMs: 300,
        browserFactory: () => ({
          // Never resolves — the shape of a browser stuck downloading or
          // waiting on a display that will not appear.
          launch: () => new Promise(() => {}),
          close: async () => {},
        }),
      } as Parameters<typeof runVisualGate>[1]);
      const elapsed = Date.now() - started;

      expect(res.skipped, 'the gate must fail open').toBe(true);
      expect(res.passed, 'and must not fail the delivery').toBe(true);
      expect(res.feedback).toMatch(/browser unavailable|timed out|timeout/i);
      expect(elapsed, 'it must give up promptly, not wait out the caller').toBeLessThan(5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still skips for a browser that fails outright', async () => {
    const dir = page();
    try {
      const res = await runVisualGate(dir, {
        launchTimeoutMs: 300,
        browserFactory: () => ({
          launch: async () => {
            throw new Error('no chromium');
          },
          close: async () => {},
        }),
      } as Parameters<typeof runVisualGate>[1]);
      expect(res.skipped).toBe(true);
      expect(res.feedback).toContain('browser unavailable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not penalise a browser that launches slowly but succeeds', async () => {
    const dir = page();
    try {
      let closed = false;
      const res = await runVisualGate(dir, {
        launchTimeoutMs: 2000,
        browserFactory: () => ({
          launch: () => new Promise((resolve) => setTimeout(resolve, 50)),
          close: async () => {
            closed = true;
          },
          // Minimal surface: the gate proceeds and fails on the next call,
          // which is fine — what matters is that it got PAST the launch.
        }),
      } as Parameters<typeof runVisualGate>[1]);
      expect(res.feedback, 'a 50ms launch under a 2s bound must not be called unavailable').not.toMatch(
        /timed out/i
      );
      expect(closed || res.skipped, 'the browser is still cleaned up either way').toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has a DEFAULT bound well inside a CI test budget', () => {
    // Every case above passes an explicit bound, so nothing else pins the
    // default — and the default is what protects a real delivery. Asserting the
    // constant is cheap; a hanging-browser test at the real default would add
    // 20 seconds to every CI run to prove the same thing.
    expect(Number.isFinite(DEFAULT_LAUNCH_TIMEOUT_MS)).toBe(true);
    expect(DEFAULT_LAUNCH_TIMEOUT_MS).toBeGreaterThan(1_000);
    expect(DEFAULT_LAUNCH_TIMEOUT_MS, 'must expire before the 60s vitest budget it was flaking on').toBeLessThan(
      30_000
    );
  });

  it('and actually USES that default when no bound is passed', () => {
    // A source check. The only runtime way to prove this is to hang a browser
    // at the real default, which would add 20 seconds to every CI run to
    // demonstrate what one line already says. Regression guard, not a boundary.
    const src = readFileSync(new URL('../../src/delivery/visual-gate.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/launchTimeoutMs\s*=\s*options\.launchTimeoutMs\s*\?\?\s*DEFAULT_LAUNCH_TIMEOUT_MS/);
  });
});
