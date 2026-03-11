/**
 * Model Routing Intelligence for UAM
 *
 * Routes tasks to the optimal model based on:
 * - Task classification and difficulty
 * - Model capability fingerprints (benchmarked data)
 * - Latency/accuracy/cost tradeoffs
 * - Fallback chains for resilience
 * - OPT 8: Persistent fingerprint data from SQLite
 *
 * Based on BENCHMARK_ANALYSIS.md and MODEL_BENCHMARK_RESULTS.md data.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { classifyTask, type TaskClassification } from './task-classifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type ModelId = 'glm-4.7' | 'gpt-5.2' | 'claude-opus-4.5' | 'gpt-5.2-codex';

export interface CategoryStats {
  attempts: number;
  successes: number;
}

export interface ModelFingerprint {
  id: ModelId;
  strengths: string[];
  weaknesses: string[];
  avgLatencyMs: number;
  successRate: number;
  costPerTask: number;
  maxComplexity: 'easy' | 'medium' | 'hard';
  bestCategories: string[];
  categoryStats?: Record<string, CategoryStats>;
}

export interface RoutingDecision {
  primary: ModelId;
  fallback: ModelId[];
  reason: string;
  estimatedLatencyMs: number;
  estimatedSuccessRate: number;
  estimatedCost: number;
}

export interface RoutingConfig {
  preferLatency: boolean;
  preferAccuracy: boolean;
  maxCostPerTask: number;
  maxLatencyMs: number;
  availableModels: ModelId[];
}

const DEFAULT_CONFIG: RoutingConfig = {
  preferLatency: false,
  preferAccuracy: true,
  maxCostPerTask: 0.05,
  maxLatencyMs: 120000,
  availableModels: ['glm-4.7', 'gpt-5.2', 'claude-opus-4.5', 'gpt-5.2-codex'],
};

// OPTIMIZATION 5: Pre-seeded with benchmark data for per-category routing
const MODEL_FINGERPRINTS: Record<ModelId, ModelFingerprint> = {
  'glm-4.7': {
    id: 'glm-4.7',
    strengths: ['speed', 'simple-code', 'patterns', 'typescript', 'bug-detection'],
    weaknesses: ['complex-algorithms', 'long-context', 'multi-step-code', 'context-awareness'],
    avgLatencyMs: 11373,
    successRate: 0.625,
    costPerTask: 0.001,
    maxComplexity: 'medium',
    bestCategories: ['coding', 'testing', 'debugging'],
    categoryStats: {
      coding: { attempts: 8, successes: 5 },
      testing: { attempts: 5, successes: 4 },
      debugging: { attempts: 4, successes: 3 },
      security: { attempts: 4, successes: 2 },
      'file-ops': { attempts: 3, successes: 1 },
      sysadmin: { attempts: 3, successes: 1 },
    },
  },
  'gpt-5.2': {
    id: 'gpt-5.2',
    strengths: ['balance', 'consistency', 'general-purpose', 'algorithm', 'multi-step'],
    weaknesses: ['refactoring', 'latency-sensitive'],
    avgLatencyMs: 21286,
    successRate: 0.875,
    costPerTask: 0.005,
    maxComplexity: 'hard',
    bestCategories: ['coding', 'security', 'file-ops', 'debugging'],
    categoryStats: {
      coding: { attempts: 8, successes: 7 },
      security: { attempts: 6, successes: 5 },
      'file-ops': { attempts: 5, successes: 4 },
      debugging: { attempts: 5, successes: 5 },
      sysadmin: { attempts: 4, successes: 3 },
      'ml-training': { attempts: 3, successes: 2 },
      'constraint-satisfaction': { attempts: 3, successes: 3 },
    },
  },
  'claude-opus-4.5': {
    id: 'claude-opus-4.5',
    strengths: ['accuracy', 'complex-reasoning', 'edge-cases', 'error-handling', 'refactoring'],
    weaknesses: ['latency', 'cost'],
    avgLatencyMs: 26359,
    successRate: 0.875,
    costPerTask: 0.02,
    maxComplexity: 'hard',
    bestCategories: ['security', 'coding', 'sysadmin', 'debugging'],
    categoryStats: {
      security: { attempts: 8, successes: 7 },
      coding: { attempts: 8, successes: 7 },
      sysadmin: { attempts: 5, successes: 5 },
      debugging: { attempts: 5, successes: 4 },
      'file-ops': { attempts: 5, successes: 4 },
      'ml-training': { attempts: 3, successes: 2 },
      'constraint-satisfaction': { attempts: 3, successes: 2 },
    },
  },
  'gpt-5.2-codex': {
    id: 'gpt-5.2-codex',
    strengths: ['code-specific', 'syntax-accuracy', 'context-awareness', 'all-difficulties'],
    weaknesses: ['latency', 'cost', 'non-code-tasks'],
    avgLatencyMs: 102399,
    successRate: 1.0,
    costPerTask: 0.01,
    maxComplexity: 'hard',
    bestCategories: ['coding', 'testing'],
    categoryStats: {
      coding: { attempts: 8, successes: 8 },
      testing: { attempts: 5, successes: 5 },
      security: { attempts: 3, successes: 3 },
      'file-ops': { attempts: 3, successes: 2 },
    },
  },
};

const COMPLEXITY_RANK = { easy: 1, medium: 2, hard: 3 };

// OPT 8: SQLite-backed fingerprint persistence
let fingerprintDb: Database.Database | null = null;

function getFingerprintDb(): Database.Database {
  if (fingerprintDb) return fingerprintDb;
  
  const dbDir = join(__dirname, '../../agents/data/memory');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  
  const dbPath = join(dbDir, 'model_fingerprints.db');
  fingerprintDb = new Database(dbPath);
  fingerprintDb.pragma('journal_mode = WAL');
  
  // Create schema
  fingerprintDb.exec(`
    CREATE TABLE IF NOT EXISTS fingerprint_updates (
      model_id TEXT NOT NULL,
      avg_latency_ms REAL,
      success_rate REAL,
      updated_at INTEGER,
      PRIMARY KEY (model_id)
    );
    
    CREATE TABLE IF NOT EXISTS category_stats (
      model_id TEXT NOT NULL,
      category TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      successes INTEGER DEFAULT 0,
      updated_at INTEGER,
      PRIMARY KEY (model_id, category)
    );
    
    CREATE INDEX IF NOT EXISTS idx_category_stats_model ON category_stats(model_id);
  `);
  
  return fingerprintDb;
}

/**
 * OPT 8: Load persisted fingerprint data on module init
 */
