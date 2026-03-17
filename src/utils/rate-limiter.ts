/**
 * Configuration options for the RateLimiter.
 */
export interface RateLimiterConfig {
  /** Maximum number of requests allowed within the time window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
}

/**
 * Tracks request timestamps for a client.
 */
interface ClientEntry {
  timestamps: number[];
}

/**
 * A sliding-window rate limiter that tracks requests per client.
 * Uses a Map to store request timestamps for each client and
 * automatically cleans up expired entries.
 */
export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly clients: Map<string, ClientEntry> = new Map();

  /**
   * Creates a new RateLimiter instance.
   *
   * @param config - Configuration for request limits and time window
   * @throws Error if maxRequests or windowMs are not positive numbers
   */
  constructor(config: RateLimiterConfig) {
    if (
      typeof config.maxRequests !== 'number' ||
      config.maxRequests <= 0 ||
      !Number.isInteger(config.maxRequests)
    ) {
      throw new Error('maxRequests must be a positive integer');
    }

    if (
      typeof config.windowMs !== 'number' ||
      config.windowMs <= 0 ||
      !Number.isInteger(config.windowMs)
    ) {
      throw new Error('windowMs must be a positive integer');
    }

    this.maxRequests = config.maxRequests;
    this.windowMs = config.windowMs;
  }

  /**
   * Checks if a request from the given client is allowed.
   * If allowed, records the request timestamp.
   *
   * @param clientId - Unique identifier for the client
   * @returns True if the request is allowed, false if rate limited
   */
  isAllowed(clientId: string): boolean {
    const now = Date.now();
    this.cleanupExpiredEntries(clientId, now);

    const entry = this.clients.get(clientId);

    if (!entry) {
      this.clients.set(clientId, { timestamps: [now] });
      return true;
    }

    if (entry.timestamps.length < this.maxRequests) {
      entry.timestamps.push(now);
      return true;
    }

    return false;
  }

  /**
   * Returns the number of remaining requests for a client within the current window.
   *
   * @param clientId - Unique identifier for the client
   * @returns Number of remaining allowed requests
   */
  getRemainingRequests(clientId: string): number {
    const now = Date.now();
    this.cleanupExpiredEntries(clientId, now);

    const entry = this.clients.get(clientId);

    if (!entry) {
      return this.maxRequests;
    }

    return Math.max(0, this.maxRequests - entry.timestamps.length);
  }

  /**
   * Resets rate limiting state.
   * If clientId is provided, resets only that client.
   * Otherwise, resets all clients.
   *
   * @param clientId - Optional client identifier to reset
   */
  reset(clientId?: string): void {
    if (clientId !== undefined) {
      this.clients.delete(clientId);
    } else {
      this.clients.clear();
    }
  }

  /**
   * Removes expired timestamps from a client's entry.
   * Deletes the entry entirely if no valid timestamps remain.
   *
   * @param clientId - Client identifier to clean up
   * @param now - Current timestamp for expiration calculation
   */
  private cleanupExpiredEntries(clientId: string, now: number): void {
    const entry = this.clients.get(clientId);

    if (!entry) {
      return;
    }

    const cutoff = now - this.windowMs;
    entry.timestamps = entry.timestamps.filter(
      (timestamp) => timestamp > cutoff
    );

    if (entry.timestamps.length === 0) {
      this.clients.delete(clientId);
    }
  }
}
