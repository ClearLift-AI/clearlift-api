import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";

export class GetSyncHistory extends OpenAPIRoute {
  schema = {
  method: "GET",
  path: "/sync/history",
  security: "session",
  summary: "Get platform sync history",
  description: "Retrieve synchronization history for all platforms",
  request: {
    query: z.object({
      platform: z.string().optional().describe("Filter by platform"),
      limit: z.number().optional().default(50).describe("Number of records to return")
    })
  },
  responses: {
    200: {
      description: "Sync history retrieved successfully",
      ...contentJson(z.object({
        history: z.array(z.object({
          id: z.number(),
          organization_id: z.string(),
          platform: z.string(),
          sync_type: z.string().nullable(),
          started_at: z.string(),
          completed_at: z.string().nullable(),
          status: z.string(),
          records_synced: z.number(),
          error_message: z.string().nullable(),
          date_from: z.string().nullable(),
          date_to: z.string().nullable(),
          duration_seconds: z.number().nullable()
        }))
      }))
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

  const { platform, limit } = c.req.query();

  try {
    let query = `
      SELECT 
        id,
        organization_id,
        platform,
        sync_type,
        started_at,
        completed_at,
        status,
        records_synced,
        error_message,
        date_from,
        date_to,
        CASE 
          WHEN completed_at IS NOT NULL 
          THEN CAST((julianday(completed_at) - julianday(started_at)) * 86400 AS INTEGER)
          ELSE NULL
        END as duration_seconds
      FROM sync_history
      WHERE organization_id = ?
    `;
    
    const queryParams: any[] = [organizationId];
    
    if (platform) {
      query += ' AND platform = ?';
      queryParams.push(platform);
    }
    
    query += ' ORDER BY started_at DESC LIMIT ?';
    queryParams.push(parseInt(limit as string) || 50);

    const historyResult = await c.env.AD_DATA.prepare(query)
      .bind(...queryParams)
      .all();

    return c.json({
      history: historyResult.results || []
    });

  } catch (error) {
    console.error('Sync history error:', error);
    return c.json({ 
      error: 'Database query failed',
      message: error instanceof Error ? error.message : 'Failed to retrieve sync history'
    }, 500);
  }
  }
}