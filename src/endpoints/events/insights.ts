import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { EventAnalyticsService } from "../../services/eventAnalytics";

export const GetEventInsights = new OpenAPIRoute({
  method: "GET",
  path: "/events/insights",
  security: "session",
  summary: "Get event-based insights",
  description: "Retrieve analytical insights from event data using DuckDB",
  request: {
    query: z.object({
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      metric_type: z.enum(['conversion_rate', 'revenue', 'user_journey']).optional()
        .default('conversion_rate').describe("Type of insight metric"),
      organization_id: z.string().optional().describe("Organization ID (uses session org if not provided)")
    })
  },
  responses: {
    200: {
      description: "Insights retrieved successfully",
      body: z.object({
        data: z.any().describe("Insight data (structure varies by metric_type)"),
        metric_type: z.string()
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
    const { start_date, end_date, metric_type, organization_id } = c.req.query();
    
    // Get organization ID from session if not provided
    const orgId = organization_id || c.get('organizationId');
    
    if (!orgId) {
      return c.json({ error: 'Organization ID is required' }, 400);
    }
    
    // Check if DUCKLAKE container binding exists
    if (!c.env.DUCKLAKE) {
      return c.json({ 
        data: [],
        metric_type,
        message: 'DuckLake container not configured. Event analytics is not available.'
      });
    }
    
    const analyticsService = new EventAnalyticsService(c.env.DUCKLAKE, orgId);
    
    const insights = await analyticsService.getEventInsights({
      start_date,
      end_date,
      metric_type: metric_type as 'conversion_rate' | 'revenue' | 'user_journey'
    });
    
    return c.json({ 
      data: insights,
      metric_type
    });
  } catch (error) {
    console.error('Get event insights error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to retrieve event insights' 
    }, 500);
  }
});