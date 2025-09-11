import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { EventAnalyticsService } from "../../services/eventAnalytics";

export class EventQuery extends OpenAPIRoute {
  schema = {
  method: "POST",
  path: "/query",
  security: "session",
  summary: "Execute a custom DuckDB query on event data",
  description: "Execute a custom DuckDB SQL query against the R2 Data Catalog via DuckLake",
  request: {
    body: z.object({
      query: z.string().describe("The DuckDB SQL query to execute"),
      organization_id: z.string().optional().describe("Organization ID (uses session org if not provided)")
    })
  },
  responses: {
    200: {
      description: "Query executed successfully",
      body: z.object({
        data: z.any().describe("Query results"),
        rowCount: z.number().optional()
      })
    },
    400: {
      description: "Invalid query",
      body: z.object({
        error: z.string()
      })
    },
    500: {
      description: "Query execution failed",
      body: z.object({
        error: z.string()
      })
    }
  }

  }

  async handle(c: AppContext) {
  try {
    const { query, organization_id } = await c.req.json();
    
    // Get organization ID from session if not provided
    const orgId = organization_id || c.get('organizationId');
    
    if (!orgId) {
      return c.json({ error: 'Organization ID is required' }, 400);
    }
    
    // Check if DUCKLAKE container binding exists
    if (!c.env.DUCKLAKE) {
      return c.json({ 
        error: 'DuckLake container not configured. Event analytics is not available.' 
      }, 503);
    }
    
    const analyticsService = new EventAnalyticsService(c.env.DUCKLAKE, orgId);
    
    // Execute the query
    const data = await analyticsService.executeQuery(query);
    
    return c.json({
      data,
      rowCount: Array.isArray(data) ? data.length : undefined
    });
  } catch (error) {
    console.error('Event query error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Query execution failed' 
    }, 500);
  }
  }
}