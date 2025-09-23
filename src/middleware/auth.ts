import { Context, Next } from "hono";
import { AppContext } from "../types";

export interface Session {
  user_id: string;
  email: string;
  name: string | null;
  current_organization_id: string | null;
  expires_at: string;
  org_id?: string;
  org_name?: string;
  org_slug?: string;
  role?: string;
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
        s.current_organization_id,
        s.expires_at,
        u.email,
        u.name,
        o.id as org_id,
        o.name as org_name,
        o.slug as org_slug,
        om.role
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN organizations o ON s.current_organization_id = o.id
      LEFT JOIN organization_members om ON om.user_id = u.id AND om.organization_id = o.id
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

  // Check if user has a current organization
  if (!session.current_organization_id) {
    return c.json({
      success: false,
      error: {
        code: "NO_ORGANIZATION",
        message: "No organization selected"
      }
    }, 403);
  }

  // Verify user has access to the organization
  if (!session.org_id || !session.role) {
    return c.json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "No access to this organization"
      }
    }, 403);
  }

  await next();
}

/**
 * Optional middleware to check specific role
 */
export function requireRole(roles: string[]) {
  return async (c: AppContext, next: Next) => {
    const session = c.get("session");

    if (!session || !session.role) {
      return c.json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Insufficient permissions"
        }
      }, 403);
    }

    if (!roles.includes(session.role)) {
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
