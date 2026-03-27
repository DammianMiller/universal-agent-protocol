/**
 * Unified Routing Service
 *
 * Bridges the two independent routing systems:
 * 1. Rule-based ModelRouter (src/models/router.ts) - uses task complexity/type keywords, routing rules, role assignments
 * 2. Benchmark-data ModelRouter (src/memory/model-router.ts) - uses MODEL_FINGERPRINTS with per-category success rates, SQLite persistence
 *
 * Combines both signals to produce a single routing decision with higher accuracy
 * than either system alone. The benchmark-data router is weighted higher when it
 * has sufficient data points (>=5) for the relevant category.
 */

import { ModelRouter as RuleBasedRouter } from './router.js';
import {
  routeTask as benchmarkRouteTask,
  recordTaskOutcome,
  getModelFingerprint,
  getAllModelFingerprints,
  type ModelId,
  type RoutingDecision,
  type RoutingConfig,
  type ModelFingerprint,
} from '../memory/model-router.js';
import type {
  MultiModelConfig,
  TaskClassificationResult,
  TaskComplexity,
  ModelConfig,
} from './types.js';

/**
 * Mapping from benchmark-data ModelId values to rule-based router model IDs.
 * Both routers now use the same model IDs (opus-4.6, sonnet-4.6, etc.).
 */
const BENCHMARK_TO_RULE_MODEL_MAP: Record<string, string> = {
  'opus-4.6': 'opus-4.6',
  'sonnet-4.6': 'sonnet-4.6',
  haiku: 'haiku',
  'qwen35-a3b': 'qwen35-a3b',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.3-codex': 'gpt-5.3-codex',
};

const RULE_TO_BENCHMARK_MODEL_MAP: Record<string, ModelId> = {
  'opus-4.6': 'opus-4.6',
  'sonnet-4.6': 'sonnet-4.6',
  haiku: 'haiku',
  'qwen35-a3b': 'qwen35-a3b',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.3-codex': 'gpt-5.3-codex',
};

/**
 * Map rule-based TaskComplexity to benchmark difficulty levels.
 */
function complexityToDifficulty(complexity: TaskComplexity): 'easy' | 'medium' | 'hard' {
  switch (complexity) {
    case 'low':
      return 'easy';
    case 'medium':
      return 'medium';
    case 'high':
    case 'critical':
      return 'hard';
  }
}

/**
 * Result from the unified routing system.
 */
export interface UnifiedRoutingResult {
  /** The selected model ID (using rule-based router's naming convention) */
  selectedModel: string;
  /** Fallback model ID if the primary fails */
  fallbackModel: string;
  /** Which system's recommendation was used: 'rule-based', 'benchmark-data', or 'consensus' */
  source: 'rule-based' | 'benchmark-data' | 'consensus';
  /** Confidence score 0-1 reflecting how confident the unified system is */
  confidence: number;
  /** Human-readable reasoning explaining the decision */
  reasoning: string;
  /** The rule-based router's classification */
  ruleBasedClassification: TaskClassificationResult;
  /** The benchmark-data router's decision */
  benchmarkDecision: RoutingDecision;
  /** Whether the two systems agreed on the model */
  systemsAgreed: boolean;
  /** Number of benchmark data points for the relevant category */
  benchmarkDataPoints: number;
}

/**
 * Options for recording outcomes back to the benchmark-data router.
 */
export interface OutcomeRecord {
  /** The model that was actually used (rule-based router naming) */
  modelUsed: string;
  /** Whether the task succeeded */
  success: boolean;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Optional task category for category-specific tracking */
  taskCategory?: string;
}

/**
 * Side-by-side analysis of both routing systems.
 */
export interface RoutingAnalysis {
  taskDescription: string;
  ruleBasedResult: {
    suggestedModel: string;
    complexity: TaskComplexity;
    taskType: string;
    reasoning: string;
  };
  benchmarkResult: {
    primaryModel: ModelId;
    score: string;
    estimatedSuccessRate: number;
    estimatedLatencyMs: number;
    estimatedCost: number;
    reasoning: string;
  };
  unifiedResult: UnifiedRoutingResult;
  modelComparison: Array<{
    modelId: string;
    benchmarkModelId: ModelId | null;
    ruleBasedRole: string | null;
    benchmarkSuccessRate: number | null;
    benchmarkCategoryDataPoints: number | null;
  }>;
}

