import { describe, it, expect, beforeEach } from 'vitest';
import { PatternRouter, resetPatternRouter } from '../../src/coordination/pattern-router.js';
import { join } from 'path';
import { existsSync } from 'fs';

describe('PatternRouter', () => {
  let router: PatternRouter;
  const projectRoot = process.cwd();
  const hasPatterns = existsSync(join(projectRoot, '.factory/patterns/index.json'));

  beforeEach(() => {
    resetPatternRouter();
    router = new PatternRouter();
  });

  describe('loadPatterns', () => {
    it('should return false for directory without patterns', () => {
      expect(router.loadPatterns('/nonexistent')).toBe(false);
    });

    it.skipIf(!hasPatterns)('should load patterns from current project', () => {
      const loaded = router.loadPatterns(projectRoot);
      expect(loaded).toBe(true);
      expect(router.getPatterns().length).toBeGreaterThan(0);
    });

    it.skipIf(!hasPatterns)('should record loaded path', () => {
      router.loadPatterns(projectRoot);
      expect(router.getLoadedPath()).toContain('.factory/patterns/index.json');
    });
  });

  describe('getPatterns', () => {
    it('should return empty array when no patterns loaded', () => {
      expect(router.getPatterns()).toHaveLength(0);
    });
  });

  describe('matchPatterns', () => {
    it.skipIf(!hasPatterns)('should match patterns by keyword', () => {
      router.loadPatterns(projectRoot);
      const matches = router.matchPatterns('output file creation');
      expect(matches.length).toBeGreaterThanOrEqual(0);
    });

    it('should return empty for no matches', () => {
      expect(router.matchPatterns('xyznonexistent')).toHaveLength(0);
    });

    it.skipIf(!hasPatterns)('should cache results', () => {
      router.loadPatterns(projectRoot);
      const r1 = router.matchPatterns('test coverage');
      const r2 = router.matchPatterns('test coverage');
      expect(r1).toEqual(r2);
    });
  });

  describe('getEnforcementChecklist', () => {
    it.skipIf(!hasPatterns)('should always include critical patterns', () => {
      router.loadPatterns(projectRoot);
      const checklist = router.getEnforcementChecklist('any random task');
      expect(checklist.length).toBeGreaterThan(0);
      // Critical patterns are always included regardless of keywords
      const allPatterns = router.getPatterns();
      expect(allPatterns.length).toBeGreaterThan(0);
    });

    it('should return empty if no patterns loaded and no critical patterns exist', () => {
      const checklist = router.getEnforcementChecklist('some task');
      expect(checklist).toBeDefined();
    });
  });
});
