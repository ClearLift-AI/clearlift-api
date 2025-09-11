import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { authMiddleware } from "../../middleware/auth";

export const CreateOrganization = new OpenAPIRoute({
  method: "POST",
  path: "/organizations",
  middleware: [authMiddleware],
  summary: "Create a new organization",
  description: "Create a new organization and add the current user as owner",
  request: {
    body: z.object({
      name: z.string().min(1).max(100).describe("Organization name"),
      slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional()
        .describe("URL-friendly slug (auto-generated if not provided)")
    })
  },
  responses: {
    201: {
      description: "Organization created successfully",
      body: z.object({
        organization: z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          created_at: z.string(),
          updated_at: z.string(),
          subscription_tier: z.string()
        })
      })
    },
    400: {
      description: "Invalid request",
      body: z.object({
        error: z.string()
      })
    },
    409: {
      description: "Organization slug already exists",
      body: z.object({
        error: z.string()
      })
    }
  }
}).handle(async (c: AppContext) => {
  const user = c.get('user');
  const { name, slug: providedSlug } = await c.req.json();
  
  if (!user) {
    return c.json({ error: 'User not found' }, 401);
  }

  // Generate slug if not provided
  const slug = providedSlug || name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  const orgId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    // Start transaction
    await c.env.DB.batch([
      // Create organization
      c.env.DB.prepare(`
        INSERT INTO organizations (id, name, slug, created_at, updated_at, settings, subscription_tier)
        VALUES (?, ?, ?, ?, ?, '{}', 'free')
      `).bind(orgId, name, slug, now, now),
      
      // Add user as owner
      c.env.DB.prepare(`
        INSERT INTO organization_members (organization_id, user_id, role, joined_at)
        VALUES (?, ?, 'owner', ?)
      `).bind(orgId, user.id, now)
    ]);

    const organization = {
      id: orgId,
      name,
      slug,
      created_at: now,
      updated_at: now,
      subscription_tier: 'free'
    };

    return c.json({ organization }, 201);
  } catch (error: any) {
    if (error.message?.includes('UNIQUE constraint')) {
      return c.json({ error: 'Organization slug already exists' }, 409);
    }
    console.error('Create organization error:', error);
    return c.json({ error: 'Failed to create organization' }, 500);
  }
});