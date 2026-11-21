/**
 * Asymmetric Multi-Role Model Router (Option C3)
 *
 * Resolves which model + endpoint runs each cognitive role (Phase 0 Blueprint,
 * Fresh-Context Adversarial Critic, Vision Reviewer) with a strict fallback
 * chain so single-arm local setups work out-of-the-box with zero extra config,
 * while multi-arm operators can assign specialized models per role.
 *
 * Precedence:
 *   1. Explicit role env override (UAP_<ROLE>_MODEL / UAP_<ROLE>_ENDPOINT)
 *   2. Explicit `.uap.json` `multiModel.<role>Model` (+ `<role>Endpoint`)
 *   3. Existing `deliver.escalateModel` / `UAP_ESCALATE_MODEL` (for blueprint & critic)
 *   4. Active local model in fresh-context thinking-ON mode (C1)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ModelPresets, type ModelConfig } from '../models/types.js';
import type { OpenAICompatClient } from '../models/openai-compat-client.js';

export type CognitiveRole = 'blueprint' | 'critic' | 'vision';

export type RoleResolutionSource =
  | 'env'
  | 'config-multi-model'
  | 'escalate-model'
  | 'fleet-telemetry'
  | 'local-fresh-context';

export interface RoleRoutingConfig {
  multiModel?: {
    blueprintModel?: string;
    blueprintEndpoint?: string;
    criticModel?: string;
    criticEndpoint?: string;
    visionModel?: string;
    visionEndpoint?: string;
  };
  deliver?: {
    escalateModel?: string;
  };
}

export interface ResolvedRoleTarget {
  role: CognitiveRole;
  modelId: string;
  endpoint?: string;
  source: RoleResolutionSource;
  thinking: boolean;
  freshContext: boolean;
}

export interface RoleRoutingTable {
  blueprint: ResolvedRoleTarget;
  critic: ResolvedRoleTarget;
  vision: ResolvedRoleTarget;
}

type EnvMap = Record<string, string | undefined>;

function cleanStr(val: string | undefined): string | undefined {
  const trimmed = val?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveOneRole(
  role: CognitiveRole,
  cfg: RoleRoutingConfig,
  env: EnvMap,
  activeModel: string,
  activeEndpoint?: string
): ResolvedRoleTarget {
  const upper = role.toUpperCase();
  const envModel = cleanStr(env[`UAP_${upper}_MODEL`]);
  const envEndpoint = cleanStr(env[`UAP_${upper}_ENDPOINT`]);
  if (envModel) {
    return {
      role,
      modelId: envModel,
      endpoint: envEndpoint ?? activeEndpoint,
      source: 'env',
      thinking: true,
      freshContext: true,
    };
  }

  const mm = cfg.multiModel;
  const cfgModel =
    role === 'blueprint'
      ? cleanStr(mm?.blueprintModel)
      : role === 'critic'
        ? cleanStr(mm?.criticModel)
        : cleanStr(mm?.visionModel);
  const cfgEndpoint =
    role === 'blueprint'
      ? cleanStr(mm?.blueprintEndpoint)
      : role === 'critic'
        ? cleanStr(mm?.criticEndpoint)
        : cleanStr(mm?.visionEndpoint);

  if (cfgModel) {
    return {
      role,
      modelId: cfgModel,
      endpoint: cfgEndpoint ?? envEndpoint ?? activeEndpoint,
      source: 'config-multi-model',
      thinking: true,
      freshContext: true,
    };
  }

  if (role !== 'vision') {
    const escalateModel = cleanStr(env.UAP_ESCALATE_MODEL) ?? cleanStr(cfg.deliver?.escalateModel);
    if (escalateModel && escalateModel !== activeModel) {
      return {
        role,
        modelId: escalateModel,
        endpoint: envEndpoint ?? activeEndpoint,
        source: 'escalate-model',
        thinking: true,
        freshContext: true,
      };
    }
  }

  return {
    role,
    modelId: activeModel,
    endpoint: envEndpoint ?? activeEndpoint,
    source: 'local-fresh-context',
    thinking: true,
    freshContext: true,
  };
}

/** Pure resolver for blueprint, critic, and vision role targets. */
export function resolveRoleRouting(
  cfg: RoleRoutingConfig,
  env: EnvMap,
  activeModel: string,
  activeEndpoint?: string
): RoleRoutingTable {
  return {
    blueprint: resolveOneRole('blueprint', cfg, env, activeModel, activeEndpoint),
    critic: resolveOneRole('critic', cfg, env, activeModel, activeEndpoint),
    vision: resolveOneRole('vision', cfg, env, activeModel, activeEndpoint),
  };
}

/** Read `.uap.json` (falling back to main root from worktree) and resolve roles. */
export function loadRoleRouting(
  projectRoot: string,
  activeModel: string,
  activeEndpoint?: string,
  env: EnvMap = process.env
): RoleRoutingTable {
  const candidates = [projectRoot];
  const mainRoot = projectRoot.split('/.worktrees/')[0];
  if (mainRoot && mainRoot !== projectRoot) candidates.push(mainRoot);

  let cfg: RoleRoutingConfig = {};
  for (const dir of candidates) {
    const file = join(dir, '.uap.json');
    if (!existsSync(file)) continue;
    try {
      cfg = JSON.parse(readFileSync(file, 'utf-8')) as RoleRoutingConfig;
      break;
    } catch {
      /* ignore malformed config and fall through */
    }
  }
  return resolveRoleRouting(cfg, env, activeModel, activeEndpoint);
}

/** Materialize a ModelConfig from a ResolvedRoleTarget (preset or custom id). */
export function buildRoleModelConfig(
  target: ResolvedRoleTarget,
  fallbackBase: ModelConfig
): ModelConfig {
  const preset = ModelPresets[target.modelId];
  if (preset) {
    return {
      ...preset,
      ...(target.endpoint ? { endpoint: target.endpoint } : {}),
    };
  }
  return {
    ...fallbackBase,
    id: target.modelId,
    name: target.modelId,
    apiModel: target.modelId,
    ...(target.endpoint ? { endpoint: target.endpoint } : {}),
  };
}

export type RoleExecutor = (prompt: string, images?: string[]) => Promise<string>;

/** Build a fresh-context thinking-ON executor bound to a resolved role target. */
export function createRoleExecutor(
  client: OpenAICompatClient,
  target: ResolvedRoleTarget,
  fallbackBase: ModelConfig,
  maxTokens = 16384
): RoleExecutor {
  const modelCfg = buildRoleModelConfig(target, fallbackBase);
  return async (prompt: string, images?: string[]): Promise<string> => {
    const res = await client.complete(modelCfg, prompt, {
      thinking: target.thinking,
      maxTokens,
      ...(images && images.length > 0 ? { images } : {}),
    });
    return res.content;
  };
}
