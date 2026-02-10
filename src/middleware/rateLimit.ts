/**
 * Rate Limiting Middleware for SOC 2 Compliance
 *
 * Implements rate limiting to prevent abuse and ensure availability.
 * Uses sliding window algorithm with D1 for distributed rate limiting.
 */

import { Context, Next } from "hono";
import { AppContext } from "../types";
import { ApiError } from "./errorHandler";
import { createAuditLogger } from "../services/auditLogger";
import { structuredLog } from "../utils/structured-logger";

export interface RateLimitConfig {
  windowMs: number;        // Time window in milliseconds
  maxRequests: number;     // Max requests per window
  keyGenerator?: (c: Context) => string; // Function to generate rate limit key
  skipSuccessfulRequests?: boolean; // Only count failed requests
  skipFailedRequests?: boolean;     // Only count successful requests
  message?: string;        // Custom error message
}

// Default rate limit configurations
export const RateLimits = {
  // General API rate limit
  standard: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 60      // 60 requests per minute
  },

  // Stricter limit for auth endpoints
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 5,            // 5 attempts per 15 minutes
    skipSuccessfulRequests: true, // Only count failures
    message: "Too many authentication attempts. Please try again later."
  },

  // Analytics endpoints (resource intensive)
  analytics: {
    windowMs: 60 * 1000,  // 1 minute
    maxRequests: 20       // 20 requests per minute
  },

  // Export endpoints (very resource intensive)
  export: {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 10            // 10 exports per hour
  },

  // Configuration changes
  config: {
    windowMs: 60 * 1000,  // 1 minute
    maxRequests: 10       // 10 changes per minute
  }
};

/**
 * Rate limit storage schema in D1
 */
interface RateLimitEntry {
  key: string;
  count: number;
  window_start: string;
  window_end: string;
  last_request: string;
}

/**
 * Generate rate limit key based on context
 */
function getDefaultKey(c: Context): string {
  // Use IP address as default key
  const ip = c.req.header("CF-Connecting-IP") ||
             c.req.header("X-Forwarded-For")?.split(",")[0].trim() ||
             c.req.header("X-Real-IP") ||
             "unknown";

  // For authenticated requests, include user ID
  const session = (c as AppContext).get("session");
  if (session?.user_id) {
    return `user:${session.user_id}`;
  }

  return `ip:${ip}`;
}

/**
 * Flag to track if rate limit table has been initialized
 * Prevents running DDL on every request
 */
let rateLimitTableInitialized = false;

/**
 * Create rate limit table if not exists
 * This should be in a migration, but included here for safety
 * Note: Only runs once per worker instance
 */
