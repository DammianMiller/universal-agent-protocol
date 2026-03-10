/**
 * Multi-Model Architecture
 * 
 * Exports for the two-tier agentic architecture:
 * - Router: Task classification and model selection
 * - Planner: Task decomposition and execution planning
 * - Executor: Subtask execution with retry/fallback
 */

// Types
export * from './types.js';

// Router
export {
  ModelRouter,
  createRouter,
  createCostOptimizedRouter,
  createPerformanceRouter,
} from './router.js';

// Planner
export {
  TaskPlanner,
  createPlanner,
} from './planner.js';
export type { PlannerOptions } from './planner.js';

// Executor
export {
  TaskExecutor,
  createExecutor,
  MockModelClient,
} from './executor.js';
export type {
  ModelClient,
  ExecutionContext,
  ExecutorOptions,
} from './executor.js';
