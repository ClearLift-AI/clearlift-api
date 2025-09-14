import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { MotherDuckService } from "../../services/motherDuckService";

export class GetConversions extends OpenAPIRoute {
  schema = {
  method: "GET",
  path: "/conversions",
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
      ...contentJson(z.object({
        data: z.array(z.object({
          period: z.string(),
          event_type: z.string(),
          event_count: z.number(),
          total_value: z.number(),
          avg_value: z.number(),
          unique_users: z.number()
        }))
      }))
    },
    503: {
      description: "Service unavailable",
      ...contentJson(z.object({
        error: z.string()
      }))
    }
  }

  }

  async handle(c: AppContext) {
  try {
    const { start_date, end_date, group_by, organization_id } = c.req.query();
    
    // Get organization ID from session if not provided
    const orgId = organization_id || c.get('organizationId');
    
    if (!orgId) {
      return c.json({ error: 'Organization ID is required' }, 400);
    }
    
    // Check if MotherDuck token exists
    if (!c.env.MOTHERDUCK_TOKEN) {
      // Fallback to empty data if MotherDuck is not configured
      return c.json({ 
        data: [],
        message: 'MotherDuck not configured. Event analytics is not available.'
      });
    }
    
    const motherDuckService = new MotherDuckService({
      token: c.env.MOTHERDUCK_TOKEN
    });
    
    const metrics = await motherDuckService.getConversionMetrics({
      organization_id: orgId,
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
  }
}