async function ensureRateLimitTable(db: D1Database) {
  if (rateLimitTableInitialized) {
    return;
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        last_request TEXT NOT NULL
      )
    `).run();

    // Create index for cleanup queries
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_rate_limits_window_end
      ON rate_limits(window_end)
    `).run();

    rateLimitTableInitialized = true;
    console.log("[RateLimit] Table initialized successfully");
  } catch (error) {
    // Table might already exist, mark as initialized
    rateLimitTableInitialized = true;
    structuredLog('WARN', 'Rate limit table check error', { service: 'rate-limiter', error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Clean up expired rate limit entries
 */
async function cleanupExpiredEntries(db: D1Database) {
  try {
    const now = new Date().toISOString();
    await db.prepare(`
      DELETE FROM rate_limits
      WHERE window_end < ?
    `).bind(now).run();
  } catch (error) {
    structuredLog('ERROR', 'Failed to cleanup rate limit entries', { service: 'rate-limiter', error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Rate limiting middleware factory
 */
export function rateLimitMiddleware(config: RateLimitConfig) {
  return async function(c: AppContext, next: Next) {
    const db = c.env.DB;

    // Ensure table exists
    await ensureRateLimitTable(db);

    // Generate rate limit key
    const key = config.keyGenerator ? config.keyGenerator(c) : getDefaultKey(c);

    // Get current time
    const now = new Date();
    const nowIso = now.toISOString();

    // Calculate window boundaries
    const windowStart = new Date(now.getTime() - config.windowMs);
    const windowEnd = now;

    // Track if next() was already called to prevent double invocation
    let nextCalled = false;

    try {
      // Get current rate limit entry
      const entry = await db.prepare(`
        SELECT * FROM rate_limits
        WHERE key = ? AND window_end > ?
      `).bind(key, nowIso).first<RateLimitEntry>();

      let count = 0;
      let shouldBlock = false;

      if (entry) {
        // Check if we're still in the same window
        const entryWindowEnd = new Date(entry.window_end);
        if (entryWindowEnd > now) {
          count = entry.count;

          // Check if limit exceeded
          if (count >= config.maxRequests) {
            shouldBlock = true;
          }
        }
      }

      // Block if rate limit exceeded
      if (shouldBlock) {
        // Calculate retry after (in seconds)
        const retryAfter = Math.ceil((new Date(entry!.window_end).getTime() - now.getTime()) / 1000);

        // Log security event (non-blocking, ignore failures)
        try {
          const auditLogger = createAuditLogger(c);
          await auditLogger.logSecurityEvent({
            severity: 'warning',
            event_type: 'rate_limit_exceeded',
            user_id: c.get("session")?.user_id,
            organization_id: c.get("org_id" as any),
            threat_indicator: `Rate limit exceeded: ${count}/${config.maxRequests}`,
            threat_source: key,
            automated_response: 'blocked',
            ip_address: c.req.header("CF-Connecting-IP") || "unknown",
            user_agent: c.req.header("User-Agent") || "unknown",
            request_id: c.get("request_id" as any),
            metadata: {
              path: new URL(c.req.url).pathname,
              method: c.req.method,
              rate_limit_key: key,
              requests_made: count,
              limit: config.maxRequests
            }
          });
        } catch (logErr) {
          // Ignore audit log failures - don't let them block the rate limit response
          structuredLog('ERROR', 'Failed to log rate limit event', { service: 'rate-limiter', error: logErr instanceof Error ? logErr.message : String(logErr) });
        }

        // Return rate limit error
        c.header("X-RateLimit-Limit", String(config.maxRequests));
        c.header("X-RateLimit-Remaining", "0");
        c.header("X-RateLimit-Reset", entry!.window_end);
        c.header("Retry-After", String(retryAfter));

        throw new ApiError(
          "RATE_LIMIT_EXCEEDED",
          config.message || "Too many requests. Please try again later.",
          429,
          { retryAfter }
        );
      }

      // Process request
      let requestSucceeded = false;
      try {
        nextCalled = true;
        await next();
        requestSucceeded = c.res.status < 400;
      } catch (error) {
        requestSucceeded = false;
        throw error;
      }

      // Update rate limit count (after next() completes, non-blocking)
      const shouldCount = (
        (!config.skipSuccessfulRequests || !requestSucceeded) &&
        (!config.skipFailedRequests || requestSucceeded)
      );

      if (shouldCount) {
        const newCount = count + 1;
        const newWindowEnd = new Date(now.getTime() + config.windowMs).toISOString();

        // Upsert rate limit entry - fire and forget, don't let D1 failures break the response
        db.prepare(`
          INSERT INTO rate_limits (key, count, window_start, window_end, last_request)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            count = ?,
            window_end = ?,
            last_request = ?
        `).bind(
          key,
          newCount,
          windowStart.toISOString(),
          newWindowEnd,
          nowIso,
          newCount,
          newWindowEnd,
          nowIso
        ).run().catch(err => structuredLog('ERROR', 'Rate limit update failed', { service: 'rate-limiter', error: err instanceof Error ? err.message : String(err) }));

        // Add rate limit headers
        c.header("X-RateLimit-Limit", String(config.maxRequests));
        c.header("X-RateLimit-Remaining", String(Math.max(0, config.maxRequests - newCount)));
        c.header("X-RateLimit-Reset", newWindowEnd);
      }

      // Occasionally clean up expired entries (1% chance)
      if (Math.random() < 0.01) {
        cleanupExpiredEntries(db).catch(err => structuredLog('ERROR', 'Rate limit cleanup failed', { service: 'rate-limiter', error: err instanceof Error ? err.message : String(err) }));
      }
    } catch (error) {
      // If rate limiting fails, log but don't block the request
      structuredLog('ERROR', 'Rate limiting error', { service: 'rate-limiter', error: error instanceof Error ? error.message : String(error) });

      // Re-throw if it's our rate limit error
      if (error instanceof ApiError && error.code === "RATE_LIMIT_EXCEEDED") {
        throw error;
      }

      // Only call next() if it hasn't been called already
      if (!nextCalled) {
        await next();
      }
    }
  };
}

/**
 * Organization-specific rate limiting
 */
export function orgRateLimitMiddleware(config: Partial<RateLimitConfig> = {}) {
  return rateLimitMiddleware({
    windowMs: config.windowMs || 60 * 1000,     // 1 minute default
    maxRequests: config.maxRequests || 100,     // 100 requests per minute default
    keyGenerator: (c: Context) => {
      const orgId = (c as AppContext).get("org_id" as any);
      if (orgId) {
        return `org:${orgId}`;
      }
      // Fall back to user/IP if no org
      return getDefaultKey(c);
    },
    ...config
  });
}

/**
 * IP-based rate limiting (for unauthenticated endpoints)
 */
export function ipRateLimitMiddleware(config: Partial<RateLimitConfig> = {}) {
  return rateLimitMiddleware({
    windowMs: config.windowMs || 60 * 1000,
    maxRequests: config.maxRequests || 30,
    keyGenerator: (c: Context) => {
      const ip = c.req.header("CF-Connecting-IP") ||
                 c.req.header("X-Forwarded-For")?.split(",")[0].trim() ||
                 c.req.header("X-Real-IP") ||
                 "unknown";
      return `ip:${ip}`;
    },
    ...config
  });
}

/**
 * Strict rate limiting for authentication endpoints
 */
export const authRateLimit = rateLimitMiddleware({
  ...RateLimits.auth,
  keyGenerator: (c: Context) => {
    // Use IP for auth endpoints to prevent credential stuffing
    const ip = c.req.header("CF-Connecting-IP") ||
               c.req.header("X-Forwarded-For")?.split(",")[0].trim() ||
               "unknown";

    // Note: Can't access request body synchronously in Hono
    // IP-based rate limiting is sufficient for auth endpoints
    return `auth:${ip}`;
  }
});

/**
 * Rate limiting for analytics endpoints
 */
export const analyticsRateLimit = rateLimitMiddleware({
  ...RateLimits.analytics,
  keyGenerator: (c: Context) => {
    const session = (c as AppContext).get("session");
    const orgId = (c as AppContext).get("org_id" as any);

    // Rate limit by organization if available
    if (orgId) {
      return `analytics:org:${orgId}`;
    }

    // Otherwise by user
    if (session?.user_id) {
      return `analytics:user:${session.user_id}`;
    }

    return getDefaultKey(c);
  }
});

/**
 * Rate limiting for export endpoints
 */
export const exportRateLimit = rateLimitMiddleware({
  ...RateLimits.export,
  keyGenerator: (c: Context) => {
    const session = (c as AppContext).get("session");
    const orgId = (c as AppContext).get("org_id" as any);

    // Strict per-organization limit for exports
    if (orgId) {
      return `export:org:${orgId}`;
    }

    // Per-user limit as fallback
    if (session?.user_id) {
      return `export:user:${session.user_id}`;
    }

    return `export:${getDefaultKey(c)}`;
  }
});