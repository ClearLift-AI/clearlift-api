/**
 * User Journey Analytics Endpoints
 *
 * Provides full user journey visualization across sessions and devices.
 * Uses identity stitching to link anonymous sessions to identified users.
 * Integrates actual revenue from connectors (Stripe, Shopify) for accurate LTV.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";
import { D1Adapter } from "../../../adapters/d1";

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
 * Query connector conversions for a user across all connected platforms
 */
async function queryConnectorConversions(
  supabase: SupabaseClient,
  db: D1Database,
  orgId: string,
  userId: string,
  anonymousIds: string[],
  dateFrom?: string,
  dateTo?: string
): Promise<ConnectorConversion[]> {
  const conversions: ConnectorConversion[] = [];

  // Get all active platform connections for this org
  const connections = await db.prepare(`
    SELECT id, platform FROM platform_connections
    WHERE organization_id = ? AND is_active = 1
  `).bind(orgId).all<{ id: string; platform: string }>();

  for (const conn of connections.results || []) {
    try {
      switch (conn.platform) {
        case 'stripe':
          const stripeConvs = await queryStripeConversions(
            supabase, conn.id, userId, anonymousIds, dateFrom, dateTo
          );
          conversions.push(...stripeConvs);
          break;

        case 'shopify':
          const shopifyConvs = await queryShopifyConversions(
            supabase, conn.id, userId, anonymousIds, dateFrom, dateTo
          );
          conversions.push(...shopifyConvs);
          break;

        case 'hubspot':
          const hubspotConvs = await queryHubspotDeals(
            supabase, conn.id, userId, anonymousIds, dateFrom, dateTo
          );
          conversions.push(...hubspotConvs);
          break;

        // Add more connectors as needed
      }
    } catch (err) {
      console.error(`Failed to query ${conn.platform} conversions:`, err);
    }
  }

  return conversions.sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

async function queryStripeConversions(
  supabase: SupabaseClient,
  connectionId: string,
  userId: string,
  anonymousIds: string[],
  dateFrom?: string,
  dateTo?: string
): Promise<ConnectorConversion[]> {
  const params = new URLSearchParams();
  params.append('connection_id', `eq.${connectionId}`);
  params.append('status', 'eq.succeeded');
  params.append('select', 'charge_id,amount,currency,status,product_id,stripe_created_at,customer_metadata,customer_id');

  if (dateFrom) params.append('stripe_created_at', `gte.${dateFrom}T00:00:00Z`);
  if (dateTo) params.append('stripe_created_at', `lte.${dateTo}T23:59:59Z`);
  params.append('limit', '500');

  const records = await supabase.queryWithSchema<any[]>(
    `stripe_conversions?${params.toString()}`,
    'stripe',
    { method: 'GET' }
  ) || [];

  return records
    .filter(record => matchUserToRecord(record.customer_metadata, userId, anonymousIds))
    .map(r => ({
      source: 'stripe' as const,
      transaction_id: r.charge_id,
      timestamp: r.stripe_created_at,
      amount: (r.amount || 0) / 100,
      currency: r.currency || 'usd',
      status: r.status,
      product_id: r.product_id || null,
      customer_id: r.customer_id || null,
      metadata: parseMetadata(r.customer_metadata)
    }));
}

async function queryShopifyConversions(
  supabase: SupabaseClient,
  connectionId: string,
  userId: string,
  anonymousIds: string[],
  dateFrom?: string,
  dateTo?: string
): Promise<ConnectorConversion[]> {
  const params = new URLSearchParams();
  params.append('connection_id', `eq.${connectionId}`);
  // Query checkouts - includes completed orders AND abandoned carts for journey analysis
  params.append('select', 'checkout_id,token,total_price,subtotal_price,currency,completed_at,created_at,updated_at,email,phone,landing_site,referring_site,source_name,note_attributes,line_items,abandoned_checkout_url,order_id');

  if (dateFrom) params.append('created_at', `gte.${dateFrom}T00:00:00Z`);
  if (dateTo) params.append('created_at', `lte.${dateTo}T23:59:59Z`);
  params.append('limit', '500');

  const records = await supabase.queryWithSchema<any[]>(
    `shopify_checkouts?${params.toString()}`,
    'shopify',
    { method: 'GET' }
  ) || [];

  return records
    .filter(record => {
      // Match by email or note_attributes containing anonymous_id
      if (record.email?.toLowerCase() === userId.toLowerCase()) return true;

      const noteAttrs = parseMetadata(record.note_attributes);
      const anonId = noteAttrs.anonymous_id || noteAttrs.clearlift_anonymous_id;
      return anonId && anonymousIds.includes(anonId);
    })
    .map(r => {
      // Determine status based on checkout state
      const isCompleted = !!r.completed_at || !!r.order_id;
      const status = isCompleted ? 'completed' : 'abandoned';

      // Extract product info from line_items if available
      const lineItems = parseMetadata(r.line_items);
      const productIds = Array.isArray(lineItems)
        ? lineItems.map((li: any) => li.product_id).filter(Boolean).join(',')
        : null;

      return {
        source: 'shopify' as const,
        transaction_id: r.checkout_id || r.token,
        timestamp: r.completed_at || r.updated_at || r.created_at,
        amount: parseFloat(r.total_price) || 0,
        currency: r.currency || 'usd',
        status,
        product_id: productIds,
        customer_id: r.email || null,
        metadata: {
          ...parseMetadata(r.note_attributes),
          landing_site: r.landing_site,
          referring_site: r.referring_site,
          source_name: r.source_name,
          subtotal: parseFloat(r.subtotal_price) || 0,
          order_id: r.order_id,
          is_abandoned: !isCompleted,
          abandoned_checkout_url: r.abandoned_checkout_url
        }
      };
    });
}

async function queryHubspotDeals(
  supabase: SupabaseClient,
  connectionId: string,
  userId: string,
  anonymousIds: string[],
  dateFrom?: string,
  dateTo?: string
): Promise<ConnectorConversion[]> {
  const params = new URLSearchParams();
  params.append('connection_id', `eq.${connectionId}`);
  params.append('dealstage', 'eq.closedwon');
  params.append('select', 'deal_id,amount,currency,dealstage,closedate,contact_email,properties');

  if (dateFrom) params.append('closedate', `gte.${dateFrom}T00:00:00Z`);
  if (dateTo) params.append('closedate', `lte.${dateTo}T23:59:59Z`);
  params.append('limit', '500');

  const records = await supabase.queryWithSchema<any[]>(
    `hubspot_deals?${params.toString()}`,
    'hubspot',
    { method: 'GET' }
  ) || [];

  return records
    .filter(record => {
      if (record.contact_email?.toLowerCase() === userId.toLowerCase()) return true;

      const props = parseMetadata(record.properties);
      const anonId = props.clearlift_anonymous_id;
      return anonId && anonymousIds.includes(anonId);
    })
    .map(r => ({
      source: 'hubspot' as const,
      transaction_id: r.deal_id,
      timestamp: r.closedate,
      amount: parseFloat(r.amount) || 0,
      currency: r.currency || 'usd',
      status: 'closed_won',
      product_id: null,
      customer_id: r.contact_email || null,
      metadata: parseMetadata(r.properties)
    }));
}

function matchUserToRecord(
  metadata: any,
  userId: string,
  anonymousIds: string[]
): boolean {
  if (!metadata) return false;

  try {
    const parsed = parseMetadata(metadata);

    // Match by email
    const email = parsed.email || parsed.customer_email;
    if (email && email.toLowerCase() === userId.toLowerCase()) return true;

    // Match by anonymous_id
    const anonId = parsed.anonymous_id || parsed.clearlift_anonymous_id;
    if (anonId && anonymousIds.includes(anonId)) return true;

    return false;
  } catch {
    return false;
  }
}

function parseMetadata(data: any): Record<string, any> {
  if (!data) return {};
  if (typeof data === 'object') return data;
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * GET /v1/analytics/users/:userId/journey
 *
 * Returns the complete user journey across all linked sessions.
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
    const session = c.get("session");
    const params = c.req.param();
    const query = c.req.query();

    const userId = decodeURIComponent(params.userId);
    const orgId = query.org_id;
    const dateFrom = query.date_from;
    const dateTo = query.date_to;
    const includeEvents = query.include_events !== 'false';

    const d1 = new D1Adapter(c.env.DB);

    // Verify org access
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);
    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    // Get org tag
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      return error(c, "NOT_FOUND", "Organization has no tracking configured", 404);
    }

    // Get all anonymous_ids linked to this user
    const anonymousIds = await d1.getAnonymousIdsByUserId(orgId, userId);

    // Get identity graph for metadata
    const identityGraph = await d1.getIdentityGraph(orgId, userId);
    const firstIdentified = identityGraph.length > 0
      ? identityGraph.reduce((min, ig) =>
          ig.identified_at < min ? ig.identified_at : min, identityGraph[0].identified_at)
      : null;

    // Estimate unique devices from different anonymous_ids
    const devices = anonymousIds.length;

    try {
      const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
      if (!supabaseKey) {
        return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
      }

      const supabase = new SupabaseClient({
        url: c.env.SUPABASE_URL,
        serviceKey: supabaseKey
      });

      // Build query for events
      const params = new URLSearchParams();
      params.append('org_tag', `eq.${tagMapping.short_tag}`);

      // Filter by user_id OR any linked anonymous_id
      if (anonymousIds.length > 0) {
        const userFilter = `user_id.eq.${userId}`;
        const anonFilters = anonymousIds.map(aid => `anonymous_id.eq.${aid}`).join(',');
        params.append('or', `(${userFilter},${anonFilters})`);
      } else {
        params.append('user_id', `eq.${userId}`);
      }

      if (dateFrom) {
        params.append('event_timestamp', `gte.${dateFrom}T00:00:00Z`);
      }
      if (dateTo) {
        params.append('event_timestamp', `lte.${dateTo}T23:59:59Z`);
      }

      params.append('order', 'event_timestamp.asc');
      params.append('limit', '5000');

      const events = await supabase.queryWithSchema<any[]>(
        `events?${params.toString()}`,
        'events',
        { method: 'GET' }
      ) || [];

      // Process events
      const sortedEvents = events.sort((a, b) =>
        new Date(a.event_timestamp).getTime() - new Date(b.event_timestamp).getTime()
      );

      // Extract journey data
      const sessions = new Set(sortedEvents.map(e => e.session_id).filter(Boolean));
      const pageviews = sortedEvents.filter(e => e.event_type === 'page_view').length;

      // Build path (unique sources in order)
      const seenSources = new Set<string>();
      const path: string[] = [];
      sortedEvents.forEach(e => {
        if (e.utm_source && !seenSources.has(e.utm_source)) {
          seenSources.add(e.utm_source);
          path.push(e.utm_medium ? `${e.utm_source}/${e.utm_medium}` : e.utm_source);
        }
      });

      // First and last touch
      const touchpointEvents = sortedEvents.filter(e => e.utm_source);
      const firstTouchEvent = touchpointEvents[0];
      const lastTouchEvent = touchpointEvents[touchpointEvents.length - 1];

      const firstTouch = firstTouchEvent ? {
        source: firstTouchEvent.utm_source,
        medium: firstTouchEvent.utm_medium || null,
        campaign: firstTouchEvent.utm_campaign || null,
        date: firstTouchEvent.event_timestamp.split('T')[0]
      } : null;

      const lastTouch = lastTouchEvent ? {
        source: lastTouchEvent.utm_source,
        medium: lastTouchEvent.utm_medium || null,
        campaign: lastTouchEvent.utm_campaign || null,
        date: lastTouchEvent.event_timestamp.split('T')[0]
      } : null;

      // Tag-based conversions
      const conversionEvents = sortedEvents.filter(e =>
        e.event_type === 'conversion' || e.event_type === 'purchase'
      );
      const tagConversions = conversionEvents.map(e => ({
        event_id: e.event_id,
        timestamp: e.event_timestamp,
        type: e.event_type,
        revenue: e.revenue || e.value || 0,
        session_id: e.session_id || null
      }));

      // Query conversions from all connected platforms (Stripe, Shopify, HubSpot, etc.)
      const connectorConversions = await queryConnectorConversions(
        supabase,
        c.env.DB,
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
      const totalTagRevenue = tagConversions.reduce((sum, c) => sum + c.revenue, 0);
      const totalConnectorRevenue = connectorConversions.reduce((sum, c) => sum + c.amount, 0);
      const totalConversions = tagConversions.length + connectorConversions.length;

      // Determine revenue source preference
      // Connector data (actual transactions) is more accurate than tag events
      const revenueSource: 'tag' | 'connectors' | 'combined' =
        connectorConversions.length > 0 && tagConversions.length > 0 ? 'combined' :
        connectorConversions.length > 0 ? 'connectors' : 'tag';

      // Summary calculations
      const firstSeen = sortedEvents.length > 0 ? sortedEvents[0].event_timestamp : null;
      const lastSeen = sortedEvents.length > 0 ? sortedEvents[sortedEvents.length - 1].event_timestamp : null;

      // Use connector revenue as source of truth if available (actual transactions)
      const lifetimeValue = totalConnectorRevenue > 0 ? totalConnectorRevenue : totalTagRevenue;

      // Days to first convert (use earliest conversion from either source)
      let daysToFirstConvert: number | null = null;
      const allConversionTimestamps = [
        ...tagConversions.map(c => c.timestamp),
        ...connectorConversions.map(c => c.timestamp)
      ].filter(Boolean).sort();

      if (firstSeen && allConversionTimestamps.length > 0) {
        const firstSeenDate = new Date(firstSeen);
        const firstConvertDate = new Date(allConversionTimestamps[0]);
        daysToFirstConvert = Math.round(
          (firstConvertDate.getTime() - firstSeenDate.getTime()) / (1000 * 60 * 60 * 24)
        );
      }

      // Days active (unique dates with events)
      const activeDates = new Set(
        sortedEvents.map(e => e.event_timestamp.split('T')[0])
      );
      const daysActive = activeDates.size;

      // Build event timeline if requested
      const eventTimeline = includeEvents ? sortedEvents.slice(0, 500).map(e => ({
        event_id: e.event_id,
        timestamp: e.event_timestamp,
        event_type: e.event_type,
        session_id: e.session_id || null,
        anonymous_id: e.anonymous_id || null,
        page_url: e.page_url || null,
        utm_source: e.utm_source || null,
        utm_medium: e.utm_medium || null,
        utm_campaign: e.utm_campaign || null
      })) : undefined;

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
          path,
          sessions: sessions.size,
          pageviews,
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
        events: eventTimeline,
        summary: {
          first_seen: firstSeen,
          last_seen: lastSeen,
          total_conversions: totalConversions,
          lifetime_value: Math.round(lifetimeValue * 100) / 100,
          days_to_first_convert: daysToFirstConvert,
          avg_session_duration: null // Would need session end times
        }
      });
    } catch (err: any) {
      console.error("User journey error:", err);
      return error(c, "INTERNAL_ERROR", "Failed to fetch user journey", 500);
    }
  }
}

