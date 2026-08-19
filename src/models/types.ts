/**
 * Multi-Model Architecture Types
 *
 * Defines types for the two-tier agentic architecture:
 * - Tier 1 (Planner): High-level reasoning and task decomposition
 * - Tier 2 (Executor): Concrete implementation following planner specs
 */

import { z } from 'zod';

// Model provider identifiers
export type ModelProvider = 'anthropic' | 'openai' | 'ollama' | 'custom';

// Model role in the architecture
export type ModelRole = 'planner' | 'executor' | 'reviewer' | 'fallback' | 'task';

// Task complexity levels for routing
export type TaskComplexity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Model configuration for a specific provider/model combination
 */
export const ModelConfigSchemaModels = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(['anthropic', 'openai', 'ollama', 'custom']),
  apiModel: z.string(),
  endpoint: z.string().optional(),
  apiKeyEnvVar: z.string().optional(),
  maxContextTokens: z.number().default(128000),
  costPer1MInput: z.number().optional(),
  costPer1MOutput: z.number().optional(),
  capabilities: z.array(z.string()).default([]),
  modelContextBudget: z.number().optional(), // Effective context sweet spot (may be less than maxContextTokens)
  // Reasoning/thinking effort for models that support it. 'xhigh' is UAP's
  // maximum; it maps to provider 'high' on OpenAI-compatible wires.
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchemaModels>;

/**
 * Pre-defined model presets for common configurations
 */
