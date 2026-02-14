/**
 * Flow Metrics Endpoint
 *
 * Provides stage-by-stage funnel metrics for the Acquisition Flow Builder.
 * Calculates visitors, dropoff rates, and time-to-next for each stage.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { SmartAttributionService, type SignalType } from "../../../services/smart-attribution";
import { StageMarkovService } from "../../../services/stage-markov";
import { getShardDbForOrg } from "../../../services/shard-router";
import { structuredLog } from '../../../utils/structured-logger';

// Enhanced channel attribution with confidence
interface EnhancedChannelAttribution {
  visitors: number;
  conversions: number;
  confidence: number;
  signal_type: SignalType;
  explanation: string;
  is_estimated: boolean;
  estimation_reason: string | null;
}

// Stage metrics interface
interface StageMetrics {
  id: string;
  name: string;
  type: string;
  connector: string | null;
  connector_event_type: string | null;
  position_row: number;
  position_col: number;
  is_conversion: boolean;
  is_traffic_source: boolean; // True for ad platforms (google_ads, facebook_ads, tiktok_ads)
  visitors: number;
  conversions: number;
  dropoff_rate: number;
  avg_time_to_next_hours: number | null;
  conversion_value_cents: number;
  by_channel?: Record<string, number>; // Channel attribution breakdown
  by_channel_enhanced?: Record<string, EnhancedChannelAttribution>; // Enhanced with confidence
  removal_effect?: number; // Stage removal effect (Markov)
  is_critical?: boolean; // True if removal_effect > 0.3
}

/**
 * GET /v1/analytics/flow/metrics
 * Get stage-by-stage funnel metrics
 */
