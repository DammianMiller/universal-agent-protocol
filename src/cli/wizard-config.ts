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
import { RoutingPresets, passthroughModelsForPreset, tiersToRoutingMatrix } from '../models/index.js';
import { upsertProxyEnvVars } from './systemd-services.js';
import { configuredSlots } from '../utils/model-slots.js';

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
  /** The pay2u example policy pack (advisory architecture/reference policies).
   * Opt-in — off by default so ordinary projects don't get pay2u-specific rules. */
  pay2uPolicies: boolean;
  /** Explicit per-policy selection (names) to enforce, applied after init via
   * applyPolicySelection. undefined = leave the default mandatory set as-is.
   * 'all' | 'recommended' are resolved to concrete names at apply time. */
  selectedPolicies?: string[] | 'all' | 'recommended';
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
  enforcement: 'block' | 'advisory' | 'off' | 'escalate';
  localMode: 'advisory' | 'deliver' | 'block' | 'escalate';
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

export interface FidelityFeatures {
  /** `max` raises every verification gate + turns on always-on visual/vision review. */
  mode: 'standard' | 'max';
  /** Vision endpoint for aesthetic review (defaults to the inference endpoint under max). */
  visionEndpoint?: string;
  /** Vision model id (defaults to 'local' for a single-model llama endpoint). */
  visionModel?: string;
}

export interface ProxyFeatures {
  /** Hook-driven, reference-counted proxy autostart (start with the session,
   *  adopt an existing one, stop only when the last client leaves). */
  autostart: boolean;
  /** Ride-along operational dashboard: `uap proxy ensure` also starts (or
   *  adopts) `uap dashboard serve`, so monitoring needs no second command.
   *  Undefined = leave whatever `.uap.json` already says (default ON). */
  dashboard?: boolean;
}

export interface HandsfreeFeatures {
  /** Force any model to keep working until a multi-epic build ledger is 100% done. */
  enabled: boolean;
  /** Forcing intensity: 'light' (Fable) | 'moderate' (frontier) | 'aggressive' (local). */
  intensity?: 'light' | 'moderate' | 'aggressive';
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
  proxy: ProxyFeatures;
  handsfree: HandsfreeFeatures;
  fidelity: FidelityFeatures;
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
      pay2uPolicies: false,
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
    delivery: { enforcement: 'escalate', localMode: 'escalate', runtimeVerify: false },
    concurrency: { enabled: true },
    collaboration: { mode: 'auto' },
    design: { enabled: false, tokenGate: false },
    reactor: { enabled: true },
    proxy: { autostart: false },
    handsfree: { enabled: false },
    fidelity: { mode: 'standard' },
    ...overrides,
  };
}

/** Environment context for preset selection (detected before the profile choice). */
export interface PresetContext {
  platforms: string[];
  localModel?: string | null;
  hasDocker?: boolean;
}

/**
 * "Maximum" profile — every feature enabled at its most capable setting for peak
 * performance and the fullest feature set. Qdrant-dependent tiers (long-term
 * memory, pattern RAG/RL) are gated on Docker being present so they can actually
 * run; routing uses the local-first preset when a local model is detected.
 */
export function maxSelections(ctx: PresetContext): WizardSelections {
  const local = Boolean(ctx.localModel);
  const docker = Boolean(ctx.hasDocker);
  return defaultSelections({
    platforms: ctx.platforms,
    memory: { shortTermMemory: true, longTermMemory: docker, knowledgeGraph: docker, prepopDocs: true, prepopGit: true },
    multiAgent: { coordinationDb: true, worktreeIsolation: true, deployBatching: true, agentMessaging: true },
    patterns: { patternLibrary: true, patternRag: docker, reinforcementLearning: docker },
    policy: { policyEngine: true, imageAssetVerification: true, iacStateParity: true, iacPipelineEnforcement: true, kubectlVerifyBackport: true, definitionOfDoneIac: true, customPoliciesDir: true, pay2uPolicies: false, selectedPolicies: 'all' },
    model: { provider: local ? 'local' : 'anthropic', qwenOptimizations: local, toolCallProfile: '', costTracking: true, modelRouting: true, routingPreset: local ? 'fable-local-opus' : 'none' },
    hooks: { sessionStart: true, preCompact: true, taskCompletion: true, autoApproveTools: true },
    browser: { cloakBrowser: true },
    // fusion + self-judge so recipes give lift without requiring an external judge key.
    recipes: { enabled: true, recipe: 'fusion', confidenceThreshold: 0.5, fusionN: 3, allowSelfJudge: true },
    // escalate, not block: direct edits land and deliver is the escalation point
    // (after repeated red gates / churn / whole-module writes). A profile that
    // re-applied block/deliver silently reverted projects that had chosen
    // escalate every time setup ran (observed 2026-08-21).
    delivery: { enforcement: 'escalate', localMode: 'escalate', runtimeVerify: true },
    concurrency: { enabled: true, ...(ctx.localModel ? { endpoint: ctx.localModel } : {}) },
    collaboration: { mode: 'always' },
    design: { enabled: true, tokenGate: true },
    reactor: { enabled: true },
    proxy: { autostart: true, dashboard: true },
    handsfree: { enabled: true, intensity: local ? 'aggressive' : 'moderate' },
    // Max fidelity: strongest gates + always-on visual/vision verification. Vision
    // review uses the local inference endpoint (resolveFidelity falls back to it).
    fidelity: { mode: 'max' },
  });
}