function loadPersistedFingerprints(): void {
  try {
    const db = getFingerprintDb();
    
    // Load global updates
    const updates = db.prepare('SELECT * FROM fingerprint_updates').all() as Array<{
      model_id: string;
      avg_latency_ms: number;
      success_rate: number;
    }>;
    
    for (const update of updates) {
      const fp = MODEL_FINGERPRINTS[update.model_id as ModelId];
      if (fp) {
        // Blend persisted data with defaults (70% persisted, 30% default)
        fp.avgLatencyMs = fp.avgLatencyMs * 0.3 + update.avg_latency_ms * 0.7;
        fp.successRate = fp.successRate * 0.3 + update.success_rate * 0.7;
      }
    }
    
    // Load category stats
    const categoryData = db.prepare('SELECT * FROM category_stats').all() as Array<{
      model_id: string;
      category: string;
      attempts: number;
      successes: number;
    }>;
    
    for (const cat of categoryData) {
      const fp = MODEL_FINGERPRINTS[cat.model_id as ModelId];
      if (fp) {
        if (!fp.categoryStats) fp.categoryStats = {};
        // Merge with existing stats
        const existing = fp.categoryStats[cat.category] || { attempts: 0, successes: 0 };
        fp.categoryStats[cat.category] = {
          attempts: existing.attempts + cat.attempts,
          successes: existing.successes + cat.successes,
        };
      }
    }
  } catch (err) {
    // Silently fail - fingerprints will use defaults
    console.warn('Failed to load persisted fingerprints:', err);
  }
}

/**
 * OPT 8: Persist fingerprint updates to SQLite
 */
