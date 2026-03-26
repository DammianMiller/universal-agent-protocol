import { describe, it, expect } from 'vitest';
import {
  classifyTask,
  type TaskClassification,
} from '../../src/memory/task-classifier.js';

describe('Task Classifier', () => {
  describe('classifyTask', () => {
    it('should classify sysadmin tasks', () => {
      const result = classifyTask('Configure systemd service for the web server and set up nginx reverse proxy');
      expect(result.category).toBe('sysadmin');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.suggestedDroid).toBe('sysadmin-expert');
    });

    it('should classify security tasks', () => {
      const result = classifyTask('Fix CVE-2024-1234 vulnerability in the authentication module');
      expect(result.category).toBe('security');
      expect(result.suggestedDroid).toBe('security-auditor');
    });

    it('should classify ML training tasks', () => {
      const result = classifyTask('Train a PyTorch classifier on the MTEB dataset with GPU acceleration');
      expect(result.category).toBe('ml-training');
      expect(result.suggestedDroid).toBe('ml-training-expert');
    });

    it('should classify debugging tasks', () => {
      const result = classifyTask('Debug the pip dependency conflict causing import errors');
      expect(result.category).toBe('debugging');
    });

    it('should classify coding tasks', () => {
      const result = classifyTask('Implement a singleton factory pattern for the API endpoint');
      expect(result.category).toBe('coding');
    });

    it('should classify file operations', () => {
      const result = classifyTask('Extract the tar archive and convert CSV data to JSON format');
      expect(result.category).toBe('file-ops');
    });

    it('should classify testing tasks', () => {
      const result = classifyTask('Write vitest unit tests with mocks and improve coverage');
      expect(result.category).toBe('testing');
    });

    it('should return unknown for ambiguous input', () => {
      const result = classifyTask('do something');
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('should include memory query hints', () => {
      const result = classifyTask('Fix the kernel build error');
      expect(result.memoryQueryHints).toBeDefined();
      expect(result.memoryQueryHints.length).toBeGreaterThan(0);
    });

    it('should include required capabilities', () => {
      const result = classifyTask('Set up Docker containers for the deployment');
      expect(result.requiredCapabilities.length).toBeGreaterThan(0);
    });

    it('should include matched keywords', () => {
      const result = classifyTask('Configure nginx reverse proxy with SSL certificates');
      expect(result.keywords.length).toBeGreaterThan(0);
    });

    it('should include ambiguity score', () => {
      const result = classifyTask('fix it');
      expect(result.ambiguity).toBeDefined();
      expect(result.ambiguity!.score).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty input', () => {
      const result = classifyTask('');
      expect(result.category).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });

    it('should classify constraint satisfaction tasks', () => {
      const result = classifyTask('Create a schedule optimizer that allocates resources with constraints');
      expect(result.category).toBe('constraint-satisfaction');
    });

    it('should return confidence between 0 and 1', () => {
      const result = classifyTask('Build a REST API with TypeScript and async patterns');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
