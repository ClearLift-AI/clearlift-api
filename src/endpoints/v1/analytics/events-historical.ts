import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { EventResponseSchema } from "../../../schemas/analytics";
import { getSecret } from "../../../utils/secrets";
import { R2SQLAdapter } from "../../../adapters/platforms/r2sql";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /v1/analytics/events/historical - Get historical events from R2 SQL
 *
 * This endpoint queries R2 SQL directly for events beyond the 45-day
 * Supabase rolling window. Use this for historical analysis where
 * 15-25 second latency is acceptable.
 *
 * For real-time queries (last 45 days), use GET /v1/analytics/events instead.
 */
export class GetEventsHistorical extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get historical events from R2 SQL",
    description: `
      Fetches historical events directly from R2 SQL Data Catalog.
      Use this for queries beyond the 45-day Supabase window.

      **Performance Note**: R2 SQL queries take 15-25 seconds.
      For real-time queries, use GET /v1/analytics/events instead.

      **Limitations**:
      - Maximum 2000 events per request (use cursor pagination for more)
      - Results sorted by timestamp descending (client-side)
      - No aggregation functions (R2 SQL limitation)
    `,
    operationId: "get-events-historical",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().describe("Start date (ISO 8601, e.g., 2025-01-01T00:00:00Z)"),
        end_date: z.string().describe("End date (ISO 8601, e.g., 2025-01-31T23:59:59Z)"),
        limit: z.string().optional().describe("Maximum events to return (default: 100, max: 2000)"),
        cursor: z.string().optional().describe("ISO timestamp cursor for pagination (events older than this)"),
        event_type: z.string().optional().describe("Filter by event type (e.g., page_view, conversion)")
      })
    },
    responses: {
      "200": {
        description: "Historical events from R2 SQL",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: EventResponseSchema,
              meta: z.object({
                timestamp: z.string(),
                data_source: z.literal("r2-sql"),
                query_time_ms: z.number(),
                org_tag: z.string(),
                start_date: z.string(),
                end_date: z.string()
              })
            })
          }
        }
      },
      "400": { description: "Invalid date range or parameters" },
      "401": { description: "Missing or invalid session" },
      "403": { description: "No access to this organization" },
      "500": { description: "Query failed" },
      "504": { description: "Query timeout (R2 SQL queries can take 15-25 seconds)" }
    }
  };

  public async handle(c: AppContext) {
    const startTime = Date.now();

    // Use resolved org_id from requireOrg middleware
    const orgId = c.get("org_id" as any) as string;

    // Get query parameters
    const startDate = c.req.query("start_date");
    const endDate = c.req.query("end_date");
    const limitParam = c.req.query("limit");
    const cursor = c.req.query("cursor");
    const eventTypeFilter = c.req.query("event_type");

    // Validate required parameters
    if (!startDate || !endDate) {
      return error(c, "INVALID_PARAMS", "start_date and end_date are required", 400);
    }

    // Parse and validate dates
    const startDateParsed = new Date(startDate);
    const endDateParsed = new Date(endDate);

    if (isNaN(startDateParsed.getTime()) || isNaN(endDateParsed.getTime())) {
      return error(c, "INVALID_DATE", "Invalid date format. Use ISO 8601 (e.g., 2025-01-01T00:00:00Z)", 400);
    }

    if (startDateParsed >= endDateParsed) {
      return error(c, "INVALID_DATE_RANGE", "start_date must be before end_date", 400);
    }

    // Cap limit at 2000 (R2 SQL performs poorly with larger limits)
    const limit = Math.min(parseInt(limitParam || "100"), 2000);

    // Look up the org_tag for this organization
    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag for analytics", 404);
    }

    const orgTag = orgTagMapping.short_tag;

    // Get R2 SQL token from secrets
    const r2SqlToken = await getSecret(c.env.R2_SQL_TOKEN);
    if (!r2SqlToken) {
      return error(c, "CONFIGURATION_ERROR", "R2 SQL token not configured", 500);
    }

    // Get domain patterns for this org (same logic as events.ts)
    let domainPatterns: string[] = [];
    try {
      const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
      if (supabaseKey) {
        const supabase = createClient(c.env.SUPABASE_URL, supabaseKey, {
          db: { schema: 'events' }
        });

        const { data: domainClaims } = await supabase
          .from("domain_claims")
          .select("domain_pattern")
          .eq("claimed_org_tag", orgTag)
          .is("released_at", null);

        domainPatterns = (domainClaims?.map(d => d.domain_pattern) || []);
      }
    } catch (err) {
      // Non-fatal: proceed without domain patterns
      console.warn("Failed to fetch domain patterns:", err);
    }

    try {
      // Initialize R2SQL adapter
      const accountId = c.env.CLOUDFLARE_ACCOUNT_ID;
      const bucketName = c.env.R2_BUCKET_NAME || "clearlift-db";
      const tableName = c.env.R2_SQL_TABLE || "clearlift.event_data_v4_1";

      const r2sql = new R2SQLAdapter(accountId, bucketName, r2SqlToken, tableName);

      // Build filters
      const filters: Record<string, any> = {};
      if (eventTypeFilter) {
        filters.event_type = eventTypeFilter;
      }

      // If cursor provided, adjust end date to cursor (pagination going backwards)
      let effectiveEndDate = endDate;
      if (cursor) {
        const cursorDate = new Date(cursor);
        if (!isNaN(cursorDate.getTime())) {
          effectiveEndDate = cursor;
        }
      }

      // Query R2 SQL
      const result = await r2sql.getEvents(orgTag, {
        timeRange: {
          start: startDate,
          end: effectiveEndDate
        },
        filters,
        limit: limit + 1, // Fetch one extra to detect if more exist
        domainPatterns
      });

      if (result.error) {
        console.error("R2 SQL query error:", result.error);
        return error(c, "QUERY_FAILED", result.error, 500);
      }

      // Determine if there are more results
      const hasMore = result.events.length > limit;
      const returnedEvents = hasMore ? result.events.slice(0, limit) : result.events;
      const nextCursor = returnedEvents.length > 0
        ? returnedEvents[returnedEvents.length - 1].timestamp
        : null;

      const queryTimeMs = Date.now() - startTime;

      // Set cache headers - historical data doesn't change, cache aggressively
      c.header('Cache-Control', 'private, max-age=600'); // 10 minutes
      c.header('X-Data-Source', 'r2-sql');
      c.header('X-Query-Time-Ms', queryTimeMs.toString());

      return success(
        c,
        {
          events: returnedEvents,
          count: returnedEvents.length,
          pagination: {
            has_more: hasMore,
            next_cursor: nextCursor,
            limit
          }
        },
        {
          data_source: "r2-sql",
          query_time_ms: queryTimeMs,
          org_tag: orgTag,
          start_date: startDate,
          end_date: endDate
        }
      );
    } catch (err) {
      console.error("Failed to fetch historical events:", err);
      const errorMessage = err instanceof Error ? err.message : "Query failed";

      // Check for timeout
      if (errorMessage.includes("timeout") || errorMessage.includes("Timeout")) {
        return error(c, "QUERY_TIMEOUT", "R2 SQL query timed out. Try a smaller date range.", 504);
      }

      return error(c, "QUERY_FAILED", errorMessage, 500);
    }
  }
}
