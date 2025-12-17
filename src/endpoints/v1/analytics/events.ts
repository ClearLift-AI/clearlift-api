import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { R2SQLAdapter } from "../../../adapters/platforms/r2sql";
import { success, error } from "../../../utils/response";
import { EventResponseSchema } from "../../../schemas/analytics";
import { getSecret } from "../../../utils/secrets";

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
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;

    // Get query parameters
    const lookback = c.req.query("lookback") || "24h";
    const limit = parseInt(c.req.query("limit") || "100");

    // Validate limit
    if (limit > 1000) {
      return error(c, "INVALID_LIMIT", "Limit cannot exceed 1000", 400);
    }

    // Access check already handled by requireOrg middleware

    // Look up the org_tag for this organization
    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag for analytics", 404);
    }

    const orgTag = orgTagMapping.short_tag;

    // Get domain patterns for this org (for domain_xxx event resolution)
    // These are domains claimed by the org - events with domain_xxx org_tags
    // will be included in the query results
    const trackingDomains = await c.env.DB.prepare(`
      SELECT domain FROM tracking_domains WHERE organization_id = ?
    `).bind(orgId).all<{ domain: string }>();

    // Convert domains to LIKE patterns: rockbot.com -> domain_%rockbot_com
    const domainPatterns: string[] = [];
    if (trackingDomains.results) {
      for (const row of trackingDomains.results) {
        // Normalize: lowercase, strip www prefix, convert dots to underscores
        const baseDomain = row.domain.toLowerCase().replace(/^www\./, '');
        const pattern = `domain_%${baseDomain.replace(/\./g, '_')}`;
        domainPatterns.push(pattern);
      }
    }

    // Get R2 SQL token from Secrets Store
    const r2SqlToken = await getSecret(c.env.R2_SQL_TOKEN);

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
      // Fetch events - include both explicit org_tag and domain patterns
      const result = await r2sql.getEvents(orgTag, {
        lookback,
        limit,
        domainPatterns
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