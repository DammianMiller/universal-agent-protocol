/**
 * Model Execution Profiles
 *
 * Evidence-based feature flag presets optimized for specific model families.
 * Each profile was derived from benchmark data (Harbor Terminal-Bench, 10 tasks).
 *
 * Key insight from 13 benchmark runs:
 *   - Small models (≤7B active params): LESS is MORE. Lean instructions,
 *     no conversation injection, domain hints only.
 *   - Medium models (13-30B active): Can handle moderate injection.
 *     Reflection checkpoints help. Search is neutral.
 *   - Large models (70B+): Can handle everything. Search, reflection,
 *     budget pressure, strategy switching all help.
 *
 * Usage:
 *   const profile = getExecutionProfile('qwen3.5-35b');
 *   // or auto-detect:
 *   const profile = detectExecutionProfile('qwen/qwen35-a3b-iq4xs');
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentExecutionConfig } from '../types/config.js';

// ============================================================================
// Profile Definitions
// ============================================================================

export interface ExecutionProfile {
  /** Profile identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Model families this profile applies to */
  modelPatterns: RegExp[];
  /** Estimated active parameters (for auto-sizing) */
  activeParamsBillions: number;
  /** Feature flag overrides */
  config: Partial<AgentExecutionConfig>;
  /** Rationale for this configuration */
  rationale: string;
  /** Quantization hints for local models (llama.cpp) */
  quantizationHint?: {
    low: string; // Quant for simple tasks (faster)
    medium: string; // Quant for standard tasks
    high: string; // Quant for complex tasks (better accuracy)
  };
}

/**
 * Small MoE models: Qwen3.5 35B (3B active), Mixtral 8x7B (12B active)
 *
 * PROVEN in 13 benchmark runs:
 * - Domain hints: +20% pass rate
 * - Lean instructions: every extra token hurts
 * - No conversation injection: regresses from 40% to 20%
 * - Low temperature: reduces stochastic variation
 */
const SMALL_MOE_PROFILE: ExecutionProfile = {
  id: 'small-moe',
  name: 'Small MoE (≤12B active)',
  modelPatterns: [
    /qwen.*3\.5.*35b/i,
    /qwen.*a3b/i,
    /mixtral.*8x7b/i,
    /mixtral.*moe/i,
    /deepseek.*v2.*lite/i,
  ],
  activeParamsBillions: 3,
  config: {
    domainHints: true,
    prependNotReplaceLoopBreaker: true,
    preExecutionHooks: true,
    lowTemperature: true,
    temperature: 0.15,
    gccFlagMutation: true,
    loopEscapeHatch: true,
    loopEscapeThreshold: 3,
    // Everything else OFF -- proven harmful for small models
    webSearch: false,
    preExecWebResearch: false,
    verifierAwareTesting: false,
    reflectionCheckpoints: false,
    progressiveBudgetPressure: false,
    outputDiffStrategySwitch: false,
    cwdInjection: false,
    softBudget: 35,
    hardBudget: 50,
    toolChoiceForce: 'required',
  },
  rationale:
    'Proven in 13 Harbor Terminal-Bench runs. Lean instructions + domain hints ' +
    'achieved 40% peak (4/10). Any conversation injection regresses to 20%.',
  quantizationHint: {
    low: 'iq2_xs',
    medium: 'iq4_xs',
    high: 'q5_k_m',
  },
};

/**
 * Small dense models: Qwen 7B, Llama 8B, Gemma 9B, Phi-3 7B
 *
 * Similar to small MoE but slightly more capable per-token.
 * Can handle marginally longer instructions.
 */
const SMALL_DENSE_PROFILE: ExecutionProfile = {
  id: 'small-dense',
  name: 'Small Dense (7-9B)',
  modelPatterns: [
    /qwen.*[^0-9]7b/i,
    /llama.*[^0-9]8b/i,
    /gemma.*[^0-9]9b/i,
    /phi.*[^0-9][37]b/i,
    /mistral.*[^0-9]7b/i,
    /codestral.*mamba/i,
  ],
  activeParamsBillions: 7,
  config: {
    domainHints: true,
    prependNotReplaceLoopBreaker: true,
    preExecutionHooks: true,
    lowTemperature: true,
    temperature: 0.2,
    gccFlagMutation: true,
    loopEscapeHatch: true,
    loopEscapeThreshold: 3,
    webSearch: false,
    preExecWebResearch: false,
    verifierAwareTesting: false,
    reflectionCheckpoints: false,
    progressiveBudgetPressure: false,
    outputDiffStrategySwitch: false,
    cwdInjection: false,
    softBudget: 35,
    hardBudget: 50,
    toolChoiceForce: 'required',
  },
  rationale:
    'Similar to small MoE. Dense 7-9B models have comparable effective ' +
    'reasoning to 3B-active MoE. Keep instructions lean.',
  quantizationHint: {
    low: 'iq2_xs',
    medium: 'q4_k_m',
    high: 'q5_k_m',
  },
};

