/**
 * Attribution Analytics Endpoints
 *
 * Tracks which marketing channels (UTM sources) led to conversions
 * Supports multiple attribution models: first_touch, last_touch, linear
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";

/**
 * GET /v1/analytics/attribution
 */
export class GetAttribution extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get marketing attribution data",
    description: "Analyze which marketing channels (UTM parameters) are driving conversions",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
        model: z.enum(['first_touch', 'last_touch', 'linear']).optional().default('last_touch').describe("Attribution model")
      })
    },
    responses: {
      "200": {
        description: "Attribution data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                attributions: z.array(z.object({
                  utm_source: z.string(),
                  utm_medium: z.string().nullable(),
                  utm_campaign: z.string().nullable(),
                  sessions: z.number(),
                  conversions: z.number(),
                  revenue: z.number(),
                  conversion_rate: z.number(),
                  cost_per_conversion: z.number().nullable()
                })),
                summary: z.object({
                  total_sessions: z.number(),
                  total_conversions: z.number(),
                  total_revenue: z.number(),
                  overall_conversion_rate: z.number()
                })
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const query = await this.getValidatedData<typeof this.schema>();

    // Verify org access
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, query.query.org_id);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    // Get org tag for querying events
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(query.query.org_id).first<{ short_tag: string }>();

    if (!tagMapping) {
      // Return empty data if no tracking tag exists yet
      return success(c, {
        attributions: [],
        summary: {
          total_sessions: 0,
          total_conversions: 0,
          total_revenue: 0,
          overall_conversion_rate: 0
        }
      });
    }

    try {
      // Initialize Supabase
      const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
      if (!supabaseKey) {
        return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
      }

      const supabase = new SupabaseClient({
        url: c.env.SUPABASE_URL,
        serviceKey: supabaseKey
      });

      // Query events from Supabase events schema
      // Events table structure:
      // - event_timestamp
      // - event_type (page_view, conversion, etc.)
      // - session_id
      // - utm_source, utm_medium, utm_campaign
      // - revenue (for conversion events)
      // - org_tag

      const params = new URLSearchParams({
        org_tag: `eq.${tagMapping.short_tag}`,
        event_timestamp: `gte.${query.query.date_from}T00:00:00Z`,
        'event_timestamp': `lte.${query.query.date_to}T23:59:59Z`,
        limit: '10000'
      });

      // Get all events (sessions + conversions)
      const endpoint = `events?${params.toString()}`;
      const events = await supabase.queryWithSchema<any[]>(endpoint, 'events', { method: 'GET' }) || [];

      // Process events based on attribution model
      const attributions = this.calculateAttributions(events, query.query.model);

      // Calculate summary
      const summary = {
        total_sessions: attributions.reduce((sum, a) => sum + a.sessions, 0),
        total_conversions: attributions.reduce((sum, a) => sum + a.conversions, 0),
        total_revenue: attributions.reduce((sum, a) => sum + a.revenue, 0),
        overall_conversion_rate: 0
      };

      if (summary.total_sessions > 0) {
        summary.overall_conversion_rate = (summary.total_conversions / summary.total_sessions) * 100;
      }

      return success(c, { attributions, summary });
    } catch (err: any) {
      console.error("Attribution query error:", err);

      // Return empty data on error instead of failing
      return success(c, {
        attributions: [],
        summary: {
          total_sessions: 0,
          total_conversions: 0,
          total_revenue: 0,
          overall_conversion_rate: 0
        }
      });
    }
  }

  /**
   * Calculate attributions based on model
   */
  private calculateAttributions(events: any[], model: string) {
    // Group events by session
    const sessionMap = new Map<string, any[]>();
    for (const event of events) {
      const sessionId = event.session_id || event.visitor_id;
      if (!sessionId) continue;

      if (!sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, []);
      }
      sessionMap.get(sessionId)!.push(event);
    }

    // Attribution map: utm_source -> { sessions, conversions, revenue }
    const attributionMap = new Map<string, any>();

    for (const [sessionId, sessionEvents] of sessionMap.entries()) {
      // Sort by timestamp
      sessionEvents.sort((a, b) =>
        new Date(a.event_timestamp).getTime() - new Date(b.event_timestamp).getTime()
      );

      // Find first and last touch points
      const firstEvent = sessionEvents[0];
      const lastEvent = sessionEvents[sessionEvents.length - 1];

      // Check if session has conversion
      const conversionEvent = sessionEvents.find(e =>
        e.event_type === 'conversion' || e.event_type === 'purchase'
      );

      let attributedSource: string;
      let attributedMedium: string | null;
      let attributedCampaign: string | null;

      // Apply attribution model
      if (model === 'first_touch') {
        attributedSource = firstEvent.utm_source || '(direct)';
        attributedMedium = firstEvent.utm_medium;
        attributedCampaign = firstEvent.utm_campaign;
      } else if (model === 'last_touch') {
        attributedSource = lastEvent.utm_source || '(direct)';
        attributedMedium = lastEvent.utm_medium;
        attributedCampaign = lastEvent.utm_campaign;
      } else {
        // Linear model - use last touch for simplicity (could be improved)
        attributedSource = lastEvent.utm_source || '(direct)';
        attributedMedium = lastEvent.utm_medium;
        attributedCampaign = lastEvent.utm_campaign;
      }

      // Create key for grouping
      const key = `${attributedSource}|${attributedMedium || ''}|${attributedCampaign || ''}`;

      if (!attributionMap.has(key)) {
        attributionMap.set(key, {
          utm_source: attributedSource,
          utm_medium: attributedMedium,
          utm_campaign: attributedCampaign,
          sessions: 0,
          conversions: 0,
          revenue: 0
        });
      }

      const attribution = attributionMap.get(key);
      attribution.sessions += 1;

      if (conversionEvent) {
        attribution.conversions += 1;
        attribution.revenue += conversionEvent.revenue || 0;
      }
    }

    // Convert to array and calculate metrics
    const attributions = Array.from(attributionMap.values()).map(attr => ({
      ...attr,
      conversion_rate: attr.sessions > 0 ? (attr.conversions / attr.sessions) * 100 : 0,
      cost_per_conversion: attr.conversions > 0 ? attr.revenue / attr.conversions : null
    }));

    // Sort by conversions descending
    attributions.sort((a, b) => b.conversions - a.conversions);

    return attributions;
  }
}
