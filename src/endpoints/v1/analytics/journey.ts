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
import { AppContext, SetupStatus, DataQualityResponse, buildDataQualityResponse } from "../../../types";
import { success, error } from "../../../utils/response";
import { structuredLog } from '../../../utils/structured-logger';
import { D1Adapter } from "../../../adapters/d1";
import { getCombinedRevenueByDateRange } from "../../../services/revenue-sources";
import { AD_PLATFORM_IDS, ACTIVE_REVENUE_PLATFORM_IDS } from "../../../config/platforms";

/**
 * Check setup status for journey analytics
 */
async function checkJourneySetupStatus(
  mainDb: D1Database,
  orgId: string
): Promise<SetupStatus> {
  // Check tracking tag
  const tagMapping = await mainDb.prepare(`
    SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? LIMIT 1
  `).bind(orgId).first<{ short_tag: string }>();

  // Check connected platforms
  const platformsResult = await mainDb.prepare(`
    SELECT platform FROM platform_connections WHERE organization_id = ? AND is_active = 1
  `).bind(orgId).all<{ platform: string }>();
  const connectedPlatforms = (platformsResult.results || []).map(r => r.platform);

  const adPlatforms = connectedPlatforms.filter(p => AD_PLATFORM_IDS.includes(p as any));
  const revenueConnectors = connectedPlatforms.filter(p => ACTIVE_REVENUE_PLATFORM_IDS.includes(p as any));

  return {
    hasTrackingTag: !!tagMapping?.short_tag,
    hasAdPlatforms: adPlatforms.length > 0,
    hasRevenueConnector: revenueConnectors.length > 0,
    hasClickIds: false, // Not checked at endpoint level
    hasUtmData: false, // Not checked at endpoint level
    trackingDomain: undefined,
    connectedPlatforms: adPlatforms,
    connectedConnectors: revenueConnectors
  };
}

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
    structuredLog('WARN', 'Failed to query stripe_charges from D1', { endpoint: 'analytics/journey', error: err instanceof Error ? err.message : String(err) });
  }

  // Query Shopify orders
  try {
    let shopifyQuery = `
      SELECT
        id,
        shopify_order_id,
        total_price_cents,
        currency,
        financial_status,
        shopify_created_at,
        customer_email_hash,
        customer_first_name
      FROM shopify_orders
      WHERE organization_id = ?
        AND financial_status = 'paid'
    `;
    const shopifyParams: any[] = [orgId];

    if (dateFrom) {
      shopifyQuery += ` AND shopify_created_at >= ?`;
      shopifyParams.push(`${dateFrom}T00:00:00Z`);
    }
    if (dateTo) {
      shopifyQuery += ` AND shopify_created_at <= ?`;
      shopifyParams.push(`${dateTo}T23:59:59Z`);
    }

    shopifyQuery += ` ORDER BY shopify_created_at DESC LIMIT 500`;

    const shopifyResult = await analyticsDb.prepare(shopifyQuery)
      .bind(...shopifyParams)
      .all<{
        id: string;
        shopify_order_id: string;
        total_price_cents: number;
        currency: string;
        financial_status: string;
        shopify_created_at: string;
        customer_email_hash: string | null;
        customer_first_name: string | null;
      }>();

    for (const row of shopifyResult.results || []) {
      // Note: Shopify stores customer_email_hash, not plain email
      // We can match by hash if userId was hashed, or skip if not
      conversions.push({
        source: 'shopify',
        transaction_id: row.shopify_order_id,
        timestamp: row.shopify_created_at,
        amount: (row.total_price_cents || 0) / 100,
        currency: row.currency || 'usd',
        status: row.financial_status,
        product_id: null,
        customer_id: row.customer_first_name || null,
        metadata: {}
      });
    }
  } catch (err) {
    structuredLog('WARN', 'Failed to query shopify_orders from D1', { endpoint: 'analytics/journey', error: err instanceof Error ? err.message : String(err) });
  }

  // Query Jobber completed jobs
  try {
    let jobberQuery = `
      SELECT
        id,
        jobber_job_id,
        total_amount_cents,
        currency,
        job_status,
        completed_at,
        client_email_hash,
        client_name
      FROM jobber_jobs
      WHERE organization_id = ?
        AND is_completed = 1
    `;
    const jobberParams: any[] = [orgId];

    if (dateFrom) {
      jobberQuery += ` AND completed_at >= ?`;
      jobberParams.push(`${dateFrom}T00:00:00Z`);
    }
    if (dateTo) {
      jobberQuery += ` AND completed_at <= ?`;
      jobberParams.push(`${dateTo}T23:59:59Z`);
    }

    jobberQuery += ` ORDER BY completed_at DESC LIMIT 500`;

    const jobberResult = await analyticsDb.prepare(jobberQuery)
      .bind(...jobberParams)
      .all<{
        id: string;
        jobber_job_id: string;
        total_amount_cents: number;
        currency: string;
        job_status: string;
        completed_at: string;
        client_email_hash: string | null;
        client_name: string | null;
      }>();

    for (const row of jobberResult.results || []) {
      conversions.push({
        source: 'other', // Jobber maps to 'other' in the union type
        transaction_id: row.jobber_job_id,
        timestamp: row.completed_at,
        amount: (row.total_amount_cents || 0) / 100,
        currency: row.currency || 'usd',
        status: row.job_status,
        product_id: null,
        customer_id: row.client_name || null,
        metadata: { source_type: 'jobber' }
      });
    }
  } catch (err) {
    structuredLog('WARN', 'Failed to query jobber_jobs from D1', { endpoint: 'analytics/journey', error: err instanceof Error ? err.message : String(err) });
  }

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

    // If no tracking tag, return empty data with setup guidance instead of 404
    if (!tagMapping) {
      const setupStatus = await checkJourneySetupStatus(c.env.DB, orgId);
      const setupGuidance = buildDataQualityResponse(setupStatus);

      return success(c, {
        user_id: userId,
        identity: {
          first_identified: null,
          devices: 0,
          email_verified: false
        },
        ltv: {
          total_revenue: 0,
          total_conversions: 0,
          currency: 'USD',
          by_source: {}
        },
        journeys: [],
        events: [],
        summary: {
          total_sessions: 0,
          total_pageviews: 0,
          first_seen: null,
          last_seen: null,
          avg_session_duration: null
        },
        setup_guidance: setupGuidance,
        _message: 'No tracking tag configured. Install the ClearLift tracking tag to capture user journeys.'
      });
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
    const analyticsDb = c.env.ANALYTICS_DB;

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

    // Calculate totals from connector conversions
    const totalConnectorRevenue = connectorConversions.reduce((sum, c) => sum + c.amount, 0);

    // Query journeys from D1 ANALYTICS_DB for this user's anonymous_ids
    const orgTag = tagMapping.short_tag;
    let userJourneys: Array<{
      id: string;
      channel_path: string;
      path_length: number;
      first_touch_ts: string;
      last_touch_ts: string;
      converted: number;
      conversion_value_cents: number;
      time_to_conversion_hours: number | null;
    }> = [];

    let tagConversions: Array<{
      event_id: string;
      timestamp: string;
      type: string;
      revenue: number;
      session_id: string | null;
    }> = [];

    try {
      // Query journeys for user's anonymous_ids
      if (anonymousIds.length > 0) {
        const placeholders = anonymousIds.map(() => '?').join(',');
        let journeyQuery = `
          SELECT id, channel_path, path_length, first_touch_ts, last_touch_ts,
                 converted, conversion_value_cents, time_to_conversion_hours
          FROM journeys
          WHERE org_tag = ? AND anonymous_id IN (${placeholders})
        `;
        const params: any[] = [orgTag, ...anonymousIds];

        if (dateFrom) {
          journeyQuery += ` AND first_touch_ts >= ?`;
          params.push(`${dateFrom}T00:00:00Z`);
        }
        if (dateTo) {
          journeyQuery += ` AND first_touch_ts <= ?`;
          params.push(`${dateTo}T23:59:59Z`);
        }

        journeyQuery += ` ORDER BY first_touch_ts ASC LIMIT 100`;

        const journeysResult = await analyticsDb.prepare(journeyQuery).bind(...params).all();
        userJourneys = (journeysResult.results || []) as Array<{
          id: string;
          channel_path: string;
          path_length: number;
          first_touch_ts: string;
          last_touch_ts: string;
          converted: number;
          conversion_value_cents: number;
          time_to_conversion_hours: number | null;
        }>;
      }

      // Query tag conversions (goal_conversions) for this user
      if (anonymousIds.length > 0) {
        const placeholders = anonymousIds.map(() => '?').join(',');
        const tagConvQuery = `
          SELECT gc.id as event_id, gc.conversion_timestamp as timestamp,
                 'goal_conversion' as type,
                 COALESCE(gc.value_cents, 0) / 100.0 as revenue,
                 NULL as session_id
          FROM goal_conversions gc
          JOIN journeys j ON gc.conversion_id = j.conversion_id
          WHERE j.org_tag = ? AND j.anonymous_id IN (${placeholders})
          ORDER BY gc.conversion_timestamp DESC
          LIMIT 50
        `;
        const tagResult = await analyticsDb.prepare(tagConvQuery)
          .bind(orgTag, ...anonymousIds)
          .all();
        tagConversions = (tagResult.results || []) as Array<{
          event_id: string;
          timestamp: string;
          type: string;
          revenue: number;
          session_id: string | null;
        }>;
      }
    } catch (err) {
      structuredLog('WARN', 'Failed to query journeys from D1', { endpoint: 'analytics/journey', error: err instanceof Error ? err.message : String(err) });
    }

    // Build journey data from journeys table
    let firstTouch: { source: string; medium: string | null; campaign: string | null; date: string } | null = null;
    let lastTouch: { source: string; medium: string | null; campaign: string | null; date: string } | null = null;
    const allChannels: string[] = [];
    let totalTagRevenue = 0;
    let daysToFirstConvert: number | null = null;

    if (userJourneys.length > 0) {
      // Parse channel paths and build unified path
      for (const journey of userJourneys) {
        try {
          const channels = JSON.parse(journey.channel_path) as string[];
          allChannels.push(...channels);
          totalTagRevenue += (journey.conversion_value_cents || 0) / 100;
        } catch {
          // If not valid JSON, treat as single channel
          allChannels.push(journey.channel_path);
        }
      }

      // First journey = first touch
      const firstJourney = userJourneys[0];
      try {
        const firstChannels = JSON.parse(firstJourney.channel_path) as string[];
        if (firstChannels.length > 0) {
          firstTouch = {
            source: firstChannels[0],
            medium: null,
            campaign: null,
            date: firstJourney.first_touch_ts
          };
        }
      } catch {
        firstTouch = {
          source: firstJourney.channel_path,
          medium: null,
          campaign: null,
          date: firstJourney.first_touch_ts
        };
      }

      // Last journey with conversion = last touch
      const lastJourney = userJourneys[userJourneys.length - 1];
      try {
        const lastChannels = JSON.parse(lastJourney.channel_path) as string[];
        if (lastChannels.length > 0) {
          lastTouch = {
            source: lastChannels[lastChannels.length - 1],
            medium: null,
            campaign: null,
            date: lastJourney.last_touch_ts
          };
        }
      } catch {
        lastTouch = {
          source: lastJourney.channel_path,
          medium: null,
          campaign: null,
          date: lastJourney.last_touch_ts
        };
      }

      // Days to first convert
      const convertedJourney = userJourneys.find(j => j.converted === 1 && j.time_to_conversion_hours != null);
      if (convertedJourney && convertedJourney.time_to_conversion_hours != null) {
        daysToFirstConvert = Math.round(convertedJourney.time_to_conversion_hours / 24 * 10) / 10;
      }
    }

    // Calculate unique channels (sessions proxy)
    const uniqueDates = new Set(userJourneys.map(j => j.first_touch_ts.slice(0, 10)));
    const sessionsCount = userJourneys.length;
    const daysActive = uniqueDates.size;

    // Determine revenue source
    const hasTagRevenue = totalTagRevenue > 0 || tagConversions.length > 0;
    const hasConnectorRevenue = connectorConversions.length > 0;
    const revenueSource: 'tag' | 'connectors' | 'combined' =
      hasTagRevenue && hasConnectorRevenue ? 'combined' :
      hasConnectorRevenue ? 'connectors' : 'tag';

    // Total conversions from both sources
    const totalTagConversions = userJourneys.filter(j => j.converted === 1).length;
    const totalConversions = totalTagConversions + connectorConversions.length;

    // Calculate summary timestamps
    const firstSeen = userJourneys.length > 0 ? userJourneys[0].first_touch_ts :
      (connectorConversions.length > 0 ? connectorConversions[0].timestamp : null);
    const lastSeen = userJourneys.length > 0
      ? userJourneys[userJourneys.length - 1].last_touch_ts
      : (connectorConversions.length > 0 ? connectorConversions[connectorConversions.length - 1].timestamp : null);

    console.log(`[Journey] User ${userId} - found ${userJourneys.length} journeys, ${tagConversions.length} tag conversions, ${connectorConversions.length} connector conversions`);

    return success(c, {
      user_id: userId,
      identity: {
        anonymous_ids: anonymousIds,
        first_identified: firstIdentified,
        devices,
        is_stitched: anonymousIds.length > 0
      },
      journey: {
        first_touch: firstTouch,
        last_touch: lastTouch,
        path: allChannels,
        sessions: sessionsCount,
        pageviews: sessionsCount * 3, // Estimate ~3 pageviews per session
        days_active: daysActive
      },
      conversions: {
        tag_conversions: tagConversions,
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
        total_revenue_tag: Math.round(totalTagRevenue * 100) / 100,
        total_revenue_connectors: Math.round(totalConnectorRevenue * 100) / 100,
        revenue_source: revenueSource
      },
      events: includeEvents ? [] : undefined, // Raw events not stored in D1
      summary: {
        first_seen: firstSeen,
        last_seen: lastSeen,
        total_conversions: totalConversions,
        lifetime_value: Math.round((totalTagRevenue + totalConnectorRevenue) * 100) / 100,
        days_to_first_convert: daysToFirstConvert,
        avg_session_duration: null // Would require event-level data
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
    const analyticsDb = c.env.ANALYTICS_DB;

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
        structuredLog('WARN', 'Failed to query daily_metrics', { endpoint: 'analytics/journey', step: 'overview', error: err instanceof Error ? err.message : String(err) });
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
      structuredLog('WARN', 'Failed to query unified revenue sources', { endpoint: 'analytics/journey', step: 'overview', error: err instanceof Error ? err.message : String(err) });
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
        structuredLog('WARN', 'Failed to query journeys', { endpoint: 'analytics/journey', step: 'overview', error: err instanceof Error ? err.message : String(err) });
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
        structuredLog('WARN', 'Failed to query top journeys', { endpoint: 'analytics/journey', step: 'overview', error: err instanceof Error ? err.message : String(err) });
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
        structuredLog('WARN', 'Failed to query top converting paths', { endpoint: 'analytics/journey', step: 'overview', error: err instanceof Error ? err.message : String(err) });
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
        structuredLog('WARN', 'Failed to query path length stats', { endpoint: 'analytics/journey', step: 'overview', error: err instanceof Error ? err.message : String(err) });
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