/**
 * Medium models: Qwen 32B, Llama 70B, DeepSeek V3 (37B active), Gemma 27B
 *
 * Can handle moderate instruction length and some conversation injection.
 * Reflection checkpoints may help. Search is neutral.
 */
const MEDIUM_PROFILE: ExecutionProfile = {
  id: 'medium',
  name: 'Medium (13-37B active)',
  modelPatterns: [
    /qwen.*[^0-9]32b/i,
    /qwen.*[^0-9]14b/i,
    /llama.*[^0-9]70b/i,
    /deepseek.*v3/i,
    /gemma.*[^0-9]27b/i,
    /codestral.*[^0-9]22b/i,
    /command.*r.*plus/i,
    /yi.*[^0-9]34b/i,
  ],
  activeParamsBillions: 30,
  config: {
    domainHints: true,
    prependNotReplaceLoopBreaker: true,
    preExecutionHooks: true,
    lowTemperature: true,
    temperature: 0.3,
    gccFlagMutation: true,
    loopEscapeHatch: true,
    loopEscapeThreshold: 4,
    // Medium models can handle some extras
    webSearch: false, // Still off -- needs larger context window
    preExecWebResearch: true, // Cache results, model can read if needed
    verifierAwareTesting: true, // Model can handle the extra instruction
    reflectionCheckpoints: true, // Helps medium models stay on track
    reflectionInterval: 15,
    progressiveBudgetPressure: false, // Still too noisy
    outputDiffStrategySwitch: false, // Still too noisy
    cwdInjection: false, // Still breaks commands
    softBudget: 40,
    hardBudget: 60,
    toolChoiceForce: 'required',
  },
  rationale:
    'Medium models can handle reflection checkpoints and verifier hints ' +
    'without losing task context. Pre-exec research cached silently.',
  quantizationHint: {
    low: 'q4_k_m',
    medium: 'q5_k_m',
    high: 'q6_k',
  },
};

/**
 * Large models: Claude Opus 4, GPT-4o, Gemini 1.5 Pro, Llama 405B
 *
 * Can handle everything. Full feature set enabled.
 * These models benefit from richer context and can synthesize search results.
 */
const LARGE_PROFILE: ExecutionProfile = {
  id: 'large',
  name: 'Large (70B+ / frontier)',
  modelPatterns: [
    /claude.*opus/i,
    /claude.*sonnet.*4/i,
    /gpt.*4/i,
    /gpt.*5/i,
    /o[134]/i,
    /gemini.*1\.5.*pro/i,
    /gemini.*2/i,
    /gemini.*ultra/i,
    /llama.*[^0-9]405b/i,
    /deepseek.*r1/i,
    /qwen.*[^0-9]72b/i,
    /qwen.*[^0-9]110b/i,
  ],
  activeParamsBillions: 100,
  config: {
    domainHints: true,
    prependNotReplaceLoopBreaker: true,
    preExecutionHooks: true,
    lowTemperature: false, // Large models benefit from some creativity
    temperature: 0.4,
    gccFlagMutation: true,
    loopEscapeHatch: true,
    loopEscapeThreshold: 5,
    // Large models can handle everything
    webSearch: true, // Can synthesize search results
    preExecWebResearch: true,
    verifierAwareTesting: true,
    reflectionCheckpoints: true,
    reflectionInterval: 10, // More frequent -- model can handle it
    progressiveBudgetPressure: true, // Helps with time management
    outputDiffStrategySwitch: true, // Can process strategy alternatives
    cwdInjection: false, // Still breaks commands regardless of model size
    softBudget: 50,
    hardBudget: 80,
    toolChoiceForce: 'auto', // Large models don't need forced tool choice
  },
  rationale:
    'Frontier models benefit from richer context, reflection, and search. ' +
    'Higher budgets and auto tool_choice since they self-regulate well.',
};

