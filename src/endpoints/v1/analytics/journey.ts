/**
 * User Journey Analytics Endpoints
 *
 * Provides full user journey visualization across sessions and devices.
 * Uses identity stitching to link anonymous sessions to identified users.
 * Integrates actual revenue from connectors (Stripe, Shopify, Jobber) for accurate LTV.
 *
 * Uses the unified Revenue Source Plugin System to aggregate conversions
 * from all configured revenue sources (Stripe, Shopify, Jobber, etc.).
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { D1Adapter } from "../../../adapters/d1";
import { getCombinedRevenueByDateRange } from "../../../services/revenue-sources";

/**
 * Generic connector conversion record
 * Supports Stripe, Shopify, HubSpot, and future connectors
 */
interface ConnectorConversion {
  source: 'stripe' | 'shopify' | 'hubspot' | 'salesforce' | 'other';
  transaction_id: string;
  timestamp: string;
  amount: number;
  currency: string;
  status: string;
  product_id: string | null;
  customer_id: string | null;
  metadata: Record<string, any>;
}

/**
 * Query connector conversions for a user from D1 ANALYTICS_DB
 * Currently supports Stripe charges from stripe_charges table
 */
async function queryConnectorConversionsD1(
  analyticsDb: D1Database,
  orgId: string,
  userId: string,
  anonymousIds: string[],
  dateFrom?: string,
  dateTo?: string
): Promise<ConnectorConversion[]> {
  const conversions: ConnectorConversion[] = [];

  try {
    // Query Stripe charges from D1 ANALYTICS_DB
    // Note: stripe_charges may have customer_email that we can match against userId
    let stripeQuery = `
      SELECT
        id,
        stripe_charge_id,
        amount_cents,
        currency,
        status,
        stripe_created_at,
        customer_email,
        product_metadata
      FROM stripe_charges
      WHERE org_id = ?
        AND status = 'succeeded'
    `;

    const queryParams: any[] = [orgId];

    if (dateFrom) {
      stripeQuery += ` AND stripe_created_at >= ?`;
      queryParams.push(`${dateFrom}T00:00:00Z`);
    }
    if (dateTo) {
      stripeQuery += ` AND stripe_created_at <= ?`;
      queryParams.push(`${dateTo}T23:59:59Z`);
    }

    stripeQuery += ` ORDER BY stripe_created_at DESC LIMIT 500`;

    const stripeResult = await analyticsDb.prepare(stripeQuery)
      .bind(...queryParams)
      .all<{
        id: string;
        stripe_charge_id: string;
        amount_cents: number;
        currency: string;
        status: string;
        stripe_created_at: string;
        customer_email: string | null;
        product_metadata: string | null;
      }>();

    for (const row of stripeResult.results || []) {
      // Match by email if available
      const matches = row.customer_email?.toLowerCase() === userId.toLowerCase();
      if (matches) {
        conversions.push({
          source: 'stripe',
          transaction_id: row.stripe_charge_id,
          timestamp: row.stripe_created_at,
          amount: (row.amount_cents || 0) / 100,
          currency: row.currency || 'usd',
          status: row.status,
          product_id: null,
          customer_id: row.customer_email || null,
          metadata: row.product_metadata ? JSON.parse(row.product_metadata) : {}
        });
      }
    }
  } catch (err) {
    // Table may not exist yet
    console.warn('[Journey] Failed to query stripe_charges from D1:', err);
  }

  // TODO: Add queries for shopify_orders, jobber_jobs when tables are available
  // These will be similar pattern - query by org_id and match by customer email

  return conversions.sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

/**
 * GET /v1/analytics/users/:userId/journey
 *
 * Returns the complete user journey across all linked sessions.
 *
 * NOTE: Currently returns minimal journey data from D1.
 * Event-based journey tracking requires events table to be populated in D1.
 */
export class GetUserJourney extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get user journey",
    description: `
Returns the complete journey for an identified user, including:
- All linked anonymous sessions (via identity stitching)
- Chronological event timeline
- First and last touch attribution
- Conversion history
- Cross-device activity

**NOTE:** Currently returns limited data. Full journey tracking requires D1 events table.
    `.trim(),
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        userId: z.string().describe("Identified user ID (email or external ID)")
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date filter (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date filter (YYYY-MM-DD)"),
        include_events: z.enum(['true', 'false']).optional().default('true').describe("Include raw event timeline")
      })
    },
    responses: {
      "200": {
        description: "User journey data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                user_id: z.string(),
                identity: z.object({
                  anonymous_ids: z.array(z.string()),
                  first_identified: z.string().nullable(),
                  devices: z.number(),
                  is_stitched: z.boolean()
                }),
                journey: z.object({
                  first_touch: z.object({
                    source: z.string(),
                    medium: z.string().nullable(),
                    campaign: z.string().nullable(),
                    date: z.string()
                  }).nullable(),
                  last_touch: z.object({
                    source: z.string(),
                    medium: z.string().nullable(),
                    campaign: z.string().nullable(),
                    date: z.string()
                  }).nullable(),
                  path: z.array(z.string()),
                  sessions: z.number(),
                  pageviews: z.number(),
                  days_active: z.number()
                }),
                conversions: z.object({
                  tag_conversions: z.array(z.object({
                    event_id: z.string(),
                    timestamp: z.string(),
                    type: z.string(),
                    revenue: z.number(),
                    session_id: z.string().nullable()
                  })),
                  connector_conversions: z.array(z.object({
                    source: z.enum(['stripe', 'shopify', 'hubspot', 'salesforce', 'other']),
                    transaction_id: z.string(),
                    timestamp: z.string(),
                    amount: z.number(),
                    currency: z.string(),
                    status: z.string(),
                    product_id: z.string().nullable()
                  })),
                  by_source: z.record(z.object({
                    count: z.number(),
                    revenue: z.number()
                  })),
                  total_conversions: z.number(),
                  total_revenue_tag: z.number(),
                  total_revenue_connectors: z.number(),
                  revenue_source: z.enum(['tag', 'connectors', 'combined'])
                }),
                events: z.array(z.object({
                  event_id: z.string(),
                  timestamp: z.string(),
                  event_type: z.string(),
                  session_id: z.string().nullable(),
                  anonymous_id: z.string().nullable(),
                  page_url: z.string().nullable(),
                  utm_source: z.string().nullable(),
                  utm_medium: z.string().nullable(),
                  utm_campaign: z.string().nullable()
                })).optional(),
                summary: z.object({
                  first_seen: z.string().nullable(),
                  last_seen: z.string().nullable(),
                  total_conversions: z.number(),
                  lifetime_value: z.number(),
                  days_to_first_convert: z.number().nullable(),
                  avg_session_duration: z.number().nullable()
                })
              })
            })
          }
        }
      },
      "404": { description: "User not found" }
    }
  };

  async handle(c: AppContext) {
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;
    const params = c.req.param();
    const query = c.req.query();

    const userId = decodeURIComponent(params.userId);
    const dateFrom = query.date_from;
    const dateTo = query.date_to;
    const includeEvents = query.include_events !== 'false';

    const d1 = new D1Adapter(c.env.DB);

    // Get org tag
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      return error(c, "NOT_FOUND", "Organization has no tracking configured", 404);
    }

    // Get all anonymous_ids linked to this user from identity_mappings
    const anonymousIds = await d1.getAnonymousIdsByUserId(orgId, userId);

    // Get identity graph for metadata
    const identityGraph = await d1.getIdentityGraph(orgId, userId);
    const firstIdentified = identityGraph.length > 0
      ? identityGraph.reduce((min, ig) =>
          ig.identified_at < min ? ig.identified_at : min, identityGraph[0].identified_at)
      : null;

    // Estimate unique devices from different anonymous_ids
    const devices = anonymousIds.length;

    // Get ANALYTICS_DB binding
    const analyticsDb = (c.env as any).ANALYTICS_DB || c.env.DB;

    // Query connector conversions from D1 (Stripe charges, etc.)
    const connectorConversions = await queryConnectorConversionsD1(
      analyticsDb,
      orgId,
      userId,
      anonymousIds,
      dateFrom,
      dateTo
    );

    // Group connector conversions by source
    const bySource: Record<string, { count: number; revenue: number }> = {};
    connectorConversions.forEach(conv => {
      if (!bySource[conv.source]) {
        bySource[conv.source] = { count: 0, revenue: 0 };
      }
      bySource[conv.source].count++;
      bySource[conv.source].revenue += conv.amount;
    });

    // Calculate totals
    const totalConnectorRevenue = connectorConversions.reduce((sum, c) => sum + c.amount, 0);
    const totalConversions = connectorConversions.length;

    // TODO: Query events from D1 when events table is available
    // For now, return empty journey with connector data only
    console.log(`[Journey] User ${userId} - returning connector data only (D1 events table not yet populated)`);

    // Determine revenue source
    const revenueSource: 'tag' | 'connectors' | 'combined' =
      connectorConversions.length > 0 ? 'connectors' : 'tag';

    // Calculate summary from connector conversions
    const firstSeen = connectorConversions.length > 0 ? connectorConversions[0].timestamp : null;
    const lastSeen = connectorConversions.length > 0
      ? connectorConversions[connectorConversions.length - 1].timestamp
      : null;

    return success(c, {
      user_id: userId,
      identity: {
        anonymous_ids: anonymousIds,
        first_identified: firstIdentified,
        devices,
        is_stitched: anonymousIds.length > 0
      },
      journey: {
        first_touch: null,  // Requires events table
        last_touch: null,   // Requires events table
        path: [],           // Requires events table
        sessions: 0,        // Requires events table
        pageviews: 0,       // Requires events table
        days_active: 0      // Requires events table
      },
      conversions: {
        tag_conversions: [],  // Requires events table
        connector_conversions: connectorConversions.map(c => ({
          source: c.source,
          transaction_id: c.transaction_id,
          timestamp: c.timestamp,
          amount: Math.round(c.amount * 100) / 100,
          currency: c.currency,
          status: c.status,
          product_id: c.product_id
        })),
        by_source: Object.fromEntries(
          Object.entries(bySource).map(([k, v]) => [k, {
            count: v.count,
            revenue: Math.round(v.revenue * 100) / 100
          }])
        ),
        total_conversions: totalConversions,
        total_revenue_tag: 0,  // Requires events table
        total_revenue_connectors: Math.round(totalConnectorRevenue * 100) / 100,
        revenue_source: revenueSource
      },
      events: includeEvents ? [] : undefined,  // Requires events table
      summary: {
        first_seen: firstSeen,
        last_seen: lastSeen,
        total_conversions: totalConversions,
        lifetime_value: Math.round(totalConnectorRevenue * 100) / 100,
        days_to_first_convert: null,  // Requires events table
        avg_session_duration: null    // Requires events table
      }
    });
  }
}

