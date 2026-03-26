import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../../src/utils/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });
  });

  describe('constructor', () => {
    it('should throw on non-positive maxRequests', () => {
      expect(() => new RateLimiter({ maxRequests: 0, windowMs: 1000 })).toThrow('maxRequests must be a positive integer');
      expect(() => new RateLimiter({ maxRequests: -1, windowMs: 1000 })).toThrow('maxRequests must be a positive integer');
    });

    it('should throw on non-integer maxRequests', () => {
      expect(() => new RateLimiter({ maxRequests: 1.5, windowMs: 1000 })).toThrow('maxRequests must be a positive integer');
    });

    it('should throw on non-positive windowMs', () => {
      expect(() => new RateLimiter({ maxRequests: 5, windowMs: 0 })).toThrow('windowMs must be a positive integer');
      expect(() => new RateLimiter({ maxRequests: 5, windowMs: -100 })).toThrow('windowMs must be a positive integer');
    });

    it('should throw on non-integer windowMs', () => {
      expect(() => new RateLimiter({ maxRequests: 5, windowMs: 1.5 })).toThrow('windowMs must be a positive integer');
    });

    it('should throw on NaN inputs', () => {
      expect(() => new RateLimiter({ maxRequests: NaN, windowMs: 1000 })).toThrow();
      expect(() => new RateLimiter({ maxRequests: 5, windowMs: NaN })).toThrow();
    });
  });

  describe('isAllowed', () => {
    it('should allow requests within the limit', () => {
      expect(limiter.isAllowed('client1')).toBe(true);
      expect(limiter.isAllowed('client1')).toBe(true);
      expect(limiter.isAllowed('client1')).toBe(true);
    });

    it('should deny requests exceeding the limit', () => {
      limiter.isAllowed('client1');
      limiter.isAllowed('client1');
      limiter.isAllowed('client1');
      expect(limiter.isAllowed('client1')).toBe(false);
    });

    it('should track clients independently', () => {
      limiter.isAllowed('client1');
      limiter.isAllowed('client1');
      limiter.isAllowed('client1');
      expect(limiter.isAllowed('client1')).toBe(false);
      expect(limiter.isAllowed('client2')).toBe(true);
    });

    it('should allow requests after window expires', async () => {
      const fast = new RateLimiter({ maxRequests: 1, windowMs: 50 });
      expect(fast.isAllowed('c')).toBe(true);
      expect(fast.isAllowed('c')).toBe(false);
      await new Promise(r => setTimeout(r, 60));
      expect(fast.isAllowed('c')).toBe(true);
    });
  });

  describe('getRemainingRequests', () => {
    it('should return full limit for new client', () => {
      expect(limiter.getRemainingRequests('new')).toBe(3);
    });

    it('should decrease as requests are made', () => {
      limiter.isAllowed('c');
      expect(limiter.getRemainingRequests('c')).toBe(2);
      limiter.isAllowed('c');
      expect(limiter.getRemainingRequests('c')).toBe(1);
      limiter.isAllowed('c');
      expect(limiter.getRemainingRequests('c')).toBe(0);
    });

    it('should not go below 0', () => {
      limiter.isAllowed('c');
      limiter.isAllowed('c');
      limiter.isAllowed('c');
      limiter.isAllowed('c');
      expect(limiter.getRemainingRequests('c')).toBe(0);
    });
  });

  describe('reset', () => {
    it('should reset a specific client', () => {
      limiter.isAllowed('c1');
      limiter.isAllowed('c1');
      limiter.isAllowed('c1');
      expect(limiter.isAllowed('c1')).toBe(false);
      limiter.reset('c1');
      expect(limiter.isAllowed('c1')).toBe(true);
    });

    it('should reset all clients when called without argument', () => {
      limiter.isAllowed('c1');
      limiter.isAllowed('c1');
      limiter.isAllowed('c1');
      limiter.isAllowed('c2');
      limiter.reset();
      expect(limiter.getRemainingRequests('c1')).toBe(3);
      expect(limiter.getRemainingRequests('c2')).toBe(3);
    });
  });
});
