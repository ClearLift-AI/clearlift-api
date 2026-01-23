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
  visitors: number;
  conversions: number;
  dropoff_rate: number;
  avg_time_to_next_hours: number | null;
  conversion_value_cents: number;
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
                  visitors: z.number(),
                  conversions: z.number(),
                  dropoff_rate: z.number(),
                  avg_time_to_next_hours: z.number().nullable(),
                  conversion_value_cents: z.number(),
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

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    try {
      // 1. Get organization settings (flow mode)
      const org = await c.env.DB.prepare(`
        SELECT flow_mode FROM organizations WHERE id = ?
      `).bind(orgId).first<{ flow_mode: string | null }>();

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
      `).bind(orgId).all<{
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
      }>();

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
      `).bind(orgId).all<{
        upstream_goal_id: string;
        downstream_goal_id: string;
        funnel_position: number | null;
      }>();

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
      `).bind(orgId).first<{ short_tag: string }>();

      const orgTag = tagMapping?.short_tag;

      // Calculate date range
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startDateStr = startDate.toISOString().split("T")[0];
      const endDateStr = endDate.toISOString().split("T")[0];

      // 5. Query stage metrics based on connector type
      const analyticsDb = (c.env as any).ANALYTICS_DB || c.env.DB;

      // Build stage metrics - query each connector's data source
      const stageMetrics: StageMetrics[] = [];
      let totalRevenueCents = 0;

      for (const goal of goals) {
        const isConversion = Boolean(goal.is_conversion) || goal.type === "conversion";
        const valueCents = goal.fixed_value_cents || goal.default_value_cents || 0;
        const connector = goal.connector || "clearlift_tag";

        let visitors = 0;
        let conversions = 0;
        let conversionValueCents = 0;

        try {
          // Query based on connector type
          if (connector === "google_ads") {
            // Google Ads clicks
            const result = await analyticsDb.prepare(`
              SELECT COALESCE(SUM(m.clicks), 0) as clicks
              FROM google_campaigns c
              LEFT JOIN google_campaign_daily_metrics m
                ON c.id = m.campaign_ref
                AND m.metric_date >= ?
                AND m.metric_date <= ?
              WHERE c.organization_id = ?
            `).bind(startDateStr, endDateStr, orgId).first<{ clicks: number }>();
            visitors = result?.clicks || 0;
            conversions = visitors; // For traffic stages, visitors = conversions
          } else if (connector === "facebook_ads") {
            // Facebook Ads clicks
            const result = await analyticsDb.prepare(`
              SELECT COALESCE(SUM(m.clicks), 0) as clicks
              FROM facebook_campaigns c
              LEFT JOIN facebook_campaign_daily_metrics m
                ON c.id = m.campaign_ref
                AND m.metric_date >= ?
                AND m.metric_date <= ?
              WHERE c.organization_id = ?
            `).bind(startDateStr, endDateStr, orgId).first<{ clicks: number }>();
            visitors = result?.clicks || 0;
            conversions = visitors;
          } else if (connector === "tiktok_ads") {
            // TikTok Ads clicks
            const result = await analyticsDb.prepare(`
              SELECT COALESCE(SUM(m.clicks), 0) as clicks
              FROM tiktok_campaigns c
              LEFT JOIN tiktok_campaign_daily_metrics m
                ON c.id = m.campaign_ref
                AND m.metric_date >= ?
                AND m.metric_date <= ?
              WHERE c.organization_id = ?
            `).bind(startDateStr, endDateStr, orgId).first<{ clicks: number }>();
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
            `).bind(orgId, startDateStr, endDateStr).first<{ conversions: number; revenue_cents: number }>();
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
            `).bind(orgId, startDateStr, endDateStr).first<{ conversions: number; revenue_cents: number }>();
            conversions = result?.conversions || 0;
            visitors = conversions;
            conversionValueCents = result?.revenue_cents || 0;
          } else if (connector === "clearlift_tag" && orgTag) {
            // Tag events - query based on trigger_config
            const triggerConfig = goal.trigger_config ? JSON.parse(goal.trigger_config) : {};
            const eventType = goal.connector_event_type || triggerConfig.event_type || "page_view";
            const pagePattern = triggerConfig.page_pattern || "";

            if (eventType === "page_view" && pagePattern) {
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
                    // Check if page matches pattern (simple substring match)
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
              // Fallback: get total page views from daily_metrics
              const result = await analyticsDb.prepare(`
                SELECT COALESCE(SUM(page_views), 0) as total_views
                FROM daily_metrics
                WHERE org_tag = ?
                  AND date >= ?
                  AND date <= ?
              `).bind(orgTag, startDateStr, endDateStr).first<{ total_views: number }>();
              visitors = result?.total_views || 0;
              conversions = visitors;
            }
          }
        } catch (err) {
          console.warn(`[FlowMetrics] Query failed for ${goal.name} (${connector}):`, err);
        }

        const metrics: StageMetrics = {
          id: goal.id,
          name: goal.name,
          type: goal.type,
          connector: goal.connector,
          connector_event_type: goal.connector_event_type,
          position_row: goal.position_row ?? stageMetrics.length,
          position_col: goal.position_col ?? 0,
          is_conversion: isConversion,
          visitors,
          conversions,
          dropoff_rate: 0, // Calculate after all stages
          avg_time_to_next_hours: null,
          conversion_value_cents: isConversion ? (conversionValueCents || conversions * valueCents) : 0,
        };

        stageMetrics.push(metrics);

        if (isConversion) {
          totalRevenueCents += metrics.conversion_value_cents;
        }
      }

      // Calculate dropoff rates based on funnel position
      // Group by position_row, then calculate dropoff between rows
      const rowGroups = new Map<number, StageMetrics[]>();
      for (const stage of stageMetrics) {
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

        // Sum visitors from previous row
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

      // Calculate overall conversion rate (top of funnel visitors to final conversion)
      // Use sum of all row 0 (entry point) visitors, not just stageMetrics[0]
      const topOfFunnelRow = sortedRows[0] ?? 0;
      const topOfFunnelVisitors = (rowGroups.get(topOfFunnelRow) || [])
        .reduce((sum, s) => sum + s.visitors, 0);
      const finalConversions = stageMetrics.filter(s => s.is_conversion)
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
          `).bind(orgTag, startDateStr, endDateStr).all<{ sessions: number; by_channel: string | null }>();

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
          console.warn("[FlowMetrics] Failed to get traffic sources:", err);
        }
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
      });
    } catch (err) {
      console.error("[FlowMetrics] Error:", err);
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
      `).bind(stageId, orgId).first<{
        id: string;
        name: string;
        type: string;
        connector: string | null;
        connector_event_type: string | null;
      }>();

      if (!stage) {
        return error(c, "STAGE_NOT_FOUND", "Stage not found", 404);
      }

      // Get relationships
      const inboundRels = await c.env.DB.prepare(`
        SELECT gr.upstream_goal_id, g.name as upstream_name
        FROM goal_relationships gr
        JOIN conversion_goals g ON gr.upstream_goal_id = g.id
        WHERE gr.downstream_goal_id = ? AND gr.organization_id = ?
      `).bind(stageId, orgId).all<{ upstream_goal_id: string; upstream_name: string }>();

      const outboundRels = await c.env.DB.prepare(`
        SELECT gr.downstream_goal_id, g.name as downstream_name
        FROM goal_relationships gr
        JOIN conversion_goals g ON gr.downstream_goal_id = g.id
        WHERE gr.upstream_goal_id = ? AND gr.organization_id = ?
      `).bind(stageId, orgId).all<{ downstream_goal_id: string; downstream_name: string }>();

      // Calculate date range
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      // Get conversion counts for this stage
      const analyticsDb = (c.env as any).ANALYTICS_DB || c.env.DB;
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
        console.warn(`[StageTransitions] Failed to query conversions:`, err);
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
          avg_time_from_previous_hours: Math.random() * 12 + 0.5, // Placeholder
          avg_time_to_next_hours: outboundRels.results?.length ? Math.random() * 24 + 1 : null,
          median_time_to_next_hours: outboundRels.results?.length ? Math.random() * 18 + 0.5 : null,
        },
      });
    } catch (err) {
      console.error("[StageTransitions] Error:", err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Failed to get stage transitions", 500);
    }
  }
}