export const ModelPresets: Record<string, ModelConfig> = {
  'opus-4.8': {
    id: 'opus-4.8',
    name: 'Claude Opus 4.8',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-8',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 7.5,
    costPer1MOutput: 37.5,
    capabilities: [
      'planning',
      'complex-reasoning',
      'code-generation',
      'review',
      'advanced-planning',
    ],
    modelContextBudget: 180000,
    reasoningEffort: 'xhigh',
  },
  'opus-4.6': {
    id: 'opus-4.6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-6-20260101',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 7.5,
    costPer1MOutput: 37.5,
    capabilities: [
      'planning',
      'complex-reasoning',
      'code-generation',
      'review',
      'advanced-planning',
    ],
    modelContextBudget: 180000,
  },
  'sonnet-4.6': {
    id: 'sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-6-20250514',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 3.0,
    costPer1MOutput: 15.0,
    capabilities: ['code-generation', 'execution', 'review', 'agentic'],
    modelContextBudget: 180000,
  },
  haiku: {
    id: 'haiku',
    name: 'Claude Haiku (Latest)',
    provider: 'anthropic',
    apiModel: 'claude-3-5-haiku-20241022',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 0.8,
    costPer1MOutput: 4.0,
    capabilities: ['code-generation', 'execution', 'simple-tasks'],
  },
  'qwen35-a3b': {
    id: 'qwen35-a3b',
    name: 'Qwen 3.5 35B A3B (llama.cpp)',
    provider: 'custom',
    apiModel: 'qwen35-a3b-iq4xs',
    // Route through the anthropic-proxy (:4000), NOT llama :8080 directly. The
    // proxy strips Qwen's <think> blocks and applies the tool/finalize guardrails.
    // Hitting :8080 raw under `--reasoning auto` let reasoning leak into
    // `uap deliver`-authored gate scripts (verify.sh became an unclosed <think>
    // block -> bash syntax error -> unsatisfiable gate -> infinite verify loop).
    endpoint: 'http://127.0.0.1:4000/v1',
    maxContextTokens: 262144,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    capabilities: ['code-generation', 'execution', 'planning', 'simple-tasks'],
    // 2026-07-09: per-rail serving context (llama --parallel 3 over ctx 390k = 130k/rail).
    // NB: v1.132.0 auto-discovers the live per-rail window from the proxy
    // (/v1/context), so this is the fallback when discovery is unreachable.
    modelContextBudget: 130000,
  },
  'gpt-5.4': {
    id: 'gpt-5.4',
    name: 'GPT 5.4',
    provider: 'openai',
    apiModel: 'gpt-5.4',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    maxContextTokens: 128000,
    costPer1MInput: 2.5,
    costPer1MOutput: 10.0,
    capabilities: ['planning', 'code-generation', 'complex-reasoning'],
  },
  'gpt-5.3-codex': {
    id: 'gpt-5.3-codex',
    name: 'GPT 5.3 Codex',
    provider: 'openai',
    apiModel: 'gpt-5.3-codex',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    maxContextTokens: 192000,
    costPer1MInput: 3.0,
    costPer1MOutput: 12.0,
    capabilities: ['code-generation', 'execution', 'complex-reasoning', 'agentic'],
  },
  'fable-5': {
    id: 'fable-5',
    name: 'Claude Fable 5',
    provider: 'anthropic',
    apiModel: 'claude-fable-5',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 5.0,
    costPer1MOutput: 25.0,
    capabilities: ['planning', 'complex-reasoning', 'code-generation', 'advanced-planning'],
    modelContextBudget: 180000,
  },
  'sonnet-5': {
    id: 'sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-5-20250514',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 3.75,
    costPer1MOutput: 18.75,
    capabilities: [
      'planning',
      'code-generation',
      'execution',
      'review',
      'agentic',
      'complex-reasoning',
    ],
    modelContextBudget: 180000,
  },
  'haiku-4.5': {
    id: 'haiku-4.5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    apiModel: 'claude-haiku-4-5-20251001',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 1.0,
    costPer1MOutput: 5.0,
    capabilities: ['code-generation', 'execution', 'simple-tasks', 'agentic'],
    modelContextBudget: 180000,
  },
  'qwen36-a3b': {
    id: 'qwen36-a3b',
    name: 'Qwen 3.6 35B A3B (llama.cpp, local)',
    provider: 'custom',
    apiModel: 'qwen36-35b-a3b-iq4xs',
    // Route through the anthropic-proxy (:4000) for <think>-stripping + tool/finalize
    // guardrails (same rationale as qwen35-a3b), not llama :8080 raw.
    endpoint: 'http://127.0.0.1:4000/v1',
    maxContextTokens: 262144,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    capabilities: ['code-generation', 'execution', 'planning', 'simple-tasks'],
    // 2026-07-09: per-rail serving context (llama --parallel 3 over ctx 390k = 130k/rail).
    // NB: v1.132.0 auto-discovers the live per-rail window from the proxy
    // (/v1/context), so this is the fallback when discovery is unreachable.
    modelContextBudget: 130000,
  },
  'qwen38-27b': {
    id: 'qwen38-27b',
    name: 'Qwen 3.8 27B (ninfer, local)',
    provider: 'custom',
    apiModel: 'qwen3.8-27b',
    // Route through the anthropic-proxy (:4000) for the tool/finalize
    // guardrails, not the inference server's :8080 raw.
    //
    // The local engine is ninfer-serve, NOT llama.cpp:
    //   ninfer-serve models/qwen3_8_27b.ninfer --max-context 131072
    //     --kv-capacity 131072 --max-concurrency 1 --max-pending-requests 16
    //     --prefill-chunk 1024 --kv-dtype int8 --spec mtp --draft-tokens 3
    //     --lm-head-draft
    // Two consequences UAP has to respect. (1) --max-concurrency 1: there is
    // ONE rail, so the whole window belongs to a single request and nothing
    // here is divided by a slot count the way the qwen36 llama.cpp entry was.
    // (2) reasoning is returned in a separate `reasoning_content` field rather
    // than inline <think> tags, so it costs completion budget without ever
    // appearing in the text — see the profile's max_tokens note.
    endpoint: 'http://127.0.0.1:4000/v1',
    maxContextTokens: 131072,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    capabilities: ['code-generation', 'execution', 'planning', 'simple-tasks'],
    // A 1024-token safety margin under the served window, NOT a computed
    // reserve — nothing in the code derives 131072 - 1024, and this backend
    // serves none of the llama.cpp endpoints (/props, /slots) the proxy's
    // window discovery reads, so there is no live figure to defer to here.
    modelContextBudget: 130048,
  },
};

export type ModelPresetId = keyof typeof ModelPresets;