/**
 * Claude-specific profile: Opus 4, Opus 4.6, Sonnet 4
 *
 * Claude models have excellent instruction following and tool use.
 * They don't need forced tool_choice and benefit from higher temperature.
 */
const CLAUDE_PROFILE: ExecutionProfile = {
  id: 'claude',
  name: 'Claude (Opus/Sonnet 4+)',
  modelPatterns: [
    /claude.*opus.*4/i,
    /claude.*sonnet.*4/i,
    /anthropic.*opus/i,
    /anthropic.*sonnet/i,
  ],
  activeParamsBillions: 200, // Estimated
  config: {
    domainHints: true,
    prependNotReplaceLoopBreaker: true,
    preExecutionHooks: true,
    lowTemperature: false,
    temperature: 0.5,
    gccFlagMutation: false, // Claude gets gcc flags right
    loopEscapeHatch: true,
    loopEscapeThreshold: 5,
    webSearch: true,
    preExecWebResearch: true,
    verifierAwareTesting: true,
    reflectionCheckpoints: false, // Claude self-reflects naturally
    progressiveBudgetPressure: true,
    outputDiffStrategySwitch: false, // Claude changes strategy on its own
    cwdInjection: false,
    softBudget: 60,
    hardBudget: 100,
    toolChoiceForce: 'auto', // Claude uses tools reliably without forcing
  },
  rationale:
    'Claude models have strong instruction following and self-regulation. ' +
    'No need for forced tool_choice or reflection injection. Higher budgets.',
};

/**
 * GPT-specific profile: GPT-4o, GPT-4.5, o1, o3
 *
 * GPT models benefit from structured prompts and explicit phase management.
 */
const GPT_PROFILE: ExecutionProfile = {
  id: 'gpt',
  name: 'GPT (4o/4.5/o-series)',
  modelPatterns: [/gpt.*4o/i, /gpt.*4\.5/i, /gpt.*5/i, /o1/i, /o3/i, /o4/i],
  activeParamsBillions: 200, // Estimated
  config: {
    domainHints: true,
    prependNotReplaceLoopBreaker: true,
    preExecutionHooks: true,
    lowTemperature: false,
    temperature: 0.4,
    gccFlagMutation: true,
    loopEscapeHatch: true,
    loopEscapeThreshold: 4,
    webSearch: true,
    preExecWebResearch: true,
    verifierAwareTesting: true,
    reflectionCheckpoints: true,
    reflectionInterval: 12,
    progressiveBudgetPressure: true, // GPT benefits from phase structure
    outputDiffStrategySwitch: true,
    cwdInjection: false,
    softBudget: 50,
    hardBudget: 80,
    toolChoiceForce: 'auto',
  },
  rationale:
    'GPT models benefit from structured phases and explicit budget management. ' +
    'Strong tool use but benefits from reflection checkpoints.',
};

/**
 * Gemini-specific profile: Gemini 1.5 Pro, Gemini 2.0, Gemini Ultra
 *
 * Gemini has very large context windows. Can handle extensive instructions.
 */
const GEMINI_PROFILE: ExecutionProfile = {
  id: 'gemini',
  name: 'Gemini (1.5 Pro / 2.0)',
  modelPatterns: [/gemini.*1\.5/i, /gemini.*2/i, /gemini.*ultra/i, /gemini.*pro/i],
  activeParamsBillions: 150, // Estimated
  config: {
    domainHints: true,
    prependNotReplaceLoopBreaker: true,
    preExecutionHooks: true,
    lowTemperature: false,
    temperature: 0.4,
    gccFlagMutation: true,
    loopEscapeHatch: true,
    loopEscapeThreshold: 4,
    webSearch: true, // Gemini can synthesize well
    preExecWebResearch: true,
    verifierAwareTesting: true,
    reflectionCheckpoints: true,
    reflectionInterval: 10,
    progressiveBudgetPressure: true,
    outputDiffStrategySwitch: true,
    cwdInjection: false,
    softBudget: 50,
    hardBudget: 80,
    toolChoiceForce: 'auto',
  },
  rationale:
    'Gemini has massive context windows (1M+ tokens). Can handle extensive ' +
    'instructions, search results, and reflection without context pressure.',
};

// ============================================================================
// Profile Registry
// ============================================================================

