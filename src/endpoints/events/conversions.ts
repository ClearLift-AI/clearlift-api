import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { EventAnalyticsService } from "../../services/eventAnalytics";

export const GetConversions = new OpenAPIRoute({
  method: "GET",
  path: "/events/conversions",
  security: "session",
  summary: "Get conversion event metrics",
  description: "Retrieve aggregated conversion event metrics from R2 Data Catalog",
  request: {
    query: z.object({
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      group_by: z.enum(['hour', 'day', 'week', 'month']).optional().default('day').describe("Time grouping"),
      organization_id: z.string().optional().describe("Organization ID (uses session org if not provided)")
    })
  },
  responses: {
    200: {
      description: "Conversion metrics retrieved successfully",
      body: z.object({
        data: z.array(z.object({
          period: z.string(),
          event_type: z.string(),
          event_count: z.number(),
          total_value: z.number(),
          avg_value: z.number(),
          unique_users: z.number()
        }))
      })
    },
    503: {
      description: "Service unavailable",
      body: z.object({
        error: z.string()
      })
    }
  }
}).handle(async (c: AppContext) => {
  try {
    const { start_date, end_date, group_by, organization_id } = c.req.query();
    
    // Get organization ID from session if not provided
    const orgId = organization_id || c.get('organizationId');
    
    if (!orgId) {
      return c.json({ error: 'Organization ID is required' }, 400);
    }
    
    // Check if DUCKLAKE container binding exists
    if (!c.env.DUCKLAKE) {
      // Fallback to empty data if DuckLake is not configured
      return c.json({ 
        data: [],
        message: 'DuckLake container not configured. Event analytics is not available.'
      });
    }
    
    const analyticsService = new EventAnalyticsService(c.env.DUCKLAKE, orgId);
    
    const metrics = await analyticsService.getConversionMetrics({
      start_date,
      end_date,
      group_by: group_by as 'hour' | 'day' | 'week' | 'month'
    });
    
    return c.json({ data: metrics });
  } catch (error) {
    console.error('Get conversions error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to retrieve conversion metrics' 
    }, 500);
  }
});