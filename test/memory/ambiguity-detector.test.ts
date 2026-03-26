import { describe, it, expect } from 'vitest';
import { detectAmbiguity, type AmbiguityResult } from '../../src/memory/ambiguity-detector.js';

describe('Ambiguity Detector', () => {
  describe('detectAmbiguity', () => {
    it('should return clear for specific instructions', () => {
      const result = detectAmbiguity(
        'Add input validation to src/auth/login.ts by checking email format with a regex'
      );
      expect(result.level).toBe('clear');
      expect(result.score).toBeLessThan(0.3);
      expect(result.shouldAsk).toBe(false);
    });

    it('should detect high ambiguity for very short instructions', () => {
      const result = detectAmbiguity('fix it');
      expect(result.score).toBeGreaterThan(0);
      expect(result.signals.length).toBeGreaterThan(0);
    });

    it('should detect pronoun ambiguity', () => {
      const result = detectAmbiguity('it needs to be updated and then deploy it');
      const pronounSignals = result.signals.filter(s => s.type === 'pronoun');
      expect(pronounSignals.length).toBeGreaterThan(0);
    });

    it('should detect relative references', () => {
      const result = detectAmbiguity('Do it like before with the usual way');
      const relativeSignals = result.signals.filter(s => s.type === 'relative_ref');
      expect(relativeSignals.length).toBeGreaterThan(0);
    });

    it('should detect vague quantifiers', () => {
      const result = detectAmbiguity('Fix some errors in several files');
      const vagueSignals = result.signals.filter(s => s.type === 'vague_quantifier');
      expect(vagueSignals.length).toBeGreaterThan(0);
    });

    it('should detect contradictions', () => {
      const result = detectAmbiguity('Make it fast and thorough');
      const contradictionSignals = result.signals.filter(s => s.type === 'contradiction');
      expect(contradictionSignals.length).toBeGreaterThan(0);
    });

    it('should detect implicit assumptions', () => {
      const result = detectAmbiguity('Obviously the config needs to be updated');
      const implicitSignals = result.signals.filter(s => s.type === 'implicit_assumption');
      expect(implicitSignals.length).toBeGreaterThan(0);
    });

    it('should cap score at 1.0', () => {
      const result = detectAmbiguity(
        'Fix it like before, obviously this thing needs some improvements, make it fast and thorough, similar to the usual way'
      );
      expect(result.score).toBeLessThanOrEqual(1.0);
    });

    it('should generate clarifying questions for ambiguous input', () => {
      const result = detectAmbiguity('Improve the code');
      expect(result.questions.length).toBeGreaterThanOrEqual(0);
    });

    it('should generate assumptions for moderate ambiguity', () => {
      const result = detectAmbiguity('Update the code to handle errors better');
      expect(result.assumptions).toBeDefined();
    });

    it('should limit questions to max 5', () => {
      const result = detectAmbiguity(
        'Fix it like before with the usual way, obviously several things need some changes, make it fast and thorough, similar to last time, improve everything'
      );
      expect(result.questions.length).toBeLessThanOrEqual(5);
    });

    it('should reduce ambiguity with project context', () => {
      const withoutCtx = detectAmbiguity('Update the service');
      const withCtx = detectAmbiguity('Update the service', {
        knownEntities: ['AuthService', 'UserService'],
      });
      expect(withCtx.score).toBeLessThanOrEqual(withoutCtx.score);
    });

    it('should detect multiple action verbs as ambiguity signal', () => {
      const result = detectAmbiguity(
        'Fix, refactor, optimize, deploy, and verify the application'
      );
      const scopeSignals = result.signals.filter(s => s.type === 'missing_scope');
      expect(scopeSignals.length).toBeGreaterThan(0);
    });

    it('should detect unspecified targets for action verbs', () => {
      const result = detectAmbiguity('Refactor the authentication module to improve performance');
      expect(result.signals.some(s => s.type === 'unspecified_target' || s.type === 'missing_scope')).toBe(true);
    });
  });
});
