/**
 * OpenAI-compatible ModelClient
 *
 * Production implementation of the ModelClient interface from executor.ts.
 * Talks to any /v1/chat/completions server — the local inference gateway
 * (:4000), llama.cpp (:8080), vLLM, Ollama, or hosted OpenAI-compatible
 * endpoints.
 */

import { resolveWireModel } from './local-model.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { fetchModelWithRetry, modelHttpTimeoutMs, TRANSIENT_HTTP_STATUSES } from './long-fetch.js';
import type { ModelConfig } from './types.js';
import type { ModelClient, ModelCompleteOptions } from './executor.js';

export interface OpenAICompatClientOptions {
  /** Fallback endpoint when the ModelConfig has none (default: UAP_INFERENCE_ENDPOINT or http://localhost:4000/v1) */
  defaultEndpoint?: string;
  /** Abort timeout in ms (default: UAP_MODEL_HTTP_TIMEOUT_MS, 30 min) */
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

const THINKING_DEFAULT_MAX_TOKENS = 16384;

/**
 * Budget for the single automatic re-request after a truncated completion.
 * Reasoning models spend their budget on in-band thinking BEFORE the visible
 * answer, so `finish_reason: "length"` routinely lands mid-string: measured
 * live (statlib gate authoring, 2026-08-13), 8192 tokens bought ~7.6k tokens
 * of reasoning and 519 characters of bash script cut inside a quoted block.
 * 32k is 4x the proxy's default completion budget of 8192 — room for a long
 * reasoning preamble AND a complete visible answer.
 */
const TRUNCATION_RETRY_MAX_TOKENS = 32768;

const DEFAULT_TIMEOUT_MS = modelHttpTimeoutMs();

const LOOPBACK_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;
// MUST be a full IPv4 literal, not a prefix. The old pattern was unanchored and
// shape-free, so any DNS name beginning with those digits — `10.evil.com`,
// `192.168.attacker.net` — was classified as private and the local-only
// credential rule waved it through to a public host in cleartext. RFC 1123
// permits labels to start with digits, so this is registerable, not theoretical.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv4(hostname: string): boolean {
  const m = IPV4_RE.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Is this endpoint on the local machine or a private network?
 *
 * Exported so every credential-bearing caller shares ONE definition. The
 * PROXY_AUTH_TOKEN fallback means a request can now carry a secret even when the
 * model preset declares no apiKeyEnvVar, so any code path that attaches an
 * Authorization header has to make the same local-only judgement — duplicating
 * the regexes is how the two drift apart and one of them starts leaking.
 */
export function isLocalEndpoint(url: URL): boolean {
  return LOOPBACK_RE.test(url.hostname) || isPrivateIpv4(url.hostname);
}

/**
 * The credential to send, or undefined.
 *
 * PROXY_AUTH_TOKEN is a secret for ONE local process — the anthropic proxy. There
 * is no arrangement in which handing it to a third party is correct, so it is
 * scoped to local endpoints by construction rather than merely being refused over
 * cleartext: an operator pointing UAP at a hosted OpenAI-compatible provider over
 * https would otherwise have shipped their proxy token (and with it, use of their
 * Anthropic passthrough) to that vendor in a header the vendor logs.
 *
 * An explicitly-named provider key keeps the older, looser rule — it belongs to
 * the endpoint it is being sent to — but still may not travel in cleartext.
 */
export function resolveRequestCredential(
  model: { apiKeyEnvVar?: string },
  url: URL
): string | undefined {
  const explicit = model.apiKeyEnvVar ? process.env[model.apiKeyEnvVar] : undefined;
  if (explicit) {
    if (url.protocol !== 'https:' && !isLocalEndpoint(url)) {
      throw new Error(
        `Refusing to send ${model.apiKeyEnvVar} over ${url.protocol}// to non-local host ${url.hostname} — use https.`
      );
    }
    return explicit;
  }
  // The local-proxy fallback: local endpoints only, regardless of scheme.
  return isLocalEndpoint(url) ? process.env.PROXY_AUTH_TOKEN || proxyTokenFromFile() : undefined;
}

/**
 * Auth headers for a bare `fetch` against the local proxy, or `{}`.
 *
 * The model calls go through resolveRequestCredential, but the proxy also serves
 * side endpoints — `/v1/context`, `/props` — that helpers probe with a plain
 * fetch and no headers. Those 401'd, and because every one of them is fail-soft
 * the breakage was silent: context-window discovery quietly fell back to a
 * preset instead of the live per-rail window, and the realtime adaptor saw no
 * utilization at all and treated a full context as nominal. Nothing errored;
 * the numbers were just wrong.
 *
 * Same credential and the same isLocalEndpoint() gate as every other caller, so
 * a probe can never carry the token somewhere a model call would not.
 * Non-throwing by design: a probe must degrade, never take down its caller.
 */
export function proxyAuthHeaders(url: string): Record<string, string> {
  try {
    const token = resolveRequestCredential({}, new URL(url));
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/**
 * PROXY_AUTH_TOKEN recovered from `.uap/proxy.env`, for processes that were
 * never handed it in their environment.
 *
 * Agent clients spawn UAP as a child process — most sharply the `uap-router`
 * MCP server (`uap mcp-router start`) — and none of them source
 * `.uap/proxy.env` first. The token the proxy requires was therefore absent
 * from process.env, no Authorization header was attached, and every request
 * came back 401. The user-visible symptom was the model reporting that "the
 * uap-router_deliver tool failed due to an authentication error" and falling
 * back to writing files by hand.
 *
 * The token lives in that file precisely because it is chmod 600 and
 * gitignored. `.mcp.json` and `opencode.json` are tracked, so wiring it through
 * an MCP `env` block would commit the secret.
 *
 * Read once and cached, misses included: this sits in the per-request path and
 * re-statting on every call is pure syscall churn. Restart the process after
 * rotating the token. Callers still gate this behind isLocalEndpoint(), so a
 * token recovered here can only ever travel to the local proxy.
 */
let cachedProxyToken: string | undefined | null = null;

/** PROXY_AUTH_TOKEN out of one systemd-style EnvironmentFile, or undefined. */
function readProxyTokenFrom(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // systemd EnvironmentFile semantics: KEY=<rest of line>. No shell
    // word-splitting, and no quote handling beyond a wrapping pair.
    const eq = trimmed.indexOf('=');
    if (eq < 0 || trimmed.slice(0, eq).trim() !== 'PROXY_AUTH_TOKEN') continue;
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (value) return value;
  }
  return undefined;
}

/**
 * Every place the token may live, in priority order.
 *
 * Walking up from cwd is not enough on its own. `uap setup` writes a
 * `.uap/proxy.env` into EVERY project, but only the install that generated the
 * secret carries PROXY_AUTH_TOKEN — so an agent working in an unrelated project
 * finds a proxy.env, finds no token in it, and (previously) stopped there and
 * sent an unauthenticated request. That is the deliver 401: the file existed,
 * it simply wasn't the file with the secret.
 *
 * So: never stop at the first file, only at the first file that actually has the
 * key, and fall back to the user-level config where the token is installed once
 * per machine rather than once per project.
 */
function* proxyEnvCandidates(): Generator<string> {
  let dir = process.cwd();
  // The MCP server's cwd is wherever the client launched it, often a
  // subdirectory of the project rather than its root.
  for (let depth = 0; depth < 12; depth++) {
    yield join(dir, '.uap', 'proxy.env');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = homedir();
  yield join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'uap', 'proxy.env');
  yield join(home, '.uap', 'proxy.env');
}

function proxyTokenFromFile(): string | undefined {
  if (cachedProxyToken !== null) return cachedProxyToken;
  cachedProxyToken = undefined;
  try {
    for (const candidate of proxyEnvCandidates()) {
      const token = readProxyTokenFrom(candidate);
      if (token) {
        cachedProxyToken = token;
        break;
      }
    }
  } catch {
    // An unreadable or malformed file is not a reason to fail the request. The
    // caller proceeds unauthenticated and surfaces the proxy's own 401, which
    // is a far clearer diagnostic than a crash inside credential resolution.
  }
  return cachedProxyToken;
}

import {
  withModelSlot,
  recordModelSuccess,
  recordModelExhaustion,
  isExhaustionError,
} from '../utils/model-slot-lease.js';

export class OpenAICompatClient implements ModelClient {
  private readonly defaultEndpoint: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatClientOptions = {}) {
    this.defaultEndpoint =
      options.defaultEndpoint ??
      process.env.UAP_INFERENCE_ENDPOINT ??
      'http://localhost:4000/v1';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Complete a prompt, holding a model slot for the duration so concurrent
   * callers (deliver fan-out, parallel experts, multiple agents/processes) stay
   * within the inference backend's slot budget — same work, just bounded
   * concurrency. 429/timeout responses feed adaptive backpressure; 2xx feed
   * recovery. The lease is re-entrant + fail-open. Disable with UAP_MODEL_LEASE=0.
   */
  async complete(
    model: ModelConfig,
    prompt: string,
    options?: ModelCompleteOptions
  ): Promise<{
    content: string;
    tokensUsed: { input: number; output: number };
    latencyMs: number;
    finishReason?: string;
  }> {
    if (process.env.UAP_MODEL_LEASE === '0') {
      return this._requestWithTruncationRetry(model, prompt, options);
    }
    return withModelSlot(`model:${model.apiModel ?? 'default'}`, async () => {
      try {
        const result = await this._requestWithTruncationRetry(model, prompt, options);
        await recordModelSuccess({}).catch(() => undefined);
        return result;
      } catch (err) {
        if (isExhaustionError(err)) await recordModelExhaustion({}).catch(() => undefined);
        throw err;
      }
    });
  }

  private async _requestWithTruncationRetry(
    model: ModelConfig,
    prompt: string,
    options?: ModelCompleteOptions
  ): Promise<{
    content: string;
    tokensUsed: { input: number; output: number };
    latencyMs: number;
    finishReason?: string;
  }> {
    const first = await this._request(model, prompt, options);
    const retryAllowed =
      first.finishReason === 'length' &&
      options?.maxTokens === undefined &&
      first.tokensUsed.output < TRUNCATION_RETRY_MAX_TOKENS &&
      process.env.UAP_TRUNCATION_RETRY !== '0';
    if (!retryAllowed) return first;
    let retry: Awaited<ReturnType<OpenAICompatClient['_request']>>;
    try {
      retry = await this._request(model, prompt, {
        ...options,
        maxTokens: TRUNCATION_RETRY_MAX_TOKENS,
      });
    } catch {
      return first;
    }
    const best =
      retry.finishReason !== 'length' || retry.content.length >= first.content.length
        ? retry
        : first;
    return {
      ...best,
      tokensUsed: {
        input: first.tokensUsed.input + retry.tokensUsed.input,
        output: first.tokensUsed.output + retry.tokensUsed.output,
      },
      latencyMs: first.latencyMs + retry.latencyMs,
    };
  }

  private async _request(
    model: ModelConfig,
    prompt: string,
    options?: ModelCompleteOptions
  ): Promise<{
    content: string;
    tokensUsed: { input: number; output: number };
    latencyMs: number;
    finishReason?: string;
  }> {
    const endpoint = (model.endpoint ?? this.defaultEndpoint).replace(/\/$/, '');
    const wireModel = await resolveWireModel(model.apiModel, endpoint);
    const timeout = options?.timeout ?? this.timeoutMs;

    const url = new URL(`${endpoint}/chat/completions`);
    const apiKey = resolveRequestCredential(model, url);

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const stopTicker = startModelCallTicker();

    const thinkingOn = options?.thinking === true;
    const thinkingOff = options?.thinking === false;
    const effectiveMaxTokens =
      options?.maxTokens ?? (thinkingOn ? THINKING_DEFAULT_MAX_TOKENS : undefined);
    const images = (options?.images ?? []).filter((img) => img.trim().length > 0);
    const userContent =
      images.length > 0
        ? [
            { type: 'text', text: prompt },
            ...images.map((imgUrl) => ({ type: 'image_url', image_url: { url: imgUrl } })),
          ]
        : prompt;

    try {
      const response = await fetchModelWithRetry(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          // Thinking-ON calls opt into explicit reasoning and MUST omit
          // x-uap-json-response (which forces a bare-JSON grammar forbidding <think>).
          ...(thinkingOn
            ? { 'x-uap-reasoning': '1' }
            : options?.jsonResponse
              ? { 'x-uap-json-response': '1' }
              : {}),
        },
        body: JSON.stringify({
          model: wireModel,
          messages: [{ role: 'user', content: userContent }],
          ...(effectiveMaxTokens ? { max_tokens: effectiveMaxTokens } : {}),
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(thinkingOn
            ? { enable_thinking: true, chat_template_kwargs: { enable_thinking: true } }
            : thinkingOff
              ? { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } }
              : {}),
          ...(model.reasoningEffort
            ? { reasoning_effort: model.reasoningEffort === 'xhigh' ? 'high' : model.reasoningEffort }
            : {}),
        }),
        signal: controller.signal,
      }, {
        retryStatuses: TRANSIENT_HTTP_STATUSES,
        statusRetries: Number(process.env.UAP_MODEL_STATUS_RETRIES ?? 5),
        statusBackoffMs: Number(process.env.UAP_MODEL_STATUS_BACKOFF_MS ?? 5000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Inference request failed (${response.status}): ${body.slice(0, 500)}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const msg = data.choices?.[0]?.message;
      const rawContent = msg?.content;
      const reasoningFallback =
        thinkingOn && (!rawContent || !rawContent.trim()) && typeof msg?.reasoning_content === 'string'
          ? msg.reasoning_content
          : undefined;
      const content =
        typeof rawContent === 'string' && rawContent.trim().length > 0
          ? rawContent
          : reasoningFallback ?? rawContent;
      if (typeof content !== 'string') {
        const errMsg =
          typeof data.error === 'string' ? data.error : data.error?.message ?? 'no choices in response';
        throw new Error(`Inference response missing content: ${errMsg}`);
      }

      return {
        content,
        tokensUsed: {
          input: data.usage?.prompt_tokens ?? 0,
          output: data.usage?.completion_tokens ?? 0,
        },
        latencyMs: Date.now() - start,
        finishReason: data.choices?.[0]?.finish_reason,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Inference request timed out after ${timeout}ms (${url.hostname})`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      stopTicker();
    }
  }
}

// ---------------------------------------------------------------------------
// Model-call progress hook. The models/ layer cannot import delivery/ (it
// would invert the dependency), so the deliver CLI REGISTERS its heartbeat
// here once per run, and every completion through this client ticks it while
// in flight. Unregistered (every other consumer of this client), the ticker
// is a no-op.
// ---------------------------------------------------------------------------

let modelCallProgress: (() => void) | null = null;
let modelCallTickMs = 30_000;

/**
 * Register a callback ticked every `tickMs` while any completion through this
 * client is in flight — deliver points this at its run heartbeat so planning
 * and judge calls are observably alive. Pass null to unregister.
 */
export function setModelCallProgress(cb: (() => void) | null, tickMs = 30_000): void {
  modelCallProgress = cb;
  modelCallTickMs = tickMs;
}

function startModelCallTicker(): () => void {
  const cb = modelCallProgress;
  if (!cb || !(modelCallTickMs > 0)) return () => {};
  const t = setInterval(() => { try { cb(); } catch { /* best-effort */ } }, modelCallTickMs);
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
}
