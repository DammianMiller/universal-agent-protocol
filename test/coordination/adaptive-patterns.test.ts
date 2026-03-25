import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdaptivePatternEngine, resetAdaptivePatternEngine } from '../../src/coordination/adaptive-patterns.js';

describe('AdaptivePatternEngine', () => {
  let engine: AdaptivePatternEngine;

  beforeEach(() => {
    resetAdaptivePatternEngine();
    engine = new AdaptivePatternEngine();
  });

  afterEach(() => {
    engine.close();
  });

  describe('recordPatternOutcome', () => {
    it('should track uses and successes', () => {
      engine.recordPatternOutcome('P12', true, 'security');
      engine.recordPatternOutcome('P12', true, 'security');
      engine.recordPatternOutcome('P12', false, 'security');
      const stats = engine.getPatternStats();
      expect(stats['P12'].uses).toBe(3);
      expect(stats['P12'].successes).toBe(2);
    });

    it('should track different categories independently', () => {
      engine.recordPatternOutcome('P12', true, 'security');
      engine.recordPatternOutcome('P12', false, 'refactor');
      const adapted = engine.getAdaptedPatterns('security');
      const securityPattern = adapted.find(a => a.id === 'P12');
      expect(securityPattern).toBeDefined();
      expect(securityPattern!.successRate).toBe(1.0);
    });

    it('should handle multiple patterns', () => {
      engine.recordPatternOutcome('P12', true, 'testing');
      engine.recordPatternOutcome('P35', false, 'testing');
      engine.recordPatternOutcome('P35', true, 'testing');
      const stats = engine.getPatternStats();
      expect(stats['P12'].rate).toBe(1.0);
      expect(stats['P35'].rate).toBe(0.5);
    });
  });

  describe('setPatternContent', () => {
    it('should store and retrieve pattern content', () => {
      engine.setPatternContent('P12', 'Output Existence pattern');
      engine.recordPatternOutcome('P12', true, 'testing');
      const adapted = engine.getAdaptedPatterns('testing');
      expect(adapted[0].content).toBe('Output Existence pattern');
    });
  });

  describe('getAdaptedPatterns', () => {
    it('should return patterns sorted by success rate', () => {
      engine.recordPatternOutcome('P1', true, 'testing');
      engine.recordPatternOutcome('P1', true, 'testing');
      engine.recordPatternOutcome('P2', true, 'testing');
      engine.recordPatternOutcome('P2', false, 'testing');
      engine.recordPatternOutcome('P3', false, 'testing');

      const adapted = engine.getAdaptedPatterns('testing');
      expect(adapted.length).toBe(3);
      expect(adapted[0].successRate).toBeGreaterThanOrEqual(adapted[1].successRate);
      expect(adapted[1].successRate).toBeGreaterThanOrEqual(adapted[2].successRate);
    });

    it('should return empty for unknown category', () => {
      engine.recordPatternOutcome('P1', true, 'security');
      const adapted = engine.getAdaptedPatterns('unknown');
      expect(adapted).toHaveLength(0);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 20; i++) {
        engine.recordPatternOutcome(`P${i}`, true, 'testing');
      }
      const adapted = engine.getAdaptedPatterns('testing', 5);
      expect(adapted.length).toBe(5);
    });
  });

  describe('getPatternStats', () => {
    it('should return empty for no outcomes', () => {
      const stats = engine.getPatternStats();
      expect(Object.keys(stats)).toHaveLength(0);
    });

    it('should aggregate across categories', () => {
      engine.recordPatternOutcome('P12', true, 'security');
      engine.recordPatternOutcome('P12', false, 'refactor');
      engine.recordPatternOutcome('P12', true, 'testing');
      const stats = engine.getPatternStats();
      expect(stats['P12'].uses).toBe(3);
      expect(stats['P12'].successes).toBe(2);
      expect(stats['P12'].rate).toBeCloseTo(0.667, 2);
    });
  });
});
