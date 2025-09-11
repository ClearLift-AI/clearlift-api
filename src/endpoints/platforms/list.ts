import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";

export class ListPlatforms extends OpenAPIRoute {
  schema = {
  method: "GET",
  path: "/list",
  security: "session",
  summary: "List connected advertising platforms",
  description: "Get all advertising platforms connected to the organization",
  responses: {
    200: {
      description: "Platforms retrieved successfully",
      body: z.object({
        platforms: z.array(z.object({
          id: z.string(),
          platform: z.string(),
          account_id: z.string(),
          account_name: z.string().nullable(),
          currency: z.string(),
          timezone: z.string(),
          connected_at: z.string(),
          last_synced_at: z.string().nullable(),
          sync_status: z.string(),
          is_active: z.boolean()
        }))
      })
    },
    404: {
      description: "No platforms connected",
      body: z.object({
        error: z.string(),
        message: z.string()
      })
    }
  }

  }

  async handle(c: AppContext) {
  const organizationId = c.get('organizationId');
  
  if (!organizationId) {
    return c.json({ 
      error: 'No organization selected',
      message: 'Please select an organization first' 
    }, 400);
  }

  try {
    const platformsResult = await c.env.AD_DATA.prepare(`
      SELECT 
        id,
        platform,
        account_id,
        account_name,
        currency,
        timezone,
        connected_at,
        last_synced_at,
        sync_status,
        metadata
      FROM platform_accounts
      WHERE organization_id = ?
      ORDER BY connected_at DESC
    `).bind(organizationId).all();

    if (!platformsResult.results || platformsResult.results.length === 0) {
      return c.json({
        error: 'No platforms connected',
        message: 'No advertising platforms are connected to this organization. Please connect your advertising accounts.'
      }, 404);
    }

    const platforms = platformsResult.results.map(platform => ({
      ...platform,
      is_active: platform.sync_status === 'active'
    }));

    return c.json({ platforms });

  } catch (error) {
    console.error('Platform list error:', error);
    return c.json({ 
      error: 'Database query failed',
      message: error instanceof Error ? error.message : 'Failed to retrieve platforms'
    }, 500);
  }
  }
}