/**
 * Unified Routing Service that combines rule-based and benchmark-data routing.
 */
export class UnifiedRoutingService {
  private ruleRouter: RuleBasedRouter;
  private benchmarkConfig: Partial<RoutingConfig>;

  /**
   * @param config - MultiModelConfig for the rule-based router
   * @param benchmarkConfig - Optional overrides for the benchmark-data router's RoutingConfig
   */
  constructor(config: MultiModelConfig, benchmarkConfig: Partial<RoutingConfig> = {}) {
    this.ruleRouter = new RuleBasedRouter(config);
    this.benchmarkConfig = benchmarkConfig;
  }

  /**
   * Route a task using both systems and combine their signals.
   *
   * Decision logic:
   * - If both systems agree on the model → use that model (source: 'consensus')
   * - If they disagree and benchmark has >=5 data points for the category → use benchmark (source: 'benchmark-data')
   * - If they disagree and benchmark has <5 data points → use rule-based (source: 'rule-based')
   */
  route(taskDescription: string): UnifiedRoutingResult {
    // Step A: Classify via rule-based router
    const ruleClassification = this.ruleRouter.classifyTask(taskDescription);

    // Step B: Get benchmark-data recommendation
    const difficulty = complexityToDifficulty(ruleClassification.complexity);
    const benchmarkDecision = benchmarkRouteTask(taskDescription, difficulty, this.benchmarkConfig);

    // Normalize model IDs so we can compare
    const ruleModelId = ruleClassification.suggestedModel;
    const benchmarkModelId = benchmarkDecision.primary;
    const benchmarkAsRuleId = BENCHMARK_TO_RULE_MODEL_MAP[benchmarkModelId] ?? benchmarkModelId;

    // Check benchmark data points for the relevant category
    const benchmarkFingerprint = getModelFingerprint(benchmarkModelId);
    const benchmarkDataPoints = this.getCategoryDataPoints(benchmarkFingerprint, taskDescription);

    // Determine if the two systems agree
    const systemsAgreed = ruleModelId === benchmarkAsRuleId;

    let selectedModel: string;
    let source: UnifiedRoutingResult['source'];
    let confidence: number;
    let reasoning: string;

    if (systemsAgreed) {
      // Consensus: both systems agree
      selectedModel = ruleModelId;
      source = 'consensus';
      confidence = this.computeConsensusConfidence(
        ruleClassification,
        benchmarkDecision,
        benchmarkDataPoints
      );
      reasoning =
        `Both routing systems agree on ${selectedModel}. ` +
        `Rule-based: ${ruleClassification.reasoning}. ` +
        `Benchmark: ${benchmarkDecision.reason}.`;
    } else if (benchmarkDataPoints >= 5) {
      // Benchmark has enough data — trust it
      selectedModel = benchmarkAsRuleId;
      source = 'benchmark-data';
      confidence = this.computeBenchmarkConfidence(benchmarkDecision, benchmarkDataPoints);
      reasoning =
        `Systems disagree (rule-based: ${ruleModelId}, benchmark: ${benchmarkAsRuleId}). ` +
        `Benchmark router preferred with ${benchmarkDataPoints} data points for this category. ` +
        `Benchmark: ${benchmarkDecision.reason}. ` +
        `Rule-based: ${ruleClassification.reasoning}.`;
    } else {
      // Not enough benchmark data — trust rule-based
      selectedModel = ruleModelId;
      source = 'rule-based';
      confidence = this.computeRuleBasedConfidence(ruleClassification, benchmarkDataPoints);
      reasoning =
        `Systems disagree (rule-based: ${ruleModelId}, benchmark: ${benchmarkAsRuleId}). ` +
        `Rule-based router preferred — benchmark has only ${benchmarkDataPoints} data points (< 5 threshold). ` +
        `Rule-based: ${ruleClassification.reasoning}. ` +
        `Benchmark: ${benchmarkDecision.reason}.`;
    }

    // Determine fallback
    const fallbackModel = this.selectFallback(selectedModel, ruleClassification, benchmarkDecision);

    return {
      selectedModel,
      fallbackModel,
      source,
      confidence,
      reasoning,
      ruleBasedClassification: ruleClassification,
      benchmarkDecision,
      systemsAgreed,
      benchmarkDataPoints,
    };
  }

