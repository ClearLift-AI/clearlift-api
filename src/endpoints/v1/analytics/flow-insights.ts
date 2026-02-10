/**
 * Flow Insights Endpoint
 *
 * Returns per-stage journey metrics derived from journey_analytics + conversion_goals.
 * Used by the GoalBuilder to overlay analytics badges on flow stages.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { structuredLog } from '../../../utils/structured-logger';

interface StageInsight {
  goal_id: string;
  goal_name: string;
  visitors: number;
  dropoff_rate: number;
  conversion_rate: number;
  top_channels: Array<{ channel: string; pct: number }>;
}

interface FlowInsightsResponse {
  stages: StageInsight[];
  summary: {
    total_sessions: number;
    converting_sessions: number;
    overall_conversion_rate: number;
    bottleneck_stage: string | null;
  };
}

/**
 * GET /v1/analytics/flow/insights
 * Get per-stage journey metrics for the flow builder overlay
 */
export class GetFlowInsights extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get flow insights for goal builder overlay",
    request: {
      query: z.object({
        org_id: z.string().uuid(),
      }),
    },
    responses: {
      "200": {
        description: "Flow insights data",
        content: { "application/json": { schema: z.any() } },
      },
    },
  };

  async handle(c: AppContext) {
    const { org_id } = c.req.query();

    if (!org_id) {
      return error(c, "MISSING_PARAM", "org_id is required", 400);
    }

    try {
      const db = c.env.DB;
      const analyticsDb = c.env.ANALYTICS_DB;

      if (!analyticsDb) {
        return error(c, "DB_ERROR", "Analytics database not available", 500);
      }

      // Get org_tag from org_tag_mappings (not organizations table)
      const orgTagRow = await db.prepare(
        `SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1`
      ).bind(org_id).first<{ short_tag: string }>();

      const orgTag = orgTagRow?.short_tag;
      if (!orgTag) {
        return success(c, { stages: [], summary: { total_sessions: 0, converting_sessions: 0, overall_conversion_rate: 0, bottleneck_stage: null } });
      }

      // Fetch latest journey_analytics
      const journeyAnalytics = await analyticsDb.prepare(`
        SELECT channel_distribution, total_sessions, converting_sessions,
               conversion_rate, transition_matrix
        FROM journey_analytics
        WHERE org_tag = ?
        ORDER BY computed_at DESC
        LIMIT 1
      `).bind(orgTag).first<{
        channel_distribution: string | null;
        total_sessions: number;
        converting_sessions: number;
        conversion_rate: number;
        transition_matrix: string | null;
      }>();

      if (!journeyAnalytics) {
        return success(c, { stages: [], summary: { total_sessions: 0, converting_sessions: 0, overall_conversion_rate: 0, bottleneck_stage: null } });
      }

      // Fetch conversion_goals for stage info
      const goalsResult = await db.prepare(`
        SELECT id, name, connector, COALESCE(position_row, 0) as position_row, is_conversion
        FROM conversion_goals
        WHERE organization_id = ? AND is_active = 1 AND connector IS NOT NULL
        ORDER BY position_row ASC
      `).bind(org_id).all<{
        id: string;
        name: string;
        connector: string;
        position_row: number;
        is_conversion: number | null;
      }>();

      const goals = goalsResult.results || [];
      if (goals.length === 0) {
        return success(c, { stages: [], summary: { total_sessions: journeyAnalytics.total_sessions || 0, converting_sessions: journeyAnalytics.converting_sessions || 0, overall_conversion_rate: journeyAnalytics.conversion_rate || 0, bottleneck_stage: null } });
      }

      const channelDist: Record<string, number> = journeyAnalytics.channel_distribution
        ? JSON.parse(journeyAnalytics.channel_distribution)
        : {};
      const transitionMatrix: Record<string, Record<string, number>> = journeyAnalytics.transition_matrix
        ? JSON.parse(journeyAnalytics.transition_matrix)
        : {};

      const totalSessions = journeyAnalytics.total_sessions || 0;
      const convertingSessions = journeyAnalytics.converting_sessions || 0;

      // Map connector → channels for attribution matching
      const CONNECTOR_TO_CHANNEL: Record<string, string[]> = {
        'direct': ['direct'],
        'facebook_ads': ['meta_ads', 'paid_social'],
        'google_ads': ['google_ads', 'paid_search'],
        'tiktok_ads': ['tiktok_ads', 'paid_social'],
        'organic_search': ['organic_search'],
        'organic_social': ['organic_social'],
        'email': ['email'],
        'sms': ['sms'],
        'referral': ['referral'],
      };

      // Non-channel connectors are cross-channel (tracking tags, revenue sources)
      const NON_CHANNEL_CONNECTORS = new Set(['clearlift_tag', 'stripe', 'shopify', 'jobber']);
      const maxRow = Math.max(...goals.map(g => g.position_row), 1);

      // Build stages
      const stages: StageInsight[] = [];
      let highestDropoff = 0;
      let bottleneckStage: string | null = null;

      for (const goal of goals) {
        const isNonChannel = NON_CHANNEL_CONNECTORS.has(goal.connector);
        const channels = isNonChannel ? [] : (CONNECTOR_TO_CHANNEL[goal.connector] || []);

        // Estimate visitors
        let visitors = 0;
        const topChannels: Array<{ channel: string; pct: number }> = [];

        if (isNonChannel) {
          // Cross-channel stages: estimate based on funnel position decay
          if (goal.is_conversion) {
            visitors = convertingSessions;
          } else {
            // Mid-funnel: decay from total sessions based on position
            const positionRatio = maxRow > 0 ? 1.0 - (goal.position_row / maxRow) * 0.5 : 0.5;
            visitors = Math.round(totalSessions * positionRatio);
          }
          // Show top entry channels as context
          const sortedChannels = Object.entries(channelDist)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);
          for (const [ch, pct] of sortedChannels) {
            topChannels.push({ channel: ch, pct: Math.round(pct * 1000) / 10 });
          }
        } else {
          for (const ch of channels) {
            const pct = channelDist[ch] || 0;
            visitors += Math.round(pct * totalSessions);
            if (pct > 0) {
              topChannels.push({ channel: ch, pct: Math.round(pct * 1000) / 10 });
            }
          }
          // Fallback if channel not observed
          if (visitors === 0 && totalSessions > 0) {
            visitors = Math.round(totalSessions * 0.1);
          }
        }

        // Dropoff: from transition matrix, find probability of NOT reaching conversion
        let dropoffRate = 0;
        for (const ch of (channels.length > 0 ? channels : Object.keys(channelDist))) {
          const transitions = transitionMatrix[ch];
          if (transitions) {
            const nullProb = transitions['(null)'] || 0;
            dropoffRate = Math.max(dropoffRate, nullProb);
          }
        }

        const conversionRate = goal.is_conversion
          ? (totalSessions > 0 ? convertingSessions / totalSessions : 0)
          : (visitors > 0 ? Math.max(0, 1 - dropoffRate) : 0);

        if (dropoffRate > highestDropoff) {
          highestDropoff = dropoffRate;
          bottleneckStage = goal.name;
        }

        stages.push({
          goal_id: goal.id,
          goal_name: goal.name,
          visitors,
          dropoff_rate: Math.round(dropoffRate * 1000) / 10,
          conversion_rate: Math.round(conversionRate * 1000) / 10,
          top_channels: topChannels.sort((a, b) => b.pct - a.pct).slice(0, 3),
        });
      }

      return success(c, {
        stages,
        summary: {
          total_sessions: totalSessions,
          converting_sessions: convertingSessions,
          overall_conversion_rate: totalSessions > 0
            ? Math.round((convertingSessions / totalSessions) * 1000) / 10
            : 0,
          bottleneck_stage: bottleneckStage,
        },
      } satisfies FlowInsightsResponse);
    } catch (err: any) {
      structuredLog('ERROR', 'Flow insights query failed', { endpoint: 'analytics/flow-insights', error: err instanceof Error ? err.message : String(err) });
      return error(c, "FLOW_INSIGHTS_ERROR", `Failed to fetch flow insights: ${err.message}`, 500);
    }
  }
}
