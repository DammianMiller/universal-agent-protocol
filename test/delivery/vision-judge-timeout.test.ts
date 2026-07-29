/**
 * The vision judge's model calls must be time-boxed.
 *
 * The autodetect probes were bounded (2s), but judgeScreenshots and
 * corroborateFindings — the calls that upload PNGs — were awaited unbounded. A
 * vision model that is merely BUSY (another agent session holding the slots)
 * then stalls the caller forever: `uap verify --visual` never returns, and under
 * --fidelity max, where the vision review is BLOCKING, a deliver run wedges.
 *
 * Measured before the fix: the same runVerify that returned in 13s against an
 * unreachable endpoint ran past 150s against the live busy model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * VISION_CALL_TIMEOUT_MS is resolved at module load, so the bound can only be
 * exercised by re-importing with the env already set. Without this the test
 * silently inherits the 120s production default and its own guard wins — which
 * is exactly how it passed standalone (env set on the command line) and failed
 * in the full suite.
 */
async function loadJudge(timeoutMs?: string) {
  if (timeoutMs) process.env.UAP_VISION_TIMEOUT_MS = timeoutMs;
  vi.resetModules();
  return await import('../../src/delivery/vision-judge.js');
}

let dir: string;
let shot: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vision-timeout-'));
  shot = join(dir, 'page.png');
  // A 1x1 PNG is enough — the judge only base64s the bytes.
  writeFileSync(
    shot,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  for (const k of ['UAP_VISION_ENDPOINT', 'UAP_VISION_MODEL', 'UAP_VISION_TIMEOUT_MS']) saved[k] = process.env[k];
  process.env.UAP_VISION_ENDPOINT = 'http://127.0.0.1:9/v1';
  process.env.UAP_VISION_MODEL = 'test-vision';
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('vision judge call timeout', () => {
  it('exposes a finite, generous default bound', async () => {
    delete process.env.UAP_VISION_TIMEOUT_MS;
    const { VISION_CALL_TIMEOUT_MS } = await loadJudge();
    // Generous on purpose: image inference is legitimately slow. The point is
    // that the wait is FINITE, not that it is short.
    expect(VISION_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(Number.isFinite(VISION_CALL_TIMEOUT_MS)).toBe(true);
  });

  it('gives up on a model that never answers, instead of hanging', async () => {
    // The busy-model case: not an error, not a refusal — silence. The stub
    // stays silent but HONORS the abort signal, which is what any conforming
    // fetch does (production goes through fetchModelWithRetry → global fetch).
    // That is the whole point of bounding with AbortSignal rather than racing a
    // timer: the request is actually cancelled, not merely abandoned in flight.
    let sawSignal = false;
    const silentButAbortable = ((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      sawSignal = Boolean(signal);
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return; // no signal → genuinely unbounded
        if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      });
    }) as unknown as typeof fetch;

    const { judgeScreenshots } = await loadJudge('5000');
    const started = Date.now();
    const verdict = await Promise.race([
      judgeScreenshots([shot], 'a working UI', undefined, silentButAbortable),
      new Promise((resolve) => setTimeout(() => resolve('TEST_GAVE_UP'), 15_000)),
    ]);
    const elapsed = Date.now() - started;

    // The judge must return on its own. If the test's own guard wins, the call
    // is still unbounded and the production hang is back.
    expect(sawSignal).toBe(true);
    expect(verdict).not.toBe('TEST_GAVE_UP');
    expect(elapsed).toBeLessThan(15_000);
    // A timed-out judge is "no vision review", never a crash — both callers
    // treat null as advisory silence.
    expect(verdict).toBeNull();
  }, 30_000);
});