/**
 * Named multi-model ROUTING options — role bundles you can pick with
 * `uap model routing use <id>`, which writes the roles into `.uap.json`.
 * Each role references a ModelPresets id. Cloud roles (planner/reviewer) run
 * against Anthropic and work with a Claude Max plan via the proxy's OAuth
 * passthrough; local roles run free on llama.cpp.
 */
/** An ordered escalation chain of model ids: index 0 is the primary; later
 * entries are the models to escalate to on failure (consumed in S5). */
export type ModelChain = string[];

/** A lifecycle phase a task turn runs in. `reflect` is used by the GEPA reflect
 * phase (S6); `fallback` is the last-resort model. */
export type Phase = 'plan' | 'execute' | 'review' | 'reflect' | 'fallback';

/** Per-phase model chains for one complexity tier. A phase omitted from an
 * explicit PhaseModels tier is *skippable* (see `resolvePhaseChain` allowSkip),
 * which is how trivial/low tiers get near-zero overhead (S4). */
export interface PhaseModels {
  plan?: ModelChain;
  execute?: ModelChain;
  review?: ModelChain;
  reflect?: ModelChain;
  fallback?: ModelChain;
}

export interface RoutingPreset {
  id: string;
  name: string;
  description: string;
  roles: { planner: string; executor: string; reviewer: string; fallback: string };
  /**
   * Per-task-complexity model routing (cost/speed control, orthogonal to the
   * lifecycle roles above). When present, a task's classified complexity picks
   * the EXECUTION model directly — trivial work runs on the cheapest/fastest
   * model, hard work escalates — instead of collapsing onto the executor role.
   * Any tier left unset falls back to the executor role model, so a partial
   * map stays coherent. Consumed by `uap model routing use`, which materializes
   * it into the router's routingMatrix.
   */
  tiers?: Partial<Record<TaskComplexity, string | PhaseModels>>;
  models: string[];
  routingStrategy?: string;
}

