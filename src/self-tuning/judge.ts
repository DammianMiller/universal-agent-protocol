/**
 * LLM Self-Tuning — the shared judge/tuner LLM client seam.
 *
 * Both the Quality Scorer (P0) and the LLM Tuner (P1) need to make a REAL call
 * to a stronger "judge" model given a prompt and get text back. This module is
 * the single, injectable seam for that:
 *
 *   - `JudgeClient` is a tiny interface (id + complete) so every consumer is
 *     testable with a deterministic stub and never hard-wires the network.
 *   - `resolveJudgeClient` builds a production client over `OpenAICompatClient`
 *     + `ModelPresets`, resolving the judge model from an explicit id, the
 *     `recipes.judge.model` config field, or an Opus fallback — the same
 *     construction the `uap verify` acceptance judge uses (src/cli/verify.ts).
 *   - `parseJsonLenient` recovers a JSON object from a completion even when the
 *     model wraps it in prose / ``` fences (the local-model reality), while the
 *     `x-uap-json-response` grammar keeps the happy path deterministic.
 *
 * The recipe/confidence-escalation engine that consumes `recipes.judge.model`
 * at serving time lives in the Python proxy; this is the TypeScript-side judge
 * call the offline tuning loop uses. See docs/design/LLM_SELF_TUNING_ANALYSIS.md.
 */

import type { ModelConfig } from '../models/types.js';
import { loadUapConfigRaw } from '../utils/config-loader.js';

/** A minimal prompt→text completion seam for the judge/tuner model. */
export interface JudgeClient {
  /** Human-readable id (model id) for logs and provenance. */
  readonly id: string;
  /** Complete a prompt and return the raw text. `json` requests grammar-constrained JSON. */
  complete(prompt: string, opts?: { json?: boolean; temperature?: number; maxTokens?: number }): Promise<string>;
}

export interface ResolveJudgeOptions {
  /** Explicit judge model: a `ModelPresets` key, a preset `apiModel`, or a bare model id. */
  judgeModel?: string;
  /** Endpoint override (e.g. a cloud gateway). Defaults to the client's default. */
  endpoint?: string;
  /** Read `recipes.judge.model` from `.uap.json` in this cwd when `judgeModel` is unset. */
  cwd?: string;
  /** Fallback preset id when nothing resolves. Default 'opus-4.8'. */
  fallbackPreset?: string;
  /** When true, do NOT fall back to a default preset — return null if unresolved. */
  requireExplicit?: boolean;
}

/**
 * Resolve a judge model id into a concrete `ModelConfig`. Order of preference:
 *   1. an exact `ModelPresets` key,
 *   2. a preset whose `apiModel` equals the id (accepts wire ids like `claude-opus-4-8`),
 *   3. a synthesized Anthropic-style config using the id verbatim as the apiModel.
 */
export function resolveJudgeModelConfig(
  id: string,
  presets: Record<string, ModelConfig>,
): ModelConfig {
  if (presets[id]) return presets[id];
  const byApiModel = Object.values(presets).find((m) => m.apiModel === id);
  if (byApiModel) return byApiModel;
  // Synthesize: treat the id as an OpenAI/Anthropic-compatible apiModel. The
  // endpoint (and thus provider translation) is the proxy's concern.
  return {
    id,
    name: id,
    provider: id.startsWith('claude') ? 'anthropic' : 'custom',
    apiModel: id,
    apiKeyEnvVar: id.startsWith('claude') ? 'ANTHROPIC_API_KEY' : undefined,
    maxContextTokens: 128000,
    capabilities: [],
  };
}

/**
 * Build a production `JudgeClient`, or null when no judge model can be resolved
 * and `requireExplicit`/no-fallback is in effect. Lazily imports the model layer
 * so callers that never score/tune don't pay for it.
 */
export async function resolveJudgeClient(opts: ResolveJudgeOptions = {}): Promise<JudgeClient | null> {
  let id = opts.judgeModel;
  if (!id && opts.cwd !== undefined) {
    const raw = loadUapConfigRaw(opts.cwd) as { recipes?: { judge?: { model?: unknown } } } | null;
    const configured = raw?.recipes?.judge?.model;
    if (typeof configured === 'string' && configured.trim()) id = configured.trim();
  }
  if (!id) {
    if (opts.requireExplicit) return null;
    id = opts.fallbackPreset ?? 'opus-4.8';
  }

  const { OpenAICompatClient } = await import('../models/openai-compat-client.js');
  const { ModelPresets } = await import('../models/types.js');
  const base = resolveJudgeModelConfig(id, ModelPresets);
  const model: ModelConfig = opts.endpoint ? { ...base, endpoint: opts.endpoint } : base;
  const client = new OpenAICompatClient();

  return {
    id: model.apiModel,
    async complete(prompt, o = {}) {
      const r = await client.complete(model, prompt, {
        temperature: o.temperature ?? 0.1,
        jsonResponse: o.json,
        ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}),
      });
      return r.content;
    },
  };
}

/**
 * Extract the first well-formed JSON object/array from a model completion.
 * Tolerates ``` fences, a `<think>` preamble, and leading/trailing prose — the
 * failure modes a local model produces even under the JSON grammar. Returns the
 * parsed value, or null if no balanced JSON literal is found.
 */
export function parseJsonLenient<T = unknown>(text: string): T | null {
  if (!text) return null;
  // Fast path: the whole thing parses.
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through to scan */
  }
  // Strip a leading <think>…</think> block if present.
  const afterThink = trimmed.replace(/^[\s\S]*?<\/think>/i, '').trim();
  // Strip ``` fences.
  const unfenced = afterThink.replace(/```(?:json)?/gi, '');
  // Scan for the first balanced {...} or [...] literal.
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = unfenced.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < unfenced.length; i++) {
      const ch = unfenced[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const candidate = unfenced.slice(start, i + 1);
          try {
            return JSON.parse(candidate) as T;
          } catch {
            break; // malformed; give up on this bracket type
          }
        }
      }
    }
  }
  return null;
}