export class GetFlowMetrics extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get flow metrics",
    description: `
Returns stage-by-stage metrics for the acquisition flow:
- Visitors at each stage
- Dropoff rate between stages
- Average time to progress to next stage
- Conversion value at each conversion point
- Overall funnel conversion rate
- Bottleneck stage identification
    `.trim(),
    operationId: "get-flow-metrics",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        days: z.coerce.number().int().min(1).max(365).default(30).describe("Number of days to analyze"),
        attribution_model: z.enum(["smart", "linear", "first_touch", "last_touch"]).default("smart").describe("Attribution model to use"),
        include_model_comparison: z.coerce.boolean().default(false).describe("Include comparison across attribution models"),
        include_removal_effects: z.coerce.boolean().default(true).describe("Include stage removal effects (Markov analysis)"),
      }),
    },
    responses: {
      "200": {
        description: "Flow metrics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                stages: z.array(z.object({
                  id: z.string(),
                  name: z.string(),
                  type: z.string(),
                  connector: z.string().nullable(),
                  connector_event_type: z.string().nullable(),
                  position_row: z.number(),
                  position_col: z.number(),
                  is_conversion: z.boolean(),
                  is_traffic_source: z.boolean(),
                  visitors: z.number(),
                  conversions: z.number(),
                  dropoff_rate: z.number(),
                  avg_time_to_next_hours: z.number().nullable(),
                  conversion_value_cents: z.number(),
                  by_channel: z.record(z.string(), z.number()).optional(),
                  by_channel_enhanced: z.record(z.string(), z.object({
                    visitors: z.number(),
                    conversions: z.number(),
                    confidence: z.number(),
                    signal_type: z.string(),
                    explanation: z.string(),
                    is_estimated: z.boolean(),
                    estimation_reason: z.string().nullable(),
                  })).optional(),
                  removal_effect: z.number().optional(),
                  is_critical: z.boolean().optional(),
                })),
                summary: z.object({
                  total_stages: z.number(),
                  conversion_stages: z.number(),
                  overall_conversion_rate: z.number(),
                  total_revenue_cents: z.number(),
                  bottleneck_stage_id: z.string().nullable(),
                  bottleneck_dropoff_rate: z.number(),
                }),
                flow_structure: z.object({
                  mode: z.enum(["simple", "advanced"]),
                  has_branching: z.boolean(),
                  entry_points: z.number(),
                }),
                traffic_sources: z.object({
                  direct_visitors: z.number(),
                  utm_visitors: z.number(),
                  total_visitors: z.number(),
                }).optional(),
                attribution_summary: z.object({
                  model_used: z.string(),
                  avg_confidence: z.number(),
                  data_completeness: z.number(),
                }).optional(),
                data_quality: z.object({
                  recommendations: z.array(z.string()),
                  has_smart_attribution: z.boolean(),
                  critical_stages_count: z.number(),
                }).optional(),
              }),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const days = parseInt(c.req.query("days") || "30", 10);
    const attributionModel = c.req.query("attribution_model") || "smart";
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _includeModelComparison = c.req.query("include_model_comparison") === "true"; // Reserved for v2
    const includeRemovalEffects = c.req.query("include_removal_effects") !== "false";

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    try {
      // 1. Get organization settings (flow mode)
      const org = await c.env.DB.prepare(`
        SELECT flow_mode FROM organizations WHERE id = ?
      `).bind(orgId).first() as { flow_mode: string | null } | null;

      const flowMode = (org?.flow_mode || "simple") as "simple" | "advanced";

      // 2. Get all goals/stages with their positions
      const goalsResult = await c.env.DB.prepare(`
        SELECT
          id, name, type, connector, connector_event_type,
          COALESCE(position_row, priority, 0) as position_row,
          COALESCE(position_col, 0) as position_col,
          is_conversion, default_value_cents, fixed_value_cents,
          value_type, trigger_config
        FROM conversion_goals
        WHERE organization_id = ? AND is_active = 1
        ORDER BY position_row ASC, position_col ASC, created_at ASC
      `).bind(orgId).all() as D1Result<{
        id: string;
        name: string;
        type: string;
        connector: string | null;
        connector_event_type: string | null;
        position_row: number;
        position_col: number;
        is_conversion: number | null;
        default_value_cents: number;
        fixed_value_cents: number | null;
        value_type: string | null;
        trigger_config: string | null;
      }>;

      const goals = goalsResult.results || [];

      if (goals.length === 0) {
        return success(c, {
          stages: [],
          summary: {
            total_stages: 0,
            conversion_stages: 0,
            overall_conversion_rate: 0,
            total_revenue_cents: 0,
            bottleneck_stage_id: null,
            bottleneck_dropoff_rate: 0,
          },
          flow_structure: {
            mode: flowMode,
            has_branching: false,
            entry_points: 0,
          },
        });
      }

      // 3. Get relationships to detect branching
      const relationshipsResult = await c.env.DB.prepare(`
        SELECT upstream_goal_id, downstream_goal_id, funnel_position
        FROM goal_relationships
        WHERE organization_id = ?
      `).bind(orgId).all() as D1Result<{
        upstream_goal_id: string;
        downstream_goal_id: string;
        funnel_position: number | null;
      }>;

      const relationships = relationshipsResult.results || [];

      // Detect branching (any goal with multiple children or multiple parents)
      const childrenCount = new Map<string, number>();
      const parentsCount = new Map<string, number>();
      const goalIds = new Set(goals.map(g => g.id));

      for (const rel of relationships) {
        childrenCount.set(rel.upstream_goal_id, (childrenCount.get(rel.upstream_goal_id) || 0) + 1);
        parentsCount.set(rel.downstream_goal_id, (parentsCount.get(rel.downstream_goal_id) || 0) + 1);
      }

      const hasBranching = Array.from(childrenCount.values()).some(c => c > 1) ||
                          Array.from(parentsCount.values()).some(c => c > 1);

      // Entry points = goals with no parents
      const goalsWithParents = new Set(relationships.map(r => r.downstream_goal_id));
      const entryPoints = goals.filter(g => !goalsWithParents.has(g.id)).length;

      // 4. Get org tag for querying analytics
      const tagMapping = await c.env.DB.prepare(`
        SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
      `).bind(orgId).first() as { short_tag: string } | null;

      const orgTag = tagMapping?.short_tag;

      // Calculate date range
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startDateStr = startDate.toISOString().split("T")[0];
      const endDateStr = endDate.toISOString().split("T")[0];

      // 5. Query stage metrics based on connector type
      const analyticsDb = c.env.ANALYTICS_DB;
      const shardDb = await getShardDbForOrg(c.env, orgId);

      // Get channel distribution for session-level attribution
      let channelDistribution: Record<string, number> = {};
      let totalChannelEvents = 0;

      if (orgTag) {
        try {
          const channelResult = await analyticsDb.prepare(`
            SELECT by_channel FROM daily_metrics
            WHERE org_tag = ? AND date >= ? AND date <= ?
          `).bind(orgTag, startDateStr, endDateStr).all() as D1Result<{ by_channel: string | null }>;

          for (const row of channelResult.results || []) {
            if (row.by_channel) {
              try {
                const channels = JSON.parse(row.by_channel) as Record<string, number>;
                for (const [channel, count] of Object.entries(channels)) {
                  channelDistribution[channel] = (channelDistribution[channel] || 0) + count;
                  totalChannelEvents += count;
                }
              } catch (e) {}
            }
          }
        } catch (err) {
          structuredLog('WARN', 'Failed to get channel distribution', { endpoint: 'analytics/flow-metrics', error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Build stage metrics - query each connector's data source
      const stageMetrics: StageMetrics[] = [];
      let totalRevenueCents = 0;
      let smartAttributionData: Awaited<ReturnType<SmartAttributionService['getSmartAttribution']>> | null = null;

      for (const goal of goals) {
        const isConversion = Boolean(goal.is_conversion) || goal.type === "conversion";
        const valueCents = goal.fixed_value_cents || goal.default_value_cents || 0;
        const connector = goal.connector || "clearlift_tag";

        let visitors = 0;
        let conversions = 0;
        let conversionValueCents = 0;
        let byChannel: Record<string, number> | undefined;

        try {
          // Query based on connector type (using unified ad_metrics table)
          if (connector === "google_ads") {
            // Google Ads clicks from unified ad_metrics (shard table)
            const result = await shardDb.prepare(`
              SELECT COALESCE(SUM(m.clicks), 0) as clicks
              FROM ad_metrics m
              WHERE m.organization_id = ?
                AND m.platform = 'google'
                AND m.entity_type = 'campaign'
                AND m.metric_date >= ?
                AND m.metric_date <= ?
            `).bind(orgId, startDateStr, endDateStr).first() as { clicks: number } | null;
            visitors = result?.clicks || 0;
            conversions = visitors; // For traffic stages, visitors = conversions
          } else if (connector === "facebook_ads") {
            // Facebook Ads clicks from unified ad_metrics (shard table)
            const result = await shardDb.prepare(`
              SELECT COALESCE(SUM(m.clicks), 0) as clicks
              FROM ad_metrics m
              WHERE m.organization_id = ?
                AND m.platform = 'facebook'
                AND m.entity_type = 'campaign'
                AND m.metric_date >= ?
                AND m.metric_date <= ?
            `).bind(orgId, startDateStr, endDateStr).first() as { clicks: number } | null;
            visitors = result?.clicks || 0;
            conversions = visitors;
          } else if (connector === "tiktok_ads") {
            // TikTok Ads clicks from unified ad_metrics (shard table)
            const result = await shardDb.prepare(`
              SELECT COALESCE(SUM(m.clicks), 0) as clicks
              FROM ad_metrics m
              WHERE m.organization_id = ?
                AND m.platform = 'tiktok'
                AND m.entity_type = 'campaign'
                AND m.metric_date >= ?
                AND m.metric_date <= ?
            `).bind(orgId, startDateStr, endDateStr).first() as { clicks: number } | null;
            visitors = result?.clicks || 0;
            conversions = visitors;
          } else if (connector === "stripe") {
            // Stripe conversions (new subscriptions only)
            const result = await analyticsDb.prepare(`
              SELECT
                COUNT(*) as conversions,
                COALESCE(SUM(amount_cents), 0) as revenue_cents
              FROM stripe_charges
              WHERE organization_id = ?
                AND DATE(stripe_created_at) >= ?
                AND DATE(stripe_created_at) <= ?
                AND (
                  billing_reason = 'subscription_create'
                  OR (billing_reason IS NULL AND status = 'succeeded')
                )
            `).bind(orgId, startDateStr, endDateStr).first() as { conversions: number; revenue_cents: number } | null;
            conversions = result?.conversions || 0;
            visitors = conversions;
            conversionValueCents = result?.revenue_cents || 0;
          } else if (connector === "shopify") {
            // Shopify orders
            const result = await analyticsDb.prepare(`
              SELECT
                COUNT(*) as conversions,
                COALESCE(SUM(total_price_cents), 0) as revenue_cents
              FROM shopify_orders
              WHERE organization_id = ?
                AND DATE(created_at) >= ?
                AND DATE(created_at) <= ?
            `).bind(orgId, startDateStr, endDateStr).first() as { conversions: number; revenue_cents: number } | null;
            conversions = result?.conversions || 0;
            visitors = conversions;
            conversionValueCents = result?.revenue_cents || 0;
          } else if (connector === "clearlift_tag" && orgTag) {
            // Tag events - query session-linked metrics from goal_completion_metrics
            // This gives us unique_visitors (session count) instead of disconnected page views
            const goalMetrics = await analyticsDb.prepare(`
              SELECT
                COALESCE(SUM(unique_visitors), 0) as unique_visitors,
                COALESCE(SUM(completions), 0) as completions,
                COALESCE(SUM(downstream_conversions), 0) as downstream_conversions,
                by_channel
              FROM goal_completion_metrics
              WHERE org_tag = ?
                AND goal_id = ?
                AND date >= ?
                AND date <= ?
            `).bind(orgTag, goal.id, startDateStr, endDateStr).first() as {
              unique_visitors: number;
              completions: number;
              downstream_conversions: number;
              by_channel: string | null;
            } | null;

            if (goalMetrics && goalMetrics.unique_visitors > 0) {
              // Use session-linked unique_visitors count
              visitors = goalMetrics.unique_visitors;
              conversions = goalMetrics.completions;

              // Parse by_channel if available for this goal
              if (goalMetrics.by_channel) {
                try {
                  const channels = JSON.parse(goalMetrics.by_channel) as Record<string, number>;
                  if (Object.keys(channels).length > 0) {
                    byChannel = channels;
                  }
                } catch (e) {
                  // Skip invalid JSON
                }
              }
            } else {
              // Fallback to page view counts if goal_completion_metrics not populated yet
              // This handles cases where aggregation hasn't run for new goals
              const triggerConfig = goal.trigger_config ? JSON.parse(goal.trigger_config) : {};
              const pagePattern = triggerConfig.page_pattern || "";

              if (pagePattern) {
                // Query page views from hourly_metrics.by_page JSON column
                const result = await analyticsDb.prepare(`
                  SELECT by_page FROM hourly_metrics
                  WHERE org_tag = ?
                    AND DATE(hour) >= ?
                    AND DATE(hour) <= ?
                    AND by_page IS NOT NULL
                `).bind(orgTag, startDateStr, endDateStr).all();

                // Aggregate page views matching the pattern
                let totalViews = 0;
                for (const row of (result.results || []) as { by_page: string }[]) {
                  try {
                    const pages = JSON.parse(row.by_page || '{}');
                    for (const [page, data] of Object.entries(pages as Record<string, any>)) {
                      if (page.includes(pagePattern)) {
                        if (typeof data === 'number') {
                          totalViews += data;
                        } else {
                          totalViews += data.events || data.count || 0;
                        }
                      }
                    }
                  } catch (e) {
                    // Skip invalid JSON
                  }
                }
                visitors = totalViews;
                conversions = visitors;
              } else {
                // Fallback: get total sessions from daily_metrics (more accurate than page views)
                const result = await analyticsDb.prepare(`
                  SELECT COALESCE(SUM(sessions), 0) as total_sessions
                  FROM daily_metrics
                  WHERE org_tag = ?
                    AND date >= ?
                    AND date <= ?
                `).bind(orgTag, startDateStr, endDateStr).first() as { total_sessions: number } | null;
                visitors = result?.total_sessions || 0;
                conversions = visitors;
              }
            }
          }
        } catch (err) {
          structuredLog('WARN', 'Stage query failed', { endpoint: 'analytics/flow-metrics', step: `${goal.name} (${connector})`, error: err instanceof Error ? err.message : String(err) });
        }

        // Calculate by_channel for this stage
        let byChannelEnhanced: Record<string, EnhancedChannelAttribution> | undefined;

        if (visitors > 0) {
          if (connector === "google_ads") {
            // Google Ads stage = 100% paid_search channel
            byChannel = { paid_search: visitors };
          } else if (connector === "facebook_ads" || connector === "tiktok_ads") {
            // Social ad stages = 100% paid_social channel
            byChannel = { paid_social: visitors };
          } else if ((connector === "stripe" || connector === "shopify") && attributionModel === "smart") {
            // Revenue stages - use SmartAttributionService for confidence-scored attribution
            try {
              const smartService = new SmartAttributionService(analyticsDb, c.env.DB);
              const attribution = await smartService.getSmartAttribution(orgId, startDateStr, endDateStr);

              if (attribution.attributions.length > 0 && attribution.summary.totalConversions > 0) {
                byChannel = {};
                byChannelEnhanced = {};

                for (const attr of attribution.attributions) {
                  const channelKey = attr.platform || attr.channel.toLowerCase().replace(/\s+/g, '_');
                  const conversionShare = attr.conversions / attribution.summary.totalConversions;

                  byChannel[channelKey] = Math.round(conversions * conversionShare);
                  byChannelEnhanced[channelKey] = {
                    visitors: Math.round(visitors * conversionShare),
                    conversions: Math.round(conversions * conversionShare),
                    confidence: attr.confidence,
                    signal_type: attr.signalType,
                    explanation: attr.explanation,
                    is_estimated: attr.is_estimated,
                    estimation_reason: attr.estimation_reason,
                  };
                }

                // Store attribution metadata for summary
                if (!smartAttributionData) {
                  smartAttributionData = attribution;
                }
              }
            } catch (err) {
              structuredLog('WARN', 'SmartAttribution failed', { endpoint: 'analytics/flow-metrics', step: goal.name, error: err instanceof Error ? err.message : String(err) });
            }

            // Fallback to proportional distribution if SmartAttribution failed
            if (!byChannel && totalChannelEvents > 0) {
              byChannel = {};
              for (const [channel, eventCount] of Object.entries(channelDistribution)) {
                const ratio = eventCount / totalChannelEvents;
                const attributed = Math.round(conversions * ratio);
                if (attributed > 0) {
                  byChannel[channel] = attributed;
                }
              }
            }
          } else if ((connector === "stripe" || connector === "shopify") && totalChannelEvents > 0) {
            // Non-smart attribution: distribute based on channel proportions
            byChannel = {};
            for (const [channel, eventCount] of Object.entries(channelDistribution)) {
              const ratio = eventCount / totalChannelEvents;
              const attributed = Math.round(conversions * ratio);
              if (attributed > 0) {
                byChannel[channel] = attributed;
              }
            }
          } else if (connector === "clearlift_tag" && totalChannelEvents > 0) {
            // Tag stages - distribute based on channel proportions
            byChannel = {};
            for (const [channel, eventCount] of Object.entries(channelDistribution)) {
              const ratio = eventCount / totalChannelEvents;
              const attributed = Math.round(visitors * ratio);
              if (attributed > 0) {
                byChannel[channel] = attributed;
              }
            }
          }
        }

        // Traffic sources are ad platforms and direct traffic - they're entry points, not funnel stages
        // 'direct' connector is used by flow builder for organic/direct traffic visualization
        const isTrafficSource = ["google_ads", "facebook_ads", "tiktok_ads", "direct"].includes(connector);

        const metrics: StageMetrics = {
          id: goal.id,
          name: goal.name,
          type: goal.type,
          connector: goal.connector,
          connector_event_type: goal.connector_event_type,
          position_row: goal.position_row ?? stageMetrics.length,
          position_col: goal.position_col ?? 0,
          is_conversion: isConversion,
          is_traffic_source: isTrafficSource,
          visitors,
          conversions,
          dropoff_rate: 0, // Calculate after all stages
          avg_time_to_next_hours: null,
          conversion_value_cents: isConversion ? (conversionValueCents || conversions * valueCents) : 0,
          by_channel: byChannel,
          by_channel_enhanced: byChannelEnhanced,
        };

        stageMetrics.push(metrics);

        if (isConversion) {
          totalRevenueCents += metrics.conversion_value_cents;
        }
      }

      // CRITICAL FIX: Separate traffic sources from funnel stages
      // Ad platforms (google_ads, facebook_ads, tiktok_ads) and direct traffic are ENTRY POINTS, not funnel stages
      // We cannot calculate dropoff from ad clicks to page views - they're not session-linked
      const trafficSourceConnectors = new Set(["google_ads", "facebook_ads", "tiktok_ads", "direct"]);
      const funnelStages = stageMetrics.filter(s => !trafficSourceConnectors.has(s.connector || ""));
      const trafficSourceStages = stageMetrics.filter(s => trafficSourceConnectors.has(s.connector || ""));

      // Mark traffic source stages as entry points (not part of dropoff calculation)
      for (const stage of trafficSourceStages) {
        stage.dropoff_rate = 0; // No dropoff - these are entry points
      }

      // Calculate dropoff rates only between funnel stages (not traffic sources)
      // Group funnel stages by position_row
      const rowGroups = new Map<number, StageMetrics[]>();
      for (const stage of funnelStages) {
        const row = stage.position_row;
        if (!rowGroups.has(row)) rowGroups.set(row, []);
        rowGroups.get(row)!.push(stage);
      }

      const sortedRows = Array.from(rowGroups.keys()).sort((a, b) => a - b);
      let maxDropoffRate = 0;
      let bottleneckStageId: string | null = null;

      for (let i = 1; i < sortedRows.length; i++) {
        const prevRow = sortedRows[i - 1];
        const currRow = sortedRows[i];
        const prevStages = rowGroups.get(prevRow) || [];
        const currStages = rowGroups.get(currRow) || [];

        // Sum visitors from previous row of FUNNEL stages only
        const prevVisitors = prevStages.reduce((sum, s) => sum + s.visitors, 0);

        // Calculate dropoff for each stage in current row
        for (const stage of currStages) {
          if (prevVisitors > 0) {
            stage.dropoff_rate = Math.round((1 - stage.visitors / prevVisitors) * 100 * 10) / 10;
            stage.dropoff_rate = Math.max(0, Math.min(100, stage.dropoff_rate));

            if (stage.dropoff_rate > maxDropoffRate) {
              maxDropoffRate = stage.dropoff_rate;
              bottleneckStageId = stage.id;
            }
          }
        }
      }

      // Enrich with timing data from funnel_transitions (session-linked)
      if (orgTag) {
        try {
          const timingResult = await analyticsDb.prepare(`
            SELECT
              from_id,
              AVG(avg_time_to_transition_hours) as avg_hours
            FROM funnel_transitions
            WHERE org_tag = ?
              AND from_type = 'goal'
              AND period_start >= ?
              AND period_end <= ?
              AND avg_time_to_transition_hours IS NOT NULL
            GROUP BY from_id
          `).bind(orgTag, startDateStr, endDateStr).all() as D1Result<{
            from_id: string;
            avg_hours: number | null;
          }>;

          // Apply timing to stages
          const timingMap = new Map<string, number>();
          for (const row of timingResult.results || []) {
            if (row.avg_hours !== null) {
              timingMap.set(row.from_id, row.avg_hours);
            }
          }

          for (const stage of stageMetrics) {
            const avgTime = timingMap.get(stage.id);
            if (avgTime !== undefined) {
              stage.avg_time_to_next_hours = Math.round(avgTime * 10) / 10;
            }
          }
        } catch (err) {
          structuredLog('WARN', 'Failed to get timing from funnel_transitions', { endpoint: 'analytics/flow-metrics', error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Calculate overall conversion rate using FUNNEL stages only (not traffic sources)
      // Top of funnel = first row of funnel stages (clearlift_tag, etc.), not ad platforms
      const topOfFunnelRow = sortedRows[0];
      const topOfFunnelVisitors = topOfFunnelRow !== undefined
        ? (rowGroups.get(topOfFunnelRow) || []).reduce((sum, s) => sum + s.visitors, 0)
        : 0;
      const finalConversions = funnelStages.filter(s => s.is_conversion)
        .reduce((sum, s) => sum + s.conversions, 0);
      const overallConversionRate = topOfFunnelVisitors > 0
        ? Math.round((finalConversions / topOfFunnelVisitors) * 100 * 100) / 100
        : 0;

      // Count conversion stages
      const conversionStages = stageMetrics.filter(s => s.is_conversion).length;

      // Get traffic source breakdown (Direct vs UTM) using by_channel from daily_metrics
      let trafficSources = {
        direct_visitors: 0,
        utm_visitors: 0,
        total_visitors: 0,
      };

      if (orgTag) {
        try {
          // Get total sessions and channel breakdown from daily_metrics
          const metricsResult = await analyticsDb.prepare(`
            SELECT sessions, by_channel
            FROM daily_metrics
            WHERE org_tag = ?
              AND date >= ?
              AND date <= ?
          `).bind(orgTag, startDateStr, endDateStr).all() as D1Result<{ sessions: number; by_channel: string | null }>;

          let totalSessions = 0;
          let directEvents = 0;
          let organicSearchEvents = 0;
          let utmEvents = 0; // non-ad-platform UTM (email, social, referral)
          let paidEvents = 0;

          for (const row of metricsResult.results || []) {
            totalSessions += row.sessions || 0;

            if (row.by_channel) {
              try {
                const channels = JSON.parse(row.by_channel) as Record<string, number>;
                // by_channel values: direct, paid_search, paid_social, organic_search, organic_social, email, referral, display
                directEvents += channels.direct || 0;
                organicSearchEvents += channels.organic_search || 0;
                // UTM = organic social + email + referral (non-paid traffic with UTMs)
                utmEvents += (channels.organic_social || 0) + (channels.email || 0) + (channels.referral || 0);
                // Paid = paid_search + paid_social + display
                paidEvents += (channels.paid_search || 0) + (channels.paid_social || 0) + (channels.display || 0);
              } catch (e) {
                // Invalid JSON, skip
              }
            }
          }

          // Calculate approximate session counts from event ratios
          // Direct includes both "direct" and "organic_search" (no UTM params)
          const directTotal = directEvents + organicSearchEvents;
          const totalEvents = directTotal + utmEvents + paidEvents;
          if (totalEvents > 0 && totalSessions > 0) {
            // Scale based on event proportions
            const directRatio = directTotal / totalEvents;
            const utmRatio = utmEvents / totalEvents;

            trafficSources = {
              direct_visitors: Math.round(totalSessions * directRatio),
              utm_visitors: Math.round(totalSessions * utmRatio),
              total_visitors: totalSessions,
            };
          } else {
            trafficSources = {
              direct_visitors: totalSessions,
              utm_visitors: 0,
              total_visitors: totalSessions,
            };
          }
        } catch (err) {
          structuredLog('WARN', 'Failed to get traffic sources', { endpoint: 'analytics/flow-metrics', error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Calculate stage removal effects using Markov analysis
      let criticalStagesCount = 0;
      if (includeRemovalEffects && orgTag) {
        try {
          const markovService = new StageMarkovService(analyticsDb, c.env.DB);
          const removalEffects = await markovService.getRemovalEffectsMap(
            orgId,
            orgTag,
            startDateStr,
            endDateStr
          );

          // Apply removal effects to stage metrics
          for (const stage of stageMetrics) {
            const removalEffect = removalEffects.get(stage.id);
            if (removalEffect !== undefined) {
              stage.removal_effect = removalEffect;
              stage.is_critical = removalEffect > 0.3;
              if (stage.is_critical) {
                criticalStagesCount++;
              }
            }
          }
          console.log(`[FlowMetrics] Applied removal effects to ${removalEffects.size} stages, ${criticalStagesCount} critical`);
        } catch (err) {
          structuredLog('WARN', 'Failed to calculate removal effects', { endpoint: 'analytics/flow-metrics', error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Build attribution summary
      let attributionSummary: { model_used: string; avg_confidence: number; data_completeness: number } | undefined;
      if (smartAttributionData) {
        const confidences = smartAttributionData.attributions.map(a => a.confidence);
        const avgConfidence = confidences.length > 0
          ? Math.round(confidences.reduce((sum, c) => sum + c, 0) / confidences.length)
          : 0;

        attributionSummary = {
          model_used: attributionModel,
          avg_confidence: avgConfidence,
          data_completeness: smartAttributionData.summary.dataCompleteness,
        };
      }

      // Build data quality recommendations based on actual data state
      const recommendations: string[] = [];

      // Check if we have any paid traffic in funnel stages (not traffic sources)
      const funnelStagesOnly = stageMetrics.filter(s => !trafficSourceConnectors.has(s.connector || ""));
      const hasPaidTrafficInFunnel = funnelStagesOnly.some(s =>
        s.by_channel && (
          (s.by_channel as Record<string, number>).paid_search > 0 ||
          (s.by_channel as Record<string, number>).paid_social > 0
        )
      );

      // Check if we have traffic source stages (ad platforms connected)
      const hasAdPlatformConnected = trafficSourceStages.length > 0;
      const totalAdClicks = trafficSourceStages.reduce((sum, s) => sum + s.visitors, 0);

      // Contextual recommendations based on data quality
      if (hasAdPlatformConnected && !hasPaidTrafficInFunnel && totalAdClicks > 10) {
        // Ad platform connected with clicks, but no paid traffic showing in funnel
        recommendations.push(
          `${totalAdClicks} ad clicks detected but 0 linked to funnel sessions. ` +
          "Check: (1) UTM/gclid/fbclid parameters in ad URLs, (2) Tag installed on landing pages, (3) No URL redirects stripping parameters"
        );
      }

      if (!smartAttributionData) {
        // No payment connector - can't do conversion attribution
        if (conversionStages > 0 && totalRevenueCents === 0) {
          recommendations.push("Connect Stripe or Shopify to track revenue and enable conversion attribution");
        } else if (conversionStages === 0) {
          recommendations.push("Add conversion goals (purchase, signup) to track funnel completion");
        }
      } else if (smartAttributionData.dataQuality.recommendations.length > 0) {
        recommendations.push(...smartAttributionData.dataQuality.recommendations);
      }

      if (criticalStagesCount === 0 && stageMetrics.length > 2) {
        recommendations.push("No critical stages identified - consider A/B testing to optimize funnel performance");
      }

      return success(c, {
        stages: stageMetrics,
        summary: {
          total_stages: stageMetrics.length,
          conversion_stages: conversionStages,
          overall_conversion_rate: overallConversionRate,
          total_revenue_cents: totalRevenueCents,
          bottleneck_stage_id: bottleneckStageId,
          bottleneck_dropoff_rate: maxDropoffRate,
        },
        flow_structure: {
          mode: flowMode,
          has_branching: hasBranching,
          entry_points: Math.max(1, entryPoints),
        },
        traffic_sources: trafficSources,
        attribution_summary: attributionSummary,
        data_quality: {
          recommendations,
          has_smart_attribution: !!smartAttributionData,
          critical_stages_count: criticalStagesCount,
        },
      });
    } catch (err) {
      structuredLog('ERROR', 'Flow metrics query failed', { endpoint: 'analytics/flow-metrics', error: err instanceof Error ? err.message : String(err) });
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Failed to get flow metrics", 500);
    }
  }
}

/**
 * GET /v1/analytics/flow/stage/:stageId/transitions
 * Get detailed transition data for a specific stage
 */
export class GetStageTransitions extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get stage transitions",
    description: "Returns detailed transition data for a specific flow stage",
    operationId: "get-stage-transitions",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        stageId: z.string().describe("Stage/Goal ID"),
      }),
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        days: z.coerce.number().int().min(1).max(365).default(30),
      }),
    },
    responses: {
      "200": {
        description: "Stage transition data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                stage_id: z.string(),
                stage_name: z.string(),
                inbound: z.object({
                  total_visitors: z.number(),
                  by_source: z.array(z.object({
                    source_stage_id: z.string().nullable(),
                    source_stage_name: z.string(),
                    visitors: z.number(),
                    percentage: z.number(),
                  })),
                }),
                outbound: z.object({
                  progressed: z.number(),
                  dropped_off: z.number(),
                  by_destination: z.array(z.object({
                    dest_stage_id: z.string(),
                    dest_stage_name: z.string(),
                    visitors: z.number(),
                    percentage: z.number(),
                  })),
                }),
                timing: z.object({
                  avg_time_from_previous_hours: z.number().nullable(),
                  avg_time_to_next_hours: z.number().nullable(),
                  median_time_to_next_hours: z.number().nullable(),
                }),
              }),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const stageId = c.req.param("stageId");
    const days = parseInt(c.req.query("days") || "30", 10);

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    try {
      // Get the stage
      const stage = await c.env.DB.prepare(`
        SELECT id, name, type, connector, connector_event_type
        FROM conversion_goals
        WHERE id = ? AND organization_id = ? AND is_active = 1
      `).bind(stageId, orgId).first() as {
        id: string;
        name: string;
        type: string;
        connector: string | null;
        connector_event_type: string | null;
      } | null;

      if (!stage) {
        return error(c, "STAGE_NOT_FOUND", "Stage not found", 404);
      }

      // Get relationships
      const inboundRels = await c.env.DB.prepare(`
        SELECT gr.upstream_goal_id, g.name as upstream_name
        FROM goal_relationships gr
        JOIN conversion_goals g ON gr.upstream_goal_id = g.id
        WHERE gr.downstream_goal_id = ? AND gr.organization_id = ?
      `).bind(stageId, orgId).all() as D1Result<{ upstream_goal_id: string; upstream_name: string }>;

      const outboundRels = await c.env.DB.prepare(`
        SELECT gr.downstream_goal_id, g.name as downstream_name
        FROM goal_relationships gr
        JOIN conversion_goals g ON gr.downstream_goal_id = g.id
        WHERE gr.upstream_goal_id = ? AND gr.organization_id = ?
      `).bind(stageId, orgId).all() as D1Result<{ downstream_goal_id: string; downstream_name: string }>;

      // Calculate date range
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      // Get conversion counts for this stage
      const analyticsDb = c.env.ANALYTICS_DB;
      let stageConversions = 0;

      try {
        const convResult = await analyticsDb.prepare(`
          SELECT COUNT(*) as count
          FROM goal_conversions
          WHERE goal_id = ?
            AND conversion_timestamp >= ?
            AND conversion_timestamp <= ?
        `).bind(stageId, startDate.toISOString(), endDate.toISOString())
          .first() as { count: number } | null;
        stageConversions = convResult?.count || 0;
      } catch (err) {
        structuredLog('WARN', 'Failed to query stage conversions', { endpoint: 'analytics/flow-metrics/transitions', error: err instanceof Error ? err.message : String(err) });
      }

      // Build inbound sources (using conversion data from upstream stages)
      const inboundSources: Array<{
        source_stage_id: string | null;
        source_stage_name: string;
        visitors: number;
        percentage: number;
      }> = [];

      if (inboundRels.results && inboundRels.results.length > 0) {
        for (const rel of inboundRels.results) {
          // Estimate visitors from each source
          const visitors = Math.floor(stageConversions / inboundRels.results.length);
          inboundSources.push({
            source_stage_id: rel.upstream_goal_id,
            source_stage_name: rel.upstream_name,
            visitors,
            percentage: stageConversions > 0 ? Math.round((visitors / stageConversions) * 100) : 0,
          });
        }
      } else {
        // No inbound relationships = direct entry
        inboundSources.push({
          source_stage_id: null,
          source_stage_name: "Direct Entry",
          visitors: stageConversions,
          percentage: 100,
        });
      }

      // Build outbound destinations
      const outboundDests: Array<{
        dest_stage_id: string;
        dest_stage_name: string;
        visitors: number;
        percentage: number;
      }> = [];

      let progressedCount = 0;
      if (outboundRels.results && outboundRels.results.length > 0) {
        for (const rel of outboundRels.results) {
          // Query conversions for downstream stage
          let destConversions = 0;
          try {
            const destResult = await analyticsDb.prepare(`
              SELECT COUNT(*) as count
              FROM goal_conversions
              WHERE goal_id = ?
                AND conversion_timestamp >= ?
                AND conversion_timestamp <= ?
            `).bind(rel.downstream_goal_id, startDate.toISOString(), endDate.toISOString())
              .first() as { count: number } | null;
            destConversions = destResult?.count || 0;
          } catch (err) {
            // ignore
          }

          progressedCount += destConversions;
          outboundDests.push({
            dest_stage_id: rel.downstream_goal_id,
            dest_stage_name: rel.downstream_name,
            visitors: destConversions,
            percentage: stageConversions > 0 ? Math.round((destConversions / stageConversions) * 100) : 0,
          });
        }
      }

      const droppedOff = Math.max(0, stageConversions - progressedCount);

      // Query real timing data from funnel_transitions
      let avgTimeFromPrevious: number | null = null;
      let avgTimeToNext: number | null = null;

      // Get org_tag for querying funnel_transitions
      const tagMapping = await c.env.DB.prepare(`
        SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
      `).bind(orgId).first() as { short_tag: string } | null;

      if (tagMapping?.short_tag) {
        const orgTag = tagMapping.short_tag;

        // Query timing for transitions TO this stage (from previous stages)
        if (inboundRels.results && inboundRels.results.length > 0) {
          try {
            const inboundTiming = await analyticsDb.prepare(`
              SELECT AVG(avg_time_to_transition_hours) as avg_hours
              FROM funnel_transitions
              WHERE org_tag = ? AND to_id = ?
                AND avg_time_to_transition_hours IS NOT NULL
              ORDER BY period_start DESC
              LIMIT 7
            `).bind(orgTag, stageId).first() as { avg_hours: number | null } | null;

            avgTimeFromPrevious = inboundTiming?.avg_hours || null;
          } catch (err) {
            structuredLog('WARN', 'Failed to query inbound timing', { endpoint: 'analytics/flow-metrics/transitions', error: err instanceof Error ? err.message : String(err) });
          }
        }

        // Query timing for transitions FROM this stage (to next stages)
        if (outboundRels.results && outboundRels.results.length > 0) {
          try {
            const outboundTiming = await analyticsDb.prepare(`
              SELECT AVG(avg_time_to_transition_hours) as avg_hours
              FROM funnel_transitions
              WHERE org_tag = ? AND from_id = ?
                AND avg_time_to_transition_hours IS NOT NULL
              ORDER BY period_start DESC
              LIMIT 7
            `).bind(orgTag, stageId).first() as { avg_hours: number | null } | null;

            avgTimeToNext = outboundTiming?.avg_hours || null;
          } catch (err) {
            structuredLog('WARN', 'Failed to query outbound timing', { endpoint: 'analytics/flow-metrics/transitions', error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      return success(c, {
        stage_id: stage.id,
        stage_name: stage.name,
        inbound: {
          total_visitors: stageConversions,
          by_source: inboundSources,
        },
        outbound: {
          progressed: progressedCount,
          dropped_off: droppedOff,
          by_destination: outboundDests,
        },
        timing: {
          avg_time_from_previous_hours: avgTimeFromPrevious,
          avg_time_to_next_hours: avgTimeToNext,
          median_time_to_next_hours: null, // Median requires more complex query, keep as null for now
        },
      });
    } catch (err) {
      structuredLog('ERROR', 'Stage transitions query failed', { endpoint: 'analytics/flow-metrics/transitions', error: err instanceof Error ? err.message : String(err) });
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Failed to get stage transitions", 500);
    }
  }
}