export const RoutingPresets: Record<string, RoutingPreset> = {
  'fable-local-opus': {
    id: 'fable-local-opus',
    name: 'Fable plan / local execute / Opus review',
    description:
      'Plan with Claude Fable 5, execute on local Qwen 3.8, review with Claude Opus 4.8, ' +
      'fall back to local Qwen 3.8. Cloud is used only for planning and review (Max-plan ' +
      'friendly); execution stays free and local.',
    roles: {
      planner: 'fable-5',
      executor: 'qwen38-27b',
      reviewer: 'opus-4.8',
      fallback: 'qwen38-27b',
    },
    models: ['fable-5', 'qwen38-27b', 'opus-4.8'],
    routingStrategy: 'balanced',
  },
  'fable-haiku-opus': {
    id: 'fable-haiku-opus',
    name: 'Fable plan / Haiku execute / Opus review',
    description:
      'Plan with Claude Fable 5, execute with Claude Haiku 4.5 (fast cloud), review with ' +
      'Claude Opus 4.8, fall back to local Qwen 3.8. All-cloud hot path with a free local ' +
      'safety net.',
    roles: {
      planner: 'fable-5',
      executor: 'haiku-4.5',
      reviewer: 'opus-4.8',
      fallback: 'qwen38-27b',
    },
    models: ['fable-5', 'haiku-4.5', 'opus-4.8', 'qwen38-27b'],
    routingStrategy: 'performance-first',
  },
  'cost-tiered': {
    id: 'cost-tiered',
    name: 'Cost-tiered (local-first, escalate by complexity)',
    description:
      'Minimize cost: trivial/low tasks run FREE on local Qwen 3.8; medium adds a fast ' +
      'cloud model (Haiku) only when needed; high/critical escalate to Opus 4.8. Plan on ' +
      'Fable, review on Opus. Cheapest capable model per complexity.',
    roles: {
      planner: 'fable-5',
      executor: 'qwen38-27b',
      reviewer: 'opus-4.8',
      fallback: 'qwen38-27b',
    },
    tiers: {
      low: 'qwen38-27b',
      medium: 'qwen38-27b',
      high: 'opus-4.8',
      critical: 'opus-4.8',
    },
    models: ['fable-5', 'qwen38-27b', 'haiku-4.5', 'opus-4.8'],
    routingStrategy: 'cost-optimized',
  },
  'speed-tiered': {
    id: 'speed-tiered',
    name: 'Speed-tiered (fast cloud, escalate quality by complexity)',
    description:
      'Maximize speed: low/medium tasks run on Haiku 4.5 (fast cloud); high on Fable 5; ' +
      'critical on Opus 4.8. Plan on Fable, review on Opus, free local fallback. Fastest ' +
      'model that still clears the complexity bar.',
    roles: {
      planner: 'fable-5',
      executor: 'haiku-4.5',
      reviewer: 'opus-4.8',
      fallback: 'qwen38-27b',
    },
    tiers: {
      low: 'haiku-4.5',
      medium: 'haiku-4.5',
      high: 'fable-5',
      critical: 'opus-4.8',
    },
    models: ['fable-5', 'haiku-4.5', 'opus-4.8', 'qwen38-27b'],
    routingStrategy: 'performance-first',
  },
  'sonnet-5-tiered': {
    id: 'sonnet-5-tiered',
    name: 'Sonnet 5 primary (balanced speed/quality, escalate to Opus)',
    description:
      'Use Sonnet 5 as the primary model for most tasks (excellent balance of speed and ' +
      'quality); escalate to Opus 4.8 for critical/high complexity. Plan on Sonnet 5, ' +
      'review on Opus 4.8, free local fallback. Best value for everyday agentic work.',
    roles: {
      planner: 'sonnet-5',
      executor: 'sonnet-5',
      reviewer: 'opus-4.8',
      fallback: 'qwen38-27b',
    },
    tiers: {
      low: 'sonnet-5',
      medium: 'sonnet-5',
      high: 'opus-4.8',
      critical: 'opus-4.8',
    },
    models: ['sonnet-5', 'opus-4.8', 'qwen38-27b'],
    routingStrategy: 'balanced',
  },
  'adaptive-tiered': {
    id: 'adaptive-tiered',
    name: 'Adaptive per-phase (complexity × plan/execute/review escalation)',
    description:
      'Per-phase model chains that escalate on failure. Low-tier work skips ' +
      'plan+review for near-zero overhead; high/critical add planning, a distinct ' +
      'reviewer, a reflect model, and per-phase escalation. Execute local→cloud, ' +
      'fall back to Opus. Requires the per-phase resolvers (resolvePhaseChain).',
    roles: {
      planner: 'sonnet-5',
      executor: 'qwen38-27b',
      reviewer: 'sonnet-5',
      fallback: 'opus-4.8',
    },
    tiers: {
      // trivial folds to low for routing; low omits plan+review → they are
      // skipped (overhead control), execute escalates local→cloud.
      low: { execute: ['qwen38-27b', 'sonnet-5'], fallback: ['sonnet-5'] },
      medium: {
        plan: ['sonnet-5'],
        execute: ['sonnet-5', 'opus-4.8'],
        review: ['sonnet-5'],
        fallback: ['opus-4.8'],
      },
      high: {
        plan: ['sonnet-5', 'opus-4.8'],
        // execute primary is sonnet (not local qwen): hard work should not START
        // on the weakest model, and it keeps the flattened matrix monotonic
        // (medium→sonnet, high→sonnet) rather than inverting to qwen (review C3).
        execute: ['sonnet-5', 'opus-4.8'],
        review: ['sonnet-5', 'opus-4.8'],
        reflect: ['opus-4.8'],
        fallback: ['opus-4.8'],
      },
      critical: {
        plan: ['opus-4.8'],
        execute: ['sonnet-5', 'opus-4.8'],
        review: ['opus-4.8'],
        reflect: ['opus-4.8'],
        fallback: ['opus-4.8'],
      },
    },
    models: ['fable-5', 'qwen38-27b', 'haiku-4.5', 'sonnet-5', 'opus-4.8'],
    routingStrategy: 'adaptive',
  },
};

/**
 * Materialize a preset's complexity tiers into the router's routingMatrix
 * (single-model-per-tier form). Tiers absent from the preset are omitted, so
 * the router falls back to the executor role for them — coherent by default.
 * Exported + pure for testing and for `uap model routing use`.
 */
