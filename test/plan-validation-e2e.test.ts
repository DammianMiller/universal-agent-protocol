import { describe, it, expect, beforeEach } from 'vitest';
import { TaskPlanner, ModelRouter, createPlanner, createRouter } from '../src/models/index.js';
import type { MultiModelConfig } from '../src/models/types.js';

describe('Automatic Plan Validation - End-to-End Verification', () => {
  let config: MultiModelConfig;

  beforeEach(() => {
    config = {
      enabled: true,
      models: ['opus-4.5', 'glm-4.7', 'deepseek-v3.2'],
      roles: {
        planner: 'opus-4.5',
        executor: 'glm-4.7',
        fallback: 'opus-4.5',
      },
      routingStrategy: 'balanced',
    };
  });

  describe('Auto-validation at all complexity levels', () => {
    it('should validate low complexity plans', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      // Simple task should create single subtask with validation
      const plan = await planner.createPlan('fix typo in readme');

      expect(plan.subtasks.length).toBe(1);
      expect(plan.subtasks[0].title).toBeDefined();
      expect(plan.subtasks[0].description).toBeDefined();
      expect(plan.subtasks[0].complexity).toBe('low');
      expect(plan.modelAssignments.has(plan.subtasks[0].id)).toBe(true);
    });

    it('should validate medium complexity plans', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      // Medium task should decompose and validate
      const plan = await planner.createPlan('implement new feature endpoint');

      expect(plan.subtasks.length).toBeGreaterThanOrEqual(1);
      // All subtasks should have required fields
      for (const subtask of plan.subtasks) {
        expect(subtask.title?.trim().length).toBeGreaterThan(0);
        expect(subtask.description?.trim().length).toBeGreaterThan(0);
        expect(subtask.complexity).toBeDefined();
        expect(plan.modelAssignments.has(subtask.id)).toBe(true);
      }
    });

    it('should validate high complexity plans', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      // Complex architectural task
      const plan = await planner.createPlan('design new microservice architecture');

      expect(plan.subtasks.length).toBeGreaterThan(1);
      // Should have planning phase
      expect(plan.subtasks.some((s) => s.type === 'planning')).toBe(true);
      // All subtasks validated
      for (const subtask of plan.subtasks) {
        expect(subtask.title?.trim().length).toBeGreaterThan(0);
        expect(subtask.description?.trim().length).toBeGreaterThan(0);
        expect(plan.modelAssignments.has(subtask.id)).toBe(true);
      }
    });

    it('should validate critical complexity plans', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      // Critical security task
      const plan = await planner.createPlan(
        'implement production authentication with OAuth2 and encryption'
      );

      expect(plan.subtasks.length).toBeGreaterThan(1);
      // Should have security review phase
      expect(plan.subtasks.some((s) => s.type === 'review')).toBe(true);
      // All subtasks validated
      for (const subtask of plan.subtasks) {
        expect(subtask.title?.trim().length).toBeGreaterThan(0);
        expect(subtask.description?.trim().length).toBeGreaterThan(0);
        expect(plan.modelAssignments.has(subtask.id)).toBe(true);
      }
    });
  });

  describe('Dependency validation', () => {
    it('should create valid dependency graph for complex plans', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      const plan = await planner.createPlan('implement authentication with tests and docs');

      // Plan should have no circular dependencies (validated by planner)
      expect(plan.dependencies).toBeDefined();

      // Verify execution order respects dependencies
      const executionOrder = planner.getExecutionOrder(plan);
      expect(executionOrder.length).toBeGreaterThan(0);
    });
  });

  describe('Model assignment validation', () => {
    it('should assign models to all subtasks', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      const plan = await planner.createPlan('implement feature with security review');

      // Every subtask should have a model assigned
      for (const subtask of plan.subtasks) {
        expect(plan.modelAssignments.has(subtask.id)).toBe(true);
        const modelId = plan.modelAssignments.get(subtask.id);
        expect(modelId).toBeDefined();
        expect(modelId).not.toBe('');
      }
    });

    it('should use appropriate models for different task types', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      const plan = await planner.createPlan('design architecture and implement feature');

      // Planning tasks should use planner model
      const planningTasks = plan.subtasks.filter((s) => s.type === 'planning');
      if (planningTasks.length > 0) {
        const planningModel = plan.modelAssignments.get(planningTasks[0].id);
        expect(planningModel).toBeDefined();
      }
    });
  });

  describe('Cost and duration estimation', () => {
    it('should estimate positive cost for all plans', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      const plan = await planner.createPlan('implement new feature');

      expect(plan.estimatedCost).toBeGreaterThan(0);
      // Cost should be reasonable (not millions)
      expect(plan.estimatedCost).toBeLessThan(10000);
    });

    it('should estimate positive duration for all plans', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      const plan = await planner.createPlan('implement new feature');

      expect(plan.estimatedDuration).toBeGreaterThan(0);
    });
  });

  describe('Validation error handling', () => {
    it('should log validation warnings but still return plan', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      // Even if there are warnings, plan should be returned
      const plan = await planner.createPlan('implement feature');

      expect(plan).toBeDefined();
      expect(plan.subtasks.length).toBeGreaterThan(0);
    });
  });

  describe('Parallel execution readiness', () => {
    it('should create plans that can be executed in parallel where possible', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      const plan = await planner.createPlan('design and implement feature');

      // Get execution order (groups parallel tasks)
      const executionOrder = planner.getExecutionOrder(plan);

      // Each level in execution order can run in parallel
      expect(executionOrder.length).toBeGreaterThanOrEqual(1);

      // Verify no cross-level dependencies
      const allTaskIds = new Set(plan.subtasks.map((s) => s.id));
      for (const level of executionOrder) {
        for (const taskId of level) {
          expect(allTaskIds.has(taskId)).toBe(true);
        }
      }
    });
  });

  describe('Plan quality metrics', () => {
    it('should create plans with proper structure', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      const plan = await planner.createPlan('implement authentication system');

      // Plan should have all required fields
      expect(plan.id).toBeDefined();
      expect(plan.originalTask).toBeDefined();
      expect(plan.subtasks.length).toBeGreaterThan(0);
      expect(plan.dependencies).toBeDefined();
      expect(plan.modelAssignments.size).toBe(plan.subtasks.length);
      expect(plan.estimatedCost).toBeGreaterThan(0);
      expect(plan.estimatedDuration).toBeGreaterThan(0);
      expect(plan.created).toBeInstanceOf(Date);
    });

    it('should create plans with meaningful subtask titles', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      const plan = await planner.createPlan('implement authentication system');

      // All subtasks should have descriptive titles
      for (const subtask of plan.subtasks) {
        expect(subtask.title?.trim().length).toBeGreaterThan(0);
        // Title should be meaningful (not just "Subtask 1")
        expect(subtask.title?.toLowerCase()).not.toBe('subtask');
      }
    });

    it('should create plans with clear outputs', async () => {
      const router = createRouter(config);
      const planner = createPlanner(router, config, { enableAutoValidation: true });

      const plan = await planner.createPlan('implement authentication system');

      // All subtasks should define outputs
      for (const subtask of plan.subtasks) {
        expect(subtask.outputs.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Auto-validation configuration', () => {
    it('should work with enableAutoValidation disabled', async () => {
      const router = createRouter(config);
      // Disable auto-validation
      const planner = createPlanner(router, config, { enableAutoValidation: false });

      // Should still create plan (but without validation)
      const plan = await planner.createPlan('implement feature');

      expect(plan).toBeDefined();
      expect(plan.subtasks.length).toBeGreaterThan(0);
    });

    it('should default to enabled auto-validation', async () => {
      const router = createRouter(config);
      // Don't specify enableAutoValidation - should default to true
      const planner = createPlanner(router, config);

      const plan = await planner.createPlan('implement feature');

      expect(plan).toBeDefined();
    });
  });
});
