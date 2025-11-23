import { Context, Next } from "hono";
import { AppContext } from "../types";

export interface Session {
  user_id: string;
  email: string;
  name: string | null;
  expires_at: string;
  token: string;
}

/**
 * Role hierarchy: owner > admin > viewer
 * Used for permission checks with inheritance
 */
const ROLE_HIERARCHY: Record<string, number> = {
  owner: 3,
  admin: 2,
  viewer: 1
};

/**
 * Check if a user's role satisfies the required role(s)
 * Supports role hierarchy: owner can do anything admin/viewer can do
 */
export function hasRole(userRole: string, requiredRoles: string[]): boolean {
  const userLevel = ROLE_HIERARCHY[userRole];

  if (userLevel === undefined) {
    return false; // Unknown role
  }

  // Check if user's role level meets or exceeds any of the required roles
  return requiredRoles.some(requiredRole => {
    const requiredLevel = ROLE_HIERARCHY[requiredRole];
    return requiredLevel !== undefined && userLevel >= requiredLevel;
  });
}

/**
 * Extracts Bearer token from Authorization header
 */
function extractToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.replace("Bearer ", "").trim();
}

/**
 * Session validation middleware
 * Validates session token and loads user data from D1
 */
export async function auth(c: AppContext, next: Next) {
  const token = extractToken(c.req.raw);

  if (!token) {
    return c.json({
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Missing authentication token"
      }
    }, 401);
  }

  try {
    const session = await c.env.DB.prepare(`
      SELECT
        s.user_id,
        s.expires_at,
        u.email,
        u.name
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.expires_at > datetime('now')
    `).bind(token).first<Session>();

    if (!session) {
      return c.json({
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or expired session"
        }
      }, 401);
    }

    // Add token to session for downstream use.
    session.token = token;

    // Store session in context
    c.set("session", session);

    await next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    return c.json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Authentication failed"
      }
    }, 500);
  }
}

/**
 * Middleware to require organization context
 * Must be used after auth middleware
 * Extracts org_id from query parameter and validates access
 */
export async function requireOrg(c: AppContext, next: Next) {
  const session = c.get("session");

  if (!session) {
    return c.json({
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Session not found"
      }
    }, 401);
  }

  // Get org_id from query parameter
  const orgId = c.req.query("org_id");

  if (!orgId) {
    return c.json({
      success: false,
      error: {
        code: "MISSING_ORG_ID",
        message: "org_id query parameter is required"
      }
    }, 400);
  }

  // Verify user has access to the organization
  const { D1Adapter } = await import("../adapters/d1");
  const d1 = new D1Adapter(c.env.DB);
  const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);

  if (!hasAccess) {
    return c.json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "No access to this organization"
      }
    }, 403);
  }

  // Store org_id in context for downstream use
  c.set("org_id" as any, orgId);

  await next();
}

/**
 * Role-based access control middleware with hierarchy support
 * Must be used after requireOrg middleware
 *
 * Supports role hierarchy: owner can do anything admin/viewer can do
 * Example: requireRole(['admin']) allows both 'admin' and 'owner' roles
 *
 * @param roles - Array of allowed roles (viewer, admin, owner)
 */
export function requireRole(roles: string[]) {
  return async (c: AppContext, next: Next) => {
    const session = c.get("session");
    const orgId = c.get("org_id" as any) as string;

    if (!session || !orgId) {
      return c.json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Insufficient context for role check"
        }
      }, 403);
    }

    try {
      // Get user's role in the organization
      const member = await c.env.DB.prepare(`
        SELECT role FROM organization_members
        WHERE user_id = ? AND organization_id = ?
      `).bind(session.user_id, orgId).first<{role: string}>();

      if (!member) {
        // User is not a member of the organization
        return c.json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "No access to this organization"
          }
        }, 403);
      }

      // Check role with hierarchy support
      if (!hasRole(member.role, roles)) {
        // Log authorization failure for audit trail
        const { createAuditLogger } = await import("../services/auditLogger");
        const auditLogger = createAuditLogger(c);

        await auditLogger.logSecurityEvent({
          severity: 'warning',
          event_type: "authorization_denied",
          user_id: session.user_id,
          organization_id: orgId,
          ip_address: c.req.header("CF-Connecting-IP") || "unknown",
          user_agent: c.req.header("User-Agent") || "unknown",
          metadata: {
            required_roles: roles,
            user_role: member.role,
            method: c.req.method,
            path: c.req.path,
            resource_type: "endpoint"
          }
        });

        return c.json({
          success: false,
          error: {
            code: "INSUFFICIENT_PERMISSIONS",
            message: `This action requires one of the following roles: ${roles.join(", ")}. You have: ${member.role}`
          }
        }, 403);
      }

      await next();
    } catch (error) {
      console.error("Role check error:", error);
      return c.json({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to verify permissions"
        }
      }, 500);
    }
  };
}

/**
 * Convenience middleware: Requires organization admin or owner role
 * Combines requireOrg + requireRole(['admin', 'owner'])
 *
 * Use this for sensitive operations like:
 * - Inviting/removing members
 * - Updating organization settings
 * - Managing connectors
 */
export const requireOrgAdmin = requireRole(['admin', 'owner']);

/**
 * Convenience middleware: Requires organization owner role only
 * Combines requireOrg + requireRole(['owner'])
 *
 * Use this for critical operations like:
 * - Deleting the organization
 * - Transferring ownership
 * - Billing changes
 */
export const requireOrgOwner = requireRole(['owner']);
