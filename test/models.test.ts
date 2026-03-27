import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModelRouter,
  createRouter,
  createCostOptimizedRouter,
  createPerformanceRouter,
  TaskPlanner,
  createPlanner,
  TaskExecutor,
  createExecutor,
  MockModelClient,
  ModelPresets,
  MultiModelConfig,
} from '../src/models/index.js';

describe('ModelRouter', () => {
  let router: ModelRouter;
  let config: MultiModelConfig;

  beforeEach(() => {
    config = {
      enabled: true,
      models: ['opus-4.6', 'sonnet-4.6', 'haiku'],
      roles: {
        planner: 'opus-4.6',
        executor: 'sonnet-4.6',
        fallback: 'haiku',
      },
      routingStrategy: 'balanced',
    };
    router = createRouter(config);
  });

  describe('classifyTask', () => {
    it('should classify simple bug fix as low complexity', () => {
      const result = router.classifyTask('fix typo in readme');
      expect(result.complexity).toBe('low');
      expect(result.requiresPlanning).toBe(false);
    });

    it('should classify security task as critical', () => {
      const result = router.classifyTask('implement authentication with OAuth2');
      expect(result.complexity).toBe('critical');
      expect(result.requiresPlanning).toBe(true);
    });

    it('should classify architecture task as high complexity', () => {
      const result = router.classifyTask('design new microservice architecture');
      expect(result.complexity).toBe('high');
      expect(result.requiresPlanning).toBe(true);
    });

    it('should identify task type correctly', () => {
      const codingTask = router.classifyTask('implement new feature');
      expect(codingTask.taskType).toBe('coding');

      const bugFixTask = router.classifyTask('fix broken login');
      expect(bugFixTask.taskType).toBe('bug-fix');

      const reviewTask = router.classifyTask('review pull request');
      expect(reviewTask.taskType).toBe('review');
    });

    it('should extract keywords', () => {
      const result = router.classifyTask('implement authentication system with security');
      expect(result.keywords).toContain('security');
      expect(result.keywords).toContain('authentication');
    });
  });

  describe('selectModel', () => {
    it('should route critical tasks to planner', () => {
      const selection = router.selectModel('critical', 'planning', ['security']);
      expect(selection.role).toBe('planner');
    });

    it('should route simple tasks to executor', () => {
      const selection = router.selectModel('low', 'coding', []);
      expect(selection.role).toBe('executor');
    });

    it('should include fallback model', () => {
      const selection = router.selectModel('medium', 'coding', []);
      expect(selection.fallback).toBeDefined();
      expect(selection.fallback?.id).toBe('haiku');
    });
  });

  describe('estimateCost', () => {
    it('should calculate cost correctly', () => {
      const model = ModelPresets['opus-4.6'];
      const cost = router.estimateCost(model, 10000, 5000);
      // Input: 10K * $7.5/1M = $0.075
      // Output: 5K * $37.5/1M = $0.1875
      // Total: $0.2625
      expect(cost).toBeCloseTo(0.2625, 4);
    });

    it('should return 0 for models without cost info', () => {
      const model = { ...ModelPresets['opus-4.6'], costPer1MInput: undefined, costPer1MOutput: undefined };
      const cost = router.estimateCost(model, 10000, 5000);
      expect(cost).toBe(0);
    });
  });

  describe('analyzeRouting', () => {
    it('should return complete analysis', () => {
      const analysis = router.analyzeRouting('implement secure authentication');

      expect(analysis.classification).toBeDefined();
      expect(analysis.matchedRules).toBeDefined();
      expect(analysis.matchedRules.length).toBeGreaterThan(0);
      expect(analysis.costComparison).toBeDefined();
      expect(analysis.costComparison.length).toBe(3);
    });
  });
});

describe('TaskPlanner', () => {
  let router: ModelRouter;
  let planner: TaskPlanner;
  let config: MultiModelConfig;

  beforeEach(() => {
    config = {
      enabled: true,
      models: ['opus-4.6', 'qwen35-a3b'],
      roles: {
        planner: 'opus-4.6',
        executor: 'qwen35-a3b',
        fallback: 'opus-4.6',
      },
      routingStrategy: 'balanced',
    };
    router = createRouter(config);
    planner = createPlanner(router, config);
  });

  describe('createPlan', () => {
    it('should create single subtask for simple tasks', async () => {
      const plan = await planner.createPlan('fix typo in readme');
      
      expect(plan.subtasks.length).toBe(1);
      expect(plan.subtasks[0].title).toBe('Execute task');
    });

    it('should decompose complex tasks', async () => {
      const plan = await planner.createPlan('implement new authentication system with security review');
      
      expect(plan.subtasks.length).toBeGreaterThan(1);
      expect(plan.subtasks.some(s => s.type === 'planning')).toBe(true);
      expect(plan.subtasks.some(s => s.type === 'coding')).toBe(true);
      expect(plan.subtasks.some(s => s.type === 'review')).toBe(true);
    });

    it('should assign models to subtasks', async () => {
      const plan = await planner.createPlan('implement new feature');
      
      for (const subtask of plan.subtasks) {
        expect(plan.modelAssignments.has(subtask.id)).toBe(true);
      }
    });

    it('should estimate cost and duration', async () => {
      const plan = await planner.createPlan('implement new feature');

      // Cost can be 0 for local models (qwen35 has 0 cost)
      expect(plan.estimatedCost).toBeGreaterThanOrEqual(0);
      expect(plan.estimatedDuration).toBeGreaterThan(0);
    });
  });

  describe('getExecutionOrder', () => {
    it('should return tasks in dependency order', async () => {
      const plan = await planner.createPlan('design and implement new architecture');
      const order = planner.getExecutionOrder(plan);
      
      expect(order.length).toBeGreaterThan(0);
      // First level should have no dependencies
      const firstLevelIds = new Set(order[0]);
      for (const taskId of firstLevelIds) {
        const deps = plan.dependencies.get(taskId) || [];
        expect(deps.length).toBe(0);
      }
    });
  });

  describe('visualizePlan', () => {
    it('should generate readable visualization', async () => {
      const plan = await planner.createPlan('implement feature');
      const viz = planner.visualizePlan(plan);
      
      expect(viz).toContain('Execution Plan');
      expect(viz).toContain('Subtasks');
      expect(viz).toContain('Estimated Cost');
    });
  });
});

