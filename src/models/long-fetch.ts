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

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await impl(url, { dispatcher: dispatcher(), ...init });
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || attempt === retries) throw err;
      options.onRetry?.(attempt + 1, err);
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
    }
  }
  throw lastErr; // unreachable, satisfies control flow
}
