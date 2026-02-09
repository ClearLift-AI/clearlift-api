/**
 * Sanitization and validation utilities for SQL interpolation.
 *
 * Extracted from AnalyticsEngineService for reuse and direct unit testing.
 * Analytics Engine SQL does not support parameterized queries, so these
 * functions provide the only defense against injection.
 */

/**
 * Sanitize a string value for Analytics Engine SQL interpolation.
 * Uses strict allowlist — only alphanumeric, underscores, hyphens, and dots survive.
 */
export function sanitizeString(value: string): string {
  return value.replace(/[^a-zA-Z0-9_\-\.]/g, '');
}

/**
 * Validate that a number is a finite, non-negative integer within a safe range.
 * Throws if the value is not valid for SQL interpolation.
 */
export function validatePositiveInt(value: number, name: string): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 100000) {
    throw new Error(`Invalid ${name}: must be a positive integer <= 100000`);
  }
  return n;
}
