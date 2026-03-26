import { describe, it, expect, beforeEach } from 'vitest';
import { PredictiveMemoryService } from '../../src/memory/predictive-memory.js';

describe('PredictiveMemoryService', () => {
  let service: PredictiveMemoryService;

  beforeEach(() => {
    service = new PredictiveMemoryService();
  });

  describe('predictNeededContext', () => {
    it('should extract file paths from task description', () => {
      const predictions = service.predictNeededContext(
        'Fix the bug in src/auth/login.ts causing login failures',
        []
      );
      expect(predictions.some(p => p.includes('src/auth/login.ts'))).toBe(true);
    });

    it('should extract camelCase identifiers', () => {
      const predictions = service.predictNeededContext(
        'Refactor the handleUserLogin function',
        []
      );
      expect(predictions.some(p => p.includes('handleUserLogin'))).toBe(true);
    });

    it('should extract technical terms', () => {
      const predictions = service.predictNeededContext(
        'Update the database migration for users table',
        []
      );
      expect(predictions.some(p => p.toLowerCase().includes('database'))).toBe(true);
    });

    it('should match category-based queries for security tasks', () => {
      const predictions = service.predictNeededContext(
        'Audit the security of the authentication module',
        []
      );
      expect(predictions.some(p => p.toLowerCase().includes('auth'))).toBe(true);
    });

    it('should match category-based queries for deployment tasks', () => {
      const predictions = service.predictNeededContext(
        'Fix the deployment pipeline for staging',
        []
      );
      expect(predictions.some(p =>
        p.toLowerCase().includes('deploy') || p.toLowerCase().includes('infrastructure')
      )).toBe(true);
    });

    it('should include entities from recent tasks', () => {
      const predictions = service.predictNeededContext(
        'Continue working on the feature',
        ['Previous work involved src/models/router.ts and handleRouting']
      );
      expect(predictions.some(p => p.includes('src/models/router.ts') || p.includes('handleRouting'))).toBe(true);
    });

    it('should handle empty task description', () => {
      const predictions = service.predictNeededContext('', []);
      expect(predictions).toBeDefined();
    });

    it('should extract backtick-quoted strings', () => {
      const predictions = service.predictNeededContext(
        'Fix the `validateInput` function in `auth.ts`',
        []
      );
      expect(predictions.some(p => p === 'validateInput')).toBe(true);
      expect(predictions.some(p => p === 'auth.ts')).toBe(true);
    });
  });

  describe('recordAccess and learning', () => {
    it('should learn from recorded access patterns', () => {
      service.recordAccess('Fix authentication bug', ['auth patterns', 'login flow']);
      service.recordAccess('Fix authorization issue', ['auth patterns', 'permissions']);

      const predictions = service.predictNeededContext(
        'Fix authentication regression',
        []
      );
      expect(predictions.some(p => p.includes('auth patterns'))).toBe(true);
    });

    it('should find similar past tasks', () => {
      service.recordAccess(
        'Refactor the database connection pooling',
        ['connection pool config', 'database patterns']
      );

      const predictions = service.predictNeededContext(
        'Improve the database connection handling',
        []
      );
      expect(predictions.some(p =>
        p.includes('connection pool config') || p.includes('database patterns')
      )).toBe(true);
    });

    it('should limit task history', () => {
      for (let i = 0; i < 110; i++) {
        service.recordAccess(`Task ${i}`, [`query-${i}`]);
      }
      // Should not throw, history is capped
      const predictions = service.predictNeededContext('New task', []);
      expect(predictions).toBeDefined();
    });
  });

  describe('prefetch', () => {
    it('should prefetch queries using provided memory service', async () => {
      const mockService = {
        query: async (q: string) => [{ id: 1, content: `result for ${q}` }],
      };

      const results = await service.prefetch(['auth patterns', 'login flow'], mockService);
      expect(results.size).toBe(2);
      expect(results.get('auth patterns')).toHaveLength(1);
    });

    it('should handle query failures gracefully', async () => {
      const mockService = {
        query: async (_q: string) => { throw new Error('DB error'); },
      };

      const results = await service.prefetch(['failing query'], mockService);
      expect(results.get('failing query')).toHaveLength(0);
    });

    it('should handle empty predictions', async () => {
      const mockService = { query: async () => [] };
      const results = await service.prefetch([], mockService);
      expect(results.size).toBe(0);
    });
  });
});