/** "Minimal" profile — core essentials only (lean, low-friction). */
export function minSelections(ctx: PresetContext): WizardSelections {
  return defaultSelections({
    platforms: ctx.platforms,
    memory: { shortTermMemory: true, longTermMemory: false, knowledgeGraph: false, prepopDocs: false, prepopGit: false },
    multiAgent: { coordinationDb: true, worktreeIsolation: true, deployBatching: false, agentMessaging: false },
    patterns: { patternLibrary: true, patternRag: false, reinforcementLearning: false },
    policy: { policyEngine: false, imageAssetVerification: false, iacStateParity: false, iacPipelineEnforcement: false, kubectlVerifyBackport: false, definitionOfDoneIac: false, customPoliciesDir: false, pay2uPolicies: false },
    model: { provider: ctx.localModel ? 'local' : 'anthropic', qwenOptimizations: false, toolCallProfile: '', costTracking: false, modelRouting: false, routingPreset: 'none' },
    hooks: { sessionStart: true, preCompact: false, taskCompletion: false, autoApproveTools: false },
    browser: { cloakBrowser: false },
    recipes: { enabled: false, recipe: 'auto', confidenceThreshold: 0.5, fusionN: 3, allowSelfJudge: false },
    delivery: { enforcement: 'advisory', localMode: 'advisory', runtimeVerify: false },
    concurrency: { enabled: false },
    collaboration: { mode: 'off' },
    design: { enabled: false, tokenGate: false },
    reactor: { enabled: false },
    // Lean by design: no ride-along dashboard until asked for it
    // (`uap proxy dashboard on` / `uap dash serve`).
    proxy: { autostart: false, dashboard: false },
    handsfree: { enabled: false },
  });
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
        // Mirror `uap model routing use <id>` exactly: materialize the preset's
        // complexity tiers into a routingMatrix so tiered presets (cost/speed/
        // sonnet-5) route per-complexity from setup, not only by lifecycle role.
        const routingMatrix = tiersToRoutingMatrix(preset);
        config.multiModel = {
          enabled: true,
          models: preset.models,
          roles: { ...preset.roles },
          routingStrategy: preset.routingStrategy || 'balanced',
          ...(routingMatrix ? { routingMatrix } : {}),
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

    // ── Maximum-fidelity mode (raised gates + always-on visual/vision) ──
    config.fidelity = {
      ...(config.fidelity as object ?? {}),
      mode: selections.fidelity.mode,
      ...(selections.fidelity.visionEndpoint ? { visionEndpoint: selections.fidelity.visionEndpoint } : {}),
      ...(selections.fidelity.visionModel ? { visionModel: selections.fidelity.visionModel } : {}),
    };

    config.proxy = {
      ...(config.proxy as object ?? {}),
      autostart: selections.proxy.autostart,
      // Written whenever the caller expressed a choice. Persisting only `false`
      // would make the setting one-way: a project already carrying
      // `dashboard: false` could never be switched back on by re-running setup.
      ...(selections.proxy.dashboard === undefined
        ? {}
        : { dashboard: selections.proxy.dashboard }),
    };

    if (selections.handsfree.enabled) {
      config.handsfree = {
        ...(config.handsfree as object ?? {}),
        enabled: true,
        ...(selections.handsfree.intensity ? { intensity: selections.handsfree.intensity } : {}),
      };
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
  } catch {
    return null;
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
    // Backend WIDTH, so the proxy can right-size fan-out recipes to hardware it
    // cannot probe for itself (ninfer serves no /slots endpoint). A one-slot
    // backend serializes fusion's N generations, turning an N-way sample into
    // an N-times-slower single answer; the proxy downgrades to `single` when it
    // sees this, unless PROXY_FORCE_MULTI_CALL=1. Written only when the operator
    // configured a width — an absent value means UNKNOWN, which changes nothing.
    // Sourced from the wizard when it offers a width, else from the config the
    // TS side already reads (`.uap.json` modelConcurrency.slots / the env), so
    // an operator who has ALREADY declared their width gets it propagated
    // without re-answering a prompt. Without this fallback the line had no
    // producer at all — no wizard path sets `concurrency.slots` — and the whole
    // downgrade sat dormant behind a hand-exported variable.
    const slots = selections.concurrency.slots ?? configuredSlots(cwd);
    const slotsLine =
      typeof slots === 'number' && Number.isFinite(slots)
        ? String(Math.max(1, Math.floor(slots)))
        : undefined;
    if (slotsLine !== undefined) lines.push(`UAP_MODEL_SLOTS=${slotsLine}`);
    if (r.allowSelfJudge) lines.push('PROXY_ALLOW_SELF_JUDGE=1');
    if (r.judgeModel) lines.push(`PROXY_ESCALATE_MODEL=${r.judgeModel}`);
    if (r.judgeEndpoint) lines.push(`PROXY_ESCALATE_ENDPOINT=${r.judgeEndpoint}`);
    if (r.judgeApiKey) lines.push(`PROXY_ESCALATE_API_KEY=${r.judgeApiKey}`);
    // Delivery
    if (d.enforcement !== 'block') lines.push(`UAP_ENFORCE_DELIVERY=${d.enforcement}`);
    else lines.push('UAP_ENFORCE_DELIVERY=block');
    lines.push(`UAP_DELIVER_LOCAL_MODE=${d.localMode}`);

    // Fidelity + vision (aesthetic screenshot review). Under max, wire the vision
    // endpoint/model so the blocking review runs against the local model with no
    // extra export. Explicit selections win; otherwise the resolver falls back to
    // the inference endpoint at runtime.
    const fid = selections.fidelity;
    lines.push(`UAP_FIDELITY=${fid.mode}`);
    if (fid.visionEndpoint) lines.push(`UAP_VISION_ENDPOINT=${fid.visionEndpoint}`);
    if (fid.visionModel) lines.push(`UAP_VISION_MODEL=${fid.visionModel}`);

    // Anthropic passthrough — keep the proxy in sync with the routing choice so
    // a picked preset works first-time: cloud tiers (planner/reviewer) reach the
    // real Anthropic API while local ids stay on llama; an all-local preset
    // ("__local_only__") forces everything local. Empty (default) = passthrough
    // all claude- models via the proxy's built-in patterns.
    const routingId = selections.model.routingPreset;
    const routingPreset =
      routingId && routingId !== 'none' ? RoutingPresets[routingId] : undefined;
    const passthrough = routingPreset ? passthroughModelsForPreset(routingPreset) : '';
    lines.push(`ANTHROPIC_PASSTHROUGH_MODELS=${passthrough}`);

    const dir = join(cwd, '.uap');
    mkdirSync(dir, { recursive: true });
    const envPath = join(dir, 'proxy.env');
    writeFileSync(envPath, lines.join('\n') + '\n');
    // Mirror the passthrough into the systemd EnvironmentFile the running
    // service actually reads (this .uap/proxy.env is only the fallback loader).
    try {
      // UAP_MODEL_SLOTS rides along: `.uap/proxy.env` is only the fallback
      // loader (see the comment above), so a systemd-managed proxy would never
      // see the width and the fan-out downgrade would never engage for it.
      upsertProxyEnvVars({
        ANTHROPIC_PASSTHROUGH_MODELS: passthrough,
        ...(slotsLine !== undefined ? { UAP_MODEL_SLOTS: slotsLine } : {}),
      });
    } catch {
      /* proxy env sync is best-effort — .uap/proxy.env still written */
    }
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
