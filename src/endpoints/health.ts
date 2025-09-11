import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../types";

export class HealthCheck extends OpenAPIRoute {
  schema = {
  method: "GET",
  path: "/health",
  summary: "Health check endpoint",
  description: "Check API health and database connectivity",
  responses: {
    200: {
      description: "API is healthy",
      body: z.object({
        status: z.literal('healthy'),
        service: z.literal('clearlift-api'),
        timestamp: z.string(),
        bindings: z.object({
          db: z.boolean(),
          ad_data: z.boolean(),
          events: z.boolean(),
          ducklake: z.boolean()
        }),
        databases: z.object({
          main: z.object({
            connected: z.boolean(),
            error: z.string().optional()
          }),
          ad_data: z.object({
            connected: z.boolean(),
            error: z.string().optional()
          })
        }).optional()
      })
    }
  }

  }

  async handle(c: AppContext) {
  const response = {
    status: 'healthy' as const,
    service: 'clearlift-api' as const,
    timestamp: new Date().toISOString(),
    bindings: {
      db: !!c.env.DB,
      ad_data: !!c.env.AD_DATA,
      events: !!c.env.R2_EVENTS,
      ducklake: !!c.env.DUCKLAKE
    },
    databases: {
      main: {
        connected: false,
        error: undefined as string | undefined
      },
      ad_data: {
        connected: false,
        error: undefined as string | undefined
      }
    }
  };

  // Test main database connection
  if (c.env.DB) {
    try {
      const result = await c.env.DB.prepare('SELECT 1 as test').first();
      response.databases.main.connected = !!result;
    } catch (error) {
      response.databases.main.connected = false;
      response.databases.main.error = error instanceof Error ? error.message : 'Unknown error';
    }
  }

  // Test AD_DATA database connection
  if (c.env.AD_DATA) {
    try {
      const result = await c.env.AD_DATA.prepare('SELECT 1 as test').first();
      response.databases.ad_data.connected = !!result;
    } catch (error) {
      response.databases.ad_data.connected = false;
      response.databases.ad_data.error = error instanceof Error ? error.message : 'Unknown error';
    }
  }

  return c.json(response);
  }
}