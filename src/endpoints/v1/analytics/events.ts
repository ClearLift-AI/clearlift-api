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

    // Cap limit at 999 so we can request 1000 and detect if more exist
    // (Supabase PostgREST caps at 1000 rows by default)
    // Clients should use cursor pagination for larger datasets
    const cappedLimit = Math.min(limit, 999);

    // Get cursor parameters for pagination
    const cursor = c.req.query("cursor");
    const direction = c.req.query("direction") || "next";

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
      case "6h":
        startTime = new Date(now.getTime() - 6 * 60 * 60 * 1000);
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

    // Use events schema
    const supabase = createClient(c.env.SUPABASE_URL, supabaseKey, {
      db: { schema: 'events' }
    });

    try {
      // First, get any domain patterns claimed by this org
      // This allows us to also fetch domain_xxx events that belong to this org
      const { data: domainClaims } = await supabase
        .from("domain_claims")
        .select("domain_pattern")
        .eq("claimed_org_tag", orgTag)
        .is("released_at", null);

      const domainPatterns = domainClaims?.map(d => d.domain_pattern) || [];

      // Query events directly - much faster than filtering on computed column
      // We filter on org_tag = orgTag OR org_tag matches any domain pattern
      // Fetch one extra to determine if there are more results (cursor pagination)
      let query = supabase
        .from("events")
        .select("*")
        .gte("timestamp", startTime.toISOString())
        .order("timestamp", { ascending: false })
        .limit(cappedLimit + 1);

      // Apply cursor-based pagination if cursor is provided
      if (cursor) {
        if (direction === "next") {
          // Get events older than cursor (going back in time)
          query = query.lt("timestamp", cursor);
        } else {
          // Get events newer than cursor (going forward in time)
          query = query.gt("timestamp", cursor);
        }
      }

      if (domainPatterns.length > 0) {
        // Build OR filter: org_tag = orgTag OR org_tag LIKE pattern1 OR ...
        // PostgREST doesn't support LIKE with .or(), so we use a raw filter
        const likeFilters = domainPatterns.map(p => `org_tag.like.${p}`).join(',');
        query = query.or(`org_tag.eq.${orgTag},${likeFilters}`);
      } else {
        // No domain claims, just filter by exact org_tag
        query = query.eq("org_tag", orgTag);
      }

      const { data: events, error: queryError } = await query;

      if (queryError) {
        console.error("Supabase query error:", queryError);
        return error(c, "QUERY_FAILED", queryError.message, 500);
      }

      // Determine if there are more results (we fetched cappedLimit + 1)
      const hasMore = events && events.length > cappedLimit;
      const returnedEvents = hasMore ? events.slice(0, cappedLimit) : (events || []);
      const nextCursor = returnedEvents.length > 0
        ? returnedEvents[returnedEvents.length - 1].timestamp
        : null;

      // Set cache headers based on lookback period
      // Shorter lookbacks = more real-time = shorter cache
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
      console.error("Failed to fetch events:", err);
      return error(c, "QUERY_FAILED", "Failed to fetch event data", 500);
    }
  }
}