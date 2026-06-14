/**
 * OpenAI-compatible ModelClient
 *
 * Production implementation of the ModelClient interface from executor.ts.
 * Talks to any /v1/chat/completions server — the local inference gateway
 * (:4000), llama.cpp (:8080), vLLM, Ollama, or hosted OpenAI-compatible
 * endpoints.
 */

import type { ModelConfig } from './types.js';
import type { ModelClient } from './executor.js';

export interface OpenAICompatClientOptions {
  /** Fallback endpoint when the ModelConfig has none (default: UAP_INFERENCE_ENDPOINT or http://localhost:4000/v1) */
  defaultEndpoint?: string;
  /** Request timeout in ms (default 300000) */
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

const DEFAULT_TIMEOUT_MS = 300_000;

const LOOPBACK_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;
const PRIVATE_HOST_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isLocalEndpoint(url: URL): boolean {
  return LOOPBACK_RE.test(url.hostname) || PRIVATE_HOST_RE.test(url.hostname);
}

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

  async complete(
    model: ModelConfig,
    prompt: string,
    options?: { maxTokens?: number; timeout?: number; temperature?: number }
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
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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
