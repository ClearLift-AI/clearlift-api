import { MiddlewareHandler } from 'hono';
import { AuthService } from '../services/auth';
import { AppContext } from '../types';

/**
 * Authentication middleware for Hono
 * Validates session token and adds user/org context to request
 */
export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '');

  if (!token) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const authService = new AuthService(c.env.DB);
  const session = await authService.validateSession(token);

  if (!session) {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  // Add session data to context for use in endpoints
  c.set('session', session);
  c.set('user', session.user);
  c.set('organizationId', session.current_organization_id);
  c.set('organization', session.organization);

  await next();
};

/**
 * Optional auth middleware - doesn't require auth but adds context if available
 */
export const optionalAuthMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '');

  if (token) {
    const authService = new AuthService(c.env.DB);
    const session = await authService.validateSession(token);

    if (session) {
      c.set('session', session);
      c.set('user', session.user);
      c.set('organizationId', session.current_organization_id);
      c.set('organization', session.organization);
    }
  }

  await next();
};

/**
 * Require organization context middleware
 * Use after authMiddleware to ensure user has an active organization
 */
export const requireOrgMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const organizationId = c.get('organizationId');
  
  if (!organizationId) {
    return c.json({ 
      error: 'No organization selected', 
      message: 'Please select or create an organization first' 
    }, 400);
  }

  await next();
};