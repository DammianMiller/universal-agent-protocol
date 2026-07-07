/**
 * Model → tool-call profile mapping.
 *
 * Maps a routed model (a ModelPresets id or a raw model name) to the
 * `config/model-profiles/<name>.json` profile that carries that model's optimal
 * tool-call + sampling/reasoning settings. Consumed by `uap-tool-calls`
 * (`detectModelProfile`) and the guided setup so the active profile
 * AUTO-SWITCHES to match whichever model the routing layer selects — there is
 * no manual "Model profile" pick in setup anymore.
 *
 * This is a PURE module (no zod, no fs) so the `uap-tool-calls` bin can import
 * it cheaply and it stays trivially unit-testable.
 */

export const GENERIC_PROFILE = 'generic';

/**
 * Explicit `ModelPresets` id → profile filename (without the `.json`).
 * Every current Anthropic + OpenAI model (and the local Qwen executors) has a
 * matching `config/model-profiles/*.json`.
 */
export const MODEL_PRESET_PROFILE: Record<string, string> = {
  'opus-4.8': 'claude-opus-4.8',
  'opus-4.6': 'claude-opus-4.6',
  'sonnet-5': 'claude-sonnet-5',
  'sonnet-4.6': 'claude-sonnet-4.6',
  'haiku-4.5': 'claude-haiku-4.5',
  haiku: 'claude-haiku-3.5',
  'fable-5': 'claude-fable-5',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.3-codex': 'gpt-5.3-codex',
  'qwen35-a3b': 'qwen35',
  'qwen36-a3b': 'qwen36',
};

/**
 * Provider → default profile used when no specific model/routing is known
 * (single-model setups that never picked a routing option).
 */
export const PROVIDER_DEFAULT_PROFILE: Record<string, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.4',
  local: 'qwen36',
  ollama: 'qwen36',
  custom: GENERIC_PROFILE,
};

/**
 * Resolve a routed model id/name to a profile filename. Falls back to fuzzy
 * matching on the raw string (so a bare `apiModel` like `claude-opus-4-8` or an
 * unknown alias still lands on the right family), then `generic`.
 */
export function profileForModelId(modelId: string | null | undefined): string {
  if (!modelId) return GENERIC_PROFILE;
  const id = modelId.trim();
  if (MODEL_PRESET_PROFILE[id]) return MODEL_PRESET_PROFILE[id];

  const lower = id.toLowerCase();
  if (/fable/.test(lower)) return 'claude-fable-5';
  if (/opus.*4[.\-_]?8/.test(lower)) return 'claude-opus-4.8';
  if (/opus.*4[.\-_]?6/.test(lower)) return 'claude-opus-4.6';
  if (/opus/.test(lower)) return 'claude-opus-4.8';
  if (/sonnet[-_. ]*5/.test(lower)) return 'claude-sonnet-5';
  if (/sonnet/.test(lower)) return 'claude-sonnet-4.6';
  if (/haiku.*4[.\-_]?5/.test(lower)) return 'claude-haiku-4.5';
  if (/haiku/.test(lower)) return 'claude-haiku-3.5';
  if (/gpt.*codex/.test(lower)) return 'gpt-5.3-codex';
  if (/gpt/.test(lower)) return 'gpt-5.4';
  if (/qwen.*(3[.\-_]?6|36)/.test(lower)) return 'qwen36';
  if (/qwen/.test(lower)) return 'qwen35';
  return GENERIC_PROFILE;
}

/**
 * Resolve the active profile from a `.uap.json` `multiModel` block (routing).
 * Uses the executor role — the model that actually generates code and emits the
 * tool calls the profile tunes. Returns null when routing is absent or disabled
 * so callers can fall back to a provider/legacy default.
 */
export function profileForRouting(
  multiModel: { enabled?: boolean; roles?: { executor?: string } } | null | undefined
): string | null {
  if (!multiModel || multiModel.enabled === false) return null;
  const executor = multiModel.roles?.executor;
  if (!executor) return null;
  return profileForModelId(executor);
}

/**
 * Resolve a provider default profile (single-model setup, no routing).
 */
export function profileForProvider(provider: string | null | undefined): string {
  if (!provider) return GENERIC_PROFILE;
  return PROVIDER_DEFAULT_PROFILE[provider] ?? GENERIC_PROFILE;
}

/**
 * Remove a stale `toolCalls.modelProfile` pin from a `.uap.json` config object
 * so the tool-call profile AUTO-FOLLOWS routing again. `uap model routing use`
 * must call this: `detectModelProfile()` returns an explicit pin BEFORE it
 * consults `multiModel` (the routing executor), so a leftover pin silently
 * overrides the routing choice and the client keeps launching the pinned
 * (often local) model. An explicit override is still available via the
 * `UAP_MODEL_PROFILE` env var, which outranks both. Pure + non-mutating:
 * returns a new config plus the cleared pin value (or null when there was none).
 */
export function clearToolCallProfilePin(
  config: Record<string, unknown>
): { config: Record<string, unknown>; cleared: string | null } {
  const tc = config.toolCalls as Record<string, unknown> | undefined;
  if (!tc || typeof tc.modelProfile !== 'string') {
    return { config, cleared: null };
  }
  const cleared = tc.modelProfile;
  const { modelProfile: _dropped, ...restTc } = tc;
  const next: Record<string, unknown> = { ...config };
  if (Object.keys(restTc).length > 0) {
    next.toolCalls = restTc;
  } else {
    delete next.toolCalls;
  }
  return { config: next, cleared };
}

