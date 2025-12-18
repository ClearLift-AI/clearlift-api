import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { createClient } from "@supabase/supabase-js";
import { success, error } from "../../../utils/response";
import { EventResponseSchema } from "../../../schemas/analytics";
import { getSecret } from "../../../utils/secrets";

/**
 * GET /v1/analytics/events - Get raw events from Supabase
 * Fetches events by org_tag using the org_events view which handles
 * domain_xxx event resolution automatically via effective_org_tag.
 */
export class GetEvents extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get raw events",
    description: "Fetches raw events from Supabase for a specific organization",
    operationId: "get-events",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        lookback: z.string().optional().describe("Time period: 1h, 24h, 7d, 30d (default: 24h)"),
        limit: z.string().optional().describe("Maximum number of events (default: 100, max: 1000)")
      })
    },
    responses: {
      "200": {
        description: "Raw events with validated core fields (60+ fields allowed via passthrough)",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: EventResponseSchema,
              meta: z.object({
                timestamp: z.string(),
                lookback: z.string(),
                org_tag: z.string()
              })
            })
          }
        }
      },
      "401": { description: "Missing or invalid session" },
      "403": { description: "No access to this org_tag" },
      "500": { description: "Query failed" }
    }
  };

  public async handle(c: AppContext) {
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;

    // Get query parameters
    const lookback = c.req.query("lookback") || "24h";
    const limit = parseInt(c.req.query("limit") || "100");

    // Validate limit
    if (limit > 1000) {
      return error(c, "INVALID_LIMIT", "Limit cannot exceed 1000", 400);
    }

    // Look up the org_tag for this organization
    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag for analytics", 404);
    }

    const orgTag = orgTagMapping.short_tag;

    // Get Supabase secret key from Secrets Store
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase key not configured", 500);
    }

    // Calculate timestamp threshold from lookback period
    const now = new Date();
    let startTime: Date;

    switch (lookback) {
      case "1h":
        startTime = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case "7d":
        startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "30d":
        startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case "24h":
      default:
        startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
    }

    // Use events schema to access org_events view
    const supabase = createClient(c.env.SUPABASE_URL, supabaseKey, {
      db: { schema: 'events' }
    });

    try {
      // Query org_events view - it resolves domain_xxx events automatically
      // via the effective_org_tag column. This handles:
      // - Events with explicit org_tag matching our orgTag
      // - Events with domain_xxx org_tag where the domain is claimed by orgTag
      const { data: events, error: queryError } = await supabase
        .from("org_events")
        .select("*")
        .eq("effective_org_tag", orgTag)
        .gte("timestamp", startTime.toISOString())
        .order("timestamp", { ascending: false })
        .limit(limit);

      if (queryError) {
        console.error("Supabase query error:", queryError);
        return error(c, "QUERY_FAILED", queryError.message, 500);
      }

      return success(
        c,
        {
          events: events || [],
          count: events?.length || 0
        },
        {
          lookback,
          org_tag: orgTag
        }
      );
    } catch (err) {
      console.error("Failed to fetch events:", err);
      return error(c, "QUERY_FAILED", "Failed to fetch event data", 500);
    }
  }
}