import { describe, it, expect } from 'vitest';
import { ModelRouter, createUAPRouter } from '../src/models/router.js';

describe('UAP Model Router Configuration', () => {
  it('should use opus-4.6 as the default planner', () => {
    const router = new ModelRouter(ModelRouter.getDefaultUAPConfig());
    const plannerModel = router.getModelForRole('planner');

    expect(plannerModel).toBeDefined();
    expect(plannerModel?.id).toBe('opus-4.6');
    expect(plannerModel?.name).toBe('Claude Opus 4.6');
  });

  it('should use qwen35 as the default executor', () => {
    const router = new ModelRouter(ModelRouter.getDefaultUAPConfig());
    const executorModel = router.getModelForRole('executor');

    expect(executorModel).toBeDefined();
    expect(executorModel?.id).toBe('qwen35');
    expect(executorModel?.name).toBe('Qwen 3.5 35B A3B (iq4xs)');
  });

  it('should use qwen35 as the default fallback', () => {
    const router = new ModelRouter(ModelRouter.getDefaultUAPConfig());
    const fallbackModel = router.getModelForRole('fallback');

    expect(fallbackModel).toBeDefined();
    expect(fallbackModel?.id).toBe('qwen35');
  });

  it('should classify planning tasks to use opus-4.6', () => {
    const router = new ModelRouter(ModelRouter.getDefaultUAPConfig());
    const result = router.classifyTask('Design the architecture for a new microservice');

    expect(result.requiresPlanning).toBe(true);
    expect(result.suggestedModel).toBe('opus-4.6');
  });

  it('should classify coding tasks to use qwen35', () => {
    const router = new ModelRouter(ModelRouter.getDefaultUAPConfig());
    const result = router.classifyTask(
      'Implement a simple calculator class with add and multiply methods'
    );

    expect(result.suggestedModel).toBe('qwen35');
  });

  it('should classify bug-fix tasks to use qwen35', () => {
    const router = new ModelRouter(ModelRouter.getDefaultUAPConfig());
    const result = router.classifyTask('Fix the null pointer exception in the login function');

    expect(result.suggestedModel).toBe('qwen35');
  });

  it('should classify high complexity tasks to use opus-4.6', () => {
    const router = new ModelRouter(ModelRouter.getDefaultUAPConfig());
    const result = router.classifyTask('Refactor the entire codebase to use async/await');

    expect(result.suggestedModel).toBe('opus-4.6');
  });

  it('should classify low complexity tasks to use qwen35', () => {
    const router = new ModelRouter(ModelRouter.getDefaultUAPConfig());
    const result = router.classifyTask('Add a comment explaining this function');

    expect(result.suggestedModel).toBe('qwen35');
  });

  it('createUAPRouter should return properly configured router', () => {
    const router = createUAPRouter();

    expect(router).toBeDefined();
    expect(router.getModelForRole('planner')?.id).toBe('opus-4.6');
    expect(router.getModelForRole('executor')?.id).toBe('qwen35');
    expect(router.getModelForRole('fallback')?.id).toBe('qwen35');
  });

  it('should have opus-4.6 and qwen35 in the models list', () => {
    const config = ModelRouter.getDefaultUAPConfig();

    expect(config.models).toContain('opus-4.6');
    expect(config.models).toContain('qwen35');
  });
});
