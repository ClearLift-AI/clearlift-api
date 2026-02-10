import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { structuredLog } from "../../../utils/structured-logger";

/**
 * Goal Configuration for Tag
 *
 * Public endpoint (no auth required) that returns goal configurations
 * for the tracking tag to use for client-side goal matching.
 *
 * Called by: clearlift.js tag on page load
 * Endpoint: GET /v1/goals/config?org_tag=xxx
 */

// Schema for tag goal config (minimal fields needed for matching)
const TagGoalConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['conversion', 'micro_conversion', 'engagement']),
  trigger: z.object({
    type: z.enum(['pageview', 'click', 'form_submit', 'custom']),
    // For pageview triggers
    page_pattern: z.string().optional(),
    page_exact: z.string().optional(),
    // For click triggers
    selector: z.string().optional(),
    // For custom event triggers
    event_name: z.string().optional(),
  }),
  value_cents: z.number(),
  funnel_position: z.number().optional(),
  downstream_goal_id: z.string().optional(),
});

export type TagGoalConfig = z.infer<typeof TagGoalConfigSchema>;

/**
 * GET /v1/goals/config - Get goal configurations for tracking tag
 *
 * Public endpoint - no authentication required.
 * Returns goals with page_pattern triggers that the tag should track.
 */
export class GetGoalConfig extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Get goal configurations for tracking tag",
    operationId: "get-goal-config",
    // No security - public endpoint
    request: {
      query: z.object({
        org_tag: z.string().describe("Organization tag (short identifier)"),
      }),
    },
    responses: {
      "200": {
        description: "Goal configurations for the tag",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                goals: z.array(TagGoalConfigSchema),
                version: z.number(),
                cached_at: z.string(),
              }),
            }),
          },
        },
      },
      "404": {
        description: "Organization not found",
      },
    },
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const orgTag = data.query.org_tag;

    // Look up organization by org_tag
    const orgMapping = await c.env.DB.prepare(`
      SELECT organization_id
      FROM org_tag_mappings
      WHERE short_tag = ? AND is_active = 1
    `).bind(orgTag).first<{ organization_id: string }>();

    if (!orgMapping) {
      return c.json({
        success: false,
        error: { code: "NOT_FOUND", message: "Organization not found" },
      }, 404);
    }

    const orgId = orgMapping.organization_id;

    // Fetch active goals with page_pattern or custom_event triggers
    const goalsResult = await c.env.DB.prepare(`
      SELECT
        g.id,
        g.name,
        g.type,
        g.trigger_config,
        g.default_value_cents,
        g.fixed_value_cents,
        g.value_type,
        g.priority,
        r.downstream_goal_id,
        r.funnel_position
      FROM conversion_goals g
      LEFT JOIN goal_relationships r ON r.upstream_goal_id = g.id
      WHERE g.organization_id = ?
        AND g.is_active = 1
        AND (
          g.trigger_config LIKE '%page_pattern%'
          OR g.trigger_config LIKE '%custom_event%'
          OR g.trigger_config LIKE '%event_type%'
        )
      ORDER BY g.priority ASC
    `).bind(orgId).all();

    // Transform to tag-friendly format
    const goals: TagGoalConfig[] = [];

    for (const row of goalsResult.results || []) {
      // Parse trigger config safely
      let triggerConfig: Record<string, any> = {};
      try {
        triggerConfig = JSON.parse(row.trigger_config as string || '{}');
      } catch {
        // Skip goals with invalid trigger config
        structuredLog('WARN', 'Invalid trigger_config for goal', { endpoint: 'GET /v1/goals/config', goal_id: row.id as string });
        continue;
      }

      // Determine trigger type and config
      let trigger: TagGoalConfig['trigger'];

      if (triggerConfig.page_pattern) {
        trigger = {
          type: 'pageview',
          page_pattern: triggerConfig.page_pattern,
        };
      } else if (triggerConfig.page_exact) {
        trigger = {
          type: 'pageview',
          page_exact: triggerConfig.page_exact,
        };
      } else if (triggerConfig.custom_event) {
        trigger = {
          type: 'custom',
          event_name: triggerConfig.custom_event,
        };
      } else if (triggerConfig.event_type === 'click') {
        trigger = {
          type: 'click',
          selector: triggerConfig.selector,
        };
      } else if (triggerConfig.event_type === 'form_submit') {
        trigger = {
          type: 'form_submit',
          selector: triggerConfig.selector,
        };
      } else {
        // Skip goals without clear triggers
        continue;
      }

      // Calculate value (prefer fixed_value_cents, fall back to default)
      const valueCents = (row.value_type === 'fixed' && row.fixed_value_cents)
        ? row.fixed_value_cents as number
        : row.default_value_cents as number || 0;

      // Validate type field (default to 'conversion' if invalid)
      const validTypes = ['conversion', 'micro_conversion', 'engagement'] as const;
      const goalType = validTypes.includes(row.type as any)
        ? (row.type as typeof validTypes[number])
        : 'conversion';

      goals.push({
        id: row.id as string,
        name: row.name as string,
        type: goalType,
        trigger,
        value_cents: valueCents,
        funnel_position: row.funnel_position as number | undefined,
        downstream_goal_id: row.downstream_goal_id as string | undefined,
      });
    }

    // Return with cache headers
    const response = c.json({
      success: true,
      data: {
        goals,
        version: Date.now(), // Simple version for cache busting
        cached_at: new Date().toISOString(),
      },
    });

    // Cache for 5 minutes (tag should periodically refresh)
    response.headers.set('Cache-Control', 'public, max-age=300');
    response.headers.set('Access-Control-Allow-Origin', '*');

    return response;
  }
}

/**
 * OPTIONS /v1/goals/config - CORS preflight
 */
export class GoalConfigOptions extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "CORS preflight for goal config",
    operationId: "goal-config-options",
  };

  public async handle(c: AppContext) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
}
