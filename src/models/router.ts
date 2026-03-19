/**
 * Model Router
 *
 * Routes tasks to appropriate models based on:
 * - Task complexity and type
 * - Routing rules configuration
 * - Cost optimization strategy
 * - Available model capabilities
 */

import {
  ModelConfig,
  ModelPresets,
  MultiModelConfig,
  TaskClassificationResult,
  TaskComplexity,
  ModelSelection,
  RoutingRule,
  DEFAULT_ROUTING_RULES,
  ModelRole,
} from './types.js';
import { createLogger } from '../utils/logger.js';
import { AdaptiveCache } from '../utils/adaptive-cache.js';

const log = createLogger('model-router-exec');

/**
 * LLM call reduction cache for task classification results.
 * Implements costOptimization.llmCallReduction.cacheResponses config.
 * Deduplicates identical or near-identical task descriptions.
 */
const classificationCache = new AdaptiveCache<string, TaskClassificationResult>({
  maxEntries: 500,
  defaultTTL: 3_600_000, // 1 hour (matches config default cacheTtlMs)
  hotThreshold: 3,
  coldEvictionRatio: 0.3,
});

/**
 * Normalize a task description for cache deduplication.
 * Strips whitespace variations and lowercases for consistent cache hits.
 */
function normalizeForCache(description: string): string {
  return description.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Complexity keywords for classification
const COMPLEXITY_KEYWORDS: Record<TaskComplexity, string[]> = {
  critical: [
    'security',
    'authentication',
    'authorization',
    'deployment',
    'migration',
    'production',
    'database',
    'encryption',
    'credentials',
    'secrets',
  ],
  high: [
    'architecture',
    'design',
    'refactor',
    'performance',
    'optimization',
    'algorithm',
    'distributed',
    'concurrent',
    'multi-step',
    'complex',
  ],
  medium: [
    'feature',
    'implement',
    'add',
    'create',
    'update',
    'modify',
    'integrate',
    'connect',
    'api',
    'endpoint',
  ],
  low: [
    'fix',
    'typo',
    'comment',
    'rename',
    'format',
    'style',
    'simple',
    'minor',
    'small',
    'quick',
    'documentation',
  ],
};

// Task type keywords
const TASK_TYPE_KEYWORDS: Record<string, string[]> = {
  planning: ['plan', 'design', 'architect', 'strategy', 'approach', 'how to'],
  coding: ['implement', 'code', 'write', 'create', 'build', 'develop'],
  refactoring: ['refactor', 'restructure', 'reorganize', 'clean', 'improve'],
  'bug-fix': ['fix', 'bug', 'error', 'issue', 'broken', 'not working', 'fails'],
  review: ['review', 'check', 'audit', 'analyze', 'evaluate', 'assess'],
  documentation: ['document', 'docs', 'readme', 'comment', 'explain', 'describe'],
};

/**
 * Model Router - routes tasks to appropriate models
 */
export class ModelRouter {
  private config: MultiModelConfig;
  private models: Map<string, ModelConfig>;
  private routingRules: RoutingRule[];
  private roleAssignments: Map<ModelRole, string>;

  constructor(config: MultiModelConfig) {
    this.config = config;
    this.models = new Map();
    this.roleAssignments = new Map();

    // Initialize models from config
    this.initializeModels();

    // Initialize routing rules
    this.routingRules = config.routing || DEFAULT_ROUTING_RULES;
    this.routingRules.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // Initialize role assignments
    this.initializeRoles();

    // Validate role assignments
    this.validateRoleAssignments();
  }

  private initializeModels(): void {
    for (const modelDef of this.config.models) {
      if (typeof modelDef === 'string') {
        // It's a preset ID
        const preset = ModelPresets[modelDef];
        if (preset) {
          this.models.set(modelDef, preset);
        } else {
          log.warn(`Model preset '${modelDef}' not found, skipping`);
        }
      } else {
        // It's a custom config
        this.models.set(modelDef.id, modelDef);
      }
    }

    // Ensure we have at least the default models
    if (this.models.size === 0) {
      const defaultPlanner = ModelPresets['opus-4.6'];
      const defaultExecutor = ModelPresets['qwen35'];
      if (defaultPlanner) {
        this.models.set('opus-4.6', defaultPlanner);
      }
      if (defaultExecutor) {
        this.models.set('qwen35', defaultExecutor);
      }
    }
  }

  private initializeRoles(): void {
    const roles = this.config.roles || {
      planner: 'opus-4.6',
      executor: 'qwen35',
      fallback: 'qwen35',
    };

    this.roleAssignments.set('planner', roles.planner || 'opus-4.6');
    this.roleAssignments.set('executor', roles.executor || 'qwen35');
    this.roleAssignments.set('reviewer', roles.reviewer || roles.planner || 'opus-4.6');
    this.roleAssignments.set('fallback', roles.fallback || 'qwen35');
  }

  private validateRoleAssignments(): void {
    const roles = this.config.roles || {};
    for (const [role, modelId] of Object.entries(roles) as Array<[string, string]>) {
      if (!this.models.has(modelId)) {
        log.warn(`Role '${role}' assigned to non-existent model '${modelId}'. Using fallback.`);
      }
    }
  }

  /**
   * Classify a task to determine complexity and type.
   * Results are cached to implement LLM call reduction (costOptimization.llmCallReduction).
   */
  classifyTask(taskDescription: string): TaskClassificationResult {
    // Check classification cache for deduplication
    const cacheKey = normalizeForCache(taskDescription);
    const cached = classificationCache.get(cacheKey);
    if (cached) {
      log.debug(`Classification cache hit for: ${cacheKey.slice(0, 50)}...`);
      return cached;
    }

    const lowerTask = taskDescription.toLowerCase();
    const words = lowerTask.split(/\s+/);

    // Detect complexity
    let complexity: TaskComplexity = 'medium';
    let maxComplexityScore = 0;

    for (const [level, keywords] of Object.entries(COMPLEXITY_KEYWORDS)) {
      const score = keywords.filter((kw) => lowerTask.includes(kw)).length;
      if (score > maxComplexityScore) {
        maxComplexityScore = score;
        complexity = level as TaskComplexity;
      }
    }

    // Detect task type
    let taskType: TaskClassificationResult['taskType'] = 'coding';
    let maxTypeScore = 0;

    for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
      const score = keywords.filter((kw) => lowerTask.includes(kw)).length;
      if (score > maxTypeScore) {
        maxTypeScore = score;
        taskType = type as TaskClassificationResult['taskType'];
      }
    }

    // Extract matched keywords
    const matchedKeywords: string[] = [];
    for (const keywords of Object.values(COMPLEXITY_KEYWORDS)) {
      matchedKeywords.push(...keywords.filter((kw) => lowerTask.includes(kw)));
    }
    for (const keywords of Object.values(TASK_TYPE_KEYWORDS)) {
      matchedKeywords.push(...keywords.filter((kw) => lowerTask.includes(kw)));
    }

    // Estimate tokens (rough heuristic)
    const estimatedTokens = Math.ceil(words.length * 1.3);

    // Determine if planning is required
    const complexityThreshold = this.config.plannerSettings?.complexityThreshold || 'medium';
    const thresholdMap: Record<TaskComplexity, number> = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };
    const requiresPlanning =
      thresholdMap[complexity] >= thresholdMap[complexityThreshold] || taskType === 'planning';

    // Select model based on routing
    const selection = this.selectModel(complexity, taskType, matchedKeywords);

    const result: TaskClassificationResult = {
      complexity,
      taskType,
      keywords: [...new Set(matchedKeywords)],
      estimatedTokens,
      requiresPlanning,
      suggestedModel: selection.model.id,
      fallbackModel: selection.fallback?.id || this.roleAssignments.get('fallback') || 'opus-4.6',
      reasoning: selection.reasoning,
    };

    // Cache the classification result for deduplication
    classificationCache.set(cacheKey, result, result.keywords.length);

    return result;
  }

  /**
   * Select the appropriate model for a task.
   * Behavior varies by routingStrategy:
   * - 'performance-first': Always use planner (highest-capability model)
   * - 'cost-optimized': Use cheapest model that meets capability threshold
   * - 'balanced': Standard priority-rule matching (default)
   * - 'adaptive': Dynamically balances cost and performance based on task characteristics
   */
  selectModel(complexity: TaskComplexity, taskType: string, keywords: string[]): ModelSelection {
    const strategy = this.config.routingStrategy || 'balanced';

    // Check routingMatrix override first - user-specified per-complexity model assignments
    if (this.config.routingMatrix?.[complexity]) {
      const matrixEntry = this.config.routingMatrix[complexity];
      const modelId =
        complexity === 'critical' || complexity === 'high'
          ? matrixEntry.planner
          : matrixEntry.executor;
      const model = this.models.get(modelId) || ModelPresets[modelId as keyof typeof ModelPresets];
      if (model) {
        return {
          model,
          fallback: undefined,
          role: complexity === 'critical' || complexity === 'high' ? 'planner' : 'executor',
          reasoning: `routingMatrix override for ${complexity} complexity: using ${model.name}`,
          estimatedCost: this.estimateCost(model, 10000, 5000),
        };
      }
    }

    // Performance-first: always use the planner (highest-capability model)
    if (strategy === 'performance-first') {
      const plannerId = this.roleAssignments.get('planner') || 'opus-4.6';
      const planner = this.models.get(plannerId) || ModelPresets['opus-4.6'];
      if (planner) {
        return {
          model: planner,
          fallback: undefined,
          role: 'planner',
          reasoning: `Strategy=performance-first: always use planner (${planner.name}) for maximum quality`,
          estimatedCost: this.estimateCost(planner, 10000, 5000),
        };
      }
    }

    // Cost-optimized: pick cheapest model that has the required capability
    if (strategy === 'cost-optimized') {
      const requiredCapability = this.getRequiredCapability(taskType, complexity);
      const candidates = Array.from(this.models.values())
        .filter((m) => !requiredCapability || m.capabilities.includes(requiredCapability))
        .sort((a, b) => {
          const costA = (a.costPer1MInput || 0) + (a.costPer1MOutput || 0);
          const costB = (b.costPer1MInput || 0) + (b.costPer1MOutput || 0);
          return costA - costB;
        });

      if (candidates.length > 0) {
        const cheapest = candidates[0];
        const fallbackId = this.roleAssignments.get('fallback');
        const fallback = fallbackId ? this.models.get(fallbackId) : undefined;
        return {
          model: cheapest,
          fallback: fallback !== cheapest ? fallback : undefined,
          role: 'executor',
          reasoning: `Strategy=cost-optimized: cheapest capable model (${cheapest.name}, $${((cheapest.costPer1MInput || 0) + (cheapest.costPer1MOutput || 0)).toFixed(2)}/1M)`,
          estimatedCost: this.estimateCost(cheapest, 10000, 5000),
        };
      }
    }

    // Adaptive: dynamically balance cost and performance based on task characteristics
    if (strategy === 'adaptive') {
      return this.selectAdaptiveModel(complexity, taskType, keywords);
    }

    // Balanced: standard priority-rule matching (fallback for adaptive)
    return this.selectBalancedModel(complexity, taskType, keywords);
  }

  /**
   * Map task type + complexity to a required model capability.
   */
  private getRequiredCapability(taskType: string, complexity: TaskComplexity): string | null {
    if (complexity === 'critical' || complexity === 'high' || taskType === 'planning') {
      return 'complex-reasoning';
    }
    if (taskType === 'coding' || taskType === 'refactoring' || taskType === 'bug-fix') {
      return 'code-generation';
    }
    if (taskType === 'review') {
      return 'review';
    }
    return null; // Any model can handle documentation, simple tasks
  }

  private buildReasoning(
    rule: RoutingRule,
    complexity: TaskComplexity,
    taskType: string,
    keywords: string[]
  ): string {
    const parts: string[] = [];

    if (rule.complexity) {
      parts.push(`complexity=${complexity}`);
    }
    if (rule.taskType) {
      parts.push(`type=${taskType}`);
    }
    if (rule.keywords && rule.keywords.length > 0) {
      const matched = rule.keywords.filter((kw) => keywords.some((k) => k.includes(kw)));
      if (matched.length > 0) {
        parts.push(`keywords=[${matched.join(',')}]`);
      }
    }

    return `Matched rule (priority=${rule.priority}): ${parts.join(', ')} → ${rule.targetRole}`;
  }

  /**
   * Adaptive routing: dynamically balance cost and performance based on task characteristics.
   * - Critical/high complexity tasks → use planner (performance-focused)
   * - Medium complexity → use balanced approach with cost consideration
   * - Low complexity → use cheapest capable model (cost-optimized)
   * - Security-sensitive tasks → always use higher-capability model
   */
  private selectAdaptiveModel(
    complexity: TaskComplexity,
    taskType: string,
    keywords: string[]
  ): ModelSelection {
    // Check for security sensitivity
    const isSecuritySensitive = keywords.some(
      (k) =>
        k.includes('security') ||
        k.includes('auth') ||
        k.includes('encrypt') ||
        k.includes('password') ||
        k.includes('credential')
    );

    // For security-sensitive or critical tasks, use planner (performance)
    if (isSecuritySensitive || complexity === 'critical') {
      const plannerId = this.roleAssignments.get('planner') || 'opus-4.6';
      const planner = this.models.get(plannerId) || ModelPresets['opus-4.6'];
      if (planner) {
        return {
          model: planner,
          fallback: undefined,
          role: 'planner',
          reasoning: `Strategy=adaptive: security-sensitive/critical task → planner (${planner.name}) for maximum quality and safety`,
          estimatedCost: this.estimateCost(planner, 10000, 5000),
        };
      }
    }

    // High complexity tasks → use planner (performance-focused)
    if (complexity === 'high') {
      const plannerId = this.roleAssignments.get('planner') || 'opus-4.6';
      const planner = this.models.get(plannerId) || ModelPresets['opus-4.6'];
      if (planner) {
        return {
          model: planner,
          fallback: undefined,
          role: 'planner',
          reasoning: `Strategy=adaptive: high complexity task → planner (${planner.name}) for better handling`,
          estimatedCost: this.estimateCost(planner, 10000, 5000),
        };
      }
    }

    // Medium complexity → balanced approach (use configured executor)
    if (complexity === 'medium') {
      const executorId = this.roleAssignments.get('executor') || 'qwen35';
      const executor = this.models.get(executorId) || ModelPresets['qwen35'];
      const fallbackId = this.roleAssignments.get('fallback');
      const fallback = fallbackId ? this.models.get(fallbackId) : undefined;

      return {
        model: executor,
        fallback: fallback !== executor ? fallback : undefined,
        role: 'executor',
        reasoning: `Strategy=adaptive: medium complexity → balanced executor (${executor.name})`,
        estimatedCost: this.estimateCost(executor, 10000, 5000),
      };
    }

    // Low complexity → cost-optimized (cheapest capable model)
    if (complexity === 'low') {
      const candidates = Array.from(this.models.values()).sort((a, b) => {
        const costA = (a.costPer1MInput || 0) + (a.costPer1MOutput || 0);
        const costB = (b.costPer1MInput || 0) + (b.costPer1MOutput || 0);
        return costA - costB;
      });

      if (candidates.length > 0) {
        const cheapest = candidates[0];
        return {
          model: cheapest,
          fallback: undefined,
          role: 'executor',
          reasoning: `Strategy=adaptive: low complexity → cost-optimized (${cheapest.name}, $${((cheapest.costPer1MInput || 0) + (cheapest.costPer1MOutput || 0)).toFixed(2)}/1M)`,
          estimatedCost: this.estimateCost(cheapest, 10000, 5000),
        };
      }
    }

    // Fallback to balanced for unknown cases
    return this.selectBalancedModel(complexity, taskType, keywords);
  }

  /**
   * Balanced routing: standard priority-rule matching (used as fallback in adaptive)
   */
  private selectBalancedModel(
    complexity: TaskComplexity,
    taskType: string,
    keywords: string[]
  ): ModelSelection {
    for (const rule of this.routingRules) {
      let matches = true;

      if (rule.complexity && rule.complexity !== complexity) {
        matches = false;
      }

      if (rule.taskType && rule.taskType !== taskType) {
        matches = false;
      }

      if (rule.keywords && rule.keywords.length > 0) {
        const hasKeyword = rule.keywords.some((kw) =>
          keywords.some((k) => k.includes(kw) || kw.includes(k))
        );
        if (!hasKeyword) {
          matches = false;
        }
      }

      if (matches) {
        const role = rule.targetRole;
        const modelId = this.roleAssignments.get(role);
        const model = modelId ? this.models.get(modelId) : undefined;

        if (model) {
          const fallbackId = this.roleAssignments.get('fallback');
          const fallback = fallbackId ? this.models.get(fallbackId) : undefined;

          return {
            model,
            fallback: fallback !== model ? fallback : undefined,
            role,
            reasoning: this.buildReasoning(rule, complexity, taskType, keywords),
            estimatedCost: this.estimateCost(model, 10000, 5000),
          };
        }
      }
    }

    // Default to executor
    const executorId = this.roleAssignments.get('executor') || 'qwen35';
    const defaultExecutor = ModelPresets['qwen35'];
    const executor = this.models.get(executorId) || defaultExecutor;
    const fallbackId = this.roleAssignments.get('fallback');
    const fallback = fallbackId ? this.models.get(fallbackId) : undefined;

    if (!executor) {
      throw new Error('No executor model available');
    }

    return {
      model: executor,
      fallback,
      role: 'executor',
      reasoning: `Default balanced routing to executor (${executor.name}) - no specific rule matched`,
      estimatedCost: this.estimateCost(executor, 10000, 5000),
    };
  }

  /**
   * Estimate cost for a model invocation
   */
  estimateCost(model: ModelConfig, inputTokens: number, outputTokens: number): number {
    const inputCost = (model.costPer1MInput || 0) * (inputTokens / 1_000_000);
    const outputCost = (model.costPer1MOutput || 0) * (outputTokens / 1_000_000);
    return inputCost + outputCost;
  }

  /**
   * Get model by ID
   */
  getModel(modelId: string): ModelConfig | undefined {
    return this.models.get(modelId);
  }

  /**
   * Get model for a specific role
   */
  getModelForRole(role: ModelRole): ModelConfig | undefined {
    const modelId = this.roleAssignments.get(role);
    return modelId ? this.models.get(modelId) : undefined;
  }

  /**
   * Get all configured models
   */
  getAllModels(): ModelConfig[] {
    return Array.from(this.models.values());
  }

  /**
   * Get routing analysis for debugging
   */
  analyzeRouting(taskDescription: string): {
    classification: TaskClassificationResult;
    matchedRules: Array<{ rule: RoutingRule; matched: boolean; reason: string }>;
    costComparison: Array<{ model: string; cost: number }>;
  } {
    const classification = this.classifyTask(taskDescription);

    const matchedRules = this.routingRules.map((rule) => {
      let matched = true;
      const reasons: string[] = [];

      if (rule.complexity) {
        if (rule.complexity !== classification.complexity) {
          matched = false;
          reasons.push(`complexity ${classification.complexity} != ${rule.complexity}`);
        } else {
          reasons.push(`complexity matches ${rule.complexity}`);
        }
      }

      if (rule.taskType) {
        if (rule.taskType !== classification.taskType) {
          matched = false;
          reasons.push(`type ${classification.taskType} != ${rule.taskType}`);
        } else {
          reasons.push(`type matches ${rule.taskType}`);
        }
      }

      if (rule.keywords && rule.keywords.length > 0) {
        const hasKeyword = rule.keywords.some((kw) =>
          classification.keywords.some((k) => k.includes(kw))
        );
        if (!hasKeyword) {
          matched = false;
          reasons.push(`no keyword match for [${rule.keywords.join(',')}]`);
        } else {
          reasons.push(`keyword matches`);
        }
      }

      return {
        rule,
        matched,
        reason: reasons.join('; '),
      };
    });

    const costComparison = Array.from(this.models.values())
      .map((model) => ({
        model: model.name,
        cost: this.estimateCost(
          model,
          classification.estimatedTokens * 10,
          classification.estimatedTokens * 5
        ),
      }))
      .sort((a, b) => a.cost - b.cost);

    return {
      classification,
      matchedRules,
      costComparison,
    };
  }

  /**
   * Get default configuration with opus-4.6 for planning and qwen35 for execution
   */
  public static getDefaultUAPConfig(): MultiModelConfig {
    return {
      enabled: true,
      models: ['opus-4.6', 'qwen35'],
      roles: {
        planner: 'opus-4.6',
        executor: 'qwen35',
        fallback: 'qwen35',
      },
      routingStrategy: 'balanced',
    };
  }
}