/** All profiles ordered from most specific to most general */
const ALL_PROFILES: ExecutionProfile[] = [
  CLAUDE_PROFILE,
  GPT_PROFILE,
  GEMINI_PROFILE,
  SMALL_MOE_PROFILE,
  SMALL_DENSE_PROFILE,
  MEDIUM_PROFILE,
  LARGE_PROFILE,
];

// ============================================================================
// Public API
// ============================================================================

/**
 * Get a profile by ID.
 */
export function getExecutionProfile(profileId: string): ExecutionProfile | undefined {
  return ALL_PROFILES.find((p) => p.id === profileId);
}

/**
 * Auto-detect the best execution profile for a model name/ID.
 *
 * Matches against model patterns in order of specificity.
 * Falls back to size-based heuristic if no pattern matches.
 *
 * @param modelName - Model name or ID (e.g., "claude-opus-4", "qwen/qwen35-a3b-iq4xs")
 * @returns The best matching profile
 */
export function detectExecutionProfile(modelName: string): ExecutionProfile {
  // Try pattern matching first (most specific wins)
  for (const profile of ALL_PROFILES) {
    for (const pattern of profile.modelPatterns) {
      if (pattern.test(modelName)) {
        return profile;
      }
    }
  }

  // Fallback: extract parameter count from model name
  const paramMatch = modelName.match(/(\d+)[bB]/);
  if (paramMatch) {
    const params = parseInt(paramMatch[1], 10);
    if (params <= 9) return SMALL_DENSE_PROFILE;
    if (params <= 35) return MEDIUM_PROFILE;
    return LARGE_PROFILE;
  }

  // Ultimate fallback: use small-dense (safest defaults)
  return SMALL_DENSE_PROFILE;
}

/**
 * Get the merged config for a model: profile defaults + user overrides.
 *
 * @param modelName - Model name for auto-detection
 * @param userOverrides - User's agentExecution config from .uap.json
 * @returns Merged config with profile defaults and user overrides
 */
export function getExecutionConfig(
  modelName: string,
  userOverrides?: Partial<AgentExecutionConfig>
): { profile: ExecutionProfile; config: AgentExecutionConfig } {
  const profile = detectExecutionProfile(modelName);

  // Start with schema defaults, overlay profile, then user overrides
  const merged: AgentExecutionConfig = {
    domainHints: true,
    prependNotReplaceLoopBreaker: true,
    preExecutionHooks: true,
    lowTemperature: true,
    temperature: 0.15,
    gccFlagMutation: true,
    loopEscapeHatch: true,
    loopEscapeThreshold: 3,
    webSearch: false,
    webSearchEndpoint: 'http://192.168.1.165:8888',
    preExecWebResearch: false,
    verifierAwareTesting: false,
    reflectionCheckpoints: false,
    reflectionInterval: 15,
    progressiveBudgetPressure: false,
    outputDiffStrategySwitch: false,
    cwdInjection: false,
    softBudget: 35,
    hardBudget: 50,
    toolChoiceForce: 'required',
    // Apply profile
    ...profile.config,
    // Apply user overrides (highest priority)
    ...userOverrides,
  };

  return { profile, config: merged };
}

/**
 * Load agentExecution overrides from .uap.json config file.
 * Returns undefined if no config or no agentExecution section found.
 */
export function loadAgentExecutionOverrides(
  projectDir?: string
): Partial<AgentExecutionConfig> | undefined {
  const dir = projectDir || process.cwd();
  const configPath = join(dir, '.uap.json');

  if (!existsSync(configPath)) return undefined;

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config?.agentExecution && typeof config.agentExecution === 'object') {
      return config.agentExecution as Partial<AgentExecutionConfig>;
    }
  } catch {
    // Config parse failure is non-fatal
  }

  return undefined;
}

/**
 * Get execution config with automatic config file loading.
 * Convenience wrapper that loads .uap.json overrides automatically.
 */
export function getExecutionConfigWithProjectOverrides(
  modelName: string,
  projectDir?: string
): { profile: ExecutionProfile; config: AgentExecutionConfig } {
  const overrides = loadAgentExecutionOverrides(projectDir);
  return getExecutionConfig(modelName, overrides);
}

/**
 * List all available profiles.
 */
export function listExecutionProfiles(): ExecutionProfile[] {
  return [...ALL_PROFILES];
}
