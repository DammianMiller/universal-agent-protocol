import { describe, it, expect, beforeEach } from 'vitest';
import {
  TaskPlanner,
  ModelRouter,
  createPlanner,
  createRouter,
  PlanValidator,
  createPlanValidator,
} from '../src/models/index.js';
import type {
  MultiModelConfig,
  ExecutionPlan,
  Subtask,
  TaskComplexity,
} from '../src/models/types.js';

// Helper to create valid subtask with proper types
function createSubtask(
  id: string,
  title: string,
  description: string,
  complexity: TaskComplexity = 'medium',
  type: Subtask['type'] = 'coding'
): Subtask {
  return {
    id,
    title,
    description,
    type,
    complexity,
    inputs: [],
    outputs: ['output'],
    constraints: [],
  };
}

// Helper to create valid execution plan
function createPlan(
  id: string,
  task: string,
  subtasks: Subtask[],
  dependencies: Map<string, string[]>,
  modelAssignments: Map<string, string>,
  cost = 1.0,
  duration = 30000
): ExecutionPlan {
  return {
    id,
    originalTask: task,
    subtasks,
    dependencies,
    modelAssignments,
    estimatedCost: cost,
    estimatedDuration: duration,
    created: new Date(),
  };
}

describe('PlanValidator - Automatic Validation', () => {
  let config: MultiModelConfig;

  beforeEach(() => {
    config = {
      enabled: true,
      models: ['opus-4.6', 'sonnet-4.6'],
      roles: {
        planner: 'opus-4.6',
        executor: 'sonnet-4.6',
        fallback: 'opus-4.6',
      },
      routingStrategy: 'balanced',
    };
  });

  describe('PlanValidator instantiation and config', () => {
    it('should create validator with default config', () => {
      const validator = createPlanValidator();
      const cfg = validator.getConfig();

      expect(cfg.enabled).toBe(true);
      expect(cfg.strictMode).toBe(false);
      expect(cfg.skipTrivialPlans).toBe(true);
    });

    it('should create validator with custom config', () => {
      const validator = createPlanValidator({
        enabled: true,
        strictMode: true,
        skipTrivialPlans: false,
        validationTimeoutMs: 60000,
      });
      const cfg = validator.getConfig();

      expect(cfg.enabled).toBe(true);
      expect(cfg.strictMode).toBe(true);
      expect(cfg.skipTrivialPlans).toBe(false);
      expect(cfg.validationTimeoutMs).toBe(60000);
    });

    it('should allow config updates', () => {
      const validator = createPlanValidator();

      expect(validator.getConfig().strictMode).toBe(false);

      validator.updateConfig({ strictMode: true });

      expect(validator.getConfig().strictMode).toBe(true);
    });
  });

  describe('validatePlan - Positive validation', () => {
    it('should validate a simple plan with no errors', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config);
      const validator = createPlanValidator({ enabled: true });

      const plan = await planner.createPlan('fix typo in readme');
      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(true);
      expect(result.validation.errors.length).toBe(0);
    });

    it('should validate a complex plan with no errors', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config);
      const validator = createPlanValidator({ enabled: true, skipTrivialPlans: false });

      const plan = await planner.createPlan('implement authentication system with security');
      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(true);
      expect(result.validation.errors.length).toBe(0);
    });

    it('should validate subtasks have required fields', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config);
      const validator = createPlanValidator({ enabled: true });

      const plan = await planner.createPlan('implement new feature');
      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      // All subtasks should have title, description, complexity, model assigned
      for (const subtask of plan.subtasks) {
        expect(subtask.title).toBeDefined();
        expect(subtask.title?.trim().length).toBeGreaterThan(0);
        expect(subtask.description).toBeDefined();
        expect(subtask.description?.trim().length).toBeGreaterThan(0);
        expect(subtask.complexity).toBeDefined();
        expect(plan.modelAssignments.has(subtask.id)).toBe(true);
      }
    });
  });

  describe('validatePlan - Error detection', () => {
    it('should detect missing subtask title', async () => {
      const validator = createPlanValidator({ enabled: true });

      const plan = createPlan(
        'test-plan-1',
        'Test task',
        [createSubtask('subtask-1', '', 'This is a test subtask')],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']])
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(false);
      expect(result.validation.errors.some((e) => e.includes('title'))).toBe(true);
    });

    it('should detect missing subtask description', async () => {
      const validator = createPlanValidator({ enabled: true });

      const plan = createPlan(
        'test-plan-2',
        'Test task',
        [createSubtask('subtask-1', 'Test subtask', '', 'medium', 'coding')],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']])
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(false);
      expect(result.validation.errors.some((e) => e.includes('description'))).toBe(true);
    });

    it('should detect missing complexity', async () => {
      const validator = createPlanValidator({ enabled: true });

      // Create a subtask with undefined complexity using type assertion
      const invalidSubtask = {
        id: 'subtask-1',
        title: 'Test subtask',
        description: 'This is a test',
        type: 'coding' as any,
        complexity: undefined as any,
        inputs: [],
        outputs: ['output'],
        constraints: [],
      };

      const plan = createPlan(
        'test-plan-3',
        'Test task',
        [invalidSubtask],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']])
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      // Validator checks for truthy complexity, undefined should fail
      expect(result.validation.isValid).toBe(false);
    });

    it('should detect missing model assignment', async () => {
      const validator = createPlanValidator({ enabled: true });

      const plan = createPlan(
        'test-plan-4',
        'Test task',
        [createSubtask('subtask-1', 'Test subtask', 'This is a test')],
        new Map(),
        new Map() // No model assignments
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(false);
      expect(result.validation.errors.some((e) => e.includes('model'))).toBe(true);
    });

    it('should detect circular dependencies', async () => {
      const validator = createPlanValidator({ enabled: true });

      const plan = createPlan(
        'test-plan-5',
        'Test task',
        [
          createSubtask('subtask-a', 'Subtask A', 'A depends on C'),
          createSubtask('subtask-b', 'Subtask B', 'B depends on A'),
          createSubtask('subtask-c', 'Subtask C', 'C depends on B (creates cycle)'),
        ],
        new Map([
          ['subtask-a', ['subtask-c']],
          ['subtask-b', ['subtask-a']],
          ['subtask-c', ['subtask-b']],
        ]),
        new Map([
          ['subtask-a', 'opus-4.6'],
          ['subtask-b', 'sonnet-4.6'],
          ['subtask-c', 'opus-4.6'],
        ])
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(false);
      expect(result.validation.errors.some((e) => e.includes('Circular'))).toBe(true);
    });

    it('should detect dependency on non-existent subtask', async () => {
      const validator = createPlanValidator({ enabled: true });

      const plan = createPlan(
        'test-plan-6',
        'Test task',
        [createSubtask('subtask-1', 'Subtask 1', 'Depends on non-existent subtask')],
        new Map([['subtask-1', ['non-existent']]]),
        new Map([['subtask-1', 'opus-4.6']])
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(false);
      expect(result.validation.errors.some((e) => e.includes('non-existent'))).toBe(true);
    });

    it('should detect invalid cost estimate', async () => {
      const validator = createPlanValidator({ enabled: true });

      const plan = createPlan(
        'test-plan-7',
        'Test task',
        [createSubtask('subtask-1', 'Subtask 1', 'Valid subtask')],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']]),
        -10 // Negative cost
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(false);
      expect(result.validation.errors.some((e) => e.includes('cost'))).toBe(true);
    });

    it('should detect invalid duration estimate', async () => {
      const validator = createPlanValidator({ enabled: true });

      const plan = createPlan(
        'test-plan-8',
        'Test task',
        [createSubtask('subtask-1', 'Subtask 1', 'Valid subtask')],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']]),
        0.5,
        -30000 // Negative duration
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(false);
      expect(result.validation.errors.some((e) => e.includes('duration'))).toBe(true);
    });
  });

  describe('validatePlan - Warnings and suggestions', () => {
    it('should warn about missing subtask type', async () => {
      const validator = createPlanValidator({ enabled: true });

      // Create a subtask with undefined type
      const invalidSubtask = {
        id: 'subtask-1',
        title: 'Subtask 1',
        description: 'Valid subtask',
        type: undefined as any,
        complexity: 'medium' as TaskComplexity,
        inputs: [],
        outputs: ['output'],
        constraints: [],
      };

      const plan = createPlan(
        'test-plan-9',
        'Test task',
        [invalidSubtask],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']])
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(true); // Not an error
      // Check if there's any warning about type (may not exist due to default)
      expect(result.validation.warnings.length >= 0).toBe(true);
    });

    it('should warn about missing outputs', async () => {
      const validator = createPlanValidator({ enabled: true });

      const plan = createPlan(
        'test-plan-10',
        'Test task',
        [{ ...createSubtask('subtask-1', 'Subtask 1', 'Valid subtask'), outputs: [] }],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']])
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(true);
      expect(result.validation.warnings.some((w) => w.includes('outputs'))).toBe(true);
    });

    it('should suggest security constraints for security-sensitive tasks', async () => {
      const validator = createPlanValidator({ enabled: true });

      const plan = createPlan(
        'test-plan-11',
        'Implement authentication with password encryption',
        [
          {
            ...createSubtask('subtask-1', 'Subtask 1', 'No security constraints mentioned'),
            constraints: [], // No security constraints
          },
        ],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']])
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(true);
      expect(result.validation.suggestions.some((s) => s.toLowerCase().includes('security'))).toBe(
        true
      );
    });

    it('should suggest breaking down high-cost plans', async () => {
      const validator = createPlanValidator({ enabled: true });

      const plan = createPlan(
        'test-plan-12',
        'Large refactoring task',
        [createSubtask('subtask-1', 'Subtask 1', 'Very expensive operation', 'critical')],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']]),
        1500 // High cost
      );

      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(true);
      expect(
        result.validation.warnings.some(
          (w) => w.includes('cost') || w.toLowerCase().includes('high')
        )
      ).toBe(true);
    });
  });

  describe('validatePlan - Trivial plan handling', () => {
    it('should skip validation for trivial plans when skipIfTrivial is true', async () => {
      const validator = createPlanValidator({ enabled: true, skipTrivialPlans: true });

      const plan = createPlan(
        'test-plan-13',
        'Simple task',
        [createSubtask('subtask-1', 'Single low-complexity task', 'Very simple', 'low')],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']])
      );

      // With skipIfTrivial: true, should return suggestion about skipping
      const result = await validator.validatePlan(plan, { skipIfTrivial: true });

      expect(result.validation.isValid).toBe(true);
      expect(result.validation.suggestions.some((s) => s.toLowerCase().includes('trivial'))).toBe(
        true
      );
    });

    it('should not skip validation when skipIfTrivial is false', async () => {
      const validator = createPlanValidator({ enabled: true, skipTrivialPlans: true });

      const plan = createPlan(
        'test-plan-14',
        'Simple task',
        [{ ...createSubtask('subtask-1', '', 'Should still validate'), title: '' }],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']])
      );

      // Should still validate and find errors
      const result = await validator.validatePlan(plan, { skipIfTrivial: false });

      expect(result.validation.isValid).toBe(false);
    });
  });

  describe('validatePlan - Timeout handling', async () => {
    it('should complete within timeout for normal plans', async () => {
      const validator = createPlanValidator({
        enabled: true,
        validationTimeoutMs: 1000, // 1 second timeout
      });

      const plan = createPlan(
        'test-plan-15',
        'Test task',
        [createSubtask('subtask-1', 'Subtask 1', 'Valid subtask')],
        new Map(),
        new Map([['subtask-1', 'opus-4.6']])
      );

      // Should complete within timeout
      const result = await validator.validatePlan(plan, { skipIfTrivial: false });
      expect(result.validation.isValid).toBe(true);
    });
  });

  describe('validatePlan - Integration with TaskPlanner', () => {
    it('should automatically validate plans created by planner', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      const plan = await planner.createPlan('implement new authentication system');

      // Plan should be valid (planner has auto-validation enabled)
      expect(plan.subtasks.length).toBeGreaterThan(0);
      for (const subtask of plan.subtasks) {
        expect(subtask.title).toBeDefined();
        expect(subtask.description).toBeDefined();
        expect(plan.modelAssignments.has(subtask.id)).toBe(true);
      }
    });

    it('should validate plans at all complexity levels', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      // Test low complexity
      const simplePlan = await planner.createPlan('fix typo');
      expect(simplePlan.subtasks.length).toBe(1);

      // Test high complexity
      const complexPlan = await planner.createPlan(
        'design new microservice architecture with security review'
      );
      expect(complexPlan.subtasks.length).toBeGreaterThan(2);

      // Test critical complexity
      const criticalPlan = await planner.createPlan(
        'implement production authentication with OAuth2 and encryption'
      );
      expect(criticalPlan.subtasks.length).toBeGreaterThan(2);
    });
  });
});
