/**
 * D1 Database Session Utilities
 *
 * Provides session-aware database access for read replication support.
 * D1 Sessions API ensures consistent reads across global replicas.
 *
 * Usage:
 * - Use getDBSession() for read-only queries (default, most common)
 * - Use getPrimarySession() when you need read-after-write consistency
 *
 * @see https://developers.cloudflare.com/d1/platform/sessions/
 */

/**
 * Get a D1 session for consistent reads
 *
 * Uses 'first-unconstrained' which allows any replica to serve the read,
 * providing the best latency. Suitable for most read operations.
 *
 * @param db - D1 Database binding
 * @returns D1 Database Session
 */
export function getDBSession(db: D1Database): D1DatabaseSession {
  return db.withSession('first-unconstrained');
}

/**
 * Get a D1 session that reads from primary
 *
 * Uses 'first-primary' which ensures reads go to the primary database.
 * Use this when you need read-after-write consistency (e.g., after an INSERT).
 *
 * @param db - D1 Database binding
 * @returns D1 Database Session that reads from primary
 */
export function getPrimarySession(db: D1Database): D1DatabaseSession {
  return db.withSession('first-primary');
}
