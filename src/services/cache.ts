/**
 * Cache Service
 *
 * KV-backed caching for hot data paths.
 * Provides sub-millisecond reads globally (vs D1 ~5-20ms).
 *
 * Cache key patterns:
 * - org:{id}:settings - AI optimization settings
 * - org:{id}:connections - Platform connections
 * - user:{id} - User profile
 * - org:{id}:pending_ai - Pending AI decisions count
 */

export class CacheService {
  constructor(private kv: KVNamespace) {}

  /**
   * Get or set cached value with automatic refresh
   *
   * @param key - Cache key
   * @param fetcher - Function to fetch fresh data if cache miss
   * @param ttlSeconds - Time to live in seconds (default 300 = 5 min)
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds = 300
  ): Promise<T> {
    // Try cache first
    const cached = await this.kv.get(key, 'json');
    if (cached !== null) {
      return cached as T;
    }

    // Cache miss - fetch fresh data
    const value = await fetcher();

    // Store in cache (fire and forget, but log errors)
    this.kv.put(key, JSON.stringify(value), {
      expirationTtl: ttlSeconds
    }).catch(err => {
      console.error(`[Cache] Failed to set ${key}:`, err);
    });

    return value;
  }

  /**
   * Get cached value only (no fetch on miss)
   */
  async get<T>(key: string): Promise<T | null> {
    return await this.kv.get(key, 'json');
  }

  /**
   * Set cached value
   */
  async set<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), {
      expirationTtl: ttlSeconds
    });
  }

  /**
   * Invalidate a specific cache key
   */
  async invalidate(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  /**
   * Invalidate all cache keys matching a prefix
   * Note: KV doesn't support prefix delete, so we track known keys
   */
  async invalidatePattern(prefix: string): Promise<void> {
    // List keys with prefix and delete each
    const list = await this.kv.list({ prefix, limit: 100 });
    await Promise.all(list.keys.map(k => this.kv.delete(k.name)));
  }

  // ============================================================================
  // Convenience methods for common cache patterns
  // ============================================================================

  /**
   * Cache key for organization settings
   */
  static orgSettingsKey(orgId: string): string {
    return `org:${orgId}:settings`;
  }

  /**
   * Cache key for organization connections
   */
  static orgConnectionsKey(orgId: string): string {
    return `org:${orgId}:connections`;
  }

  /**
   * Cache key for user profile
   */
  static userKey(userId: string): string {
    return `user:${userId}`;
  }

  /**
   * Cache key for pending AI decisions count
   */
  static pendingAIKey(orgId: string): string {
    return `org:${orgId}:pending_ai`;
  }

  /**
   * Invalidate all caches for an organization
   */
  async invalidateOrg(orgId: string): Promise<void> {
    await Promise.all([
      this.invalidate(CacheService.orgSettingsKey(orgId)),
      this.invalidate(CacheService.orgConnectionsKey(orgId)),
      this.invalidate(CacheService.pendingAIKey(orgId))
    ]);
  }

  /**
   * Invalidate user cache
   */
  async invalidateUser(userId: string): Promise<void> {
    await this.invalidate(CacheService.userKey(userId));
  }
}
