import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { AuthService } from "../../services/auth";
import { authMiddleware } from "../../middleware/auth";

export class SwitchOrganization extends OpenAPIRoute {
  schema = {
  method: "POST",
  path: "/switch",
  middleware: [authMiddleware],
  summary: "Switch current organization",
  description: "Switch the user's current active organization",
  request: {
    body: z.object({
      organization_id: z.string().describe("Organization ID to switch to")
    })
  },
  responses: {
    200: {
      description: "Organization switched successfully",
      body: z.object({
        success: z.boolean(),
        organization: z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          role: z.string()
        })
      })
    },
    403: {
      description: "Access denied",
      body: z.object({
        error: z.string()
      })
    },
    404: {
      description: "Organization not found",
      body: z.object({
        error: z.string()
      })
    }
  }

  }

  async handle(c: AppContext) {
  const user = c.get('user');
  const session = c.get('session');
  const { organization_id } = await c.req.json();
  
  if (!user || !session) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const authService = new AuthService(c.env.DB);
  
  // Check if user has access to the organization
  const hasAccess = await authService.hasOrgAccess(user.id, organization_id);
  if (!hasAccess) {
    return c.json({ error: 'Access denied to this organization' }, 403);
  }

  // Get organization details
  const org = await c.env.DB.prepare(`
    SELECT o.*, om.role 
    FROM organizations o
    JOIN organization_members om ON o.id = om.organization_id
    WHERE o.id = ? AND om.user_id = ?
  `).bind(organization_id, user.id).first();

  if (!org) {
    return c.json({ error: 'Organization not found' }, 404);
  }

  // Update session with new organization
  const updated = await authService.updateSessionOrganization(session.token, organization_id);
  
  if (!updated) {
    return c.json({ error: 'Failed to switch organization' }, 500);
  }

  return c.json({
    success: true,
    organization: {
      id: org.id as string,
      name: org.name as string,
      slug: org.slug as string,
      role: org.role as string
    }
  });
  }
}