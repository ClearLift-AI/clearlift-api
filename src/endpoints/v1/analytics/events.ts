import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { EventResponseSchema } from "../../../schemas/analytics";
import { getSecret } from "../../../utils/secrets";
import { R2SQLAdapter } from "../../../adapters/platforms/r2sql";
import { structuredLog } from '../../../utils/structured-logger';

/**
 * GET /v1/analytics/events - Get raw events from R2 SQL
 * Fetches events by org_tag using R2 SQL Data Catalog.
 */
export class GetEvents extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get raw events",
    description: "Fetches raw events from R2 SQL for a specific organization",
    operationId: "get-events",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        lookback: z.string().optional().describe("Time period: 1h, 24h, 7d, 30d (default: 24h)"),
        limit: z.string().optional().describe("Maximum number of events (default: 100, max: 999). Use cursor pagination for larger datasets."),
        cursor: z.string().optional().describe("ISO timestamp cursor for pagination (events older than this)"),
        direction: z.enum(["next", "prev"]).optional().describe("Pagination direction (default: next)")
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

    // R2 SQL supports up to 10,000 but 5,000+ can timeout; cap at 5,000
    const cappedLimit = Math.min(limit, 5000);

    // Look up the org_tag for this organization
    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag for analytics", 404);
    }

    const orgTag = orgTagMapping.short_tag;

    // Get R2 SQL configuration
    const r2ApiToken = await getSecret(c.env.R2_SQL_TOKEN);
    if (!r2ApiToken) {
      return error(c, "CONFIGURATION_ERROR", "R2 SQL token not configured", 500);
    }

    // Look up domain patterns claimed by this org (from D1)
    let domainPatterns: string[] = [];
    try {
      const domainClaimsResult = await c.env.DB.prepare(`
        SELECT domain_pattern FROM domain_claims
        WHERE claimed_org_tag = ? AND released_at IS NULL
      `).bind(orgTag).all<{ domain_pattern: string }>();

      domainPatterns = (domainClaimsResult.results || []).map(d => d.domain_pattern);
    } catch {
      // Domain claims table may not exist in all envs
    }

    try {
      // Initialize R2 SQL adapter
      const r2sql = new R2SQLAdapter(
        c.env.CLOUDFLARE_ACCOUNT_ID || '',
        c.env.R2_BUCKET_NAME || 'clearlift-events-lake',
        r2ApiToken
      );

      // Query events from R2 SQL
      const result = await r2sql.getEvents(orgTag, {
        lookback,
        limit: cappedLimit + 1, // Fetch one extra to detect if more exist
        domainPatterns
      });

      if (result.error) {
        structuredLog('ERROR', 'R2 SQL query error', { endpoint: 'analytics/events', error: result.error });
        return error(c, "QUERY_FAILED", result.error, 500);
      }

      // Determine if there are more results
      const hasMore = result.events.length > cappedLimit;
      const returnedEvents = hasMore ? result.events.slice(0, cappedLimit) : result.events;
      const nextCursor = returnedEvents.length > 0
        ? returnedEvents[returnedEvents.length - 1].timestamp
        : null;

      // Set cache headers based on lookback period
      const cacheSeconds: Record<string, number> = {
        '1h': 30,
        '6h': 30,
        '24h': 60,
        '7d': 300,
        '30d': 600
      };
      const maxAge = cacheSeconds[lookback] || 60;
      c.header('Cache-Control', `private, max-age=${maxAge}`);

      return success(
        c,
        {
          events: returnedEvents,
          count: returnedEvents.length,
          pagination: {
            has_more: hasMore,
            next_cursor: nextCursor,
            limit: cappedLimit
          }
        },
        {
          lookback,
          org_tag: orgTag
        }
      );
    } catch (err) {
      structuredLog('ERROR', 'Failed to fetch events', { endpoint: 'analytics/events', error: err instanceof Error ? err.message : String(err) });
      return error(c, "QUERY_FAILED", "Failed to fetch event data", 500);
    }
  }
}