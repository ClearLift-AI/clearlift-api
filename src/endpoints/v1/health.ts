import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success } from "../../utils/response";

export class HealthEndpoint extends OpenAPIRoute {
  public schema = {
    tags: ["System"],
    summary: "Health check endpoint",
    operationId: "health-check",
    responses: {
      "200": {
        description: "Service is healthy",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                status: z.string(),
                service: z.string(),
                timestamp: z.string(),
                bindings: z.object({
                  db: z.boolean(),
                  supabase: z.boolean(),
                  duckdb: z.boolean()
                }),
                checks: z.object({
                  database: z.object({
                    connected: z.boolean(),
                    latency_ms: z.number().optional()
                  }),
                  supabase: z.object({
                    connected: z.boolean(),
                    latency_ms: z.number().optional()
                  }),
                  duckdb: z.object({
                    connected: z.boolean(),
                    latency_ms: z.number().optional()
                  })
                })
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const checks = {
      database: { connected: false, latency_ms: 0 },
      supabase: { connected: false, latency_ms: 0 },
      duckdb: { connected: false, latency_ms: 0 }
    };

    // Check D1 Database
    if (c.env.DB) {
      try {
        const start = Date.now();
        const result = await c.env.DB.prepare("SELECT 1 as test").first();
        checks.database.latency_ms = Date.now() - start;
        checks.database.connected = result?.test === 1;
      } catch (error) {
        console.error("D1 health check failed:", error);
        checks.database.connected = false;
      }
    }

    // Check Supabase connectivity
    const supabaseUrl = c.env.SUPABASE_URL;
    const supabaseKey = c.env.SUPABASE_SECRET_KEY;

    if (supabaseUrl && supabaseKey) {
      try {
        const start = Date.now();
        const response = await fetch(`${supabaseUrl}/rest/v1/`, {
          method: "HEAD",
          headers: {
            "apikey": supabaseKey.toString(),
            "Authorization": `Bearer ${supabaseKey}`
          }
        });
        checks.supabase.latency_ms = Date.now() - start;
        checks.supabase.connected = response.ok || response.status === 406; // 406 is expected for HEAD request
      } catch (error) {
        console.error("Supabase health check failed:", error);
        checks.supabase.connected = false;
      }
    }

    // Check DuckDB API connectivity
    try {
      const start = Date.now();
      const response = await fetch("https://query.clearlift.ai/health", {
        method: "GET",
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });
      checks.duckdb.latency_ms = Date.now() - start;
      checks.duckdb.connected = response.ok;
    } catch (error) {
      console.error("DuckDB health check failed:", error);
      checks.duckdb.connected = false;
    }

    const data = {
      status: "healthy",
      service: "clearlift-api",
      timestamp: new Date().toISOString(),
      bindings: {
        db: !!c.env.DB,
        supabase: !!(supabaseUrl && supabaseKey),
        duckdb: true // Always available as external service
      },
      checks
    };

    return success(c, data);
  }
}