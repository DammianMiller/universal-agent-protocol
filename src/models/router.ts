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

// Complexity keywords for classification
const COMPLEXITY_KEYWORDS: Record<TaskComplexity, string[]> = {
  critical: [
    'security', 'authentication', 'authorization', 'deployment', 'migration',
    'production', 'database', 'encryption', 'credentials', 'secrets',
  ],
  high: [
    'architecture', 'design', 'refactor', 'performance', 'optimization',
    'algorithm', 'distributed', 'concurrent', 'multi-step', 'complex',
  ],
  medium: [
    'feature', 'implement', 'add', 'create', 'update', 'modify',
    'integrate', 'connect', 'api', 'endpoint',
  ],
  low: [
    'fix', 'typo', 'comment', 'rename', 'format', 'style',
    'simple', 'minor', 'small', 'quick', 'documentation',
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
  }

  private initializeModels(): void {
    for (const modelDef of this.config.models) {
      if (typeof modelDef === 'string') {
        // It's a preset ID
        const preset = ModelPresets[modelDef];
        if (preset) {
          this.models.set(modelDef, preset);
        }
      } else {
        // It's a custom config
        this.models.set(modelDef.id, modelDef);
      }
    }
    
    // Ensure we have at least the default models
    if (this.models.size === 0) {
      const defaultModel = ModelPresets['opus-4.5'];
      if (defaultModel) {
        this.models.set('opus-4.5', defaultModel);
      }
    }
  }

  private initializeRoles(): void {
    const roles = this.config.roles || {
      planner: 'opus-4.5',
      executor: 'glm-4.7',
      fallback: 'opus-4.5',
    };
    
    this.roleAssignments.set('planner', roles.planner || 'opus-4.5');
    this.roleAssignments.set('executor', roles.executor || 'glm-4.7');
    this.roleAssignments.set('reviewer', roles.reviewer || roles.planner || 'opus-4.5');
    this.roleAssignments.set('fallback', roles.fallback || 'opus-4.5');
  }

  /**
   * Classify a task to determine complexity and type
   */
  classifyTask(taskDescription: string): TaskClassificationResult {
    const lowerTask = taskDescription.toLowerCase();
    const words = lowerTask.split(/\s+/);
    
    // Detect complexity
    let complexity: TaskComplexity = 'medium';
    let maxComplexityScore = 0;
    
    for (const [level, keywords] of Object.entries(COMPLEXITY_KEYWORDS)) {
      const score = keywords.filter(kw => lowerTask.includes(kw)).length;
      if (score > maxComplexityScore) {
        maxComplexityScore = score;
        complexity = level as TaskComplexity;
      }
    }
    
    // Detect task type
    let taskType: TaskClassificationResult['taskType'] = 'coding';
    let maxTypeScore = 0;
    
    for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
      const score = keywords.filter(kw => lowerTask.includes(kw)).length;
      if (score > maxTypeScore) {
        maxTypeScore = score;
        taskType = type as TaskClassificationResult['taskType'];
      }
    }
    
    // Extract matched keywords
    const matchedKeywords: string[] = [];
    for (const keywords of Object.values(COMPLEXITY_KEYWORDS)) {
      matchedKeywords.push(...keywords.filter(kw => lowerTask.includes(kw)));
    }
    for (const keywords of Object.values(TASK_TYPE_KEYWORDS)) {
      matchedKeywords.push(...keywords.filter(kw => lowerTask.includes(kw)));
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
      thresholdMap[complexity] >= thresholdMap[complexityThreshold] ||
      taskType === 'planning';
    
    // Select model based on routing
    const selection = this.selectModel(complexity, taskType, matchedKeywords);
    
    return {
      complexity,
      taskType,
      keywords: [...new Set(matchedKeywords)],
      estimatedTokens,
      requiresPlanning,
      suggestedModel: selection.model.id,
      fallbackModel: selection.fallback?.id || this.roleAssignments.get('fallback') || 'opus-4.5',
      reasoning: selection.reasoning,
    };
  }

  /**
   * Select the appropriate model for a task
   */
  selectModel(
    complexity: TaskComplexity,
    taskType: string,
    keywords: string[]
  ): ModelSelection {
    // Find matching routing rule
    for (const rule of this.routingRules) {
      let matches = true;
      
      if (rule.complexity && rule.complexity !== complexity) {
        matches = false;
      }
      
      if (rule.taskType && rule.taskType !== taskType) {
        matches = false;
      }
      
      if (rule.keywords && rule.keywords.length > 0) {
        const hasKeyword = rule.keywords.some(kw => 
          keywords.some(k => k.includes(kw) || kw.includes(k))
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
    const executorId = this.roleAssignments.get('executor') || 'glm-4.7';
    const defaultExecutor = ModelPresets['glm-4.7'];
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
      reasoning: `Default routing to executor (${executor.name}) - no specific rule matched`,
      estimatedCost: this.estimateCost(executor, 10000, 5000),
    };
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
      const matched = rule.keywords.filter(kw => 
        keywords.some(k => k.includes(kw))
      );
      if (matched.length > 0) {
        parts.push(`keywords=[${matched.join(',')}]`);
      }
    }
    
    return `Matched rule (priority=${rule.priority}): ${parts.join(', ')} → ${rule.targetRole}`;
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
    
    const matchedRules = this.routingRules.map(rule => {
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
        const hasKeyword = rule.keywords.some(kw => 
          classification.keywords.some(k => k.includes(kw))
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
    
    const costComparison = Array.from(this.models.values()).map(model => ({
      model: model.name,
      cost: this.estimateCost(model, classification.estimatedTokens * 10, classification.estimatedTokens * 5),
    })).sort((a, b) => a.cost - b.cost);
    
    return {
      classification,
      matchedRules,
      costComparison,
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
