import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { DatalakeManagementService } from "../../services/datalakeManagement";

export class SyncCampaignsToDatalake extends OpenAPIRoute {
  schema = {
  method: "POST",
  path: "/sync/campaigns",
  security: "session",
  summary: "Sync campaign data to datalake",
  description: "Copy campaign data from AD_DATA database to datalake Iceberg tables",
  request: {
    body: z.object({
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      platforms: z.array(z.string()).optional().describe("Filter by platforms"),
      overwrite: z.boolean().optional().default(false).describe("Overwrite existing data")
    })
  },
  responses: {
    200: {
      description: "Sync completed successfully",
      body: z.object({
        success: z.boolean(),
        rowsSynced: z.number(),
        message: z.string()
      })
    },
    404: {
      description: "No data to sync",
      body: z.object({
        error: z.string()
      })
    }
  }

  }

  async handle(c: AppContext) {
  const organizationId = c.get('organizationId');
  
  if (!organizationId) {
    return c.json({ error: 'No organization selected' }, 400);
  }

  if (!c.env.DUCKLAKE || !c.env.AD_DATA) {
    return c.json({ 
      error: 'Required services not configured (DuckLake or AD_DATA)'
    }, 503);
  }

  const { start_date, end_date, platforms, overwrite } = await c.req.json();

  try {
    // Build query to fetch campaign data from AD_DATA
    let whereConditions = ['organization_id = ?'];
    let queryParams = [organizationId];

    if (start_date) {
      whereConditions.push('date >= ?');
      queryParams.push(start_date);
    }

    if (end_date) {
      whereConditions.push('date <= ?');
      queryParams.push(end_date);
    }

    if (platforms && platforms.length > 0) {
      whereConditions.push(`platform IN (${platforms.map(() => '?').join(', ')})`);
      queryParams.push(...platforms);
    }

    const campaignsQuery = `
      SELECT 
        id,
        organization_id,
        platform,
        campaign_id,
        campaign_name,
        campaign_type,
        status,
        date,
        impressions,
        clicks,
        spend,
        conversions,
        revenue,
        ctr,
        cpc,
        cpa,
        roas,
        quality_score,
        budget_daily,
        budget_total
      FROM campaigns
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY date DESC
      LIMIT 10000
    `;

    const campaignsResult = await c.env.AD_DATA.prepare(campaignsQuery)
      .bind(...queryParams)
      .all();

    if (!campaignsResult.results || campaignsResult.results.length === 0) {
      return c.json({
        error: 'No campaign data found to sync'
      }, 404);
    }

    // Transform data for datalake (ensure proper types and add metadata)
    const transformedData = campaignsResult.results.map(row => ({
      id: row.id || crypto.randomUUID(),
      organization_id: organizationId,
      date: row.date,
      platform: row.platform,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      impressions: row.impressions || 0,
      clicks: row.clicks || 0,
      spend: row.spend || 0,
      conversions: row.conversions || 0,
      revenue: row.revenue || 0,
      ctr: row.ctr || 0,
      cpc: row.cpc || 0,
      cpa: row.cpa || 0,
      roas: row.roas || 0
    }));

    // Write to datalake
    const datalakeService = new DatalakeManagementService(c.env.DUCKLAKE, organizationId);
    
    // Create table if it doesn't exist
    try {
      await datalakeService.createTable('campaign_metrics', {
        id: 'VARCHAR',
        organization_id: 'VARCHAR NOT NULL',
        date: 'DATE',
        platform: 'VARCHAR',
        campaign_id: 'VARCHAR',
        campaign_name: 'VARCHAR',
        impressions: 'BIGINT',
        clicks: 'BIGINT',
        spend: 'DOUBLE',
        conversions: 'BIGINT',
        revenue: 'DOUBLE',
        ctr: 'DOUBLE',
        cpc: 'DOUBLE',
        cpa: 'DOUBLE',
        roas: 'DOUBLE',
        created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
      });
    } catch (error) {
      // Table might already exist
      console.log('Table creation skipped:', error.message);
    }

    // Write data in batches
    const result = await datalakeService.batchWrite('campaign_metrics', transformedData, 500);

    return c.json({
      success: true,
      rowsSynced: result.totalRowsInserted,
      message: `Successfully synced ${result.totalRowsInserted} campaign records to datalake`
    });

  } catch (error) {
    console.error('Campaign sync error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to sync campaigns'
    }, 500);
  }
  }
}

