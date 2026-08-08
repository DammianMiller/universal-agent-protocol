/**
 * A dead model endpoint must stop the run, not spend its whole budget on it.
 *
 * Live on 2026-08-09: the proxy was down, and a mission burned 5 turns x 3 epic
 * attempts plus a re-plan — 15 turns, ~6s each of retry timeouts — every one of
 * them reporting a gate percentage, none of them ever reaching a model. The
 * no-progress rail could not catch it because an errored turn counts as
 * "inconclusive", which RESETS the streak.
 *
 * The hard part is not detecting it, it is NOT over-detecting it: the predicate
 * that decides "safe to retry" is a much wider set than "the endpoint is gone",
 * and aborting on the wider one would kill a healthy long run whose model was
 * simply still thinking.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAgenticExecutor } from '../../src/delivery/agentic-executor.js';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { LadderResult } from '../../src/delivery/verifier-ladder.js';
import {
  ENDPOINT_UNREACHABLE,
  isEndpointUnreachable,
  isTransientNetworkError,
} from '../../src/models/long-fetch.js';

const MODEL = { id: 'm', apiModel: 'm', endpoint: 'http://127.0.0.1:9/v1' } as never;

/** An undici transport failure carrying a cause code, as Node really raises it. */
function transportError(code: string): TypeError {
  const err = new TypeError('fetch failed');
  (err as TypeError & { cause?: { code: string } }).cause = { code };
  return err;
}

describe('isEndpointUnreachable is NARROWER than isTransientNetworkError', () => {
  // The distinction this whole change rests on. Everything in the second list
  // is worth retrying but is NOT evidence the endpoint is gone, and aborting on
  // it would kill a healthy run.
  it('treats connection-establishment failures as unreachable', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(isEndpointUnreachable(transportError(code)), code).toBe(true);
    }
  });

  it('does NOT treat a dropped connection or a slow model as unreachable', () => {
    // ECONNRESET/EPIPE/UND_ERR_SOCKET = reachable, flaky under load.
    // UND_ERR_*_TIMEOUT = reachable, still generating past the 30-min ceiling.
    for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      expect(isEndpointUnreachable(transportError(code)), code).toBe(false);
      // ...but each is still RETRYABLE, which is the wider predicate's job.
      expect(isTransientNetworkError(transportError(code)), code).toBe(true);
    }
  });

  it('does not treat a bare "fetch failed" with no cause as unreachable', () => {
    // Retryable (safe), but it does not say the listener is gone — and this
    // predicate gates an abort.
    const bare = new TypeError('fetch failed');
    expect(isTransientNetworkError(bare)).toBe(true);
    expect(isEndpointUnreachable(bare)).toBe(false);
  });

  it('never treats a caller abort as unreachable', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isEndpointUnreachable(abort)).toBe(false);
  });
});

describe('agentic executor on an unreachable endpoint', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agx-down-'));
    writeFileSync(join(dir, 'calc.js'), 'let a = 1;\n', 'utf-8');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const exec = () => createAgenticExecutor(MODEL, { projectRoot: dir, endpoint: 'http://127.0.0.1:9/v1' });

  it('THROWS a marked error instead of returning a turn-shaped failure', async () => {
    // Returning a string is what let the loop treat a dead endpoint as an
    // ordinary bad turn and keep going.
    vi.spyOn(global, 'fetch').mockRejectedValue(transportError('ECONNREFUSED'));
    await expect(exec()('go')).rejects.toThrow(ENDPOINT_UNREACHABLE);
  }, 30_000);

  it('names the endpoint and an actionable next step', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(transportError('ECONNREFUSED'));
    const err = await exec()('go').catch((e: unknown) => e as Error);
    expect(err.message).toContain('http://127.0.0.1:9/v1');
    expect(err.message).toMatch(/uap proxy/);
  }, 30_000);

  it('leaves a merely-flaky connection on the old, non-fatal path', async () => {
    // The regression that matters: a reset socket must NOT kill the run.
    vi.spyOn(global, 'fetch').mockRejectedValue(transportError('ECONNRESET'));
    const out = await exec()('go');
    expect(out).toContain('agentic executor error');
    expect(out).not.toContain(ENDPOINT_UNREACHABLE);
  }, 30_000);
});

describe('convergence loop aborts on a persistently unreachable endpoint', () => {
  let dir: string;
  const RUNGS = [{ id: 'g', name: 'gate', command: 'true', required: true }];
  const red = (): LadderResult => ({ passed: false, score: 0, results: [], feedback: 'red' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-down-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stops after two consecutive unreachable turns instead of spending the budget', async () => {
    let calls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 10, rungs: RUNGS, baselineCheck: false },
      async () => {
        calls++;
        throw new Error(`${ENDPOINT_UNREACHABLE}: cannot reach the model endpoint`);
      },
      { ladderRunner: red },
    );
    const result = await loop.deliver('anything');
    expect(result.success).toBe(false);
    // Two turns, not ten. This is the whole point.
    expect(calls).toBe(2);
    expect(result.stallReason).toContain(ENDPOINT_UNREACHABLE);
  }, 30_000);

  it('does NOT abort when the endpoint recovers on the next turn', async () => {
    // A proxy RESTART looks exactly like one unreachable turn. Requiring two
    // consecutive is what keeps a restart from killing a live run.
    let calls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 4, rungs: RUNGS, baselineCheck: false },
      async () => {
        calls++;
        if (calls === 1) throw new Error(`${ENDPOINT_UNREACHABLE}: transient`);
        return 'recovered, no file blocks';
      },
      { ladderRunner: red },
    );
    const result = await loop.deliver('anything');
    expect(calls).toBeGreaterThan(2); // survived the blip and kept working
    expect(result.stallReason ?? '').not.toContain(ENDPOINT_UNREACHABLE);
  }, 30_000);

  it('leaves an ordinary executor error on the normal, non-fatal path', async () => {
    let calls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 3, rungs: RUNGS, baselineCheck: false },
      async () => {
        calls++;
        throw new Error('model returned nonsense');
      },
      { ladderRunner: red },
    );
    await loop.deliver('anything');
    expect(calls).toBe(3); // spends its turns, as before
  }, 30_000);
});
