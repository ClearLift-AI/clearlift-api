/**
 * Audit Logging Middleware for SOC 2 Compliance
 *
 * Automatically logs all API requests for audit trail.
 * Tracks user actions, data access, and security events.
 */

import { Context, Next } from "hono";
import { AppContext } from "../types";
import { AuditLogger, createAuditLogger } from "../services/auditLogger";

/**
 * Extract client IP address from request
 */
function getClientIp(c: Context): string {
  // Cloudflare provides the real IP
  return c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0].trim() ||
    c.req.header("X-Real-IP") ||
    "unknown";
}

/**
 * Generate or extract request ID
 */
function getRequestId(c: Context): string {
  return c.req.header("X-Request-Id") || crypto.randomUUID();
}

/**
 * Determine the action type from the request
 */
function getAction(method: string, path: string): string {
  // Authentication endpoints
  if (path.includes('/auth') || path.includes('/login')) {
    return 'auth.attempt';
  }
  if (path.includes('/logout')) {
    return 'auth.logout';
  }
  if (path.includes('/session')) {
    return 'auth.session';
  }

  // OAuth endpoints
  if (path.includes('/oauth') || path.includes('/callback')) {
    return 'oauth.flow';
  }
  if (path.includes('/connectors') && path.includes('/connect')) {
    return 'oauth.connect';
  }

  // Data access endpoints
  if (path.includes('/analytics')) {
    return 'data.analytics';
  }
  if (path.includes('/export')) {
    return 'data.export';
  }

  // Configuration endpoints
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    if (path.includes('/connectors')) {
      return 'config.connector';
    }
    if (path.includes('/organizations')) {
      return 'config.organization';
    }
    if (path.includes('/users')) {
      return 'config.user';
    }
  }

  // Worker management
  if (path.includes('/workers')) {
    return 'worker.management';
  }
  if (path.includes('/sync/trigger')) {
    return 'sync.trigger';
  }

  // Default action based on method
  switch (method) {
    case 'GET':
      return 'api.read';
    case 'POST':
      return 'api.create';
    case 'PUT':
    case 'PATCH':
      return 'api.update';
    case 'DELETE':
      return 'api.delete';
    default:
      return 'api.request';
  }
}

/**
 * Extract resource info from path
 */
function extractResource(path: string): { type?: string; id?: string } {
  const segments = path.split('/').filter(s => s);

  // Common patterns: /v1/resource/id or /v1/resource/id/action
  if (segments.length >= 3) {
    const resourceType = segments[1]; // After v1
    const resourceId = segments[2];

    // Check if it's a UUID or ID-like string
    if (resourceId && !['health', 'status', 'list'].includes(resourceId)) {
      return {
        type: resourceType,
        id: resourceId
      };
    }

    return { type: resourceType };
  }

  return {};
}

/**
 * Main audit logging middleware
 */
export async function auditMiddleware(c: AppContext, next: Next) {
  const startTime = Date.now();
  const requestId = getRequestId(c);
  const ipAddress = getClientIp(c);
  const userAgent = c.req.header("User-Agent") || "unknown";
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;

  // Set request ID in context for downstream use
  c.set("request_id" as any, requestId);

  const auditLogger = createAuditLogger(c);

  // Get session info if available
  const session = c.get("session");
  const orgId = c.get("org_id" as any) as string | undefined;

  // Extract resource info
  const resource = extractResource(path);

  try {
    // Execute the actual request
    await next();

    // Calculate response time
    const responseTime = Date.now() - startTime;

    // Log successful request (fire-and-forget, don't block response)
    auditLogger.logApiRequest({
      user_id: session?.user_id,
      organization_id: orgId,
      session_token_hash: session?.token,
      action: getAction(method, path),
      method,
      path,
      resource_type: resource.type,
      resource_id: resource.id,
      ip_address: ipAddress,
      user_agent: userAgent,
      request_id: requestId,
      success: true,
      status_code: c.res.status,
      response_time_ms: responseTime,
      metadata: {
        query_params: Object.fromEntries(new URL(c.req.url).searchParams)
      }
    }).catch(err => console.error('Failed to write audit log:', err));

    // Log data access for analytics endpoints (fire-and-forget)
    if (path.includes('/analytics') && session) {
      const queryParams = Object.fromEntries(new URL(c.req.url).searchParams);

      auditLogger.logDataAccess({
        user_id: session.user_id,
        organization_id: orgId || queryParams.org_id,
        access_type: 'api_fetch',
        data_source: determineDataSource(path),
        table_name: extractTableName(path),
        filters_applied: queryParams,
        query_time_ms: responseTime,
        request_id: requestId,
        ip_address: ipAddress,
        data_classification: 'internal'
      }).catch(err => console.error('Failed to write data access log:', err));
    }

  } catch (error) {
    const responseTime = Date.now() - startTime;

    // Log failed request (fire-and-forget)
    auditLogger.logApiRequest({
      user_id: session?.user_id,
      organization_id: orgId,
      session_token_hash: session?.token,
      action: getAction(method, path),
      method,
      path,
      resource_type: resource.type,
      resource_id: resource.id,
      ip_address: ipAddress,
      user_agent: userAgent,
      request_id: requestId,
      success: false,
      status_code: c.res.status || 500,
      error_code: (error as any).code || 'INTERNAL_ERROR',
      error_message: (error as any).message || 'Unknown error',
      response_time_ms: responseTime
    }).catch(err => console.error('Failed to write audit log:', err));

    // Log security events for suspicious activity (fire-and-forget)
    if (shouldLogSecurityEvent(error, path)) {
      auditLogger.logSecurityEvent({
        severity: getSecuritySeverity(error),
        event_type: getSecurityEventType(error, path),
        user_id: session?.user_id,
        organization_id: orgId,
        threat_indicator: (error as any).message,
        threat_source: ipAddress,
        ip_address: ipAddress,
        user_agent: userAgent,
        request_id: requestId,
        metadata: {
          method,
          path,
          error_details: (error as any).details
        }
      }).catch(err => console.error('Failed to write security log:', err));
    }

    throw error; // Re-throw to maintain normal error flow
  }
}