/**
 * GET /v1/analytics/journeys/overview
 *
 * Aggregate journey metrics across all users.
 *
 * NOTE: Currently returns empty metrics. Journey analytics requires
 * events table to be populated in D1.
 */
export class GetJourneysOverview extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get journey overview metrics",
    description: "Aggregate journey metrics: avg path length, time to convert, top paths. NOTE: Currently returns empty (requires D1 events table).",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)")
      })
    },
    responses: {
      "200": {
        description: "Journey overview metrics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                metrics: z.object({
                  total_identified_users: z.number(),
                  total_anonymous_sessions: z.number(),
                  identity_match_rate: z.number(),
                  avg_path_length: z.number(),
                  avg_days_to_convert: z.number(),
                  avg_sessions_to_convert: z.number()
                }),
                top_journeys: z.array(z.object({
                  path: z.string(),
                  journeys: z.number(),
                  conversions: z.number(),
                  revenue: z.number(),
                  conversion_rate: z.number()
                })),
                top_converting_paths: z.array(z.object({
                  path: z.string(),
                  conversions: z.number(),
                  revenue: z.number()
                })),
                conversion_by_path_length: z.array(z.object({
                  path_length: z.number(),
                  conversions: z.number(),
                  conversion_rate: z.number()
                }))
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;
    const query = c.req.query();

    const dateFrom = query.date_from;
    const dateTo = query.date_to;

    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      return success(c, {
        metrics: {
          total_identified_users: 0,
          total_anonymous_sessions: 0,
          identity_match_rate: 0,
          avg_path_length: 0,
          avg_days_to_convert: 0,
          avg_sessions_to_convert: 0,
          total_conversions: 0,
          total_revenue: 0
        },
        top_paths: [],
        conversion_by_path_length: [],
        revenue_by_source: {}
      });
    }

    const orgTag = tagMapping.short_tag;
    const analyticsDb = (c.env as any).ANALYTICS_DB;

    // Get identity mappings count from D1
    const identityCount = await c.env.DB.prepare(`
      SELECT COUNT(DISTINCT user_id) as users, COUNT(DISTINCT anonymous_id) as anon_ids
      FROM identity_mappings WHERE organization_id = ?
    `).bind(orgId).first() as { users: number; anon_ids: number } | null;

    // Query daily_metrics for session/user totals in date range
    let dailyMetrics: { sessions: number; users: number } | null = null;
    if (analyticsDb) {
      try {
        dailyMetrics = await analyticsDb.prepare(`
          SELECT
            COALESCE(SUM(sessions), 0) as sessions,
            COALESCE(SUM(users), 0) as users
          FROM daily_metrics
          WHERE org_tag = ?
            AND date >= ? AND date <= ?
        `).bind(orgTag, dateFrom, dateTo).first() as { sessions: number; users: number } | null;
      } catch (err) {
        console.warn('[Journey Overview] Failed to query daily_metrics:', err);
      }
    }

    // Query unified revenue sources for conversions and revenue
    // This aggregates Stripe, Shopify, Jobber, and any future connectors
    let revenueData = {
      conversions: 0,
      revenue: 0,
      uniqueCustomers: 0,
      sources: {} as Record<string, { conversions: number; revenue: number; displayName: string }>
    };

    try {
      const combinedRevenue = await getCombinedRevenueByDateRange(
        analyticsDb || c.env.DB,
        orgId,
        { start: dateFrom, end: dateTo }
      );
      revenueData = combinedRevenue.summary;
      console.log(`[Journey Overview] Revenue sources for org ${orgId}:`, Object.keys(revenueData.sources));
    } catch (err) {
      console.warn('[Journey Overview] Failed to query unified revenue sources:', err);
    }

    // Query journeys table for path analytics
    let journeyStats: {
      avg_path_length: number;
      avg_time_to_convert: number;
      avg_sessions_to_convert: number;
      total_journeys: number;
      converted_journeys: number;
    } | null = null;

    if (analyticsDb) {
      try {
        journeyStats = await analyticsDb.prepare(`
          SELECT
            COALESCE(AVG(path_length), 0) as avg_path_length,
            COALESCE(AVG(CASE WHEN converted = 1 THEN time_to_conversion_hours / 24.0 ELSE NULL END), 0) as avg_time_to_convert,
            COALESCE(AVG(CASE WHEN converted = 1 THEN path_length ELSE NULL END), 0) as avg_sessions_to_convert,
            COUNT(*) as total_journeys,
            SUM(CASE WHEN converted = 1 THEN 1 ELSE 0 END) as converted_journeys
          FROM journeys
          WHERE org_tag = ?
            AND first_touch_ts >= ? AND first_touch_ts <= ?
        `).bind(orgTag, `${dateFrom}T00:00:00Z`, `${dateTo}T23:59:59Z`).first() as {
          avg_path_length: number;
          avg_time_to_convert: number;
          avg_sessions_to_convert: number;
          total_journeys: number;
          converted_journeys: number;
        } | null;
      } catch (err) {
        console.warn('[Journey Overview] Failed to query journeys:', err);
      }
    }

    // Query top journeys by traffic volume (regardless of conversion status)
    let topJourneys: Array<{ path: string; journeys: number; conversions: number; revenue: number; conversion_rate: number }> = [];
    if (analyticsDb) {
      try {
        const journeysResult = await analyticsDb.prepare(`
          SELECT
            channel_path as path,
            COUNT(*) as journeys,
            SUM(CASE WHEN converted = 1 THEN 1 ELSE 0 END) as conversions,
            COALESCE(SUM(conversion_value_cents), 0) as revenue_cents
          FROM journeys
          WHERE org_tag = ?
            AND first_touch_ts >= ? AND first_touch_ts <= ?
          GROUP BY channel_path
          ORDER BY journeys DESC
          LIMIT 10
        `).bind(orgTag, `${dateFrom}T00:00:00Z`, `${dateTo}T23:59:59Z`).all() as {
          results: Array<{ path: string; journeys: number; conversions: number; revenue_cents: number }>
        };

        topJourneys = (journeysResult.results || []).map(row => ({
          path: row.path,
          journeys: row.journeys,
          conversions: row.conversions || 0,
          revenue: Math.round((row.revenue_cents || 0) / 100 * 100) / 100,
          conversion_rate: row.journeys > 0 ? Math.round((row.conversions || 0) / row.journeys * 100 * 100) / 100 : 0
        }));
      } catch (err) {
        console.warn('[Journey Overview] Failed to query top journeys:', err);
      }
    }

    // Query top converting paths from journeys table (if available)
    let topConvertingPaths: Array<{ path: string; conversions: number; revenue: number }> = [];
    if (analyticsDb) {
      try {
        const pathsResult = await analyticsDb.prepare(`
          SELECT
            channel_path as path,
            COUNT(*) as conversions,
            COALESCE(SUM(conversion_value_cents), 0) as revenue_cents
          FROM journeys
          WHERE org_tag = ?
            AND converted = 1
            AND first_touch_ts >= ? AND first_touch_ts <= ?
          GROUP BY channel_path
          ORDER BY conversions DESC
          LIMIT 10
        `).bind(orgTag, `${dateFrom}T00:00:00Z`, `${dateTo}T23:59:59Z`).all() as {
          results: Array<{ path: string; conversions: number; revenue_cents: number }>
        };

        topConvertingPaths = (pathsResult.results || []).map(row => ({
          path: row.path,
          conversions: row.conversions,
          revenue: Math.round((row.revenue_cents || 0) / 100 * 100) / 100
        }));
      } catch (err) {
        console.warn('[Journey Overview] Failed to query top converting paths:', err);
      }
    }

    // Query conversion by path length
    let conversionByPathLength: Array<{ path_length: number; conversions: number; conversion_rate: number }> = [];
    if (analyticsDb) {
      try {
        const pathLengthResult = await analyticsDb.prepare(`
          SELECT
            path_length,
            SUM(CASE WHEN converted = 1 THEN 1 ELSE 0 END) as conversions,
            COUNT(*) as total,
            CAST(SUM(CASE WHEN converted = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100 as conversion_rate
          FROM journeys
          WHERE org_tag = ?
            AND first_touch_ts >= ? AND first_touch_ts <= ?
          GROUP BY path_length
          ORDER BY path_length ASC
          LIMIT 20
        `).bind(orgTag, `${dateFrom}T00:00:00Z`, `${dateTo}T23:59:59Z`).all() as {
          results: Array<{ path_length: number; conversions: number; conversion_rate: number }>
        };

        conversionByPathLength = (pathLengthResult.results || []).map(row => ({
          path_length: row.path_length,
          conversions: row.conversions,
          conversion_rate: Math.round((row.conversion_rate || 0) * 100) / 100
        }));
      } catch (err) {
        console.warn('[Journey Overview] Failed to query path length stats:', err);
      }
    }

    // Calculate identity match rate
    const totalUsers = dailyMetrics?.users || identityCount?.anon_ids || 0;
    const identifiedUsers = identityCount?.users || 0;
    const identityMatchRate = totalUsers > 0
      ? Math.round((identifiedUsers / totalUsers) * 100 * 100) / 100
      : 0;

    console.log(`[Journey Overview] org ${orgId} - sessions: ${dailyMetrics?.sessions || 0}, conversions: ${revenueData.conversions}, revenue: $${revenueData.revenue}`);

    return success(c, {
      metrics: {
        total_identified_users: identityCount?.users || 0,
        total_anonymous_sessions: dailyMetrics?.sessions || identityCount?.anon_ids || 0,
        identity_match_rate: identityMatchRate,
        avg_path_length: Math.round((journeyStats?.avg_path_length || 0) * 10) / 10,
        avg_days_to_convert: Math.round((journeyStats?.avg_time_to_convert || 0) * 10) / 10,
        avg_sessions_to_convert: Math.round((journeyStats?.avg_sessions_to_convert || 0) * 10) / 10,
        total_conversions: revenueData.conversions,
        total_revenue: Math.round(revenueData.revenue * 100) / 100
      },
      top_journeys: topJourneys,
      top_converting_paths: topConvertingPaths,
      conversion_by_path_length: conversionByPathLength,
      revenue_by_source: revenueData.sources
    });
  }
}
