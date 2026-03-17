import type { ExecutionPlan, Subtask } from '../models/types.js';

export interface PlanValidationConfig {
  enabled?: boolean;
  strictMode?: boolean;
  skipTrivialPlans?: boolean;
  validationTimeoutMs?: number;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
  validationTimeMs: number;
}

export interface PlanValidationResult {
  plan: ExecutionPlan;
  validation: ValidationResult;
  revisedPlan?: ExecutionPlan;
}

export class PlanValidator {
  private config: PlanValidationConfig;

  constructor(config: PlanValidationConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      strictMode: config.strictMode ?? false,
      skipTrivialPlans: config.skipTrivialPlans ?? true,
      validationTimeoutMs: config.validationTimeoutMs ?? 300000,
    };
  }

  async validatePlan(
    plan: ExecutionPlan,
    options: { skipIfTrivial?: boolean } = {}
  ): Promise<PlanValidationResult> {
    const startTime = Date.now();
    const timeoutMs = this.config.validationTimeoutMs || 300000;

    if (this.config.skipTrivialPlans && options.skipIfTrivial !== false) {
      if (this.isTrivialPlan(plan)) {
        return {
          plan,
          validation: {
            isValid: true,
            errors: [],
            warnings: [],
            suggestions: ['Plan is trivial, validation skipped'],
            validationTimeMs: Date.now() - startTime,
          },
        };
      }
    }

    // Enforce validation timeout
    const validationPromise = this.runValidation(plan, startTime);
    const timeoutPromise = new Promise<PlanValidationResult>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Plan validation timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    );

    return Promise.race([validationPromise, timeoutPromise]);
  }

  private async runValidation(
    plan: ExecutionPlan,
    startTime: number
  ): Promise<PlanValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    this.validateSubtasks(plan.subtasks, errors, warnings, suggestions);
    this.validateDependencies(plan, errors, warnings, suggestions);
    this.validateModelAssignments(plan, errors, warnings, suggestions);
    this.validateConstraints(plan, errors, warnings, suggestions);
    this.validateCostEstimate(plan, errors, warnings, suggestions);

    const validationResult: ValidationResult = {
      isValid: errors.length === 0,
      errors,
      warnings,
      suggestions,
      validationTimeMs: Date.now() - startTime,
    };

    return {
      plan,
      validation: validationResult,
    };
  }

  private isTrivialPlan(plan: ExecutionPlan): boolean {
    return plan.subtasks.length === 1 && plan.subtasks[0].complexity === 'low';
  }

  private validateSubtasks(
    subtasks: Subtask[],
    errors: string[],
    warnings: string[],
    suggestions: string[]
  ): void {
    for (const subtask of subtasks) {
      if (!subtask.title || subtask.title.trim().length === 0) {
        errors.push(`Subtask ${subtask.id}: Missing or empty title`);
      }
      if (!subtask.description || subtask.description.trim().length === 0) {
        errors.push(`Subtask ${subtask.id}: Missing or empty description`);
      }
      if (!subtask.complexity) {
        errors.push(`Subtask ${subtask.id}: Missing complexity`);
      }
      if (!subtask.type) {
        warnings.push(`Subtask ${subtask.id}: Missing type, defaulting to 'task'`);
      }
      if (subtask.outputs.length === 0) {
        warnings.push(`Subtask ${subtask.id}: No outputs defined`);
      }
      if (this.config.strictMode && subtask.constraints.length === 0) {
        suggestions.push(`Subtask ${subtask.id}: Consider adding constraints for better quality`);
      }
    }

    const titles = subtasks.map((s) => s.title);
    const duplicates = new Set(titles.filter((t, i, a) => a.indexOf(t) !== i));
    if (duplicates.size > 0) {
      warnings.push(`Duplicate subtask titles: ${Array.from(duplicates).join(', ')}`);
    }
  }

  private validateDependencies(
    plan: ExecutionPlan,
    errors: string[],
    _warnings: string[],
    _suggestions: string[]
  ): void {
    const subtaskIds = new Set(plan.subtasks.map((s) => s.id));
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const hasCycle = (nodeId: string): boolean => {
      visited.add(nodeId);
      recStack.add(nodeId);
      const deps = plan.dependencies.get(nodeId) || [];
      for (const dep of deps) {
        if (!visited.has(dep)) {
          if (hasCycle(dep)) return true;
        } else if (recStack.has(dep)) {
          return true;
        }
      }
      recStack.delete(nodeId);
      return false;
    };

    for (const subtask of plan.subtasks) {
      if (hasCycle(subtask.id)) {
        errors.push('Circular dependency detected in plan');
        break;
      }
    }

    for (const [subtaskId, deps] of plan.dependencies.entries()) {
      for (const dep of deps) {
        if (!subtaskIds.has(dep)) {
          errors.push(`Subtask ${subtaskId} depends on non-existent subtask ${dep}`);
        }
      }
    }
  }

  private validateModelAssignments(
    plan: ExecutionPlan,
    errors: string[],
    _warnings: string[],
    _suggestions: string[]
  ): void {
    for (const subtask of plan.subtasks) {
      const modelId = plan.modelAssignments.get(subtask.id);
      if (!modelId) {
        errors.push(`Subtask ${subtask.id}: No model assigned`);
      }
    }
  }

  private validateConstraints(
    plan: ExecutionPlan,
    _errors: string[],
    warnings: string[],
    suggestions: string[]
  ): void {
    let hasSecurityConstraints = false;
    let hasPerformanceConstraints = false;

    for (const subtask of plan.subtasks) {
      if (subtask.constraints) {
        for (const constraint of subtask.constraints) {
          if (constraint.toLowerCase().includes('security')) {
            hasSecurityConstraints = true;
          }
          if (
            constraint.toLowerCase().includes('performance') ||
            constraint.toLowerCase().includes('latency')
          ) {
            hasPerformanceConstraints = true;
          }
        }
      }
    }

    const securityKeywords = ['security', 'auth', 'password', 'encrypt', 'cert', 'ssl', 'tls'];
    const taskText = (
      plan.originalTask +
      ' ' +
      plan.subtasks.map((s) => s.description).join(' ')
    ).toLowerCase();

    if (securityKeywords.some((k) => taskText.includes(k)) && !hasSecurityConstraints) {
      suggestions.push('Task appears security-sensitive but lacks explicit security constraints');
    }

    const perfKeywords = ['performance', 'latency', 'throughput', 'scale', 'optimiz'];
    if (perfKeywords.some((k) => taskText.includes(k)) && !hasPerformanceConstraints) {
      warnings.push(
        'Task appears performance-sensitive but lacks explicit performance constraints'
      );
    }
  }

  private validateCostEstimate(
    plan: ExecutionPlan,
    errors: string[],
    warnings: string[],
    suggestions: string[]
  ): void {
    if (plan.estimatedCost < 0) {
      errors.push(`Invalid cost estimate: ${plan.estimatedCost}`);
    }
    if (plan.estimatedCost > 1000) {
      warnings.push(`High cost estimate: $${plan.estimatedCost.toFixed(2)}`);
      suggestions.push('Consider breaking down into smaller subtasks to reduce cost');
    }
    if (plan.estimatedDuration < 0) {
      errors.push(`Invalid duration estimate: ${plan.estimatedDuration}`);
    }
    if (plan.estimatedDuration > 86400000) {
      warnings.push(
        `Very long duration estimate: ${Math.round(plan.estimatedDuration / 3600000)} hours`
      );
    }
  }

  getConfig(): PlanValidationConfig {
    return { ...this.config };
  }

  updateConfig(config: PlanValidationConfig): void {
    this.config = { ...this.config, ...config };
  }
}

export function createPlanValidator(config?: PlanValidationConfig): PlanValidator {
  return new PlanValidator(config);
}
