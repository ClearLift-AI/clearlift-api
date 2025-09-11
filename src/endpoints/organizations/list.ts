import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { AuthService } from "../../services/auth";
import { authMiddleware } from "../../middleware/auth";

export class ListOrganizations extends OpenAPIRoute {
  schema = {
  method: "GET",
  path: "/",
  middleware: [authMiddleware],
  summary: "List user's organizations",
  description: "Get all organizations the authenticated user has access to",
  responses: {
    200: {
      description: "List of organizations",
      body: z.object({
        organizations: z.array(z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          role: z.string(),
          created_at: z.string(),
          updated_at: z.string(),
          subscription_tier: z.string(),
          is_current: z.boolean()
        }))
      })
    },
    401: {
      description: "Unauthorized",
      body: z.object({
        error: z.string()
      })
    }
  }

  }

  async handle(c: AppContext) {
  const user = c.get('user');
  const currentOrgId = c.get('organizationId');
  
  if (!user) {
    return c.json({ error: 'User not found' }, 401);
  }

  const authService = new AuthService(c.env.DB);
  const organizations = await authService.getUserOrganizations(user.id);

  const orgsWithCurrent = organizations.map(org => ({
    ...org,
    is_current: org.id === currentOrgId
  }));

  return c.json({ organizations: orgsWithCurrent });
  }
}