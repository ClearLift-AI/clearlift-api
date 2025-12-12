/**
 * Attribution Analytics Endpoints
 *
 * Multi-touch attribution with identity stitching support.
 * Supports: first_touch, last_touch, linear, time_decay, position_based
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";
import { D1Adapter } from "../../../adapters/d1";
import { GoogleAdsSupabaseAdapter } from "../../../adapters/platforms/google-supabase";
import { FacebookSupabaseAdapter } from "../../../adapters/platforms/facebook-supabase";
import { TikTokAdsSupabaseAdapter } from "../../../adapters/platforms/tiktok-supabase";
import {
  AttributionModel,
  AttributionConfig,
  calculateAttribution,
  aggregateAttributionByChannel,
  buildConversionPaths
} from "../../../services/attribution-models";

const AttributionModelEnum = z.enum([
  'first_touch',
  'last_touch',
  'linear',
  'time_decay',
  'position_based'
]);

// Data quality levels for "best available data" approach
type DataQuality = 'verified' | 'estimated' | 'platform_reported';

// Warning codes for insufficient data scenarios
type DataWarning =
  | 'no_events'                    // No tracked events at all
  | 'no_tracked_conversions'       // Events exist but no conversion events
  | 'insufficient_events'          // Too few events for reliable attribution
  | 'using_platform_conversions'   // Using platform-reported conversions
  | 'no_conversion_source';        // No conversion source configured

interface DataQualityInfo {
  quality: DataQuality;
  warnings: DataWarning[];
  event_count: number;
  conversion_count: number;
  fallback_source?: 'ad_platforms' | 'connectors' | null;
}

/**
 * GET /v1/analytics/attribution
 *
 * Multi-touch attribution with identity stitching.
 */
