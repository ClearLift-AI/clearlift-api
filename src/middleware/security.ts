/**
 * Security Headers Middleware for SOC 2 Compliance
 *
 * Implements security best practices via HTTP headers.
 * Protects against common web vulnerabilities.
 */

import { Context, Next } from "hono";
import { AppContext } from "../types";

/**
 * Security headers configuration
 */
export interface SecurityHeadersConfig {
  contentSecurityPolicy?: string | boolean;
  crossOriginEmbedderPolicy?: string | boolean;
  crossOriginOpenerPolicy?: string | boolean;
  crossOriginResourcePolicy?: string | boolean;
  expectCT?: string | boolean;
  originAgentCluster?: string | boolean;
  referrerPolicy?: string | boolean;
  strictTransportSecurity?: string | boolean;
  xContentTypeOptions?: string | boolean;
  xDNSPrefetchControl?: string | boolean;
  xDownloadOptions?: string | boolean;
  xFrameOptions?: string | boolean;
  xPermittedCrossDomainPolicies?: string | boolean;
  xPoweredBy?: string | boolean;
  xXSSProtection?: string | boolean;
}

/**
 * Default security headers configuration
 */
const defaultConfig: SecurityHeadersConfig = {
  contentSecurityPolicy: "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.adbliss.io https://*.adbliss.io https://api.clearlift.ai https://*.clearlift.ai",
  crossOriginEmbedderPolicy: false, // Disabled to allow Swagger UI CDN resources
  crossOriginOpenerPolicy: "same-origin",
  crossOriginResourcePolicy: "same-origin",
  expectCT: "max-age=0",
  originAgentCluster: "?1",
  referrerPolicy: "strict-origin-when-cross-origin",
  strictTransportSecurity: "max-age=31536000; includeSubDomains; preload",
  xContentTypeOptions: "nosniff",
  xDNSPrefetchControl: "off",
  xDownloadOptions: "noopen",
  xFrameOptions: "DENY",
  xPermittedCrossDomainPolicies: "none",
  xPoweredBy: false, // Remove X-Powered-By header
  xXSSProtection: "1; mode=block"
};

/**
 * Apply security headers to response
 */
