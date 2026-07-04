/**
 * OpenAI-compatible ModelClient
 *
 * Production implementation of the ModelClient interface from executor.ts.
 * Talks to any /v1/chat/completions server — the local inference gateway
 * (:4000), llama.cpp (:8080), vLLM, Ollama, or hosted OpenAI-compatible
 * endpoints.
 */

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
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

const DEFAULT_TIMEOUT_MS = modelHttpTimeoutMs();

const LOOPBACK_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;
const PRIVATE_HOST_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isLocalEndpoint(url: URL): boolean {
  return LOOPBACK_RE.test(url.hostname) || PRIVATE_HOST_RE.test(url.hostname);
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
  ): Promise<{ content: string; tokensUsed: { input: number; output: number }; latencyMs: number }> {
    if (process.env.UAP_MODEL_LEASE === '0') {
      return this._request(model, prompt, options);
    }
    return withModelSlot(`model:${model.apiModel ?? 'default'}`, async () => {
      try {
        const result = await this._request(model, prompt, options);
        await recordModelSuccess({}).catch(() => undefined);
        return result;
      } catch (err) {
        if (isExhaustionError(err)) await recordModelExhaustion({}).catch(() => undefined);
        throw err;
      }
    });
  }

  private async _request(
    model: ModelConfig,
    prompt: string,
    options?: { maxTokens?: number; timeout?: number; temperature?: number; jsonResponse?: boolean }
  ): Promise<{ content: string; tokensUsed: { input: number; output: number }; latencyMs: number }> {
    const endpoint = (model.endpoint ?? this.defaultEndpoint).replace(/\/$/, '');
    const apiKey = model.apiKeyEnvVar ? process.env[model.apiKeyEnvVar] : undefined;
    const timeout = options?.timeout ?? this.timeoutMs;

    const url = new URL(`${endpoint}/chat/completions`);
    // Never send a credential in cleartext beyond the local network.
    if (apiKey && url.protocol !== 'https:' && !isLocalEndpoint(url)) {
      throw new Error(
        `Refusing to send ${model.apiKeyEnvVar} over ${url.protocol}// to non-local host ${url.hostname} — use https.`
      );
    }

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