  /**
   * Record a task outcome, feeding back to the benchmark-data router for learning.
   */
  recordOutcome(outcome: OutcomeRecord): void {
    const benchmarkModelId =
      RULE_TO_BENCHMARK_MODEL_MAP[outcome.modelUsed] ?? (outcome.modelUsed as ModelId);

    // Only record if it's a valid benchmark model ID
    if (getModelFingerprint(benchmarkModelId as ModelId)) {
      recordTaskOutcome(
        benchmarkModelId as ModelId,
        outcome.success,
        outcome.latencyMs,
        outcome.taskCategory
      );
    }
  }

  /**
   * Show both systems' recommendations side by side for analysis/debugging.
   */
  analyzeRouting(taskDescription: string): RoutingAnalysis {
    const ruleClassification = this.ruleRouter.classifyTask(taskDescription);
    const difficulty = complexityToDifficulty(ruleClassification.complexity);
    const benchmarkDecision = benchmarkRouteTask(taskDescription, difficulty, this.benchmarkConfig);
    const unifiedResult = this.route(taskDescription);

    // Build model comparison across all known models
    const allRuleModels = this.ruleRouter.getAllModels();
    const allBenchmarkFingerprints = getAllModelFingerprints();

    const modelComparison = allRuleModels.map((model: ModelConfig) => {
      const benchmarkId = RULE_TO_BENCHMARK_MODEL_MAP[model.id] ?? null;
      const fp = benchmarkId ? (allBenchmarkFingerprints[benchmarkId as ModelId] ?? null) : null;

      // Find the category data points from the benchmark fingerprint
      const categoryDataPoints = fp
        ? this.getCategoryDataPointsFromFingerprint(fp, taskDescription)
        : null;

      return {
        modelId: model.id,
        benchmarkModelId: benchmarkId as ModelId | null,
        ruleBasedRole: this.getRoleForModel(model.id),
        benchmarkSuccessRate: fp ? fp.successRate : null,
        benchmarkCategoryDataPoints: categoryDataPoints,
      };
    });

    return {
      taskDescription,
      ruleBasedResult: {
        suggestedModel: ruleClassification.suggestedModel,
        complexity: ruleClassification.complexity,
        taskType: ruleClassification.taskType,
        reasoning: ruleClassification.reasoning,
      },
      benchmarkResult: {
        primaryModel: benchmarkDecision.primary,
        score: `${benchmarkDecision.estimatedSuccessRate * 100}%`,
        estimatedSuccessRate: benchmarkDecision.estimatedSuccessRate,
        estimatedLatencyMs: benchmarkDecision.estimatedLatencyMs,
        estimatedCost: benchmarkDecision.estimatedCost,
        reasoning: benchmarkDecision.reason,
      },
      unifiedResult,
      modelComparison,
    };
  }

  /**
   * Get the underlying rule-based router for advanced usage.
   */
  getRuleRouter(): RuleBasedRouter {
    return this.ruleRouter;
  }

  // --- Private helpers ---

  /**
   * Get the number of benchmark data points for the most relevant category
   * for a given task description, using the benchmark model's fingerprint.
   */
  private getCategoryDataPoints(
    fingerprint: ModelFingerprint | null,
    _taskDescription: string
  ): number {
    if (!fingerprint?.categoryStats) return 0;
    return this.getMaxCategoryAttempts(fingerprint);
  }

  /**
   * Same as getCategoryDataPoints but takes a fingerprint directly (no model lookup).
   */
  private getCategoryDataPointsFromFingerprint(
    fingerprint: ModelFingerprint,
    _taskDescription: string
  ): number {
    if (!fingerprint.categoryStats) return 0;
    return this.getMaxCategoryAttempts(fingerprint);
  }

