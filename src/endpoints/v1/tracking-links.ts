import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { nanoid } from "nanoid";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";

// ============== Schema Definitions ==============

const TrackingLinkSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(100).optional(),
  destination_url: z.string().url().min(1),
  utm_source: z.string().max(100).default('email'),
  utm_medium: z.string().max(100).default('email'),
  utm_campaign: z.string().max(100).optional(),
  utm_content: z.string().max(100).optional(),
});

// ============== Helper Functions ==============

/**
 * Get org_tag from org_id
 */
async function getOrgTag(c: AppContext, orgId: string): Promise<string | null> {
  const result = await c.env.DB.prepare(`
    SELECT short_tag FROM org_tag_mappings
    WHERE organization_id = ? AND is_active = 1
  `).bind(orgId).first<{ short_tag: string }>();

  return result?.short_tag ?? null;
}

// ============== Tracking Links Endpoints ==============

/**
 * GET /v1/tracking-links - List tracking links
 */
export class ListTrackingLinks extends OpenAPIRoute {
  public schema = {
    tags: ["Tracking Links"],
    summary: "List email tracking links for an organization",
    operationId: "list-tracking-links",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      })
    },
    responses: {
      "200": {
        description: "List of tracking links",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(TrackingLinkSchema.extend({
                id: z.string(),
                org_tag: z.string(),
                tracking_url: z.string(),
                created_at: z.string(),
                created_by: z.string().nullable(),
                is_active: z.boolean(),
              }))
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Get org_tag
    const orgTag = await getOrgTag(c, orgId);
    if (!orgTag) {
      return error(c, "NO_ORG_TAG", "Organization tag not found", 404);
    }

    // Verify member access
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const links = await c.env.DB.prepare(`
      SELECT id, org_tag, name, destination_url,
             utm_source, utm_medium, utm_campaign, utm_content,
             created_at, created_by, is_active
      FROM tracking_links
      WHERE org_tag = ? AND is_active = 1
      ORDER BY created_at DESC
    `).bind(orgTag).all();

    // Add tracking URL to each link
    const irisBase = c.env.IRIS_BASE_URL || 'https://iris.adbliss.io';
    const linksWithUrl = (links.results || []).map(link => ({
      ...link,
      is_active: Boolean(link.is_active),
      tracking_url: `${irisBase}/r/${link.id}`,
    }));

    return success(c, linksWithUrl);
  }
}

/**
 * POST /v1/tracking-links - Create a tracking link
 */
export class CreateTrackingLink extends OpenAPIRoute {
  public schema = {
    tags: ["Tracking Links"],
    summary: "Create a new email tracking link",
    operationId: "create-tracking-link",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      }),
      body: contentJson(TrackingLinkSchema.omit({ id: true }))
    },
    responses: {
      "201": {
        description: "Tracking link created",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: TrackingLinkSchema.extend({
                id: z.string(),
                org_tag: z.string(),
                tracking_url: z.string(),
                created_at: z.string(),
                created_by: z.string(),
                is_active: z.boolean(),
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Get org_tag
    const orgTag = await getOrgTag(c, orgId);
    if (!orgTag) {
      return error(c, "NO_ORG_TAG", "Organization tag not found", 404);
    }

    // Verify member access
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const data = await this.getValidatedData<typeof this.schema>();
    const body = data.body;

    // Auto-create platform_connections row for tracking_link if it doesn't exist
    const existingConnection = await c.env.DB.prepare(`
      SELECT id FROM platform_connections
      WHERE organization_id = ? AND platform = 'tracking_link' AND is_active = 1
    `).bind(orgId).first();

    if (!existingConnection) {
      const connectionId = nanoid(21);
      await c.env.DB.prepare(`
        INSERT INTO platform_connections (
          id, organization_id, platform, account_id, account_name,
          connected_by, connected_at, is_active, settings
        ) VALUES (?, ?, 'tracking_link', 'internal', 'Tracking Links', ?, datetime('now'), 1,
          json('{"auto_sync":false}'))
      `).bind(connectionId, orgId, session.user_id).run();
    }

    // Generate short ID (12 chars, URL-safe)
    const id = nanoid(12);
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO tracking_links (
        id, org_tag, name, destination_url,
        utm_source, utm_medium, utm_campaign, utm_content,
        created_at, created_by, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      id,
      orgTag,
      body.name || null,
      body.destination_url,
      body.utm_source || 'email',
      body.utm_medium || 'email',
      body.utm_campaign || null,
      body.utm_content || null,
      now,
      session.user_id
    ).run();

    const result = {
      id,
      org_tag: orgTag,
      name: body.name || null,
      destination_url: body.destination_url,
      utm_source: body.utm_source || 'email',
      utm_medium: body.utm_medium || 'email',
      utm_campaign: body.utm_campaign || null,
      utm_content: body.utm_content || null,
      tracking_url: `${c.env.IRIS_BASE_URL || 'https://iris.adbliss.io'}/r/${id}`,
      created_at: now,
      created_by: session.user_id,
      is_active: true,
    };

    return success(c, result, undefined, 201);
  }
}

/**
 * DELETE /v1/tracking-links/:id - Deactivate a tracking link
 */
export class DeleteTrackingLink extends OpenAPIRoute {
  public schema = {
    tags: ["Tracking Links"],
    summary: "Deactivate a tracking link (soft delete)",
    operationId: "delete-tracking-link",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      }),
      params: z.object({
        id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Tracking link deactivated"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Get org_tag
    const orgTag = await getOrgTag(c, orgId);
    if (!orgTag) {
      return error(c, "NO_ORG_TAG", "Organization tag not found", 404);
    }

    const data = await this.getValidatedData<typeof this.schema>();
    const linkId = data.params.id;

    // Soft delete (set is_active = 0)
    const result = await c.env.DB.prepare(`
      UPDATE tracking_links
      SET is_active = 0
      WHERE id = ? AND org_tag = ?
    `).bind(linkId, orgTag).run();

    if (!result.meta?.changes) {
      return error(c, "NOT_FOUND", "Tracking link not found", 404);
    }

    return success(c, { deleted: true, id: linkId });
  }
}

/**
 * GET /v1/tracking-links/:id - Get a single tracking link
 */
export class GetTrackingLink extends OpenAPIRoute {
  public schema = {
    tags: ["Tracking Links"],
    summary: "Get a tracking link by ID",
    operationId: "get-tracking-link",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      }),
      params: z.object({
        id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Tracking link details",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: TrackingLinkSchema.extend({
                id: z.string(),
                org_tag: z.string(),
                tracking_url: z.string(),
                created_at: z.string(),
                created_by: z.string().nullable(),
                is_active: z.boolean(),
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Get org_tag
    const orgTag = await getOrgTag(c, orgId);
    if (!orgTag) {
      return error(c, "NO_ORG_TAG", "Organization tag not found", 404);
    }

    const data = await this.getValidatedData<typeof this.schema>();
    const linkId = data.params.id;

    const link = await c.env.DB.prepare(`
      SELECT id, org_tag, name, destination_url,
             utm_source, utm_medium, utm_campaign, utm_content,
             created_at, created_by, is_active
      FROM tracking_links
      WHERE id = ? AND org_tag = ?
    `).bind(linkId, orgTag).first();

    if (!link) {
      return error(c, "NOT_FOUND", "Tracking link not found", 404);
    }

    return success(c, {
      ...link,
      is_active: Boolean(link.is_active),
      tracking_url: `${c.env.IRIS_BASE_URL || 'https://iris.adbliss.io'}/r/${link.id}`,
    });
  }
}
