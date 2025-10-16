import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { R2SQLAdapter } from "../../../adapters/platforms/r2sql";
import { success, error } from "../../../utils/response";
import { EventResponseSchema } from "../../../schemas/analytics";

/**
 * GET /v1/analytics/events - Get raw events from R2 SQL
 * Simple endpoint that fetches events by org_tag with time filter
 */
export class GetEvents extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get raw events",
    description: "Fetches raw events from R2 SQL for a specific org_tag",
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
        description: "Raw events from R2 SQL with validated core fields (60+ fields allowed via passthrough)",
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
    const session = c.get("session");

    if (!session) {
      return error(c, "UNAUTHORIZED", "Session not found", 401);
    }

    // Get query parameters
    const orgIdParam = c.req.query("org_id");
    const lookback = c.req.query("lookback") || "24h";
    const limit = parseInt(c.req.query("limit") || "100");

    if (!orgIdParam) {
      return error(c, "MISSING_ORG_ID", "org_id query parameter is required", 400);
    }

    // Validate limit
    if (limit > 1000) {
      return error(c, "INVALID_LIMIT", "Limit cannot exceed 1000", 400);
    }

    // Verify user has access to the organization
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgIdParam);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    // Look up the org_tag for this organization
    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgIdParam).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag for analytics", 404);
    }

    const orgTag = orgTagMapping.short_tag;

    // Get R2 SQL token (handle both Secret Store and .dev.vars)
    let r2SqlToken: string | null = null;

    if (typeof c.env.R2_SQL_TOKEN === 'string') {
      r2SqlToken = c.env.R2_SQL_TOKEN;
    } else if (c.env.R2_SQL_TOKEN && typeof c.env.R2_SQL_TOKEN.get === 'function') {
      try {
        r2SqlToken = await c.env.R2_SQL_TOKEN.get();
      } catch (e) {
        // Secret Store not available locally, this is expected
        console.log('R2_SQL_TOKEN Secret Store not available, using .dev.vars');
      }
    }

    if (!r2SqlToken) {
      return error(c, "CONFIGURATION_ERROR", "R2 SQL token not configured", 500);
    }

    // Create R2 SQL adapter
    const r2sql = new R2SQLAdapter(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.R2_BUCKET_NAME,
      r2SqlToken
    );

    try {
      // Fetch events - no filters, just time-based query
      const result = await r2sql.getEvents(orgTag, {
        lookback,
        limit
      });

      if (result.error) {
        return error(c, "QUERY_FAILED", result.error, 500);
      }

      return success(
        c,
        {
          events: result.events,
          count: result.rowCount
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