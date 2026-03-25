import { describe, it, expect } from 'vitest';
import {
  calculateEntropy,
  calculateInformationDensity,
} from '../../src/memory/semantic-compression.js';

describe('Semantic Compression', () => {
  describe('calculateEntropy', () => {
    it('should return 0 for empty text', () => {
      expect(calculateEntropy('')).toBe(0);
    });

    it('should return low entropy for repetitive text', () => {
      const entropy = calculateEntropy('the the the the the the the');
      expect(entropy).toBeLessThan(0.5);
    });

    it('should return high entropy for diverse text', () => {
      const entropy = calculateEntropy('apple banana cherry date elderberry fig grape honeydew');
      expect(entropy).toBeGreaterThan(0.8);
    });

    it('should return value between 0 and 1', () => {
      const entropy = calculateEntropy('This is a test with some repeated words and some unique words');
      expect(entropy).toBeGreaterThanOrEqual(0);
      expect(entropy).toBeLessThanOrEqual(1);
    });

    it('should return 1 for all unique words', () => {
      const entropy = calculateEntropy('alpha bravo charlie delta echo foxtrot');
      expect(entropy).toBeCloseTo(1.0, 1);
    });
  });

  describe('calculateInformationDensity', () => {
    it('should return 0 for empty text', () => {
      expect(calculateInformationDensity('')).toBe(0);
    });

    it('should return higher density for diverse content', () => {
      const diverse = calculateInformationDensity('apple banana cherry date elderberry fig grape');
      const repetitive = calculateInformationDensity('the the the the the the the');
      expect(diverse).toBeGreaterThan(repetitive);
    });

    it('should return value between 0 and 1', () => {
      const density = calculateInformationDensity('This is a sample text for testing information density');
      expect(density).toBeGreaterThanOrEqual(0);
      expect(density).toBeLessThanOrEqual(1);
    });
  });
});