/**
 * Dedicated authentication audit middleware
 */
export async function authAuditMiddleware(c: AppContext, next: Next) {
  const auditLogger = createAuditLogger(c);
  const ipAddress = getClientIp(c);
  const userAgent = c.req.header("User-Agent") || "unknown";
  const path = new URL(c.req.url).pathname;

  // Determine event type
  let eventType: 'login' | 'logout' | 'session_refresh' | 'oauth_connect' | 'failed_login' = 'login';

  if (path.includes('logout')) {
    eventType = 'logout';
  } else if (path.includes('refresh') || path.includes('session')) {
    eventType = 'session_refresh';
  } else if (path.includes('oauth') || path.includes('connect')) {
    eventType = 'oauth_connect';
  }

  try {
    await next();

    const session = c.get("session");

    // Log successful auth event (fire-and-forget, don't block response)
    if (session) {
      auditLogger.logAuthEvent({
        event_type: eventType,
        user_id: session.user_id,
        email: session.email,
        auth_method: 'session',
        provider: extractProvider(path),
        ip_address: ipAddress,
        user_agent: userAgent,
        success: true,
        session_id: session.token,
        session_created: eventType === 'login'
      }).catch(err => console.error('Failed to write auth audit log:', err));
    }
  } catch (error) {
    // Log failed auth attempt (fire-and-forget, don't block error response)
    auditLogger.logAuthEvent({
      event_type: 'failed_login',
      auth_method: 'session',
      provider: extractProvider(path),
      ip_address: ipAddress,
      user_agent: userAgent,
      success: false,
      failure_reason: (error as any).message || 'Authentication failed',
      metadata: {
        path,
        error_code: (error as any).code
      }
    }).catch(err => console.error('Failed to write auth audit log:', err));

    throw error;
  }
}

/**
 * Helper function to determine data source from path
 */
function determineDataSource(path: string): 'r2_sql' | 'd1' | 'external_api' {
  if (path.includes('/events')) {
    return 'r2_sql';
  }
  if (path.includes('/platforms') || path.includes('/conversions')) {
    return 'd1'; // Platform data now served from D1 ANALYTICS_DB
  }
  if (path.includes('/user') || path.includes('/organizations')) {
    return 'd1';
  }
  return 'external_api';
}

/**
 * Extract table name from path
 */
function extractTableName(path: string): string | undefined {
  if (path.includes('/events')) return 'event_stream';
  if (path.includes('/campaigns')) return 'campaigns';
  if (path.includes('/conversions')) return 'conversions';
  if (path.includes('/users')) return 'users';
  if (path.includes('/organizations')) return 'organizations';
  return undefined;
}

/**
 * Extract OAuth provider from path
 */
function extractProvider(path: string): string | undefined {
  if (path.includes('google')) return 'google';
  if (path.includes('facebook')) return 'facebook';
  if (path.includes('tiktok')) return 'tiktok';
  if (path.includes('stripe')) return 'stripe';
  if (path.includes('cloudflare')) return 'cloudflare_access';
  return undefined;
}

/**
 * Determine if an error should trigger a security event
 */
function shouldLogSecurityEvent(error: any, path: string): boolean {
  const errorMessage = error.message?.toLowerCase() || '';

  // SQL injection attempts
  if (errorMessage.includes('sql') || errorMessage.includes('injection')) {
    return true;
  }

  // Unauthorized access attempts
  if (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED') {
    return true;
  }

  // Brute force indicators (multiple failed auth)
  if (path.includes('/auth') && !error.success) {
    return true;
  }

  // Data exfiltration attempts (large exports)
  if (path.includes('/export') && errorMessage.includes('limit')) {
    return true;
  }

  return false;
}

/**
 * Determine security event severity
 */
function getSecuritySeverity(error: any): 'info' | 'warning' | 'critical' {
  const errorMessage = error.message?.toLowerCase() || '';

  if (errorMessage.includes('injection') || errorMessage.includes('malicious')) {
    return 'critical';
  }

  if (error.code === 'FORBIDDEN' || errorMessage.includes('unauthorized')) {
    return 'warning';
  }

  return 'info';
}

/**
 * Determine security event type
 */
function getSecurityEventType(error: any, path: string): string {
  const errorMessage = error.message?.toLowerCase() || '';

  if (errorMessage.includes('sql') || errorMessage.includes('injection')) {
    return 'sql_injection';
  }

  if (path.includes('/auth') && !error.success) {
    return 'brute_force';
  }

  if (error.code === 'FORBIDDEN') {
    return 'unauthorized_access';
  }

  if (path.includes('/export') && errorMessage.includes('limit')) {
    return 'data_exfiltration';
  }

  return 'security_violation';
}