/**
 * Persistence Profile (Option C) — model-aware hands-free forcing intensity.
 *
 * Fable persists on long tasks intrinsically (trained). Frontier chat models
 * (Opus/Sonnet/GPT) are capable but stop at turn boundaries and declare
 * premature "done". Small local models (qwen35-a3b) additionally loop and
 * mis-declare completion. So the EXTERNAL forcing the harness applies should
 * scale inversely with the model's intrinsic persistence: trust Fable, nudge
 * the frontier, firmly drive the local model — while every profile keeps the
 * anti-spin safeguards (bounded blocks + stagnation give-up) so "never stop
 * early" never becomes "spin forever".
 *
 * Pure + fail-soft: resolution never throws; unknown models get the safe
 * `moderate` default.
 */

export type PersistenceIntensity = 'off' | 'light' | 'moderate' | 'aggressive';
export type ModelFamily = 'fable' | 'frontier' | 'local' | 'unknown';

export interface PersistenceProfile {
  model: string;
  family: ModelFamily;
  intensity: PersistenceIntensity;
  /** Whether the Stop hook may block session-end while the build is incomplete. */
  stopHookBlocks: boolean;
  /** Hard cap on consecutive Stop-hook blocks before giving up (anti-wedge). */
  maxBlocks: number;
  /** Consecutive no-progress blocks that trigger give-up + escalation. */
  stagnationLimit: number;
  /** Whether to inject the strong autonomy directive into interactive prompts. */
  injectAutonomy: boolean;
}

const PROFILES: Record<Exclude<PersistenceIntensity, 'off'>, Omit<PersistenceProfile, 'model' | 'family'>> = {
  // Fable — trust intrinsic persistence; keep only a light safety net.
  light: { intensity: 'light', stopHookBlocks: true, maxBlocks: 3, stagnationLimit: 2, injectAutonomy: false },
  // Opus/Sonnet/GPT — nudge past premature-done; moderate blocking.
  moderate: { intensity: 'moderate', stopHookBlocks: true, maxBlocks: 6, stagnationLimit: 3, injectAutonomy: true },
  // qwen / small local — firmly drive; more blocks tolerated, tighter stagnation.
  aggressive: { intensity: 'aggressive', stopHookBlocks: true, maxBlocks: 9, stagnationLimit: 3, injectAutonomy: true },
};

const OFF_PROFILE: Omit<PersistenceProfile, 'model' | 'family'> = {
  intensity: 'off',
  stopHookBlocks: false,
  maxBlocks: 0,
  stagnationLimit: 0,
  injectAutonomy: false,
};

/** Classify a model id into a persistence family by name heuristics. */
export function classifyModelFamily(modelId: string): ModelFamily {
  const m = (modelId || '').toLowerCase();
  if (m.includes('fable')) return 'fable';
  if (/qwen|a3b|llama|gemma|mistral|deepseek|local|small|3b|7b|8b|14b|32b|35b/.test(m)) return 'local';
  if (/opus|sonnet|claude|gpt|o1|o3|gemini|grok|haiku/.test(m)) return 'frontier';
  return 'unknown';
}

function familyIntensity(family: ModelFamily): Exclude<PersistenceIntensity, 'off'> {
  switch (family) {
    case 'fable':
      return 'light';
    case 'local':
      return 'aggressive';
    case 'frontier':
      return 'moderate';
    default:
      return 'moderate';
  }
}

export interface PersistenceConfig {
  /** hands-free master switch; default ON (auto-applied). */
  enabled?: boolean;
  /** force a specific intensity regardless of model. */
  intensity?: PersistenceIntensity;
  /** per-model overrides keyed by model id substring. */
  overrides?: Record<string, Partial<PersistenceProfile>>;
}

/**
 * Resolve the effective persistence profile for a model. `off` when hands-free
 * is disabled. An explicit `intensity` (env/config) overrides the family
 * default; per-model overrides refine individual fields.
 */
export function resolvePersistenceProfile(
  modelId: string | undefined,
  cfg: PersistenceConfig = {}
): PersistenceProfile {
  const model = modelId || 'unknown';
  const family = classifyModelFamily(model);

  if (cfg.enabled === false) {
    return { model, family, ...OFF_PROFILE };
  }

  const intensity: PersistenceIntensity = cfg.intensity ?? familyIntensity(family);
  const base = intensity === 'off' ? OFF_PROFILE : PROFILES[intensity];
  let profile: PersistenceProfile = { model, family, ...base, intensity };

  // Apply any per-model override whose key is a substring of the model id.
  if (cfg.overrides) {
    for (const [key, ov] of Object.entries(cfg.overrides)) {
      if (model.toLowerCase().includes(key.toLowerCase())) {
        profile = { ...profile, ...ov, model, family };
      }
    }
  }
  return profile;
}
