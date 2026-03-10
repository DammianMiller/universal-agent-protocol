/**
 * Task Planner
 * 
 * Tier 1 of the Multi-Model Architecture.
 * Responsible for:
 * - Task decomposition into subtasks
 * - Dependency analysis
 * - Model assignment for each subtask
 * - Quality assurance routing
 */

import { randomUUID } from 'crypto';
import {
  ExecutionPlan,
  Subtask,
  TaskComplexity,
  MultiModelConfig,
} from './types.js';
import { ModelRouter } from './router.js';

// UUID generator
const uuidv4 = (): string => randomUUID();

/**
 * Planner configuration options
 */
export interface PlannerOptions {
  maxSubtasks?: number;
  maxDepth?: number;
  enableParallelization?: boolean;
  estimateTokenBudget?: boolean;
}

const DEFAULT_OPTIONS: PlannerOptions = {
  maxSubtasks: 10,
  maxDepth: 3,
  enableParallelization: true,
  estimateTokenBudget: true,
};

/**
 * Task Planner - decomposes tasks and creates execution plans
 */
export class TaskPlanner {
  private router: ModelRouter;
  readonly config: MultiModelConfig;
  private options: PlannerOptions;

  constructor(
    router: ModelRouter,
    config: MultiModelConfig,
    options: PlannerOptions = {}
  ) {
    this.router = router;
    this.config = config;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Create an execution plan for a task
   */
  createPlan(taskDescription: string): ExecutionPlan {
    const planId = uuidv4();
    
    // Classify the overall task
    const classification = this.router.classifyTask(taskDescription);
    
    // Decompose if needed
    const subtasks = classification.requiresPlanning
      ? this.decomposeTask(taskDescription, classification.complexity)
      : [this.createSingleSubtask(taskDescription, classification)];
    
    // Build dependency graph
    const dependencies = this.analyzeDependencies(subtasks);
    
    // Assign models to subtasks
    const modelAssignments = this.assignModels(subtasks);
    
    // Estimate cost and duration
    const estimatedCost = this.estimateTotalCost(subtasks, modelAssignments);
    const estimatedDuration = this.estimateDuration(subtasks, dependencies);
    
    return {
      id: planId,
      originalTask: taskDescription,
      subtasks,
      dependencies,
      modelAssignments,
      estimatedCost,
      estimatedDuration,
      created: new Date(),
    };
  }

  /**
   * Decompose a complex task into subtasks
   */
  private decomposeTask(taskDescription: string, complexity: TaskComplexity): Subtask[] {
    const subtasks: Subtask[] = [];
    const lowerTask = taskDescription.toLowerCase();
    
    // Analysis/understanding phase
    if (complexity === 'high' || complexity === 'critical') {
      subtasks.push({
        id: uuidv4(),
        title: 'Analyze requirements',
        description: `Understand the requirements and constraints for: ${taskDescription}`,
        type: 'planning',
        complexity: 'medium',
        inputs: ['task_description'],
        outputs: ['requirements_analysis', 'constraints_list'],
        constraints: ['Must identify all edge cases', 'Must note dependencies'],
      });
    }
    
    // Design phase for architectural tasks
    if (lowerTask.includes('architecture') || lowerTask.includes('design') || lowerTask.includes('refactor')) {
      subtasks.push({
        id: uuidv4(),
        title: 'Design solution',
        description: 'Create detailed design for the solution including interfaces, patterns, and structure',
        type: 'planning',
        complexity: 'high',
        inputs: ['requirements_analysis'],
        outputs: ['design_document', 'interface_definitions'],
        constraints: ['Must follow SOLID principles', 'Must be testable'],
      });
    }
    
    // Implementation phase
    subtasks.push({
      id: uuidv4(),
      title: 'Implement solution',
      description: 'Write the code implementing the required functionality',
      type: 'coding',
      complexity: complexity === 'critical' ? 'high' : complexity,
      inputs: subtasks.length > 0 ? ['design_document'] : ['task_description'],
      outputs: ['source_code'],
      constraints: ['Must have proper error handling', 'Must be well-typed'],
    });
    
    // Testing phase
    if (complexity !== 'low') {
      subtasks.push({
        id: uuidv4(),
        title: 'Write tests',
        description: 'Create unit tests and integration tests for the implementation',
        type: 'coding',
        complexity: 'medium',
        inputs: ['source_code'],
        outputs: ['test_code'],
        constraints: ['Must achieve >80% coverage', 'Must test edge cases'],
      });
    }
    
    // Review phase for critical tasks
    if (complexity === 'critical' || lowerTask.includes('security')) {
      subtasks.push({
        id: uuidv4(),
        title: 'Security review',
        description: 'Review code for security vulnerabilities and best practices',
        type: 'review',
        complexity: 'high',
        inputs: ['source_code'],
        outputs: ['security_report', 'recommendations'],
        constraints: ['Must check OWASP top 10', 'Must verify input validation'],
      });
    }
    
    // Documentation for significant changes
    if (complexity === 'high' || complexity === 'critical') {
      subtasks.push({
        id: uuidv4(),
        title: 'Update documentation',
        description: 'Update documentation to reflect the changes',
        type: 'documentation',
        complexity: 'low',
        inputs: ['source_code', 'design_document'],
        outputs: ['documentation'],
        constraints: ['Must include usage examples', 'Must document breaking changes'],
      });
    }
    
    return subtasks;
  }

  /**
   * Create a single subtask for simple tasks
   */
  private createSingleSubtask(
    taskDescription: string,
    classification: { complexity: TaskComplexity; taskType: string }
  ): Subtask {
    return {
      id: uuidv4(),
      title: 'Execute task',
      description: taskDescription,
      type: classification.taskType as Subtask['type'],
      complexity: classification.complexity,
      inputs: ['task_description'],
      outputs: ['result'],
      constraints: [],
    };
  }

  /**
   * Analyze dependencies between subtasks
   */
  private analyzeDependencies(subtasks: Subtask[]): Map<string, string[]> {
    const dependencies = new Map<string, string[]>();
    
    // Build output-to-subtask mapping
    const outputProducers = new Map<string, string>();
    for (const subtask of subtasks) {
      for (const output of subtask.outputs) {
        outputProducers.set(output, subtask.id);
      }
    }
    
    // Find dependencies based on inputs
    for (const subtask of subtasks) {
      const deps: string[] = [];
      for (const input of subtask.inputs) {
        const producer = outputProducers.get(input);
        if (producer && producer !== subtask.id) {
          deps.push(producer);
        }
      }
      if (deps.length > 0) {
        dependencies.set(subtask.id, [...new Set(deps)]);
      }
    }
    
    return dependencies;
  }

  /**
   * Assign models to subtasks based on routing
   */
  private assignModels(subtasks: Subtask[]): Map<string, string> {
    const assignments = new Map<string, string>();
    
    for (const subtask of subtasks) {
      const selection = this.router.selectModel(
        subtask.complexity,
        subtask.type,
        [] // Could extract keywords from description
      );
      assignments.set(subtask.id, selection.model.id);
    }
    
    return assignments;
  }

  /**
   * Estimate total cost for the plan
   */
  private estimateTotalCost(
    subtasks: Subtask[],
    assignments: Map<string, string>
  ): number {
    let totalCost = 0;
    
    for (const subtask of subtasks) {
      const modelId = assignments.get(subtask.id);
      const model = modelId ? this.router.getModel(modelId) : undefined;
      
      if (model) {
        // Estimate tokens based on complexity
        const tokenMultiplier: Record<TaskComplexity, number> = {
          low: 1,
          medium: 2,
          high: 4,
          critical: 6,
        };
        const baseTokens = 5000;
        const estimatedTokens = baseTokens * tokenMultiplier[subtask.complexity];
        
        totalCost += this.router.estimateCost(model, estimatedTokens, estimatedTokens / 2);
      }
    }
    
    return totalCost;
  }

  /**
   * Estimate duration considering parallelization
   */
  private estimateDuration(
    subtasks: Subtask[],
    dependencies: Map<string, string[]>
  ): number {
    if (!this.options.enableParallelization) {
      // Sequential execution
      return subtasks.reduce((total, subtask) => {
        const baseTime = 30000; // 30 seconds base
        const multiplier: Record<TaskComplexity, number> = {
          low: 1,
          medium: 2,
          high: 4,
          critical: 6,
        };
        return total + baseTime * multiplier[subtask.complexity];
      }, 0);
    }
    
    // Parallel execution - find critical path
    const subtaskDurations = new Map<string, number>();
    for (const subtask of subtasks) {
      const baseTime = 30000;
      const multiplier: Record<TaskComplexity, number> = {
        low: 1,
        medium: 2,
        high: 4,
        critical: 6,
      };
      subtaskDurations.set(subtask.id, baseTime * multiplier[subtask.complexity]);
    }
    
    // Calculate earliest completion time for each subtask
    const completionTimes = new Map<string, number>();
    const queue = subtasks.filter(s => !dependencies.has(s.id)).map(s => s.id);
    
    while (queue.length > 0) {
      const subtaskId = queue.shift()!;
      const deps = dependencies.get(subtaskId) || [];
      const maxDepTime = deps.length > 0
        ? Math.max(...deps.map(d => completionTimes.get(d) || 0))
        : 0;
      completionTimes.set(subtaskId, maxDepTime + (subtaskDurations.get(subtaskId) || 0));
      
      // Add dependent subtasks to queue
      for (const subtask of subtasks) {
        const subtaskDeps = dependencies.get(subtask.id) || [];
        if (subtaskDeps.includes(subtaskId) && !completionTimes.has(subtask.id)) {
          const allDepsComplete = subtaskDeps.every(d => completionTimes.has(d));
          if (allDepsComplete) {
            queue.push(subtask.id);
          }
        }
      }
    }
    
    return Math.max(...Array.from(completionTimes.values()), 0);
  }

  /**
   * Get execution order respecting dependencies
   */
  getExecutionOrder(plan: ExecutionPlan): string[][] {
    const levels: string[][] = [];
    const completed = new Set<string>();
    const remaining = new Set(plan.subtasks.map(s => s.id));
    
    while (remaining.size > 0) {
      const currentLevel: string[] = [];
      
      for (const subtaskId of remaining) {
        const deps = plan.dependencies.get(subtaskId) || [];
        const allDepsComplete = deps.every(d => completed.has(d));
        
        if (allDepsComplete) {
          currentLevel.push(subtaskId);
        }
      }
      
      if (currentLevel.length === 0 && remaining.size > 0) {
        // Circular dependency or bug - just add remaining
        currentLevel.push(...remaining);
        remaining.clear();
      }
      
      for (const id of currentLevel) {
        remaining.delete(id);
        completed.add(id);
      }
      
      if (currentLevel.length > 0) {
        levels.push(currentLevel);
      }
    }
    
    return levels;
  }

  /**
   * Visualize the plan as text
   */
  visualizePlan(plan: ExecutionPlan): string {
    const lines: string[] = [
      `=== Execution Plan: ${plan.id.slice(0, 8)} ===`,
      `Task: ${plan.originalTask.slice(0, 80)}${plan.originalTask.length > 80 ? '...' : ''}`,
      `Estimated Cost: $${plan.estimatedCost.toFixed(4)}`,
      `Estimated Duration: ${Math.round(plan.estimatedDuration / 1000)}s`,
      '',
      'Subtasks:',
    ];
    
    const executionOrder = this.getExecutionOrder(plan);
    let level = 1;
    
    for (const levelTasks of executionOrder) {
      lines.push(`  Level ${level} (parallel):`);
      for (const taskId of levelTasks) {
        const subtask = plan.subtasks.find(s => s.id === taskId);
        const modelId = plan.modelAssignments.get(taskId);
        if (subtask) {
          lines.push(`    - [${subtask.complexity.toUpperCase()}] ${subtask.title}`);
          lines.push(`      Type: ${subtask.type}, Model: ${modelId || 'default'}`);
          const deps = plan.dependencies.get(taskId);
          if (deps && deps.length > 0) {
            lines.push(`      Depends on: ${deps.map(d => plan.subtasks.find(s => s.id === d)?.title || d).join(', ')}`);
          }
        }
      }
      level++;
    }
    
    return lines.join('\n');
  }
}

/**
 * Create a planner instance
 */
export function createPlanner(
  router: ModelRouter,
  config: MultiModelConfig,
  options?: PlannerOptions
): TaskPlanner {
  return new TaskPlanner(router, config, options);
}
