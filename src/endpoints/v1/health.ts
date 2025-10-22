import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success } from "../../utils/response";
import { getSecret } from "../../utils/secrets";

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
                  r2_sql: z.boolean()
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
                  r2_sql: z.object({
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
      r2_sql: { connected: false, latency_ms: 0 }
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
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);

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

    // Check R2 SQL connectivity
    // Note: We need R2_SQL_TOKEN to test, so we'll check if binding exists
    const hasR2Token = !!(c.env.R2_SQL_TOKEN && c.env.R2_BUCKET_NAME && c.env.CLOUDFLARE_ACCOUNT_ID);
    checks.r2_sql.connected = hasR2Token;
    checks.r2_sql.latency_ms = 0; // Can't test without making actual query

    const data = {
      status: "healthy",
      service: "clearlift-api",
      timestamp: new Date().toISOString(),
      bindings: {
        db: !!c.env.DB,
        supabase: !!(supabaseUrl && supabaseKey),
        r2_sql: hasR2Token
      },
      checks
    };

    return success(c, data);
  }
}