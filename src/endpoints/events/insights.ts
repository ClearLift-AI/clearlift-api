import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { MotherDuckService } from "../../services/motherDuckService";

export class GetEventInsights extends OpenAPIRoute {
  schema = {
  method: "GET",
  path: "/insights",
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
      ...contentJson(z.object({
        data: z.any().describe("Insight data (structure varies by metric_type)"),
        metric_type: z.string()
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
    const { start_date, end_date, metric_type, organization_id } = c.req.query();
    
    // Get organization ID from session if not provided
    const orgId = organization_id || c.get('organizationId');
    
    if (!orgId) {
      return c.json({ error: 'Organization ID is required' }, 400);
    }
    
    // Check if MotherDuck token exists
    if (!c.env.MOTHERDUCK_TOKEN) {
      return c.json({ 
        data: [],
        metric_type,
        message: 'MotherDuck not configured. Event analytics is not available.'
      });
    }
    
    const motherDuckService = new MotherDuckService({
      token: c.env.MOTHERDUCK_TOKEN
    });
    
    // For now, return empty insights as getEventInsights needs to be implemented
    const insights: any[] = [];
    
    // TODO: Implement getEventInsights in MotherDuckService
    // const insights = await motherDuckService.getEventInsights({
    //   organization_id: orgId,
    //   start_date,
    //   end_date,
    //   metric_type: metric_type as 'conversion_rate' | 'revenue' | 'user_journey'
    // });
    
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
  }
}