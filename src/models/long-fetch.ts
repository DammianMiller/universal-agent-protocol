/**
 * Long-running model HTTP — fetch tuned for local-inference latencies.
 *
 * Node's global fetch (undici) ships a 300s headersTimeout. A local model
 * prefilling a large agentic/blind prompt through a concurrency-gated proxy
 * routinely takes longer than that, so every long turn died with an opaque
 * `TypeError: fetch failed` and no retry — observed live as one killed turn
 * per octopus run. This module provides:
 *
 *  - a shared undici Agent whose headers/body timeouts default to 30 minutes
 *    (UAP_MODEL_HTTP_TIMEOUT_MS to tune), connect timeout stays short — a
 *    down server should fail fast, a thinking model should not;
 *  - `fetchModelWithRetry`: bounded retries with backoff on TRANSIENT
 *    network-level failures only (connection reset/refused, undici timeout
 *    codes, generic `fetch failed`). Model completions here are idempotent
 *    POSTs, so a retry is always safe. HTTP-level errors (4xx/5xx responses)
 *    are returned to the caller untouched — they are protocol, not transport.
 */

import { Agent } from 'undici';

/**
 * Node's global fetch IS undici and honors a per-request `dispatcher` in its
 * init (untyped but supported). Routing through globalThis.fetch — instead of
 * importing undici's fetch directly — keeps test doubles that stub the global
 * working, while production still gets the long-timeout dispatcher.
 */
type FetchLike = (url: string | URL, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;
const globalFetch: FetchLike = (url, init) => (globalThis.fetch as unknown as FetchLike)(url, init);

/**
 * Marks a failure as "the model endpoint is not reachable".
 *
 * A greppable prefix rather than an Error subclass because it has to survive
 * being stringified into an executor error string and read back by the
 * convergence loop, which never sees the original Error object. Lives here, in
 * the transport module, so both the executor that raises it and the loop that
 * consumes it can import it without a cycle.
 */
export const ENDPOINT_UNREACHABLE = 'ENDPOINT_UNREACHABLE';

/**
 * Statuses a LOCAL inference stack emits during a survivable window: 529
 * (proxy admission/overload while the model reloads), 502/503/504 (proxy
 * restarting or the upstream moving ports). Deliberately excludes 500 — that
 * carries a real per-request verdict (e.g. "context size has been exceeded")
 * a retry cannot change.
 */
export const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504, 529]);

const DEFAULT_MODEL_HTTP_TIMEOUT_MS = 30 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 2_000;

export function modelHttpTimeoutMs(): number {
  const v = Number(process.env.UAP_MODEL_HTTP_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MODEL_HTTP_TIMEOUT_MS;
}

let _agent: Agent | null = null;
let _agentTimeout = 0;

function dispatcher(): Agent {
  const timeout = modelHttpTimeoutMs();
  if (!_agent || _agentTimeout !== timeout) {
    _agent = new Agent({
      headersTimeout: timeout,
      bodyTimeout: timeout,
      connectTimeout: CONNECT_TIMEOUT_MS,
    });
    _agentTimeout = timeout;
  }
  return _agent;
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Codes that mean the connection could never be ESTABLISHED — nothing is
 * listening, or the name does not resolve.
 *
 * Deliberately a strict subset of TRANSIENT_CODES, and deliberately NOT reused
 * from it. The transient set answers "is a retry safe?", which is a different
 * question from "is the endpoint dead?", and most of it means *reachable but
 * flaky or slow*: ECONNRESET/EPIPE/UND_ERR_SOCKET are a dropped connection
 * under load, and UND_ERR_*_TIMEOUT is a model still thinking past the
 * 30-minute ceiling. Treating those as "unreachable" would kill a long,
 * healthy run and tell the operator to go restart a proxy that is fine.
 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * True only when the endpoint could not be reached at all.
 *
 * Note the asymmetry with `isTransientNetworkError`: a bare
 * `TypeError: fetch failed` with no cause code is NOT enough here. It is
 * retryable (safe), but it does not say the listener is gone, and this
 * predicate gates an abort.
 */
export function isEndpointUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  if (cause?.code && UNREACHABLE_CODES.has(cause.code)) return true;
  const direct = (err as Error & { code?: string }).code;
  return Boolean(direct && UNREACHABLE_CODES.has(direct));
}

/** True for network-level failures worth retrying (never HTTP responses). */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Explicit abort by the caller's signal is a decision, not a flake.
  if (err.name === 'AbortError') return false;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  if (cause?.code && TRANSIENT_CODES.has(cause.code)) return true;
  const direct = (err as Error & { code?: string }).code;
  if (direct && TRANSIENT_CODES.has(direct)) return true;
  // undici wraps transport failures as `TypeError: fetch failed`.
  return err.name === 'TypeError' && err.message.includes('fetch failed');
}