/**
 * GET /v1/analytics/journeys/overview
 *
 * Aggregate journey metrics across all users.
 */
export class GetJourneysOverview extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get journey overview metrics",
    description: "Aggregate journey metrics: avg path length, time to convert, top paths",
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
                top_paths: z.array(z.object({
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
    const session = c.get("session");
    const query = c.req.query();

    const orgId = query.org_id;
    const dateFrom = query.date_from;
    const dateTo = query.date_to;

    const d1 = new D1Adapter(c.env.DB);

    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);
    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

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
          avg_sessions_to_convert: 0
        },
        top_paths: [],
        conversion_by_path_length: []
      });
    }

    try {
      const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
      if (!supabaseKey) {
        return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
      }

      const supabase = new SupabaseClient({
        url: c.env.SUPABASE_URL,
        serviceKey: supabaseKey
      });

      // Get identity mappings count
      const identityCount = await c.env.DB.prepare(`
        SELECT COUNT(DISTINCT user_id) as users, COUNT(DISTINCT anonymous_id) as anon_ids
        FROM identity_mappings WHERE organization_id = ?
      `).bind(orgId).first<{ users: number; anon_ids: number }>();

      // Query events
      const params = new URLSearchParams();
      params.append('org_tag', `eq.${tagMapping.short_tag}`);
      params.append('event_timestamp', `gte.${dateFrom}T00:00:00Z`);
      params.append('event_timestamp', `lte.${dateTo}T23:59:59Z`);
      params.append('limit', '10000');

      const events = await supabase.queryWithSchema<any[]>(
        `events?${params.toString()}`,
        'events',
        { method: 'GET' }
      ) || [];

      // Calculate metrics
      const uniqueUsers = new Set(events.map(e => e.user_id).filter(Boolean));
      const uniqueSessions = new Set(events.map(e => e.session_id).filter(Boolean));
      const identifiedSessions = events.filter(e => e.user_id);

      const identityMatchRate = uniqueSessions.size > 0
        ? (identifiedSessions.length / events.length) * 100
        : 0;

      // Group by user/session to calculate paths
      const userPaths = new Map<string, string[]>();
      events.forEach(e => {
        const key = e.user_id || e.anonymous_id || e.session_id;
        if (!key) return;

        if (!userPaths.has(key)) {
          userPaths.set(key, []);
        }
        if (e.utm_source) {
          const path = userPaths.get(key)!;
          const source = e.utm_medium ? `${e.utm_source}/${e.utm_medium}` : e.utm_source;
          if (path[path.length - 1] !== source) {
            path.push(source);
          }
        }
      });

      // Calculate path stats
      const pathLengths = Array.from(userPaths.values()).map(p => p.length);
      const avgPathLength = pathLengths.length > 0
        ? pathLengths.reduce((a, b) => a + b, 0) / pathLengths.length
        : 0;

      // Top converting paths
      const conversions = events.filter(e =>
        e.event_type === 'conversion' || e.event_type === 'purchase'
      );
      const pathConversions = new Map<string, { count: number; revenue: number }>();

      conversions.forEach(conv => {
        const key = conv.user_id || conv.anonymous_id;
        if (!key) return;

        const path = userPaths.get(key);
        if (!path || path.length === 0) return;

        const pathStr = path.join(' → ');
        if (!pathConversions.has(pathStr)) {
          pathConversions.set(pathStr, { count: 0, revenue: 0 });
        }
        const data = pathConversions.get(pathStr)!;
        data.count++;
        data.revenue += conv.revenue || conv.value || 0;
      });

      const topPaths = Array.from(pathConversions.entries())
        .map(([path, data]) => ({
          path,
          conversions: data.count,
          revenue: Math.round(data.revenue * 100) / 100
        }))
        .sort((a, b) => b.conversions - a.conversions)
        .slice(0, 10);

      // Conversion by path length
      const pathLengthConversions = new Map<number, { total: number; converted: number }>();
      userPaths.forEach((path, key) => {
        const len = path.length;
        if (!pathLengthConversions.has(len)) {
          pathLengthConversions.set(len, { total: 0, converted: 0 });
        }
        pathLengthConversions.get(len)!.total++;

        // Check if this user converted
        const converted = conversions.some(c =>
          (c.user_id || c.anonymous_id) === key
        );
        if (converted) {
          pathLengthConversions.get(len)!.converted++;
        }
      });

      const conversionByPathLength = Array.from(pathLengthConversions.entries())
        .map(([pathLength, data]) => ({
          path_length: pathLength,
          conversions: data.converted,
          conversion_rate: data.total > 0
            ? Math.round((data.converted / data.total) * 10000) / 100
            : 0
        }))
        .sort((a, b) => a.path_length - b.path_length)
        .slice(0, 10);

      return success(c, {
        metrics: {
          total_identified_users: identityCount?.users || uniqueUsers.size,
          total_anonymous_sessions: uniqueSessions.size,
          identity_match_rate: Math.round(identityMatchRate * 100) / 100,
          avg_path_length: Math.round(avgPathLength * 10) / 10,
          avg_days_to_convert: 0, // Would need per-user calculation
          avg_sessions_to_convert: 0 // Would need per-user calculation
        },
        top_paths: topPaths,
        conversion_by_path_length: conversionByPathLength
      });
    } catch (err: any) {
      console.error("Journey overview error:", err);
      return error(c, "INTERNAL_ERROR", "Failed to fetch journey overview", 500);
    }
  }
}
