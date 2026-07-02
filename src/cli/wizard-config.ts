/**
 * Wizard configuration model + `.uap.json` patcher.
 *
 * The selection schema and the config-persistence logic the guided setup wizard
 * uses to write rich settings (memory tiers, coordination, patterns, policy
 * toggles, model provider/profile, hooks, browser) into `.uap.json`. Ported
 * out of the legacy inquirer wizard's `executeSetup` so the guided flow is the
 * single source of truth and the config write is independently testable.
 */

import { writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { RoutingPresets } from '../models/index.js';

export interface MemoryFeatures {
  shortTermMemory: boolean;
  longTermMemory: boolean;
  knowledgeGraph: boolean;
  prepopDocs: boolean;
  prepopGit: boolean;
}

export interface MultiAgentFeatures {
  coordinationDb: boolean;
  worktreeIsolation: boolean;
  deployBatching: boolean;
  agentMessaging: boolean;
}

export interface PatternFeatures {
  patternLibrary: boolean;
  patternRag: boolean;
  reinforcementLearning: boolean;
}

export interface PolicyFeatures {
  policyEngine: boolean;
  imageAssetVerification: boolean;
  iacStateParity: boolean;
  iacPipelineEnforcement: boolean;
  kubectlVerifyBackport: boolean;
  definitionOfDoneIac: boolean;
  customPoliciesDir: boolean;
}

export interface ModelFeatures {
  provider: 'openai' | 'anthropic' | 'local' | 'custom';
  qwenOptimizations: boolean;
  toolCallProfile: string;
  costTracking: boolean;
  modelRouting: boolean;
  /** Named RoutingPresets id (e.g. fable-local-opus); 'none'/undefined = single model. */
  routingPreset?: string;
}

export interface HooksFeatures {
  sessionStart: boolean;
  preCompact: boolean;
  taskCompletion: boolean;
  autoApproveTools: boolean;
}

export interface BrowserFeatures {
  cloakBrowser: boolean;
}

export interface RecipeFeatures {
  enabled: boolean;
  recipe: 'auto' | 'single' | 'confidence' | 'fusion' | 'ratings' | 'remom';
  confidenceThreshold: number;
  fusionN: number;
  allowSelfJudge: boolean;
  judgeModel?: string;
  judgeEndpoint?: string;
  /** Written to .uap/proxy.env ONLY (secret) — never persisted to .uap.json. */
  judgeApiKey?: string;
}

export interface DeliveryFeatures {
  enforcement: 'block' | 'advisory' | 'off';
  localMode: 'advisory' | 'deliver' | 'block';
  runtimeVerify: boolean;
}

export interface ConcurrencyFeatures {
  enabled: boolean; // adaptive AIMD backpressure
  slots?: number;
  endpoint?: string;
}

export interface CollaborationFeatures {
  mode: 'auto' | 'always' | 'off';
}

export interface DesignFeatures {
  enabled: boolean;
  tokenGate: boolean;
}

export interface ReactorFeatures {
  enabled: boolean;
}

export interface WizardSelections {
  /** init platform tokens (claude, factory, vscode, opencode, codex, …) */
  platforms: string[];
  memory: MemoryFeatures;
  multiAgent: MultiAgentFeatures;
  patterns: PatternFeatures;
  policy: PolicyFeatures;
  model: ModelFeatures;
  hooks: HooksFeatures;
  browser: BrowserFeatures;
  recipes: RecipeFeatures;
  delivery: DeliveryFeatures;
  concurrency: ConcurrencyFeatures;
  collaboration: CollaborationFeatures;
  design: DesignFeatures;
  reactor: ReactorFeatures;
}

/** Conservative defaults used by the non-interactive path and as prompt seeds. */
export function defaultSelections(overrides: Partial<WizardSelections> = {}): WizardSelections {
  return {
    platforms: ['claude'],
    memory: { shortTermMemory: true, longTermMemory: false, knowledgeGraph: false, prepopDocs: false, prepopGit: false },
    multiAgent: { coordinationDb: true, worktreeIsolation: true, deployBatching: false, agentMessaging: false },
    patterns: { patternLibrary: true, patternRag: false, reinforcementLearning: false },
    policy: {
      policyEngine: true,
      imageAssetVerification: false,
      iacStateParity: true,
      iacPipelineEnforcement: true,
      kubectlVerifyBackport: true,
      definitionOfDoneIac: true,
      customPoliciesDir: false,
    },
    model: { provider: 'anthropic', qwenOptimizations: false, toolCallProfile: 'claude-sonnet-4.6', costTracking: false, modelRouting: false },
    hooks: { sessionStart: true, preCompact: true, taskCompletion: false, autoApproveTools: false },
    browser: { cloakBrowser: false },
    recipes: {
      enabled: false,
      recipe: 'auto',
      confidenceThreshold: 0.5,
      fusionN: 3,
      allowSelfJudge: false,
    },
    delivery: { enforcement: 'block', localMode: 'advisory', runtimeVerify: false },
    concurrency: { enabled: true },
    collaboration: { mode: 'auto' },
    design: { enabled: false, tokenGate: false },
    reactor: { enabled: true },
    ...overrides,
  };
}

/**
 * Patch `.uap.json` with the wizard's rich settings (merging onto existing
 * config). Pure file write — no prompts, no subprocesses. Returns the path
 * written, or null on failure (fail-soft).
 */
export async function applyWizardConfig(
  cwd: string,
  selections: WizardSelections
): Promise<string | null> {
  try {
    const { loadUapConfigRaw, findUapConfigPath } = await import('../utils/config-loader.js');
    const configPath = findUapConfigPath(cwd) || join(cwd, '.uap.json');
    const config: Record<string, unknown> = loadUapConfigRaw(cwd) ?? {};

    // ── Memory ──────────────────────────────────────────────────────────
    const memory = (config.memory || {}) as Record<string, unknown>;
    if (selections.memory.longTermMemory) {
      memory.longTerm = {
        enabled: true,
        provider: 'qdrant',
        endpoint: 'localhost:6333',
        collection: 'agent_memory',
        embeddingModel: 'all-MiniLM-L6-v2',
        ...((memory.longTerm as Record<string, unknown>) || {}),
      };
    } else {
      const lt = (memory.longTerm || {}) as Record<string, unknown>;
      lt.enabled = false;
      memory.longTerm = lt;
    }
    if (selections.memory.knowledgeGraph) memory.knowledgeGraph = { enabled: true };
    if (selections.memory.prepopDocs) {
      memory.prepopulation = { ...((memory.prepopulation as Record<string, unknown>) || {}), docs: true };
    }
    if (selections.memory.prepopGit) {
      memory.prepopulation = { ...((memory.prepopulation as Record<string, unknown>) || {}), gitHistory: true };
    }
    config.memory = memory;

    // ── Multi-agent ─────────────────────────────────────────────────────
    config.coordination = {
      database: selections.multiAgent.coordinationDb,
      deployBatching: selections.multiAgent.deployBatching,
      agentMessaging: selections.multiAgent.agentMessaging,
    };
    if (selections.multiAgent.worktreeIsolation) {
      config.worktrees = {
        enabled: true,
        directory: '.worktrees',
        branchPrefix: 'feature/',
        autoCleanup: true,
        ...((config.worktrees as Record<string, unknown>) || {}),
      };
    }

    // ── Patterns ────────────────────────────────────────────────────────
    if (selections.patterns.patternRag) {
      const memObj = config.memory as Record<string, unknown>;
      memObj.patternRag = {
        enabled: true,
        collection: 'agent_patterns',
        embeddingModel: 'all-MiniLM-L6-v2',
        vectorSize: 384,
        scoreThreshold: 0.35,
        topK: 2,
        ...((memObj.patternRag as Record<string, unknown>) || {}),
      };
    }
    if (selections.patterns.reinforcementLearning) config.patternRL = { enabled: true };

    // ── Policy ──────────────────────────────────────────────────────────
    config.policy = {
      enabled: selections.policy.policyEngine,
      imageAssetVerification: selections.policy.imageAssetVerification,
      iacStateParity: selections.policy.iacStateParity,
      iacPipelineEnforcement: selections.policy.iacPipelineEnforcement,
      kubectlVerifyBackport: selections.policy.kubectlVerifyBackport,
      definitionOfDoneIac: selections.policy.definitionOfDoneIac,
      customDir: selections.policy.customPoliciesDir ? './policies' : undefined,
    };

    // ── Model ───────────────────────────────────────────────────────────
    config.model = {
      provider: selections.model.provider,
      costTracking: selections.model.costTracking,
      routing: selections.model.modelRouting,
      ...(selections.model.provider === 'local'
        ? { qwenOptimizations: selections.model.qwenOptimizations }
        : {}),
    };
    if (selections.model.toolCallProfile) {
      const toolCalls = (config.toolCalls as Record<string, unknown>) || {};
      toolCalls.modelProfile = selections.model.toolCallProfile;
      config.toolCalls = toolCalls;
    }

    // ── Multi-model routing option (from a named RoutingPreset) ─────────
    if (selections.model.routingPreset && selections.model.routingPreset !== 'none') {
      const preset = RoutingPresets[selections.model.routingPreset];
      if (preset) {
        config.multiModel = {
          enabled: true,
          models: preset.models,
          roles: { ...preset.roles },
          routingStrategy: preset.routingStrategy || 'balanced',
        };
      }
    }

    // ── Hooks ───────────────────────────────────────────────────────────
    config.hooks = {
      sessionStart: selections.hooks.sessionStart,
      preCompact: selections.hooks.preCompact,
      taskCompletion: selections.hooks.taskCompletion,
      autoApproveTools: selections.hooks.autoApproveTools,
    };

    // ── Browser ─────────────────────────────────────────────────────────
    if (selections.browser.cloakBrowser) config.browser = { cloakBrowser: true };

    // ── Serving-layer recipes + escalation judge ────────────────────────
    // (secret apiKey is NOT written here — see writeProxyEnv)
    config.recipes = {
      enabled: selections.recipes.enabled,
      recipe: selections.recipes.recipe,
      confidenceThreshold: selections.recipes.confidenceThreshold,
      fusionN: selections.recipes.fusionN,
      allowSelfJudge: selections.recipes.allowSelfJudge,
      ...(selections.recipes.judgeModel || selections.recipes.judgeEndpoint
        ? {
            judge: {
              ...(selections.recipes.judgeModel ? { model: selections.recipes.judgeModel } : {}),
              ...(selections.recipes.judgeEndpoint ? { endpoint: selections.recipes.judgeEndpoint } : {}),
            },
          }
        : {}),
    };

    // ── Delivery + runtime gates ────────────────────────────────────────
    config.delivery = {
      enforcement: selections.delivery.enforcement,
      localMode: selections.delivery.localMode,
      runtimeVerify: selections.delivery.runtimeVerify,
    };

    // ── Model-slot concurrency (real consumer: model-slot-lease/model-slots)
    config.modelConcurrency = {
      ...((config.modelConcurrency as Record<string, unknown>) || {}),
      adaptive: selections.concurrency.enabled,
      ...(selections.concurrency.slots ? { slots: selections.concurrency.slots } : {}),
      ...(selections.concurrency.endpoint ? { endpoint: selections.concurrency.endpoint } : {}),
    };

    // ── Agent collaboration mode (real consumer: collaboration-inject) ───
    config.collaboration = { mode: selections.collaboration.mode };

    // ── DESIGN.md integration ───────────────────────────────────────────
    config.design = { enabled: selections.design.enabled, tokenGate: selections.design.tokenGate };

    // ── Reactor per-prompt injection ────────────────────────────────────
    config.reactor = { enabled: selections.reactor.enabled };

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
  } catch {
    return null;
  }
}

/** Model profile choices per provider (label + value + hint). */
export function profileChoicesFor(
  provider: ModelFeatures['provider']
): { label: string; value: string; hint: string }[] {
  switch (provider) {
    case 'anthropic':
      return [
        { label: 'claude-sonnet-4.6', value: 'claude-sonnet-4.6', hint: 'recommended — best speed/cost/quality' },
        { label: 'claude-opus-4.6', value: 'claude-opus-4.6', hint: 'most capable, deep reasoning' },
        { label: 'claude-haiku-3.5', value: 'claude-haiku-3.5', hint: 'fastest/cheapest' },
      ];
    case 'openai':
      return [
        { label: 'gpt-5.4', value: 'gpt-5.4', hint: 'recommended general-purpose' },
        { label: 'gpt-5.3-codex', value: 'gpt-5.3-codex', hint: 'code-specialized' },
      ];
    case 'local':
      return [
        { label: 'generic', value: 'generic', hint: 'any OpenAI-compatible server' },
        { label: 'qwen35-a3b', value: 'qwen35-a3b', hint: 'recommended for local — Qwen optimizations' },
      ];
    default:
      return [{ label: 'generic', value: 'generic', hint: 'any OpenAI-compatible endpoint' }];
  }
}

/**
 * Emit `.uap/proxy.env` — the KEY=VALUE file the proxy launcher / systemd
 * EnvironmentFile and the Python proxy's own fallback loader consume. This is
 * where the recipe/escalation and delivery env vars (including the secret judge
 * API key) live, so the guided-setup selections actually reach the running
 * proxy without the user hand-exporting env. Returns the path written, or null.
 */
export function writeProxyEnv(cwd: string, selections: WizardSelections): string | null {
  try {
    const r = selections.recipes;
    const d = selections.delivery;
    const lines: string[] = [
      '# Generated by `uap setup` — proxy runtime env (recipes, escalation, delivery).',
      '# Sourced by the proxy launcher / systemd EnvironmentFile and by the Python',
      '# proxy fallback loader. Existing process env always takes precedence.',
    ];
    // Recipes / escalation
    lines.push(`PROXY_CONFIDENCE_ESCALATE=${r.enabled ? 'on' : 'off'}`);
    lines.push(`PROXY_RECIPE=${r.recipe}`);
    lines.push(`PROXY_CONFIDENCE_THRESHOLD=${r.confidenceThreshold}`);
    lines.push(`PROXY_FUSION_N=${r.fusionN}`);
    if (r.allowSelfJudge) lines.push('PROXY_ALLOW_SELF_JUDGE=1');
    if (r.judgeModel) lines.push(`PROXY_ESCALATE_MODEL=${r.judgeModel}`);
    if (r.judgeEndpoint) lines.push(`PROXY_ESCALATE_ENDPOINT=${r.judgeEndpoint}`);
    if (r.judgeApiKey) lines.push(`PROXY_ESCALATE_API_KEY=${r.judgeApiKey}`);
    // Delivery
    if (d.enforcement !== 'block') lines.push(`UAP_ENFORCE_DELIVERY=${d.enforcement}`);
    else lines.push('UAP_ENFORCE_DELIVERY=block');
    lines.push(`UAP_DELIVER_LOCAL_MODE=${d.localMode}`);

    const dir = join(cwd, '.uap');
    mkdirSync(dir, { recursive: true });
    const envPath = join(dir, 'proxy.env');
    writeFileSync(envPath, lines.join('\n') + '\n');
    // Contains a secret (judge API key) — restrict permissions best-effort.
    try {
      chmodSync(envPath, 0o600);
    } catch {
      /* non-POSIX / best-effort */
    }
    return envPath;
  } catch {
    return null;
  }
}
