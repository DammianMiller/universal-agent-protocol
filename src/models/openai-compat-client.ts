/**
 * OpenAI-compatible ModelClient
 *
 * Production implementation of the ModelClient interface from executor.ts.
 * Talks to any /v1/chat/completions server — the local inference gateway
 * (:4000), llama.cpp (:8080), vLLM, Ollama, or hosted OpenAI-compatible
 * endpoints.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { fetchModelWithRetry, modelHttpTimeoutMs } from './long-fetch.js';
import type { ModelConfig } from './types.js';
import type { ModelClient } from './executor.js';

export interface OpenAICompatClientOptions {
  /** Fallback endpoint when the ModelConfig has none (default: UAP_INFERENCE_ENDPOINT or http://localhost:4000/v1) */
  defaultEndpoint?: string;
  /** Abort timeout in ms (default: UAP_MODEL_HTTP_TIMEOUT_MS, 30 min) */
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

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
    options?: { maxTokens?: number; timeout?: number; temperature?: number; jsonResponse?: boolean }
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

  /**
   * One bounded re-request when the completion was TRUNCATED.
   *
   * `finish_reason: "length"` means the text ends wherever the budget ran out,
   * not where the model finished — for code/scripts that is a syntax error the
   * caller cannot distinguish from a model mistake. Measured live (2026-08-13):
   * deliver's self-gate authoring burned two of its three attempts on scripts
   * cut mid-quote, failed the run, and fed the model feedback ("make sure it is
   * complete") about a defect only the budget could fix.
   *
   * Retries once with an explicit raised budget, and ONLY when the caller did
   * not pin `maxTokens` — an explicit cap is a cost decision the caller owns.
   * The pick is non-regressive: a cleanly-finished retry always wins; a retry
   * that also ended early wins only if it carries more text; a retry that
   * ERRORS is discarded in favor of the first (partial) result. Either way
   * `finishReason` reports what the returned content actually is.
   * Kill-switch: UAP_TRUNCATION_RETRY=0.
   */
  private async _requestWithTruncationRetry(
    model: ModelConfig,
    prompt: string,
    options?: { maxTokens?: number; timeout?: number; temperature?: number; jsonResponse?: boolean }
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
      // A first call that already produced >= the retry budget was not starved
      // by a low server-side default — re-requesting at the same ceiling is a
      // deterministic duplicate decode.
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
      // The retry is opportunistic. Failing it must not destroy the partial
      // result the first request already paid for — truncated-but-visible
      // (finishReason: 'length') beats a thrown error the caller cannot
      // salvage anything from.
      return first;
    }
    // Non-regressive pick: a clean retry always wins; a retry that ALSO ended
    // early (still 'length', or chopped by the proxy's degenerate guard) wins
    // only if it carries more text. Both requests were paid for either way, so
    // usage reports the sum regardless of which content is returned.
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
    options?: { maxTokens?: number; timeout?: number; temperature?: number; jsonResponse?: boolean }
  ): Promise<{
    content: string;
    tokensUsed: { input: number; output: number };
    latencyMs: number;
    finishReason?: string;
  }> {
    const endpoint = (model.endpoint ?? this.defaultEndpoint).replace(/\/$/, '');
    const timeout = options?.timeout ?? this.timeoutMs;

    const url = new URL(`${endpoint}/chat/completions`);
    // One shared rule for what may be sent where (throws on a cleartext leak of
    // an explicit provider key; silently withholds the local proxy token from any
    // non-local endpoint).
    const apiKey = resolveRequestCredential(model, url);

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetchModelWithRetry(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          // Evaluator verdicts: the UAP proxy grammar-constrains this
          // completion to a bare JSON value (no <think> preamble), so judge/
          // critic/ideation parses are deterministic. Ignored by other servers.
          ...(options?.jsonResponse ? { 'x-uap-json-response': '1' } : {}),
        },
        body: JSON.stringify({
          model: model.apiModel,
          messages: [{ role: 'user', content: prompt }],
          ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          // Reasoning effort for models that support it. UAP's 'xhigh' maps to
          // the OpenAI-compatible maximum 'high' on the wire.
          ...(model.reasoningEffort
            ? { reasoning_effort: model.reasoningEffort === 'xhigh' ? 'high' : model.reasoningEffort }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Inference request failed (${response.status}): ${body.slice(0, 500)}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
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
    }
  }
}