/**
 * Create a router instance from config
 */
export function createRouter(config: MultiModelConfig): ModelRouter {
  return new ModelRouter(config);
}

/**
 * Default router with cost-optimized settings
 */
export function createCostOptimizedRouter(): ModelRouter {
  return new ModelRouter({
    enabled: true,
    models: ['deepseek-v3.2', 'glm-4.7', 'opus-4.5'],
    roles: {
      planner: 'deepseek-v3.2',
      executor: 'glm-4.7',
      reviewer: 'deepseek-v3.2',
      fallback: 'opus-4.5',
    },
    routingStrategy: 'cost-optimized',
    costOptimization: {
      enabled: true,
      targetReduction: 90,
      maxPerformanceDegradation: 20,
      fallbackThreshold: 3,
    },
  });
}

/**
 * Default router with performance-first settings
 */
export function createPerformanceRouter(): ModelRouter {
  return new ModelRouter({
    enabled: true,
    models: ['opus-4.5', 'gpt-5.2'],
    roles: {
      planner: 'opus-4.5',
      executor: 'opus-4.5',
      reviewer: 'opus-4.5',
      fallback: 'opus-4.5',
    },
    routingStrategy: 'performance-first',
  });
}

/**
 * Default UAP router with opus-4.6 for planning and qwen35 for execution
 */
export function createUAPRouter(): ModelRouter {
  return new ModelRouter(ModelRouter.getDefaultUAPConfig());
}