function persistFingerprintUpdate(modelId: ModelId): void {
  try {
    const db = getFingerprintDb();
    const fp = MODEL_FINGERPRINTS[modelId];
    if (!fp) return;
    
    db.prepare(`
      INSERT OR REPLACE INTO fingerprint_updates (model_id, avg_latency_ms, success_rate, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(modelId, fp.avgLatencyMs, fp.successRate, Date.now());
  } catch (err) {
    console.warn('Failed to persist fingerprint update:', err);
  }
}

/**
 * OPT 8: Persist category stats to SQLite
 */
function persistCategoryStats(modelId: ModelId, category: string): void {
  try {
    const db = getFingerprintDb();
    const fp = MODEL_FINGERPRINTS[modelId];
    const stats = fp?.categoryStats?.[category];
    if (!stats) return;
    
    db.prepare(`
      INSERT OR REPLACE INTO category_stats (model_id, category, attempts, successes, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(modelId, category, stats.attempts, stats.successes, Date.now());
  } catch (err) {
    console.warn('Failed to persist category stats:', err);
  }
}

// Initialize on module load
loadPersistedFingerprints();

/**
 * Failure handlers for model-specific known issues
 */
const FAILURE_HANDLERS: Record<string, {
  action: 'add_context' | 'reduce_context' | 'switch_model';
  context?: string;
  fallbackModel?: ModelId;
}> = {
  'gpt-5.2-codex:permission_denied': {
    action: 'add_context',
    context: 'Do not attempt file operations. Return code only.',
    fallbackModel: 'gpt-5.2',
  },
  'glm-4.7:timeout': {
    action: 'reduce_context',
    fallbackModel: 'gpt-5.2',
  },
  'glm-4.7:context_overflow': {
    action: 'reduce_context',
    fallbackModel: 'gpt-5.2',
  },
};

/**
 * OPTIMIZATION 5: Enhanced per-category scoring with confidence weighting
 * Score a model for a given task using category-specific success rates
 */
function scoreModel(
  model: ModelFingerprint,
  classification: TaskClassification,
  difficulty: 'easy' | 'medium' | 'hard',
  config: RoutingConfig,
): number {
  let score = 0;

  // Category match bonus - INCREASED weight for proven categories
  if (model.bestCategories.includes(classification.category)) {
    score += 40; // Increased from 30
  }

  // Complexity match
  if (COMPLEXITY_RANK[model.maxComplexity] >= COMPLEXITY_RANK[difficulty]) {
    score += 20;
  } else {
    score -= 50; // Penalty for difficulty exceeding capability
  }

  // OPTIMIZATION 5: Use per-category success rate with confidence weighting
  // If we have enough data (>=3 attempts), weight category rate 2x higher than global
  const categoryRate = getCategorySuccessRate(model, classification.category);
  const categoryAttempts = model.categoryStats?.[classification.category]?.attempts || 0;
  
  let effectiveSuccessRate: number;
  if (categoryRate !== null && categoryAttempts >= 3) {
    // Blend category and global rates, weighted by sample size confidence
    const confidence = Math.min(categoryAttempts / 10, 1); // Max confidence at 10 samples
    effectiveSuccessRate = categoryRate * confidence + model.successRate * (1 - confidence);
    // Bonus for having category-specific data
    score += 10;
  } else {
    effectiveSuccessRate = model.successRate;
  }

  // Success rate (0-30 points) - INCREASED from 25
  score += effectiveSuccessRate * 30;

  // Latency preference (0-15 points)
  if (config.preferLatency) {
    const latencyScore = Math.max(0, 1 - (model.avgLatencyMs / 120000));
    score += latencyScore * 15;
  }

  // Accuracy preference bonus
  if (config.preferAccuracy) {
    score += effectiveSuccessRate * 10;
  }

  // Cost constraint
  if (model.costPerTask > config.maxCostPerTask) {
    score -= 20;
  }

  // Latency constraint
  if (model.avgLatencyMs > config.maxLatencyMs) {
    score -= 30;
  }

  // Keyword match with model strengths - INCREASED weight
  const taskKeywords = classification.keywords.map(k => k.toLowerCase());
  for (const strength of model.strengths) {
    if (taskKeywords.some(kw => strength.includes(kw) || kw.includes(strength))) {
      score += 8; // Increased from 5
    }
  }

  return score;
}

/**
 * Get per-category success rate if enough data exists (>=3 attempts)
 * Returns null if not enough data, allowing fallback to global rate
 */
function getCategorySuccessRate(model: ModelFingerprint, category: string): number | null {
  const stats = model.categoryStats?.[category];
  if (!stats || stats.attempts < 3) return null;
  return stats.successes / stats.attempts;
}

/**
 * Route a task to the best model
 */
export function routeTask(
  instruction: string,
  difficulty: 'easy' | 'medium' | 'hard' = 'medium',
  config: Partial<RoutingConfig> = {},
): RoutingDecision {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const classification = classifyTask(instruction);

  // Score all available models
  const scored = cfg.availableModels
    .filter(id => MODEL_FINGERPRINTS[id])
    .map(id => ({
      id,
      fingerprint: MODEL_FINGERPRINTS[id],
      score: scoreModel(MODEL_FINGERPRINTS[id], classification, difficulty, cfg),
    }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      primary: 'gpt-5.2',
      fallback: ['claude-opus-4.5'],
      reason: 'No available models matched, defaulting to GPT 5.2',
      estimatedLatencyMs: 21286,
      estimatedSuccessRate: 0.875,
      estimatedCost: 0.005,
    };
  }

  const primary = scored[0];
  const fallbacks = scored.slice(1).map(s => s.id);

  return {
    primary: primary.id,
    fallback: fallbacks,
    reason: `${primary.id} selected for ${classification.category}/${difficulty} task (score: ${primary.score.toFixed(0)})`,
    estimatedLatencyMs: primary.fingerprint.avgLatencyMs,
    estimatedSuccessRate: primary.fingerprint.successRate,
    estimatedCost: primary.fingerprint.costPerTask,
  };
}

/**
 * Get failure handler for a model-specific error
 */
export function getFailureHandler(modelId: ModelId, errorType: string): typeof FAILURE_HANDLERS[string] | null {
  return FAILURE_HANDLERS[`${modelId}:${errorType}`] || null;
}

/**
 * Get model fingerprint
 */
export function getModelFingerprint(modelId: ModelId): ModelFingerprint | null {
  return MODEL_FINGERPRINTS[modelId] || null;
}

/**
 * Get all model fingerprints
 */
export function getAllModelFingerprints(): Record<ModelId, ModelFingerprint> {
  return { ...MODEL_FINGERPRINTS };
}

/**
 * Update model fingerprint with new benchmark data
 */
export function updateModelFingerprint(
  modelId: ModelId,
  updates: Partial<Pick<ModelFingerprint, 'avgLatencyMs' | 'successRate' | 'costPerTask'>>,
): void {
  const fp = MODEL_FINGERPRINTS[modelId];
  if (!fp) return;

  if (updates.avgLatencyMs !== undefined) {
    // Exponential moving average
    fp.avgLatencyMs = fp.avgLatencyMs * 0.7 + updates.avgLatencyMs * 0.3;
  }
  if (updates.successRate !== undefined) {
    fp.successRate = fp.successRate * 0.7 + updates.successRate * 0.3;
  }
  if (updates.costPerTask !== undefined) {
    fp.costPerTask = updates.costPerTask;
  }
}

/**
 * Record task outcome to update model fingerprints (feedback loop)
 * Call this after each task completes to improve future routing decisions
 * OPT 8: Now persists to SQLite for cross-session learning
 */
export function recordTaskOutcome(
  modelId: ModelId,
  success: boolean,
  latencyMs: number,
  taskCategory?: string
): void {
  const fp = MODEL_FINGERPRINTS[modelId];
  if (!fp) return;
  
  // Update global success rate using exponential moving average
  const newSuccessRate = success ? 1.0 : 0.0;
  fp.successRate = fp.successRate * 0.9 + newSuccessRate * 0.1;
  
  // Update latency using exponential moving average
  fp.avgLatencyMs = fp.avgLatencyMs * 0.8 + latencyMs * 0.2;
  
  // OPT 8: Persist global fingerprint update
  persistFingerprintUpdate(modelId);
  
  // Update per-category stats if category provided
  if (taskCategory) {
    if (!fp.categoryStats) fp.categoryStats = {};
    if (!fp.categoryStats[taskCategory]) {
      fp.categoryStats[taskCategory] = { attempts: 0, successes: 0 };
    }
    fp.categoryStats[taskCategory].attempts++;
    if (success) {
      fp.categoryStats[taskCategory].successes++;
    }
    
    // OPT 8: Persist category stats
    persistCategoryStats(modelId, taskCategory);
  }
}

/**
 * Get routing recommendation with explanation
 */
export function explainRouting(instruction: string, difficulty: 'easy' | 'medium' | 'hard' = 'medium'): string {
  const decision = routeTask(instruction, difficulty);
  const fingerprint = MODEL_FINGERPRINTS[decision.primary];
  
  const lines = [
    `Primary Model: ${decision.primary}`,
    `Reason: ${decision.reason}`,
    `Expected Latency: ${(decision.estimatedLatencyMs / 1000).toFixed(1)}s`,
    `Expected Success: ${(decision.estimatedSuccessRate * 100).toFixed(0)}%`,
    `Strengths: ${fingerprint?.strengths.slice(0, 3).join(', ') || 'N/A'}`,
    `Fallbacks: ${decision.fallback.join(' -> ') || 'None'}`,
  ];
  
  return lines.join('\n');
}

/**
 * OPT 8: Close fingerprint database connection
 */
export function closeFingerprintDb(): void {
  if (fingerprintDb) {
    fingerprintDb.close();
    fingerprintDb = null;
  }
}

/**
 * OPT 8: Force reload fingerprints from database
 */
export function reloadFingerprints(): void {
  loadPersistedFingerprints();
}

export const ModelRouter = {
  routeTask,
  getFailureHandler,
  getModelFingerprint,
  getAllModelFingerprints,
  updateModelFingerprint,
  recordTaskOutcome,
  explainRouting,
  closeFingerprintDb,
  reloadFingerprints,
};

export default ModelRouter;