describe('TaskExecutor', () => {
  let router: ModelRouter;
  let planner: TaskPlanner;
  let executor: TaskExecutor;
  let config: MultiModelConfig;

  beforeEach(() => {
    config = {
      enabled: true,
      models: ['opus-4.6', 'haiku'],
      roles: {
        planner: 'opus-4.6',
        executor: 'haiku',
        fallback: 'opus-4.6',
      },
      routingStrategy: 'balanced',
    };
    router = createRouter(config);
    planner = createPlanner(router, config);
    
    const mockClient = new MockModelClient({
      'implement': 'function example() { return "implemented"; }',
      'test': 'describe("test", () => { it("works", () => {}); });',
    }, 100);
    
    executor = createExecutor(router, config, mockClient);
  });

  describe('executePlan', () => {
    it('should execute simple plan', async () => {
      const plan = await planner.createPlan('fix typo');
      const results = await executor.executePlan(plan, planner);
      
      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);
    });

    it('should track execution results', async () => {
      const plan = await planner.createPlan('implement feature');
      await executor.executePlan(plan, planner);
      
      const results = executor.getResults(plan.id);
      expect(results).toBeDefined();
      expect(results!.length).toBeGreaterThan(0);
    });

    it('should calculate total cost', async () => {
      const plan = await planner.createPlan('implement feature');
      await executor.executePlan(plan, planner);
      
      const cost = executor.getTotalCost(plan.id);
      expect(cost).toBeGreaterThanOrEqual(0);
    });

    it('should generate summary', async () => {
      const plan = await planner.createPlan('implement feature');
      await executor.executePlan(plan, planner);
      
      const summary = executor.generateSummary(plan.id);
      expect(summary).toContain('Execution Summary');
      expect(summary).toContain('Success Rate');
    });
  });
});

describe('Factory Functions', () => {
  describe('createCostOptimizedRouter', () => {
    it('should use cost-optimized settings', () => {
      const router = createCostOptimizedRouter();
      const models = router.getAllModels();

      expect(models.some(m => m.id === 'haiku')).toBe(true);
      expect(models.some(m => m.id === 'qwen35-a3b')).toBe(true);
    });
  });

  describe('createPerformanceRouter', () => {
    it('should use performance-first settings', () => {
      const router = createPerformanceRouter();
      const models = router.getAllModels();
      
      expect(models.some(m => m.id === 'opus-4.6')).toBe(true);
    });
  });
});

describe('ModelPresets', () => {
  it('should have opus-4.6 preset', () => {
    expect(ModelPresets['opus-4.6']).toBeDefined();
    expect(ModelPresets['opus-4.6'].provider).toBe('anthropic');
    expect(ModelPresets['opus-4.6'].costPer1MInput).toBe(7.5);
  });

  it('should have sonnet-4.6 preset', () => {
    expect(ModelPresets['sonnet-4.6']).toBeDefined();
    expect(ModelPresets['sonnet-4.6'].provider).toBe('anthropic');
    expect(ModelPresets['sonnet-4.6'].costPer1MInput).toBe(3.0);
  });

  it('should have haiku preset', () => {
    expect(ModelPresets['haiku']).toBeDefined();
    expect(ModelPresets['haiku'].provider).toBe('anthropic');
    expect(ModelPresets['haiku'].costPer1MInput).toBe(0.8);
  });

  it('should have qwen35-a3b preset', () => {
    expect(ModelPresets['qwen35-a3b']).toBeDefined();
    expect(ModelPresets['qwen35-a3b'].provider).toBe('custom');
    expect(ModelPresets['qwen35-a3b'].apiModel).toBe('qwen35-a3b-iq4xs');
  });

  it('should have gpt-5.4 preset', () => {
    expect(ModelPresets['gpt-5.4']).toBeDefined();
    expect(ModelPresets['gpt-5.4'].provider).toBe('openai');
    expect(ModelPresets['gpt-5.4'].costPer1MInput).toBe(2.5);
  });

  it('should have gpt-5.3-codex preset', () => {
    expect(ModelPresets['gpt-5.3-codex']).toBeDefined();
    expect(ModelPresets['gpt-5.3-codex'].provider).toBe('openai');
    expect(ModelPresets['gpt-5.3-codex'].costPer1MInput).toBe(3.0);
  });
});