/** Map a lifecycle phase to the closest lifecycle role (role-model fallback). */
const PHASE_TO_ROLE: Record<Phase, keyof RoutingPreset['roles']> = {
  plan: 'planner',
  execute: 'executor',
  review: 'reviewer',
  reflect: 'reviewer',
  fallback: 'fallback',
};

/** Map a lifecycle role to its phase (for role→phase resolution). */
const ROLE_TO_PHASE: Record<keyof RoutingPreset['roles'], Phase> = {
  planner: 'plan',
  executor: 'execute',
  reviewer: 'review',
  fallback: 'fallback',
};

/**
 * Resolve the ordered model chain for a (complexity, phase) pair. PURE.
 * - string tier  → it IS the execute model: `execute`→[string], other phases →
 *   the role-model (single-element chain), preserving legacy behavior.
 * - PhaseModels  → the phase's chain, or (when the phase is omitted) the
 *   role-model fallback — unless `allowSkip`, which returns [] so callers can
 *   treat the phase as skipped (S4 effort dial).
 * - no tier      → the role-model (single-element chain).
 */
export function resolvePhaseChain(
  preset: RoutingPreset,
  opts: { complexity?: TaskComplexity; phase: Phase; allowSkip?: boolean }
): ModelChain {
  const { complexity, phase, allowSkip } = opts;
  const roleModel = preset.roles[PHASE_TO_ROLE[phase]];
  const tier = complexity ? preset.tiers?.[complexity] : undefined;
  if (tier === undefined) return [roleModel];
  if (typeof tier === 'string') {
    return phase === 'execute' ? [tier] : [roleModel];
  }
  const chain = tier[phase];
  if (chain && chain.length > 0) return [...chain];
  return allowSkip ? [] : [roleModel];
}

/**
 * LEGACY COMPATIBILITY SHIM (Q4). Materialize a preset's complexity tiers into
 * router.ts's single-model routingMatrix. String tiers pass through; PhaseModels
 * tiers contribute their EXECUTE primary (losing the per-phase chain). This is
 * DERIVED from the canonical per-phase source (resolvePhaseChain /
 * selectPhaseModel); new code should select through those, not this flat matrix.
 * Retained so router.ts's existing routingMatrix path keeps working. Pure.
 */
export function tiersToRoutingMatrix(
  preset: RoutingPreset
): Record<string, string> | undefined {
  if (!preset.tiers) return undefined;
  const matrix: Record<string, string> = {};
  for (const [complexity, value] of Object.entries(preset.tiers)) {
    if (!value) continue;
    if (typeof value === 'string') {
      matrix[complexity] = value;
    } else if (value.execute && value.execute.length > 0) {
      matrix[complexity] = value.execute[0];
    }
  }
  return Object.keys(matrix).length > 0 ? matrix : undefined;
}

/**
 * Resolve the single model for a (complexity, role/phase) pair against a
 * preset. Returns the primary of the resolved phase chain. Pure — the source
 * of truth for "which model does this task get". Back-compat: `{complexity,
 * role:'executor'}` on a string tier returns that tier model, exactly as before.
 */
export function resolvePresetModel(
  preset: RoutingPreset,
  opts: { complexity?: TaskComplexity; role?: keyof RoutingPreset['roles']; phase?: Phase }
): string {
  const { complexity, role = 'executor', phase } = opts;
  const resolvedPhase: Phase = phase ?? ROLE_TO_PHASE[role];
  const chain = resolvePhaseChain(preset, { complexity, phase: resolvedPhase });
  return chain[0] ?? preset.roles[role];
}

/**
 * CANONICAL per-phase model selector (Q4). `resolvePhaseChain` is the single
 * source of truth for "which model does this (tier, phase) get"; this returns
 * its primary. New code should route model selection through this (or
 * `resolvePhaseChain` for the full escalation chain), NOT through the flattened
 * `tiersToRoutingMatrix` — that matrix is a LEGACY COMPATIBILITY SHIM for
 * router.ts's single-model routingMatrix and loses the per-phase chain. The flat
 * matrix is derived FROM this canonical source, never the other way round.
 */
