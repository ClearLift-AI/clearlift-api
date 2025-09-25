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

    // Add token to session for downstream use (e.g., DuckDB queries)
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
 * Optional middleware to check specific role
 * Must be used after requireOrg
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
          message: "Insufficient context"
        }
      }, 403);
    }

    // Get user's role in the organization
    const role = await c.env.DB.prepare(`
      SELECT role FROM organization_members
      WHERE user_id = ? AND organization_id = ?
    `).bind(session.user_id, orgId).first<{role: string}>();

    if (!role || !roles.includes(role.role)) {
      return c.json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: `Requires one of: ${roles.join(", ")}`
        }
      }, 403);
    }

    await next();
  };
}
