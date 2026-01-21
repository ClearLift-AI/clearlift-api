/**
 * Cross-Source Deduplication Service
 *
 * Prevents double-counting conversions across sources (Stripe, Shopify, Tag events)
 * using email hash + date + source as the deduplication key.
 */

/**
 * Generate a deduplication key from customer email and conversion details
 *
 * The key format is: {emailHash16}_{YYYY-MM-DD}_{source}
 * Example: "a1b2c3d4e5f6g7h8_2024-01-15_stripe"
 *
 * @param customerEmail - The customer's email address
 * @param conversionDate - The date of the conversion (YYYY-MM-DD format)
 * @param source - The conversion source ('stripe', 'shopify', 'tag', etc.)
 * @returns The deduplication key
 */
export function generateDedupKey(
  customerEmail: string,
  conversionDate: string,
  source: string
): string {
  // Normalize email: lowercase and trim
  const normalizedEmail = customerEmail.toLowerCase().trim();

  // Generate a shortened hash of the email (first 16 chars of SHA-256)
  // Note: In Cloudflare Workers, use SubtleCrypto
  const emailHash = hashEmail(normalizedEmail);

  // Format: {hash}_{date}_{source}
  return `${emailHash}_${conversionDate}_${source}`;
}

/**
 * Hash email using a simple hash function
 * For production use with SubtleCrypto, use hashEmailAsync
 */
function hashEmail(email: string): string {
  // Simple hash for synchronous contexts
  // In production, prefer hashEmailAsync with SubtleCrypto
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    const char = email.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Convert to hex and take first 16 chars
  const hexHash = Math.abs(hash).toString(16).padStart(8, '0');
  return hexHash + hexHash; // Duplicate to get 16 chars
}

/**
 * Hash email using SubtleCrypto (async, for Workers)
 */
export async function hashEmailAsync(email: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(email.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 16);
}

/**
 * Generate dedup key using async hashing (for Cloudflare Workers)
 */
export async function generateDedupKeyAsync(
  customerEmail: string,
  conversionDate: string,
  source: string
): Promise<string> {
  const emailHash = await hashEmailAsync(customerEmail);
  return `${emailHash}_${conversionDate}_${source}`;
}

/**
 * Check if a conversion already exists with the same dedup key
 *
 * @param db - D1 database binding
 * @param orgId - Organization ID
 * @param dedupKey - The deduplication key to check
 * @param windowHours - Time window to check for duplicates (default 24 hours)
 * @returns True if a duplicate exists
 */
export async function isDuplicate(
  db: D1Database,
  orgId: string,
  dedupKey: string,
  windowHours: number = 24
): Promise<boolean> {
  const result = await db.prepare(`
    SELECT 1 FROM conversions
    WHERE organization_id = ?
      AND dedup_key = ?
      AND created_at >= datetime('now', '-' || ? || ' hours')
    LIMIT 1
  `).bind(orgId, dedupKey, windowHours).first();

  return !!result;
}

/**
 * Check for existing conversions across all sources for the same email/date
 * Returns all sources that have recorded this conversion
 *
 * @param db - D1 database binding
 * @param orgId - Organization ID
 * @param emailHash - The email hash (first 16 chars of SHA-256)
 * @param conversionDate - The date of the conversion (YYYY-MM-DD)
 * @returns Array of sources that have this conversion
 */
export async function findExistingConversions(
  db: D1Database,
  orgId: string,
  emailHash: string,
  conversionDate: string
): Promise<string[]> {
  const pattern = `${emailHash}_${conversionDate}_%`;

  const result = await db.prepare(`
    SELECT DISTINCT conversion_source
    FROM conversions
    WHERE organization_id = ?
      AND dedup_key LIKE ?
  `).bind(orgId, pattern).all<{ conversion_source: string }>();

  return (result.results || []).map(r => r.conversion_source);
}

/**
 * Deduplication result for batch processing
 */
export interface DedupResult {
  dedupKey: string;
  isDuplicate: boolean;
  existingSources: string[];
}

/**
 * Batch check for duplicates
 * More efficient for processing multiple conversions at once
 *
 * @param db - D1 database binding
 * @param orgId - Organization ID
 * @param conversions - Array of {email, date, source} to check
 * @returns Map of dedup key to result
 */
export async function batchCheckDuplicates(
  db: D1Database,
  orgId: string,
  conversions: Array<{ email: string; date: string; source: string }>
): Promise<Map<string, DedupResult>> {
  const results = new Map<string, DedupResult>();

  // Generate all dedup keys
  const dedupKeys: string[] = [];
  for (const conv of conversions) {
    const key = await generateDedupKeyAsync(conv.email, conv.date, conv.source);
    dedupKeys.push(key);
    results.set(key, {
      dedupKey: key,
      isDuplicate: false,
      existingSources: [],
    });
  }

  // Query for existing keys in batch
  if (dedupKeys.length > 0) {
    // Build placeholders for IN clause
    const placeholders = dedupKeys.map(() => '?').join(',');
    const existing = await db.prepare(`
      SELECT dedup_key, conversion_source
      FROM conversions
      WHERE organization_id = ?
        AND dedup_key IN (${placeholders})
    `).bind(orgId, ...dedupKeys).all<{ dedup_key: string; conversion_source: string }>();

    // Mark duplicates
    for (const row of existing.results || []) {
      const result = results.get(row.dedup_key);
      if (result) {
        result.isDuplicate = true;
        result.existingSources.push(row.conversion_source);
      }
    }
  }

  return results;
}