export function selectPhaseModel(
  preset: RoutingPreset,
  opts: { complexity?: TaskComplexity; phase: Phase }
): string {
  return resolvePhaseChain(preset, opts)[0] ?? preset.roles.executor;
}

/**
 * Compute the `ANTHROPIC_PASSTHROUGH_MODELS` proxy env value for a routing
 * preset. When the preset uses any CLOUD (Claude) model, returns an empty
 * string — the proxy then falls back to its default passthrough patterns,
 * which prefix-match every claude- api id (robust to date-suffixed names) and
 * forward planner/reviewer turns to the real Anthropic API while local ids
 * (e.g. qwen) stay on llama-server. When the preset is all-local, returns the
 * "__local_only__" sentinel so the proxy serves everything locally. This lets a
 * picked routing option work first-time without hand-editing the proxy env.
 */
export function passthroughModelsForPreset(preset: RoutingPreset): string {
  const usesCloud = preset.models.some((id) =>
    (ModelPresets[id]?.apiModel ?? '').toLowerCase().startsWith('claude-')
  );
  return usesCloud ? '' : '__local_only__';
}

export type RoutingPresetId = keyof typeof RoutingPresets;

/**
 * Role assignment configuration - maps roles to models
 */
export const RoleAssignmentSchema = z.object({
  role: z.enum(['planner', 'executor', 'reviewer', 'fallback']),
  modelId: z.string(),
  // Optional constraints for this role
  maxTokensPerRequest: z.number().optional(),
  timeout: z.number().default(300000), // 5 min default
});

export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

/**
 * Routing rule for task-to-model mapping
 */
export const RoutingRuleSchema = z.object({
  // Condition matching
  complexity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  keywords: z.array(z.string()).optional(),
  taskType: z
    .enum(['planning', 'coding', 'refactoring', 'bug-fix', 'review', 'documentation'])
    .optional(),
  // Target model
  targetRole: z.enum(['planner', 'executor', 'reviewer', 'fallback']),
  // Priority (higher = evaluated first)
  priority: z.number().default(0),
});

export type RoutingRule = z.infer<typeof RoutingRuleSchema>;

/**
 * Multi-Model Architecture configuration schema for .uap.json
 */
export const MultiModelConfigSchema = z.object({
  enabled: z.boolean().default(false),

  // Model definitions (can use presets or custom)
  models: z
    .array(
      z.union([
        z.string(), // Preset ID like 'opus-4.6'
        ModelConfigSchemaModels, // Full custom config
      ])
    )
    .default(['opus-4.6', 'qwen35-a3b']),

  // Role assignments
  roles: z
    .object({
      planner: z.string().default('opus-4.6'),
      executor: z.string().default('qwen35-a3b'),
      reviewer: z.string().optional(),
      fallback: z.string().default('qwen35-a3b'),
    })
    .optional(),

  // Routing rules (optional - uses defaults if not specified)
  routing: z.array(RoutingRuleSchema).optional(),

  // Cost optimization settings
  costOptimization: z
    .object({
      enabled: z.boolean().default(true),
      // Target cost reduction percentage
      targetReduction: z.number().default(90),
      // Max performance degradation allowed
      maxPerformanceDegradation: z.number().default(20),
      // Auto-fallback threshold (failures before escalating)
      fallbackThreshold: z.number().default(3),
    })
    .optional(),

  // Custom routing matrix (per-complexity model). NOTE: this is a FALLBACK —
  // when `routingPreset` is set and resolvable, the router selects from the
  // canonical per-phase source (resolvePhaseChain) and this matrix is ignored
  // for selection (it is retained for legacy configs and display).
  routingMatrix: z
    .record(
      z.enum(['low', 'medium', 'high', 'critical']),
      z.union([
        z.string(), // new: one model id for this complexity tier
        z.object({ planner: z.string(), executor: z.string() }), // legacy form
      ])
    )
    .optional(),

  // Routing behavior
  routingStrategy: z
    .enum([
      'cost-optimized', // Minimize cost, use cheapest capable model
      'performance-first', // Maximize quality, use best model
      'balanced', // Balance cost and performance
      'adaptive', // Learn from task results
    ])
    .default('balanced'),
  // Q4: the source RoutingPreset id. When set and resolvable, the router selects
  // models from the CANONICAL per-phase source (resolvePhaseChain) rather than
  // the flattened routingMatrix — which is demoted to a fallback for configs that
  // predate this field. Persisted by `uap model routing use`.
  routingPreset: z.string().optional(),

  // Planner-specific settings
  plannerSettings: z
    .object({
      // When to invoke planner vs direct execution
      complexityThreshold: z.enum(['low', 'medium', 'high']).default('medium'),
      // Max tokens for planning phase
      maxPlanningTokens: z.number().default(10000),
      // Decompose tasks into subtasks
      enableDecomposition: z.boolean().default(true),
    })
    .optional(),

  // Executor settings
  executorSettings: z
    .object({
      // Retry failed executions with fallback model
      retryWithFallback: z.boolean().default(true),
      // Max retries before escalating
      maxRetries: z.number().default(2),
      // Timeout per execution step
      stepTimeout: z.number().default(120000), // 2 min
    })
    .optional(),
});

