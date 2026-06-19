/**
 * Wizard configuration model + `.uap.json` patcher.
 *
 * The selection schema and the config-persistence logic the guided setup wizard
 * uses to write rich settings (memory tiers, coordination, patterns, policy
 * toggles, model provider/profile, hooks, browser) into `.uap.json`. Ported
 * out of the legacy inquirer wizard's `executeSetup` so the guided flow is the
 * single source of truth and the config write is independently testable.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

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

    // ── Hooks ───────────────────────────────────────────────────────────
    config.hooks = {
      sessionStart: selections.hooks.sessionStart,
      preCompact: selections.hooks.preCompact,
      taskCompletion: selections.hooks.taskCompletion,
      autoApproveTools: selections.hooks.autoApproveTools,
    };

    // ── Browser ─────────────────────────────────────────────────────────
    if (selections.browser.cloakBrowser) config.browser = { cloakBrowser: true };

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
