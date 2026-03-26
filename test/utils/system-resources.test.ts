import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  detectSystemResources,
  getMaxParallel,
  isParallelEnabled,
  resetResourceCache,
} from '../../src/utils/system-resources.js';

describe('System Resources', () => {
  beforeEach(() => {
    resetResourceCache();
  });

  afterEach(() => {
    delete process.env.UAP_MAX_PARALLEL;
    delete process.env.UAP_PARALLEL;
    resetResourceCache();
  });

  describe('detectSystemResources', () => {
    it('should return vCPUs, vramGB, and memoryGB', () => {
      const res = detectSystemResources();
      expect(res).toHaveProperty('vCPUs');
      expect(res).toHaveProperty('vramGB');
      expect(res).toHaveProperty('memoryGB');
      expect(typeof res.vCPUs).toBe('number');
      expect(res.vCPUs).toBeGreaterThan(0);
      expect(res.memoryGB).toBeGreaterThan(0);
    });

    it('should cache results after first call', () => {
      const res1 = detectSystemResources();
      const res2 = detectSystemResources();
      expect(res1).toBe(res2);
    });

    it('should return fresh results after cache reset', () => {
      const res1 = detectSystemResources();
      resetResourceCache();
      const res2 = detectSystemResources();
      expect(res1).not.toBe(res2);
      expect(res1.vCPUs).toBe(res2.vCPUs);
    });
  });

  describe('getMaxParallel', () => {
    it('should return a positive number for io mode', () => {
      const val = getMaxParallel('io');
      expect(val).toBeGreaterThan(0);
      expect(val).toBeLessThanOrEqual(8);
    });

    it('should return a positive number for cpu mode', () => {
      const val = getMaxParallel('cpu');
      expect(val).toBeGreaterThan(0);
    });

    it('should respect UAP_MAX_PARALLEL env var', () => {
      process.env.UAP_MAX_PARALLEL = '42';
      expect(getMaxParallel('io')).toBe(42);
      expect(getMaxParallel('cpu')).toBe(42);
    });

    it('should ignore invalid UAP_MAX_PARALLEL values', () => {
      process.env.UAP_MAX_PARALLEL = 'notanumber';
      const val = getMaxParallel('io');
      expect(val).toBeGreaterThan(0);
    });

    it('should ignore negative UAP_MAX_PARALLEL values', () => {
      process.env.UAP_MAX_PARALLEL = '-5';
      const val = getMaxParallel('io');
      expect(val).toBeGreaterThan(0);
    });

    it('should default to io mode', () => {
      const defaultVal = getMaxParallel();
      const ioVal = getMaxParallel('io');
      expect(defaultVal).toBe(ioVal);
    });
  });

  describe('isParallelEnabled', () => {
    it('should return true by default', () => {
      expect(isParallelEnabled()).toBe(true);
    });

    it('should return false when UAP_PARALLEL is "false"', () => {
      process.env.UAP_PARALLEL = 'false';
      expect(isParallelEnabled()).toBe(false);
    });

    it('should return true for any other UAP_PARALLEL value', () => {
      process.env.UAP_PARALLEL = 'true';
      expect(isParallelEnabled()).toBe(true);
      process.env.UAP_PARALLEL = '1';
      expect(isParallelEnabled()).toBe(true);
    });
  });
});