function applySecurityHeaders(c: Context, config: SecurityHeadersConfig) {
  // Content-Security-Policy
  if (config.contentSecurityPolicy) {
    const csp = typeof config.contentSecurityPolicy === 'string'
      ? config.contentSecurityPolicy
      : defaultConfig.contentSecurityPolicy;
    if (typeof csp === 'string') {
      c.header("Content-Security-Policy", csp);
    }
  }

  // Cross-Origin-Embedder-Policy
  if (config.crossOriginEmbedderPolicy) {
    const coep = typeof config.crossOriginEmbedderPolicy === 'string'
      ? config.crossOriginEmbedderPolicy
      : "require-corp";
    c.header("Cross-Origin-Embedder-Policy", coep);
  }

  // Cross-Origin-Opener-Policy
  if (config.crossOriginOpenerPolicy) {
    const coop = typeof config.crossOriginOpenerPolicy === 'string'
      ? config.crossOriginOpenerPolicy
      : "same-origin";
    c.header("Cross-Origin-Opener-Policy", coop);
  }

  // Cross-Origin-Resource-Policy
  if (config.crossOriginResourcePolicy) {
    const corp = typeof config.crossOriginResourcePolicy === 'string'
      ? config.crossOriginResourcePolicy
      : "same-origin";
    c.header("Cross-Origin-Resource-Policy", corp);
  }

  // Expect-CT
  if (config.expectCT) {
    const expectCT = typeof config.expectCT === 'string'
      ? config.expectCT
      : "max-age=0";
    c.header("Expect-CT", expectCT);
  }

  // Origin-Agent-Cluster
  if (config.originAgentCluster) {
    const oac = typeof config.originAgentCluster === 'string'
      ? config.originAgentCluster
      : "?1";
    c.header("Origin-Agent-Cluster", oac);
  }

  // Referrer-Policy
  if (config.referrerPolicy) {
    const rp = typeof config.referrerPolicy === 'string'
      ? config.referrerPolicy
      : "strict-origin-when-cross-origin";
    c.header("Referrer-Policy", rp);
  }

  // Strict-Transport-Security (HSTS)
  if (config.strictTransportSecurity) {
    const hsts = typeof config.strictTransportSecurity === 'string'
      ? config.strictTransportSecurity
      : "max-age=31536000; includeSubDomains; preload";
    c.header("Strict-Transport-Security", hsts);
  }

  // X-Content-Type-Options
  if (config.xContentTypeOptions) {
    const xcto = typeof config.xContentTypeOptions === 'string'
      ? config.xContentTypeOptions
      : "nosniff";
    c.header("X-Content-Type-Options", xcto);
  }

  // X-DNS-Prefetch-Control
  if (config.xDNSPrefetchControl) {
    const xdpc = typeof config.xDNSPrefetchControl === 'string'
      ? config.xDNSPrefetchControl
      : "off";
    c.header("X-DNS-Prefetch-Control", xdpc);
  }

  // X-Download-Options
  if (config.xDownloadOptions) {
    const xdo = typeof config.xDownloadOptions === 'string'
      ? config.xDownloadOptions
      : "noopen";
    c.header("X-Download-Options", xdo);
  }

  // X-Frame-Options
  if (config.xFrameOptions) {
    const xfo = typeof config.xFrameOptions === 'string'
      ? config.xFrameOptions
      : "DENY";
    c.header("X-Frame-Options", xfo);
  }

  // X-Permitted-Cross-Domain-Policies
  if (config.xPermittedCrossDomainPolicies) {
    const xpcdp = typeof config.xPermittedCrossDomainPolicies === 'string'
      ? config.xPermittedCrossDomainPolicies
      : "none";
    c.header("X-Permitted-Cross-Domain-Policies", xpcdp);
  }

  // Remove X-Powered-By header for security
  if (config.xPoweredBy === false) {
    c.header("X-Powered-By", "");
  }

  // X-XSS-Protection (legacy but still useful)
  if (config.xXSSProtection) {
    const xxp = typeof config.xXSSProtection === 'string'
      ? config.xXSSProtection
      : "1; mode=block";
    c.header("X-XSS-Protection", xxp);
  }
}

/**
 * Security headers middleware
 */
export function securityHeaders(config: SecurityHeadersConfig = {}) {
  const mergedConfig = { ...defaultConfig, ...config };

  return async function(c: Context, next: Next) {
    // Apply security headers to response
    applySecurityHeaders(c, mergedConfig);

    // Add additional security measures
    addSecurityContext(c);

    await next();
  };
}

/**
 * Add security context to request
 */
function addSecurityContext(c: Context) {
  // Add request ID if not present
  if (!c.req.header("X-Request-Id")) {
    const requestId = crypto.randomUUID();
    c.header("X-Request-Id", requestId);
  }

  // Add timestamp
  c.header("X-Response-Time", new Date().toISOString());

  // Add service identifier (but not revealing technology stack)
  c.header("X-Service", "AdBliss-API");
}

/**
 * Content type validation middleware
 */
export function validateContentType(allowedTypes: string[] = ["application/json"]) {
  return async function(c: Context, next: Next) {
    // Only validate for requests with body
    if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
      const contentType = c.req.header("Content-Type");

      if (!contentType) {
        return c.json({
          success: false,
          error: {
            code: "INVALID_CONTENT_TYPE",
            message: "Content-Type header is required"
          }
        }, 400);
      }

      // Extract main content type (before semicolon)
      const mainContentType = contentType.split(";")[0].trim();

      if (!allowedTypes.includes(mainContentType)) {
        return c.json({
          success: false,
          error: {
            code: "INVALID_CONTENT_TYPE",
            message: `Content-Type must be one of: ${allowedTypes.join(", ")}`
          }
        }, 415); // Unsupported Media Type
      }
    }

    await next();
  };
}

/**
 * Input sanitization middleware
 */
