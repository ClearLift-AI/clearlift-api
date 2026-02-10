/**
 * Structured Logger for Production Observability
 *
 * Outputs JSON to stdout/stderr for log aggregation (Cloudflare Logpush).
 * Provides severity levels, structured metadata, and error classification
 * to replace raw console.error calls across the API worker.
 *
 * Usage:
 *   import { structuredLog, handleEndpointError, isRetryableError } from '../utils/structured-logger';
 *
 *   structuredLog('INFO', 'Request processed', { org_id: 'abc', endpoint: '/v1/analytics/cac/summary' });
 *
 *   try { ... } catch (err) {
 *     structuredLog('ERROR', 'Query failed', { org_id, endpoint, error: err instanceof Error ? err.message : String(err) });
 *   }
 */

// =============================================================================
// Types
// =============================================================================

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface LogContext {
  org_id?: string;
  endpoint?: string;
  step?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  worker: 'clearlift-api';
  [key: string]: unknown;
}

// =============================================================================
// Core Logger
// =============================================================================

/**
 * JSON.stringify with circular reference protection and Error serialization.
 * Prevents crashes when context contains circular refs, functions, or BigInts.
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return '[Function]';
    return value;
  });
}

/**
 * Emit a structured JSON log entry.
 *
 * Routes to the appropriate console method based on severity:
 *   - CRITICAL / ERROR  -> console.error  (stderr)
 *   - WARN              -> console.warn   (stderr on most runtimes)
 *   - INFO              -> console.log    (stdout)
 */
export function structuredLog(level: LogLevel, message: string, context?: LogContext): void {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    worker: 'clearlift-api',
    ...context,
  };

  const json = safeStringify(entry);

  switch (level) {
    case 'CRITICAL':
    case 'ERROR':
      console.error(json);
      break;
    case 'WARN':
      console.warn(json);
      break;
    default:
      console.log(json);
  }
}

/**
 * Extract error details including stack trace for structured logging.
 * Use this when logging errors to capture full debugging context.
 */
export function errorContext(error: unknown): { error: string; error_type: string; stack?: string } {
  if (error instanceof Error) {
    return {
      error: error.message,
      error_type: error.constructor.name,
      ...(error.stack ? { stack: error.stack.split('\n').slice(1, 4).join(' | ') } : {}),
    };
  }
  return { error: String(error), error_type: typeof error };
}

// =============================================================================
// Error Classification
// =============================================================================

const RETRYABLE_PATTERN =
  /SQLITE_BUSY|D1_|timeout|network|ECONNRESET|ECONNREFUSED|429|503|too many|temporarily unavailable|internal error/i;

/**
 * Classify whether an error is retryable (transient) or permanent.
 */
export function isRetryableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return RETRYABLE_PATTERN.test(msg);
}