  /**
   * Get the maximum number of attempts across all categories for a fingerprint.
   * This represents the most-exercised category and serves as a proxy for
   * how much data we have for this model.
   */
  private getMaxCategoryAttempts(fingerprint: ModelFingerprint): number {
    if (!fingerprint.categoryStats) return 0;
    let max = 0;
    for (const stats of Object.values(fingerprint.categoryStats)) {
      if (stats.attempts > max) {
        max = stats.attempts;
      }
    }
    return max;
  }

  /**
   * Compute confidence when both systems agree.
   * Higher confidence because consensus is a strong signal.
   */
  private computeConsensusConfidence(
    ruleClassification: TaskClassificationResult,
    benchmarkDecision: RoutingDecision,
    dataPoints: number
  ): number {
    // Base: 0.7 for consensus agreement
    let confidence = 0.7;

    // Boost from benchmark success rate
    confidence += benchmarkDecision.estimatedSuccessRate * 0.15;

    // Boost from data richness (max +0.1 at 10+ data points)
    confidence += Math.min(dataPoints / 10, 1) * 0.1;

    // Small boost if rule-based had high keyword match count
    if (ruleClassification.keywords.length >= 3) {
      confidence += 0.05;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Compute confidence when using the benchmark-data router (disagreement case).
   */
  private computeBenchmarkConfidence(
    benchmarkDecision: RoutingDecision,
    dataPoints: number
  ): number {
    // Base: 0.5 (disagreement lowers base)
    let confidence = 0.5;

    // Strong boost from benchmark success rate
    confidence += benchmarkDecision.estimatedSuccessRate * 0.2;

    // Data richness boost (max +0.15 at 15+ data points)
    confidence += Math.min(dataPoints / 15, 1) * 0.15;

    return Math.min(confidence, 1.0);
  }

  /**
   * Compute confidence when using the rule-based router (disagreement, low benchmark data).
   */
  private computeRuleBasedConfidence(
    ruleClassification: TaskClassificationResult,
    dataPoints: number
  ): number {
    // Base: 0.5 (disagreement lowers base)
    let confidence = 0.5;

    // Boost from rule keyword matches
    confidence += Math.min(ruleClassification.keywords.length / 5, 1) * 0.15;

    // Planning requirement is a strong signal for using higher-capability model
    if (ruleClassification.requiresPlanning) {
      confidence += 0.1;
    }

    // Slight penalty if benchmark had some data (even if below threshold)
    if (dataPoints > 0) {
      confidence -= 0.05;
    }

    return Math.min(Math.max(confidence, 0.1), 1.0);
  }

  /**
   * Select the best fallback model from the two systems' recommendations.
   */
  private selectFallback(
    selectedModel: string,
    ruleClassification: TaskClassificationResult,
    benchmarkDecision: RoutingDecision
  ): string {
    // Try rule-based fallback first
    if (ruleClassification.fallbackModel && ruleClassification.fallbackModel !== selectedModel) {
      return ruleClassification.fallbackModel;
    }

    // Try benchmark fallbacks
    for (const fallbackId of benchmarkDecision.fallback) {
      const asRuleId = BENCHMARK_TO_RULE_MODEL_MAP[fallbackId] ?? fallbackId;
      if (asRuleId !== selectedModel) {
        return asRuleId;
      }
    }

    // Last resort: return rule-based fallback even if same (caller can handle)
    return ruleClassification.fallbackModel;
  }

  /**
   * Get the role assigned to a model in the rule-based router.
   */
  private getRoleForModel(modelId: string): string | null {
    for (const role of ['planner', 'executor', 'reviewer', 'fallback'] as const) {
      const model = this.ruleRouter.getModelForRole(role);
      if (model && model.id === modelId) {
        return role;
      }
    }
    return null;
  }
}

/**
 * Create a UnifiedRoutingService with the given configuration.
 */
export function createUnifiedRouter(
  config: MultiModelConfig,
  benchmarkConfig?: Partial<RoutingConfig>
): UnifiedRoutingService {
  return new UnifiedRoutingService(config, benchmarkConfig);
}