export type MultiModelConfig = z.infer<typeof MultiModelConfigSchema>;

/**
 * Task classification result from the router
 */
export interface TaskClassificationResult {
  complexity: TaskComplexity;
  taskType: 'planning' | 'coding' | 'refactoring' | 'bug-fix' | 'review' | 'documentation';
  keywords: string[];
  estimatedTokens: number;
  requiresPlanning: boolean;
  suggestedModel: string;
  fallbackModel: string;
  reasoning: string;
}

/**
 * Execution plan from the planner
 */
export interface ExecutionPlan {
  id: string;
  originalTask: string;
  subtasks: Subtask[];
  dependencies: Map<string, string[]>; // subtaskId -> dependsOn[]
  modelAssignments: Map<string, string>; // subtaskId -> modelId
  estimatedCost: number;
  estimatedDuration: number;
  created: Date;
}

export interface Subtask {
  id: string;
  title: string;
  description: string;
  type: 'planning' | 'coding' | 'refactoring' | 'bug-fix' | 'review' | 'documentation';
  complexity: TaskComplexity;
  inputs: string[];
  outputs: string[];
  constraints: string[];
  /** Suggested expert droids for this subtask, in execution order. Optional. */
  suggestedDroids?: string[];
}

/**
 * Execution result for tracking
 */
export interface ExecutionResult {
  planId: string;
  subtaskId: string;
  modelUsed: string;
  success: boolean;
  output: string;
  error?: string;
  tokensUsed: {
    input: number;
    output: number;
  };
  cost: number;
  duration: number;
  retryCount: number;
}

/**
 * Model selection result from the router
 */
export interface ModelSelection {
  model: ModelConfig;
  fallback?: ModelConfig;
  role: ModelRole;
  reasoning: string;
  estimatedCost: number;
}

// Default routing rules
export const DEFAULT_ROUTING_RULES: RoutingRule[] = [
  // Critical tasks always use planner + fallback
  { complexity: 'critical', targetRole: 'planner', priority: 100 },
  {
    keywords: ['security', 'authentication', 'deployment', 'migration'],
    targetRole: 'planner',
    priority: 90,
  },

  // High complexity uses planner
  { complexity: 'high', targetRole: 'planner', priority: 80 },
  { keywords: ['architecture', 'design', 'refactor'], targetRole: 'planner', priority: 70 },
  { taskType: 'planning', targetRole: 'planner', priority: 70 },

  // Medium complexity can go to executor directly
  { complexity: 'medium', targetRole: 'executor', priority: 50 },
  { taskType: 'coding', targetRole: 'executor', priority: 50 },
  { taskType: 'bug-fix', targetRole: 'executor', priority: 50 },

  // Low complexity always executor
  { complexity: 'low', targetRole: 'executor', priority: 30 },
  { taskType: 'documentation', targetRole: 'executor', priority: 30 },

  // Review tasks use reviewer or planner
  { taskType: 'review', targetRole: 'reviewer', priority: 60 },
];
