import { Endpoint, z } from "chanfana";
import { AppContext } from "../../types";

export const ListCampaigns = new Endpoint({
  method: "POST",
  path: "/",
  security: "session",
  summary: "Get campaign data",
  description: "Retrieve campaign performance metrics from AD_DATA database",
  request: {
    body: z.object({
      lookback_days: z.number().optional().default(30).describe("Number of days to look back"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      platforms: z.array(z.string()).optional().describe("Filter by platforms"),
      group_by: z.enum(['day', 'campaign', 'platform']).optional().default('day')
    })
  },
  responses: {
    200: {
      description: "Campaign data retrieved successfully",
      body: z.object({
        campaigns: z.array(z.object({
          id: z.string(),
          organization_id: z.string(),
          platform: z.string(),
          campaign_id: z.string(),
          campaign_name: z.string(),
          campaign_type: z.string().nullable(),
          status: z.string(),
          date: z.string(),
          impressions: z.number(),
          clicks: z.number(),
          spend: z.number(),
          conversions: z.number(),
          revenue: z.number(),
          ctr: z.number(),
          cpc: z.number(),
          cpa: z.number(),
          roas: z.number()
        })),
        summary: z.object({
          total_spend: z.number(),
          total_clicks: z.number(),
          total_impressions: z.number(),
          total_conversions: z.number(),
          total_revenue: z.number(),
          avg_ctr: z.number(),
          avg_cpc: z.number(),
          avg_roas: z.number()
        }).optional()
      })
    },
    404: {
      description: "No campaign data found",
      body: z.object({
        error: z.string(),
        message: z.string()
      })
    }
  }
}).handle(async (c: AppContext) => {
  const organizationId = c.get('organizationId');
  
  if (!organizationId) {
    return c.json({ 
      error: 'No organization selected',
      message: 'Please select an organization first' 
    }, 400);
  }

  const body = await c.req.json();
  const { lookback_days, start_date, end_date, platforms, group_by } = body;

  // Calculate date range
  const endDate = end_date ? new Date(end_date) : new Date();
  const startDate = start_date 
    ? new Date(start_date) 
    : new Date(Date.now() - lookback_days * 24 * 60 * 60 * 1000);

  try {
    // Build query conditions
    let whereConditions = [
      'organization_id = ?',
      'date >= ?',
      'date <= ?'
    ];
    
    let queryParams = [
      organizationId,
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0]
    ];

    if (platforms && platforms.length > 0) {
      whereConditions.push(`platform IN (${platforms.map(() => '?').join(', ')})`);
      queryParams.push(...platforms);
    }

    // Query campaigns from AD_DATA database
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
      ORDER BY date DESC, platform, campaign_name
    `;

    const campaignsResult = await c.env.AD_DATA.prepare(campaignsQuery)
      .bind(...queryParams)
      .all();

    if (!campaignsResult.results || campaignsResult.results.length === 0) {
      return c.json({
        error: 'No campaign data found',
        message: 'No campaigns found for the specified criteria. Please sync your advertising platforms first.'
      }, 404);
    }

    // Calculate summary metrics
    const summary = campaignsResult.results.reduce((acc, campaign) => {
      acc.total_spend += campaign.spend || 0;
      acc.total_clicks += campaign.clicks || 0;
      acc.total_impressions += campaign.impressions || 0;
      acc.total_conversions += campaign.conversions || 0;
      acc.total_revenue += campaign.revenue || 0;
      return acc;
    }, {
      total_spend: 0,
      total_clicks: 0,
      total_impressions: 0,
      total_conversions: 0,
      total_revenue: 0,
      avg_ctr: 0,
      avg_cpc: 0,
      avg_roas: 0
    });

    // Calculate averages
    if (summary.total_impressions > 0) {
      summary.avg_ctr = (summary.total_clicks / summary.total_impressions) * 100;
    }
    if (summary.total_clicks > 0) {
      summary.avg_cpc = summary.total_spend / summary.total_clicks;
    }
    if (summary.total_spend > 0) {
      summary.avg_roas = summary.total_revenue / summary.total_spend;
    }

    return c.json({
      campaigns: campaignsResult.results,
      summary
    });

  } catch (error) {
    console.error('Campaign query error:', error);
    return c.json({ 
      error: 'Database query failed',
      message: error instanceof Error ? error.message : 'Failed to retrieve campaign data'
    }, 500);
  }
});