import { describe, it, expect, beforeEach } from 'vitest';
import {
  CapabilityRouter,
  DEFAULT_CAPABILITY_MAPPINGS,
  type RoutingResult,
} from '../../src/coordination/capability-router.js';
import type { Task } from '../../src/tasks/types.js';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    description: 'A test task',
    type: 'task',
    priority: 'medium',
    status: 'pending',
    labels: [],
    assignee: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe('CapabilityRouter', () => {
  let router: CapabilityRouter;

  beforeEach(() => {
    router = new CapabilityRouter();
  });

  describe('routeTask', () => {
    it('should match TypeScript files to typescript capability', () => {
      const task = createTask({ title: 'Fix bug' });
      const result = router.routeTask(task, ['src/auth/login.ts']);
      expect(result.matchedCapabilities).toContain('typescript');
      expect(result.recommendedDroids).toContain('typescript-node-expert');
    });

    it('should match Python files to python capability', () => {
      const task = createTask({ title: 'Add feature' });
      const result = router.routeTask(task, ['scripts/migrate.py']);
      expect(result.matchedCapabilities).toContain('python');
    });

    it('should match CLI files to cli capability', () => {
      const task = createTask({ title: 'Fix CLI output' });
      const result = router.routeTask(task, ['src/cli/dashboard.ts']);
      expect(result.matchedCapabilities).toContain('cli');
      expect(result.recommendedDroids).toContain('cli-design-expert');
    });

    it('should match security files', () => {
      const task = createTask({ title: 'Fix auth' });
      const result = router.routeTask(task, ['src/auth/validate.ts']);
      expect(result.matchedCapabilities).toContain('security');
    });

    it('should match by task keyword', () => {
      const task = createTask({ title: 'security audit of endpoints', labels: ['security'] });
      const result = router.routeTask(task);
      expect(result.matchedCapabilities).toContain('security');
    });

    it('should match documentation files', () => {
      const task = createTask({ title: 'Update docs' });
      const result = router.routeTask(task, ['README.md', 'docs/api.md']);
      expect(result.matchedCapabilities).toContain('documentation');
    });

    it('should return confidence score between 0 and 1', () => {
      const task = createTask({ title: 'Fix TypeScript bug' });
      const result = router.routeTask(task, ['src/index.ts']);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should handle no matches gracefully', () => {
      const task = createTask({ title: 'Some generic task' });
      const result = router.routeTask(task);
      expect(result.matchedCapabilities).toBeDefined();
      expect(result.reasoning).toBeDefined();
    });

    it('should limit recommended droids to 3', () => {
      const task = createTask({ title: 'Update security typescript refactor performance' });
      const result = router.routeTask(task, [
        'src/auth/login.ts',
        'src/perf/bench.ts',
        'README.md',
      ]);
      expect(result.recommendedDroids.length).toBeLessThanOrEqual(3);
    });
  });

  describe('findBestAgent', () => {
    it('should return null for empty agent list', () => {
      const task = createTask();
      expect(router.findBestAgent(task, [])).toBeNull();
    });

    it('should prefer idle agents', () => {
      const task = createTask({ title: 'Fix TypeScript bug' });
      const agents = [
        { id: 'busy', name: 'agent-busy', status: 'active' as const, capabilities: ['typescript'], currentTask: 'other', registeredAt: '', lastHeartbeat: '' },
        { id: 'idle', name: 'agent-idle', status: 'idle' as const, capabilities: ['typescript'], currentTask: undefined, registeredAt: '', lastHeartbeat: '' },
      ];
      const match = router.findBestAgent(task, agents as any, ['src/index.ts']);
      expect(match).not.toBeNull();
      expect(match!.agent.id).toBe('idle');
    });

    it('should match agents by capabilities', () => {
      const task = createTask({ title: 'Fix Python bug' });
      const agents = [
        { id: 'ts', name: 'ts-agent', status: 'idle' as const, capabilities: ['typescript'], registeredAt: '', lastHeartbeat: '' },
        { id: 'py', name: 'py-agent', status: 'idle' as const, capabilities: ['python'], registeredAt: '', lastHeartbeat: '' },
      ];
      const match = router.findBestAgent(task, agents as any, ['scripts/test.py']);
      expect(match).not.toBeNull();
      expect(match!.agent.id).toBe('py');
    });
  });

  describe('routeFiles', () => {
    it('should categorize files by capability', () => {
      const result = router.routeFiles(['src/auth.ts', 'scripts/deploy.py', 'README.md']);
      expect(result.has('typescript')).toBe(true);
      expect(result.has('python')).toBe(true);
      expect(result.has('documentation')).toBe(true);
    });

    it('should handle empty file list', () => {
      const result = router.routeFiles([]);
      expect(result.size).toBe(0);
    });
  });

  describe('getParallelReviewDroids', () => {
    it('should always include quality and security droids', () => {
      const droids = router.getParallelReviewDroids(['src/index.ts']);
      expect(droids).toContain('code-quality-guardian');
      expect(droids).toContain('security-auditor');
    });

    it('should include capability-specific droids', () => {
      const droids = router.getParallelReviewDroids(['src/auth.ts']);
      expect(droids).toContain('typescript-node-expert');
    });

    it('should include doc reviewer for markdown changes', () => {
      const droids = router.getParallelReviewDroids(['README.md']);
      expect(droids).toContain('documentation-expert');
    });
  });

  describe('addMapping', () => {
    it('should add a new capability mapping', () => {
      router.addMapping({
        capability: 'frontend',
        droids: ['react-expert'],
        skills: [],
        filePatterns: ['*.tsx', '*.css'],
        taskTypes: ['task'],
        priority: 9,
      });
      const task = createTask({ title: 'Fix React component' });
      const result = router.routeTask(task, ['src/App.tsx']);
      expect(result.matchedCapabilities).toContain('frontend');
    });

    it('should update an existing mapping', () => {
      const before = router.getMappings().length;
      router.addMapping({
        capability: 'typescript',
        droids: ['custom-ts'],
        skills: [],
        filePatterns: ['*.ts'],
        taskTypes: ['task'],
        priority: 15,
      });
      expect(router.getMappings().length).toBe(before);
    });
  });

  describe('getMappings', () => {
    it('should return a copy of mappings', () => {
      const m1 = router.getMappings();
      const m2 = router.getMappings();
      expect(m1).not.toBe(m2);
      expect(m1).toEqual(m2);
    });

    it('should include default mappings', () => {
      expect(router.getMappings().length).toBe(DEFAULT_CAPABILITY_MAPPINGS.length);
    });
  });
});
