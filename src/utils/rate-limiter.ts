/**
 * Configuration options for the RateLimiter.
 */
export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

/**
 * A sliding-window rate limiter that tracks requests per client.
 */
import { z } from 'zod';

import { AppError } from './validate-json.js';

export class RateLimiter {
  private static readonly configSchema = z.object({
    maxRequests: z
      .number({
        required_error: 'maxRequests is required',
        invalid_type_error: 'maxRequests must be a number',
      })
      .int('maxRequests must be an integer')
      .positive('maxRequests must be greater than 0'),
    windowMs: z
      .number({
        required_error: 'windowMs is required',
        invalid_type_error: 'windowMs must be a number',
      })
      .int('windowMs must be an integer')
      .positive('windowMs must be greater than 0'),
  });

  private static readonly clientIdSchema = z
    .string({
      required_error: 'clientId is required',
      invalid_type_error: 'clientId must be a string',
    })
    .min(1, 'clientId must not be empty');

  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly requests: Map<string, number[]> = new Map();

  /**
   * Creates a new RateLimiter instance.
   *
   * @param config - Configuration for request limits and window size
   * @returns A configured RateLimiter instance
   * @throws AppError when config is invalid
   */
  constructor(config: RateLimiterConfig) {
    const validation = RateLimiter.configSchema.safeParse(config);

    if (!validation.success) {
      throw new AppError('Invalid rate limiter configuration', 'INVALID_CONFIG', {
        errors: validation.error.errors,
        received: config,
      });
    }

    this.maxRequests = validation.data.maxRequests;
    this.windowMs = validation.data.windowMs;
  }

  /**
   * Checks if a request from the given client is allowed and records it if so.
   *
   * @param clientId - Identifier for the calling client
   * @returns True if the request is allowed; otherwise false
   * @throws AppError when clientId is invalid
   */
  isAllowed(clientId: string): boolean {
    this.ensureValidClientId(clientId);
    const now = Date.now();
    this.cleanupExpiredEntries(now, clientId);

    const timestamps = this.requests.get(clientId) ?? [];

    if (timestamps.length < this.maxRequests) {
      timestamps.push(now);
      this.requests.set(clientId, timestamps);
      return true;
    }

    return false;
  }

  /**
   * Returns the remaining number of requests for a client in the current window.
   *
   * @param clientId - Identifier for the calling client
   * @returns Remaining number of requests in the window
   * @throws AppError when clientId is invalid
   */
  getRemainingRequests(clientId: string): number {
    this.ensureValidClientId(clientId);
    const now = Date.now();
    this.cleanupExpiredEntries(now, clientId);

    const timestamps = this.requests.get(clientId);

    if (!timestamps) {
      return this.maxRequests;
    }

    return Math.max(0, this.maxRequests - timestamps.length);
  }

  /**
   * Resets rate limiting for a single client or all clients.
   *
   * @param clientId - Optional client identifier to reset; omit to reset all
   * @returns Nothing
   */
  reset(clientId?: string): void {
    if (clientId) {
      this.ensureValidClientId(clientId);
      this.requests.delete(clientId);
      return;
    }

    this.requests.clear();
  }

  /**
   * Removes expired timestamps and deletes empty client entries.
   *
   * @param now - Current timestamp used as reference
   * @param clientId - Optional client identifier to scope cleanup
   * @returns Nothing
   */
  private cleanupExpiredEntries(now: number, clientId?: string): void {
    const cutoff = now - this.windowMs;

    if (clientId) {
      const timestamps = this.requests.get(clientId);

      if (!timestamps) {
        return;
      }

      const validTimestamps = timestamps.filter(
        (timestamp) => timestamp > cutoff
      );

      if (validTimestamps.length === 0) {
        this.requests.delete(clientId);
      } else {
        this.requests.set(clientId, validTimestamps);
      }

      return;
    }

    for (const [id, timestamps] of this.requests.entries()) {
      const validTimestamps = timestamps.filter(
        (timestamp) => timestamp > cutoff
      );

      if (validTimestamps.length === 0) {
        this.requests.delete(id);
      } else {
        this.requests.set(id, validTimestamps);
      }
    }
  }

  /**
   * Ensures the client identifier is valid.
   *
   * @param clientId - Identifier to validate
   * @returns Nothing
   * @throws AppError when clientId is invalid
   */
  private ensureValidClientId(clientId: string): void {
    const validation = RateLimiter.clientIdSchema.safeParse(clientId);

    if (!validation.success) {
      throw new AppError('Invalid client identifier', 'INVALID_CLIENT_ID', {
        errors: validation.error.errors,
        received: clientId,
      });
    }
  }
}