export class SyncEventsToDatalake extends OpenAPIRoute {
  schema = {
  method: "POST",
  path: "/sync/events",
  security: "session",
  summary: "Sync event data to datalake",
  description: "Write event data to datalake Iceberg tables",
  request: {
    body: z.object({
      events: z.array(z.object({
        event_id: z.string(),
        timestamp: z.string(),
        event_type: z.string(),
        event_value: z.number().optional(),
        currency: z.string().optional(),
        user_id: z.string().optional(),
        session_id: z.string().optional(),
        utm_source: z.string().optional(),
        utm_medium: z.string().optional(),
        utm_campaign: z.string().optional(),
        device_type: z.string().optional(),
        browser: z.string().optional(),
        country: z.string().optional(),
        attribution_path: z.string().optional()
      })).describe("Array of events to sync")
    })
  },
  responses: {
    200: {
      description: "Events synced successfully",
      body: z.object({
        success: z.boolean(),
        eventsSynced: z.number(),
        message: z.string()
      })
    },
    400: {
      description: "Invalid request",
      body: z.object({
        error: z.string()
      })
    }
  }

  }

  async handle(c: AppContext) {
  const organizationId = c.get('organizationId');
  const { events } = await c.req.json();
  
  if (!organizationId) {
    return c.json({ error: 'No organization selected' }, 400);
  }

  if (!events || events.length === 0) {
    return c.json({ error: 'No events provided' }, 400);
  }

  if (!c.env.DUCKLAKE) {
    return c.json({ 
      error: 'DuckLake container not configured'
    }, 503);
  }

  try {
    const datalakeService = new DatalakeManagementService(c.env.DUCKLAKE, organizationId);
    
    // Create table if it doesn't exist
    try {
      await datalakeService.createTable('conversion_events', {
        id: 'VARCHAR',
        organization_id: 'VARCHAR NOT NULL',
        event_id: 'VARCHAR',
        timestamp: 'TIMESTAMP',
        event_type: 'VARCHAR',
        event_value: 'DOUBLE',
        currency: 'VARCHAR',
        user_id: 'VARCHAR',
        session_id: 'VARCHAR',
        utm_source: 'VARCHAR',
        utm_medium: 'VARCHAR',
        utm_campaign: 'VARCHAR',
        device_type: 'VARCHAR',
        browser: 'VARCHAR',
        country: 'VARCHAR',
        attribution_path: 'VARCHAR',
        created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
      });
    } catch (error) {
      // Table might already exist
      console.log('Table creation skipped:', error.message);
    }

    // Add IDs and organization_id to events
    const eventsWithIds = events.map(event => ({
      id: crypto.randomUUID(),
      organization_id: organizationId,
      ...event
    }));

    // Write events to datalake
    const result = await datalakeService.batchWrite('conversion_events', eventsWithIds, 1000);

    return c.json({
      success: true,
      eventsSynced: result.totalRowsInserted,
      message: `Successfully synced ${result.totalRowsInserted} events to datalake`
    });

  } catch (error) {
    console.error('Event sync error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to sync events'
    }, 500);
  }
  }
}

export class GetSyncStatus extends OpenAPIRoute {
  schema = {
  method: "GET",
  path: "/sync/status",
  security: "session",
  summary: "Get sync operation status",
  description: "Check the status of data synchronization operations",
  responses: {
    200: {
      description: "Status retrieved successfully",
      body: z.object({
        tables: z.array(z.object({
          table: z.string(),
          exists: z.boolean(),
          rowCount: z.number().optional()
        }))
      })
    }
  }

  }

  async handle(c: AppContext) {
  const organizationId = c.get('organizationId');
  
  if (!organizationId) {
    return c.json({ error: 'No organization selected' }, 400);
  }

  if (!c.env.DUCKLAKE) {
    return c.json({ 
      tables: []
    });
  }

  try {
    const datalakeService = new DatalakeManagementService(c.env.DUCKLAKE, organizationId);
    const tables = await datalakeService.listTables();
    
    const tableStatus = [];
    
    // Check key tables
    const keyTables = ['conversion_events', 'campaign_metrics', 'user_interactions', 'attribution_data'];
    
    for (const tableName of keyTables) {
      const exists = tables.some(t => t.name === tableName);
      let rowCount = undefined;
      
      if (exists) {
        try {
          const countResult = await datalakeService.executeQuery(
            `SELECT COUNT(*) as count FROM r2_catalog.default.${tableName} WHERE organization_id = '${organizationId}'`
          );
          rowCount = countResult[0]?.count || 0;
        } catch (error) {
          // Ignore count errors
        }
      }
      
      tableStatus.push({
        table: tableName,
        exists,
        rowCount
      });
    }
    
    return c.json({ tables: tableStatus });

  } catch (error) {
    console.error('Get sync status error:', error);
    return c.json({ tables: [] });
  }
  }
}