export interface ModelFetchOptions {
  /** Retries on transient network failure (default 2). */
  retries?: number;
  /** Base backoff between retries; doubles each attempt (default 2000ms). */
  backoffMs?: number;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  /** Called before each retry (logging seam). */
  onRetry?: (attempt: number, err: unknown) => void;
  /**
   * HTTP statuses to treat as TRANSIENT and retry (own budget, below). Off by
   * default: 4xx/5xx are protocol, not transport, and most must reach the
   * caller (500 "context size exceeded" is a real answer). But a local-stack
   * caller knows its 529 (proxy up, model loading), 502/503/504 (proxy
   * restarting / upstream moving ports) windows are 20–90s blips worth riding
   * out — each one killed a whole multi-minute agentic turn before this
   * (observed 2026-08-15: every Studio model reload risked an in-flight turn).
   */
  retryStatuses?: ReadonlySet<number>;
  /** Retries for retryStatuses responses (default 5; ~2.5min at 5s base). */
  statusRetries?: number;
  /** Base backoff for status retries; doubles each attempt (default 5000ms). */
  statusBackoffMs?: number;
}

/**
 * POST a model request with long timeouts and bounded transient-failure
 * retries. Returns the undici Response (API-compatible with global fetch's
 * Response for .ok/.status/.json()/.text()).
 */
export async function fetchModelWithRetry(
  url: string | URL,
  init: RequestInit,
  options: ModelFetchOptions = {}
): Promise<Response> {
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const impl = options.fetchImpl ?? globalFetch;
  const retryStatuses = options.retryStatuses;
  const statusRetries = Math.max(0, options.statusRetries ?? 5);
  const statusBackoffMs = options.statusBackoffMs ?? 5000;

  // Separate budgets on purpose: transport retries are cheap-and-fast (the
  // request never reached a server), status retries wait out a slow upstream
  // window. One shared counter would let a flapping connection starve the
  // status budget or vice versa.
  //
  // Backoff sleeps observe the caller's AbortSignal: a judge with a 60s
  // timeout must not sit blind through a 155s status-retry ladder. An abort
  // resolves the sleep immediately; the next attempt then rejects with the
  // caller's AbortError through the normal non-transient path.
  const signal = (init as { signal?: AbortSignal | null }).signal ?? undefined;
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        signal?.removeEventListener('abort', done);
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });

  let statusAttempt = 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await impl(url, { dispatcher: dispatcher(), ...init });
      if (retryStatuses?.has(res.status) && statusAttempt < statusRetries && !signal?.aborted) {
        statusAttempt++;
        options.onRetry?.(statusAttempt, new Error(`HTTP ${res.status} (retryable upstream window)`));
        // Consume the body so the connection can be reused, then wait.
        // Jittered (±20%): 529 IS the overload signal, and unjittered
        // exponential backoff resynchronizes every waiting caller into
        // retry waves against the already-overloaded upstream.
        try { await res.text(); } catch { /* discarded */ }
        await wait(statusBackoffMs * 2 ** (statusAttempt - 1) * (0.8 + Math.random() * 0.4));
        attempt--; // status retries do not spend the transport budget
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || attempt === retries) throw err;
      options.onRetry?.(attempt + 1, err);
      await wait(backoffMs * 2 ** attempt);
    }
  }
  throw lastErr; // unreachable, satisfies control flow
}
