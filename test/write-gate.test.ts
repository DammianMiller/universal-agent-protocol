import { describe, it, expect } from 'vitest';
import { evaluateWriteGate, formatGateResult } from '../src/memory/write-gate.js';

describe('WriteGate', () => {
  describe('evaluateWriteGate', () => {
    it('rejects empty content', () => {
      const result = evaluateWriteGate('');
      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('Empty');
    });

    it('rejects very short content', () => {
      const result = evaluateWriteGate('ok cool');
      expect(result.passed).toBe(false);
    });

    it('rejects noise patterns (acknowledgments)', () => {
      // Short noise gets rejected as "too short"
      for (const content of ['ok', 'yes', 'great']) {
        const result = evaluateWriteGate(content);
        expect(result.passed).toBe(false);
      }
      // Longer noise gets rejected by noise pattern matching
      for (const content of ['thanks, that looks good', 'sounds good to me', 'looks good, ship it']) {
        const result = evaluateWriteGate(content);
        expect(result.passed).toBe(false);
        expect(result.rejectionReason).toContain('noise');
      }
    });

    it('passes behavioral change content', () => {
      const behavioral = [
        'Always use TypeScript, never raw JavaScript',
        'Prefer tabs over spaces for indentation',
        "Don't use console.log in production code",
        'Default timezone is US/Pacific for all scheduling',
      ];
      for (const content of behavioral) {
        const result = evaluateWriteGate(content);
        expect(result.passed).toBe(true);
        expect(result.criteria.find(c => c.name === 'behavioral_change')?.matched).toBe(true);
      }
    });

    it('passes commitment content', () => {
      const commitments = [
        'Deadline for v2 release is March 15, 2026',
        'Will deliver the PR by Friday',
        'Follow up on budget approval if no response by Jan 17',
        'Waiting on response from Sarah about the API contract',
      ];
      for (const content of commitments) {
        const result = evaluateWriteGate(content);
        expect(result.passed).toBe(true);
        expect(result.criteria.find(c => c.name === 'commitment')?.matched).toBe(true);
      }
    });

    it('passes decision with rationale content', () => {
      const decisions = [
        'Decided to use Postgres over SQLite because we need JSONB support',
        'Chose JWT over session cookies for stateless scaling',
        'Evaluated React vs Vue and selected React for ecosystem maturity',
      ];
      for (const content of decisions) {
        const result = evaluateWriteGate(content);
        expect(result.passed).toBe(true);
        expect(result.criteria.find(c => c.name === 'decision_rationale')?.matched).toBe(true);
      }
    });

    it('passes stable fact content', () => {
      const facts = [
        'API endpoint for auth is at https://api.example.com/v2/auth',
        'The staging environment uses Node 20',
        'API key rotates monthly, check .env for current value',
        'Production database schema has a users table with email column',
      ];
      for (const content of facts) {
        const result = evaluateWriteGate(content);
        expect(result.passed).toBe(true);
        expect(result.criteria.find(c => c.name === 'stable_fact')?.matched).toBe(true);
      }
    });

    it('passes explicit remember requests', () => {
      const explicit = [
        'Remember this: the client name is Sarah, not Sara',
        "Don't forget that the deploy script needs sudo",
        'Important to know: billing uses a different database',
        'Remember: never CC the client on technical threads',
      ];
      for (const content of explicit) {
        const result = evaluateWriteGate(content);
        expect(result.passed).toBe(true);
        expect(result.criteria.find(c => c.name === 'explicit_request')?.matched).toBe(true);
      }
    });

    it('gives higher scores for content matching multiple criteria', () => {
      const singleMatch = evaluateWriteGate('Always use TypeScript');
      const multiMatch = evaluateWriteGate(
        'Decided to always use TypeScript over JavaScript because of type safety. Deadline for migration is March 2026.'
      );
      expect(multiMatch.score).toBeGreaterThan(singleMatch.score);
    });

    it('gives length bonus for longer structured content', () => {
      const short = evaluateWriteGate('Prefer tabs over spaces');
      const long = evaluateWriteGate(
        'Prefer tabs over spaces for all TypeScript files. ' +
        'This applies to the entire codebase including tests, configs, and documentation. ' +
        'The rationale is consistency with the existing eslint configuration and team convention. ' +
        'Exception: YAML files should always use 2-space indentation as required by the YAML spec.'
      );
      expect(long.score).toBeGreaterThan(short.score);
    });

    it('rejects generic transient content', () => {
      const transient = [
        'The weather is nice today',
        'This is an interesting article about AI',
        'Line 47 has a bug',
      ];
      for (const content of transient) {
        const result = evaluateWriteGate(content);
        expect(result.passed).toBe(false);
      }
    });

    it('respects custom minScore config', () => {
      const content = 'Always use TypeScript';
      const strict = evaluateWriteGate(content, { minScore: 0.9, enableFuzzyMatching: true });
      const lenient = evaluateWriteGate(content, { minScore: 0.1, enableFuzzyMatching: true });
      expect(strict.passed).toBe(false);
      expect(lenient.passed).toBe(true);
    });
  });

  describe('formatGateResult', () => {
    it('formats passed result', () => {
      const result = evaluateWriteGate('Always prefer TypeScript over JavaScript');
      const formatted = formatGateResult(result);
      expect(formatted).toContain('PASSED');
      expect(formatted).toContain('behavioral_change');
    });

    it('formats rejected result', () => {
      const result = evaluateWriteGate('ok');
      const formatted = formatGateResult(result);
      expect(formatted).toContain('REJECTED');
    });
  });
});