export class GetAttribution extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get marketing attribution data",
    description: `
Analyze which marketing channels are driving conversions using multi-touch attribution.

**Attribution Models:**
- **first_touch**: 100% credit to first touchpoint
- **last_touch**: 100% credit to last touchpoint before conversion
- **linear**: Equal credit to all touchpoints
- **time_decay**: More credit to recent touchpoints (configurable half-life)
- **position_based**: 40% first, 40% last, 20% middle (U-shape)

**Identity Stitching:**
When enabled, links anonymous sessions to identified users for accurate cross-device attribution.
    `.trim(),
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
        model: AttributionModelEnum.optional().describe("Attribution model (default: from org settings or last_touch)"),
        attribution_window: z.coerce.number().min(1).max(180).optional().describe("Days to look back for touchpoints (default: from org settings or 30)"),
        time_decay_half_life: z.coerce.number().min(1).max(90).optional().describe("Half-life in days for time_decay model (default: from org settings or 7)"),
        use_identity_stitching: z.enum(['true', 'false']).optional().default('true').describe("Enable identity stitching for cross-device attribution")
      })
    },
    responses: {
      "200": {
        description: "Attribution data with per-channel breakdown",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                model: AttributionModelEnum,
                config: z.object({
                  attribution_window_days: z.number(),
                  time_decay_half_life_days: z.number(),
                  identity_stitching_enabled: z.boolean()
                }),
                // Data quality info for "best available data" approach
                data_quality: z.object({
                  quality: z.enum(['verified', 'estimated', 'platform_reported']),
                  warnings: z.array(z.string()),
                  event_count: z.number(),
                  conversion_count: z.number(),
                  fallback_source: z.string().nullable().optional()
                }),
                attributions: z.array(z.object({
                  utm_source: z.string(),
                  utm_medium: z.string().nullable(),
                  utm_campaign: z.string().nullable(),
                  touchpoints: z.number(),
                  conversions_in_path: z.number(),
                  attributed_conversions: z.number(),
                  attributed_revenue: z.number(),
                  avg_position_in_path: z.number()
                })),
                summary: z.object({
                  total_conversions: z.number(),
                  total_revenue: z.number(),
                  avg_path_length: z.number(),
                  avg_days_to_convert: z.number(),
                  identified_users: z.number(),
                  anonymous_sessions: z.number()
                })
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
    const useIdentityStitching = query.use_identity_stitching !== 'false';

    console.log(`[Attribution] Request: orgId=${orgId}, dateFrom=${dateFrom}, dateTo=${dateTo}, model=${query.model}`);

    // Get org settings for defaults
    const d1 = new D1Adapter(c.env.DB);
    const org = await d1.getOrganizationWithAttribution(orgId);
    if (!org) {
      return error(c, "NOT_FOUND", "Organization not found", 404);
    }

    // Build config from query params and org defaults
    const model = (query.model || org.default_attribution_model || 'last_touch') as AttributionModel;
    const attributionWindowDays = query.attribution_window
      ? parseInt(query.attribution_window)
      : org.attribution_window_days;
    const timeDecayHalfLifeDays = query.time_decay_half_life
      ? parseInt(query.time_decay_half_life)
      : org.time_decay_half_life_days;

    const config: AttributionConfig = {
      model,
      attribution_window_days: attributionWindowDays,
      time_decay_half_life_days: timeDecayHalfLifeDays
    };

    // Get org tag for querying events
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    console.log(`[Attribution] orgId=${orgId}, tagMapping=${tagMapping?.short_tag || 'NONE'}`);

    // Helper function to build platform fallback attributions
    // Uses platform-specific adapters with correct schema/table names
    const buildPlatformFallback = async (supabase: SupabaseClient, dateRange?: { start: string; end: string }): Promise<{
      attributions: any[];
      summary: { total_conversions: number; total_revenue: number };
    }> => {
      try {
        // Get active platform connections
        const connections = await c.env.DB.prepare(`
          SELECT DISTINCT platform FROM platform_connections
          WHERE organization_id = ? AND is_active = 1
        `).bind(orgId).all<{ platform: string }>();

        const platforms = connections.results?.map(r => r.platform) || [];
        console.log(`[Attribution Fallback] orgId=${orgId}, platforms=${JSON.stringify(platforms)}`);
        if (platforms.length === 0) {
          console.log(`[Attribution Fallback] No platforms connected`);
          return { attributions: [], summary: { total_conversions: 0, total_revenue: 0 } };
        }

        // Build date range for queries (default: last 30 days)
        const effectiveDateRange = dateRange || {
          start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          end: new Date().toISOString().split('T')[0]
        };

        // Fetch campaign data from each platform using correct adapters
        const allCampaigns: any[] = [];
        let totalConversions = 0;
        let totalRevenue = 0;

        for (const platform of platforms) {
          try {
            if (platform === 'google') {
              // Use GoogleAdsSupabaseAdapter with google_ads schema
              const adapter = new GoogleAdsSupabaseAdapter(supabase);
              const campaigns = await adapter.getCampaignsWithMetrics(orgId, effectiveDateRange);

              for (const campaign of campaigns) {
                const conversions = campaign.metrics.conversions || 0;
                const revenue = (campaign.metrics.conversion_value_cents || 0) / 100;

                allCampaigns.push({
                  utm_source: 'google',
                  utm_medium: 'cpc',
                  utm_campaign: campaign.campaign_name,
                  touchpoints: 0,
                  conversions_in_path: 0,
                  attributed_conversions: conversions,
                  attributed_revenue: revenue,
                  avg_position_in_path: 0
                });

                totalConversions += conversions;
                totalRevenue += revenue;
              }
            } else if (platform === 'facebook') {
              // Use FacebookSupabaseAdapter with facebook_ads schema
              const adapter = new FacebookSupabaseAdapter(supabase);
              const campaigns = await adapter.getCampaignsWithMetrics(orgId, effectiveDateRange);

              for (const campaign of campaigns) {
                const conversions = campaign.metrics.conversions || 0;
                const revenue = (campaign.metrics.conversion_value_cents || 0) / 100;

                allCampaigns.push({
                  utm_source: 'facebook',
                  utm_medium: 'paid',
                  utm_campaign: campaign.campaign_name,
                  touchpoints: 0,
                  conversions_in_path: 0,
                  attributed_conversions: conversions,
                  attributed_revenue: revenue,
                  avg_position_in_path: 0
                });

                totalConversions += conversions;
                totalRevenue += revenue;
              }
            } else if (platform === 'tiktok') {
              // Use TikTokAdsSupabaseAdapter with tiktok_ads schema
              const adapter = new TikTokAdsSupabaseAdapter(supabase);
              const campaigns = await adapter.getCampaigns(orgId);
              const metrics = await adapter.getCampaignDailyMetrics(orgId, effectiveDateRange);

              // Aggregate metrics by campaign
              const metricsByCampaign: Record<string, { conversions: number; revenue: number }> = {};
              for (const m of metrics) {
                const ref = (m as any).campaign_ref;
                if (!metricsByCampaign[ref]) {
                  metricsByCampaign[ref] = { conversions: 0, revenue: 0 };
                }
                metricsByCampaign[ref].conversions += m.conversions || 0;
                metricsByCampaign[ref].revenue += (m.conversion_value_cents || 0) / 100;
              }

              for (const campaign of campaigns) {
                const campaignMetrics = metricsByCampaign[campaign.id] || { conversions: 0, revenue: 0 };

                allCampaigns.push({
                  utm_source: 'tiktok',
                  utm_medium: 'paid',
                  utm_campaign: campaign.campaign_name,
                  touchpoints: 0,
                  conversions_in_path: 0,
                  attributed_conversions: campaignMetrics.conversions,
                  attributed_revenue: campaignMetrics.revenue,
                  avg_position_in_path: 0
                });

                totalConversions += campaignMetrics.conversions;
                totalRevenue += campaignMetrics.revenue;
              }
            }
          } catch (err) {
            console.warn(`Failed to fetch ${platform} campaigns for fallback:`, err);
          }
        }

        // Sort by attributed_conversions descending
        allCampaigns.sort((a, b) => b.attributed_conversions - a.attributed_conversions);

        console.log(`[Attribution Fallback] Returning ${allCampaigns.length} campaigns, ${totalConversions} conversions`);
        return {
          attributions: allCampaigns,
          summary: { total_conversions: totalConversions, total_revenue: totalRevenue }
        };
      } catch (err) {
        console.error('[Attribution Fallback] Error:', err);
        return { attributions: [], summary: { total_conversions: 0, total_revenue: 0 } };
      }
    };

    if (!tagMapping) {
      // No tag mapping = can't query events, fall back to platform data
      try {
        const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
        if (supabaseKey) {
          const supabase = new SupabaseClient({
            url: c.env.SUPABASE_URL,
            serviceKey: supabaseKey
          });
          const fallback = await buildPlatformFallback(supabase, { start: dateFrom, end: dateTo });

          return success(c, {
            model,
            config: {
              attribution_window_days: attributionWindowDays,
              time_decay_half_life_days: timeDecayHalfLifeDays,
              identity_stitching_enabled: useIdentityStitching
            },
            data_quality: {
              quality: 'platform_reported' as DataQuality,
              warnings: ['no_events', 'using_platform_conversions'] as DataWarning[],
              event_count: 0,
              conversion_count: 0,
              fallback_source: 'ad_platforms'
            },
            attributions: fallback.attributions,
            summary: {
              total_conversions: fallback.summary.total_conversions,
              total_revenue: fallback.summary.total_revenue,
              avg_path_length: 0,
              avg_days_to_convert: 0,
              identified_users: 0,
              anonymous_sessions: 0
            }
          });
        }
      } catch (err) {
        console.warn('Failed to fetch platform fallback:', err);
      }

      return success(c, {
        model,
        config: {
          attribution_window_days: attributionWindowDays,
          time_decay_half_life_days: timeDecayHalfLifeDays,
          identity_stitching_enabled: useIdentityStitching
        },
        data_quality: {
          quality: 'platform_reported' as DataQuality,
          warnings: ['no_events', 'no_conversion_source'] as DataWarning[],
          event_count: 0,
          conversion_count: 0,
          fallback_source: null
        },
        attributions: [],
        summary: {
          total_conversions: 0,
          total_revenue: 0,
          avg_path_length: 0,
          avg_days_to_convert: 0,
          identified_users: 0,
          anonymous_sessions: 0
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

      // Build identity map if stitching is enabled
      const identityMap = new Map<string, string[]>();
      if (useIdentityStitching) {
        const identities = await c.env.DB.prepare(`
          SELECT user_id, anonymous_id FROM identity_mappings
          WHERE organization_id = ?
        `).bind(orgId).all<{ user_id: string; anonymous_id: string }>();

        // Group anonymous_ids by user_id
        (identities.results || []).forEach(row => {
          if (!identityMap.has(row.user_id)) {
            identityMap.set(row.user_id, []);
          }
          identityMap.get(row.user_id)!.push(row.anonymous_id);
        });
      }

      // Query events from Supabase
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

      const eventCount = events.length;
      console.log(`[Attribution] Events query returned ${eventCount} events`);

      // Check for no events scenario - fall back to platform data
      if (eventCount === 0) {
        console.log(`[Attribution] No events found, calling buildPlatformFallback`);
        const fallback = await buildPlatformFallback(supabase, { start: dateFrom, end: dateTo });
        return success(c, {
          model,
          config: {
            attribution_window_days: attributionWindowDays,
            time_decay_half_life_days: timeDecayHalfLifeDays,
            identity_stitching_enabled: useIdentityStitching
          },
          data_quality: {
            quality: 'platform_reported' as DataQuality,
            warnings: ['no_events', 'using_platform_conversions'] as DataWarning[],
            event_count: 0,
            conversion_count: 0,
            fallback_source: 'ad_platforms'
          },
          attributions: fallback.attributions,
          summary: {
            total_conversions: fallback.summary.total_conversions,
            total_revenue: fallback.summary.total_revenue,
            avg_path_length: 0,
            avg_days_to_convert: 0,
            identified_users: 0,
            anonymous_sessions: 0
          }
        });
      }

      // Build conversion paths with identity stitching
      // Note: nonConversionPaths reserved for future data-driven attribution
      const { conversionPaths } = buildConversionPaths(
        events,
        identityMap,
        attributionWindowDays
      );

      const conversionCount = conversionPaths.length;

      // Check for no conversions scenario - events exist but no conversion events tracked
      if (conversionCount === 0) {
        const fallback = await buildPlatformFallback(supabase, { start: dateFrom, end: dateTo });
        return success(c, {
          model,
          config: {
            attribution_window_days: attributionWindowDays,
            time_decay_half_life_days: timeDecayHalfLifeDays,
            identity_stitching_enabled: useIdentityStitching
          },
          data_quality: {
            quality: 'estimated' as DataQuality,
            warnings: ['no_tracked_conversions', 'using_platform_conversions'] as DataWarning[],
            event_count: eventCount,
            conversion_count: 0,
            fallback_source: 'ad_platforms'
          },
          attributions: fallback.attributions,
          summary: {
            total_conversions: fallback.summary.total_conversions,
            total_revenue: fallback.summary.total_revenue,
            avg_path_length: 0,
            avg_days_to_convert: 0,
            identified_users: 0,
            anonymous_sessions: eventCount // Use event count as proxy for sessions
          }
        });
      }

      // Determine data quality based on event/conversion counts
      let dataQuality: DataQualityInfo = {
        quality: 'verified',
        warnings: [],
        event_count: eventCount,
        conversion_count: conversionCount,
        fallback_source: null
      };

      // Check for insufficient events (less than 10 is unreliable)
      if (eventCount < 10) {
        dataQuality.warnings.push('insufficient_events');
      }

      // Calculate attribution for each conversion path
      const attributionResults = conversionPaths.map(path =>
        calculateAttribution(path, config)
      );

      // Aggregate by channel
      const attributions = aggregateAttributionByChannel(attributionResults);

      // Calculate summary stats
      const totalConversions = conversionPaths.length;
      const totalRevenue = conversionPaths.reduce((sum, p) => sum + p.conversion_value, 0);
      const avgPathLength = totalConversions > 0
        ? attributionResults.reduce((sum, r) => sum + r.path_length, 0) / totalConversions
        : 0;
      const avgDaysToConvert = totalConversions > 0
        ? attributionResults.reduce((sum, r) => sum + r.days_to_convert, 0) / totalConversions
        : 0;

      // Count identified vs anonymous
      const identifiedUsers = new Set(
        conversionPaths.filter(p => p.user_id && identityMap.has(p.user_id)).map(p => p.user_id)
      ).size;
      const anonymousSessions = conversionPaths.filter(p => !p.user_id || !identityMap.has(p.user_id!)).length;

      return success(c, {
        model,
        config: {
          attribution_window_days: attributionWindowDays,
          time_decay_half_life_days: timeDecayHalfLifeDays,
          identity_stitching_enabled: useIdentityStitching
        },
        data_quality: dataQuality,
        attributions,
        summary: {
          total_conversions: totalConversions,
          total_revenue: totalRevenue,
          avg_path_length: Math.round(avgPathLength * 10) / 10,
          avg_days_to_convert: Math.round(avgDaysToConvert * 10) / 10,
          identified_users: identifiedUsers,
          anonymous_sessions: anonymousSessions
        }
      });
    } catch (err: any) {
      console.error("[Attribution] Query error in main try block:", err.message || err);

      // Try platform fallback on error (e.g., events table doesn't exist)
      console.log("[Attribution] Attempting platform fallback from catch block...");
      try {
        const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
        if (supabaseKey) {
          const supabase = new SupabaseClient({
            url: c.env.SUPABASE_URL,
            serviceKey: supabaseKey
          });
          const fallback = await buildPlatformFallback(supabase, { start: dateFrom, end: dateTo });

          return success(c, {
            model,
            config: {
              attribution_window_days: attributionWindowDays,
              time_decay_half_life_days: timeDecayHalfLifeDays,
              identity_stitching_enabled: useIdentityStitching
            },
            data_quality: {
              quality: 'platform_reported' as DataQuality,
              warnings: ['no_events', 'using_platform_conversions'] as DataWarning[],
              event_count: 0,
              conversion_count: 0,
              fallback_source: 'ad_platforms'
            },
            attributions: fallback.attributions,
            summary: {
              total_conversions: fallback.summary.total_conversions,
              total_revenue: fallback.summary.total_revenue,
              avg_path_length: 0,
              avg_days_to_convert: 0,
              identified_users: 0,
              anonymous_sessions: 0
            }
          });
        }
      } catch (fallbackErr) {
        console.warn('Platform fallback also failed:', fallbackErr);
      }

      // Return empty data only if fallback also fails
      return success(c, {
        model,
        config: {
          attribution_window_days: attributionWindowDays,
          time_decay_half_life_days: timeDecayHalfLifeDays,
          identity_stitching_enabled: useIdentityStitching
        },
        data_quality: {
          quality: 'platform_reported' as DataQuality,
          warnings: ['no_events'] as DataWarning[],
          event_count: 0,
          conversion_count: 0,
          fallback_source: null
        },
        attributions: [],
        summary: {
          total_conversions: 0,
          total_revenue: 0,
          avg_path_length: 0,
          avg_days_to_convert: 0,
          identified_users: 0,
          anonymous_sessions: 0
        }
      });
    }
  }
}

/**
 * GET /v1/analytics/attribution/compare
 *
 * Compare attribution across multiple models side-by-side.
 */
export class GetAttributionComparison extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Compare attribution models",
    description: "Run multiple attribution models and compare results side-by-side",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
        models: z.string().optional().describe("Comma-separated models to compare (default: all)")
      })
    },
    responses: {
      "200": {
        description: "Comparison of attribution models",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                models: z.array(z.object({
                  model: AttributionModelEnum,
                  attributions: z.array(z.object({
                    utm_source: z.string(),
                    attributed_conversions: z.number(),
                    attributed_revenue: z.number()
                  }))
                })),
                summary: z.object({
                  total_conversions: z.number(),
                  total_revenue: z.number()
                })
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

    const modelsParam = query.models || 'first_touch,last_touch,linear,time_decay,position_based';
    const models = modelsParam.split(',').map(m => m.trim()) as AttributionModel[];

    const d1 = new D1Adapter(c.env.DB);
    const org = await d1.getOrganizationWithAttribution(orgId);
    if (!org) {
      return error(c, "NOT_FOUND", "Organization not found", 404);
    }

    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      return success(c, {
        models: models.map(model => ({ model, attributions: [] })),
        summary: { total_conversions: 0, total_revenue: 0 }
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

      // Get identity map
      const identities = await c.env.DB.prepare(`
        SELECT user_id, anonymous_id FROM identity_mappings WHERE organization_id = ?
      `).bind(orgId).all<{ user_id: string; anonymous_id: string }>();

      const identityMap = new Map<string, string[]>();
      (identities.results || []).forEach(row => {
        if (!identityMap.has(row.user_id)) {
          identityMap.set(row.user_id, []);
        }
        identityMap.get(row.user_id)!.push(row.anonymous_id);
      });

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

      const { conversionPaths } = buildConversionPaths(
        events,
        identityMap,
        org.attribution_window_days
      );

      // Calculate attribution for each model
      const modelResults = models.map(model => {
        const config: AttributionConfig = {
          model,
          attribution_window_days: org.attribution_window_days,
          time_decay_half_life_days: org.time_decay_half_life_days
        };

        const attributionResults = conversionPaths.map(path =>
          calculateAttribution(path, config)
        );

        const attributions = aggregateAttributionByChannel(attributionResults)
          .slice(0, 10) // Top 10 channels
          .map(a => ({
            utm_source: a.utm_source,
            attributed_conversions: Math.round(a.attributed_conversions * 100) / 100,
            attributed_revenue: Math.round(a.attributed_revenue * 100) / 100
          }));

        return { model, attributions };
      });

      const totalConversions = conversionPaths.length;
      const totalRevenue = conversionPaths.reduce((sum, p) => sum + p.conversion_value, 0);

      return success(c, {
        models: modelResults,
        summary: {
          total_conversions: totalConversions,
          total_revenue: Math.round(totalRevenue * 100) / 100
        }
      });
    } catch (err: any) {
      console.error("Attribution comparison error:", err);
      return success(c, {
        models: models.map(model => ({ model, attributions: [] })),
        summary: { total_conversions: 0, total_revenue: 0 }
      });
    }
  }
}
