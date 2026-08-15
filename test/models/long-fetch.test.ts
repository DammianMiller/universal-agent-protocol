/**
 * Long model HTTP: transient-failure classification and bounded retry —
 * the guard against undici's 300s headersTimeout killing long local-model
 * turns as opaque `TypeError: fetch failed`.
 */

import { describe, it, expect } from 'vitest';
import {
  isTransientNetworkError,
  fetchModelWithRetry,
  modelHttpTimeoutMs,
} from '../../src/models/long-fetch.js';

function fetchFailed(code?: string): TypeError {
  const err = new TypeError('fetch failed');
  if (code) (err as TypeError & { cause?: { code: string } }).cause = { code };
  return err;
}

describe('isTransientNetworkError', () => {
  it('classifies undici transport failures as transient', () => {
    expect(isTransientNetworkError(fetchFailed())).toBe(true);
    expect(isTransientNetworkError(fetchFailed('UND_ERR_HEADERS_TIMEOUT'))).toBe(true);
    expect(isTransientNetworkError(fetchFailed('ECONNRESET'))).toBe(true);
  });

  it('never retries deliberate aborts or protocol errors', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isTransientNetworkError(abort)).toBe(false);
    expect(isTransientNetworkError(new Error('agentic chat failed (500): boom'))).toBe(false);
    expect(isTransientNetworkError('not-an-error')).toBe(false);
  });
});

describe('fetchModelWithRetry', () => {
  it('retries transient failures with backoff and succeeds', async () => {
    let calls = 0;
    const retriedAt: number[] = [];
    const impl = (async () => {
      calls++;
      if (calls < 3) throw fetchFailed('UND_ERR_HEADERS_TIMEOUT');
      return { ok: true, status: 200 } as Response;
    }) as never;
    const res = await fetchModelWithRetry('http://x/v1/chat/completions', { method: 'POST' }, {
      fetchImpl: impl,
      backoffMs: 1,
      onRetry: (attempt) => retriedAt.push(attempt),
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(3);
    expect(retriedAt).toEqual([1, 2]);
  });

  it('gives up after the retry budget and rethrows the last error', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      throw fetchFailed('ECONNRESET');
    }) as never;
    await expect(
      fetchModelWithRetry('http://x', {}, { fetchImpl: impl, retries: 2, backoffMs: 1 })
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });

  it('does NOT retry non-transient errors', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      throw new Error('boom');
    }) as never;
    await expect(fetchModelWithRetry('http://x', {}, { fetchImpl: impl, backoffMs: 1 })).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});

describe('fetchModelWithRetry — transient HTTP statuses', () => {
  const resp = (status: number) =>
    ({ ok: status < 400, status, text: async () => 'busy' }) as unknown as Response;

  it('rides out retryable statuses (529 model-reload window) and returns the recovery', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return calls < 3 ? resp(529) : resp(200);
    }) as never;
    const res = await fetchModelWithRetry('http://x', {}, {
      fetchImpl: impl,
      retryStatuses: new Set([529, 503]),
      statusBackoffMs: 1,
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  it('does NOT retry statuses outside the set — 500 carries a real verdict', async () => {
    let calls = 0;
    const impl = (async () => { calls++; return resp(500); }) as never;
    const res = await fetchModelWithRetry('http://x', {}, {
      fetchImpl: impl,
      retryStatuses: new Set([529, 503]),
      statusBackoffMs: 1,
    });
    expect(res.status).toBe(500);
    expect(calls).toBe(1);
  });

  it('returns the final retryable response once the status budget is spent', async () => {
    let calls = 0;
    const impl = (async () => { calls++; return resp(503); }) as never;
    const res = await fetchModelWithRetry('http://x', {}, {
      fetchImpl: impl,
      retryStatuses: new Set([503]),
      statusRetries: 2,
      statusBackoffMs: 1,
    });
    expect(res.status).toBe(503);
    expect(calls).toBe(3); // initial + 2 status retries
  });

  it('is off by default — a 529 with no retryStatuses is returned untouched', async () => {
    let calls = 0;
    const impl = (async () => { calls++; return resp(529); }) as never;
    const res = await fetchModelWithRetry('http://x', {}, { fetchImpl: impl });
    expect(res.status).toBe(529);
    expect(calls).toBe(1);
  });

  it('an abort cuts the status-retry backoff short instead of sleeping through it', async () => {
    // A judge with a 60s AbortController must not sit blind through a
    // 155s retry ladder — the sleep resolves on abort and the next attempt
    // surfaces the AbortError promptly.
    const controller = new AbortController();
    let calls = 0;
    const impl = (async (_url: unknown, init: { signal?: AbortSignal }) => {
      calls++;
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return resp(529);
    }) as never;
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    await expect(
      fetchModelWithRetry('http://x', { signal: controller.signal }, {
        fetchImpl: impl,
        retryStatuses: new Set([529]),
        statusBackoffMs: 60_000, // would sleep a minute without abort-awareness
      })
    ).rejects.toThrow('aborted');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toBe(2); // initial 529, then the aborted attempt
  });

  it('status retries do not consume the transport-retry budget', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      if (calls === 1) return resp(529);          // status retry (own budget)
      if (calls === 2) throw fetchFailed('UND_ERR_HEADERS_TIMEOUT'); // transport retry 1
      if (calls === 3) throw fetchFailed('UND_ERR_HEADERS_TIMEOUT'); // transport retry 2
      return resp(200);
    }) as never;
    const res = await fetchModelWithRetry('http://x', {}, {
      fetchImpl: impl,
      retries: 2,
      backoffMs: 1,
      retryStatuses: new Set([529]),
      statusBackoffMs: 1,
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(4);
  });
});

describe('modelHttpTimeoutMs', () => {
  it('defaults to 30 minutes and honors the env override', () => {
    delete process.env.UAP_MODEL_HTTP_TIMEOUT_MS;
    expect(modelHttpTimeoutMs()).toBe(30 * 60 * 1000);
    process.env.UAP_MODEL_HTTP_TIMEOUT_MS = '60000';
    try {
      expect(modelHttpTimeoutMs()).toBe(60000);
    } finally {
      delete process.env.UAP_MODEL_HTTP_TIMEOUT_MS;
    }
  });
});