export function sanitizeInput() {
  return async function(c: AppContext, next: Next) {
    // OAuth-related parameters that should be exempt from SQL injection checks
    // These contain special characters (0x, slashes, etc.) that trigger false positives
    const oauthWhitelist = ['code', 'state', 'redirect_uri', 'access_token', 'refresh_token'];

    // Sanitize query parameters
    const url = new URL(c.req.url);
    const sanitizedParams = new URLSearchParams();

    for (const [key, value] of url.searchParams.entries()) {
      const sanitizedValue = sanitizeString(value);
      sanitizedParams.set(key, sanitizedValue);

      // Skip SQL injection checks for OAuth parameters (they contain 0x, slashes, etc.)
      if (oauthWhitelist.includes(key)) {
        continue;
      }

      // Check for SQL injection patterns
      if (containsSQLInjectionPattern(sanitizedValue)) {
        // Log security event
        const { createAuditLogger } = await import("../services/auditLogger");
        const auditLogger = createAuditLogger(c);

        await auditLogger.logSecurityEvent({
          severity: 'critical',
          event_type: 'sql_injection_attempt',
          user_id: c.get("session")?.user_id,
          threat_indicator: `SQL injection pattern in query param: ${key}`,
          threat_source: c.req.header("CF-Connecting-IP") || "unknown",
          automated_response: 'blocked',
          request_data: sanitizedValue,
          ip_address: c.req.header("CF-Connecting-IP") || "unknown",
          user_agent: c.req.header("User-Agent") || "unknown",
          request_id: c.req.header("X-Request-Id")
        });

        return c.json({
          success: false,
          error: {
            code: "INVALID_INPUT",
            message: "Invalid characters in request"
          }
        }, 400);
      }
    }

    // NOTE: Body sanitization is disabled to prevent body stream consumption
    // that interferes with Chanfana/OpenAPIRoute's body parsing.
    // Chanfana endpoints use Zod schemas for validation, which provides
    // type safety and prevents injection attacks at the schema level.
    // For non-Chanfana routes that need body sanitization, implement it
    // at the route handler level after body parsing.

    await next();
  };
}

/**
 * Sanitize a string value
 */
function sanitizeString(value: string): string {
  // Remove null bytes
  let sanitized = value.replace(/\0/g, "");

  // Encode HTML entities to prevent XSS
  // Note: Forward slashes are NOT encoded as they're safe in JSON/API contexts
  // and required for URLs (redirect_uri, etc.)
  sanitized = sanitized
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

  return sanitized;
}

/**
 * Sanitize an object recursively
 */
function sanitizeObject(obj: any): any {
  if (typeof obj === "string") {
    return sanitizeString(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }

  if (obj && typeof obj === "object") {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[sanitizeString(key)] = sanitizeObject(value);
    }
    return sanitized;
  }

  return obj;
}

/**
 * Check for SQL injection patterns
 */
function containsSQLInjectionPattern(value: string): boolean {
  const sqlPatterns = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|FROM|WHERE|ORDER BY|GROUP BY|HAVING)\b)/gi,
    /(--|\||;|\/\*|\*\/|xp_|sp_|0x)/gi,
    /(\bOR\b\s*\d+\s*=\s*\d+|\bAND\b\s*\d+\s*=\s*\d+)/gi,
    /(\'\s*OR\s*\'|\"\s*OR\s*\")/gi
  ];

  return sqlPatterns.some(pattern => pattern.test(value));
}

/**
 * Check for injection patterns in object
 */
function containsInjectionInObject(obj: any): boolean {
  if (typeof obj === "string") {
    return containsSQLInjectionPattern(obj);
  }

  if (Array.isArray(obj)) {
    return obj.some(item => containsInjectionInObject(item));
  }

  if (obj && typeof obj === "object") {
    return Object.values(obj).some(value => containsInjectionInObject(value));
  }

  return false;
}

/**
 * Clickjacking protection middleware
 */
export function clickjackingProtection(policy: "DENY" | "SAMEORIGIN" = "DENY") {
  return async function(c: Context, next: Next) {
    c.header("X-Frame-Options", policy);
    c.header("Content-Security-Policy", `frame-ancestors ${policy === "DENY" ? "'none'" : "'self'"}`);
    await next();
  };
}