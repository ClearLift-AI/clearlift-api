import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";
import { structuredLog } from "../../utils/structured-logger";

const GoalConfigSchema = z.object({
  trigger: z.enum(['pageview', 'click', 'event']),
  match: z.string().optional(),
  value: z.number().optional(),
  currency: z.string().optional()
});

const TrackingConfigSchema = z.object({
  goals: z.record(z.string(), GoalConfigSchema).optional(),
  enable_fingerprinting: z.boolean().optional(),
  enable_cross_domain_tracking: z.boolean().optional(),
  enable_performance_tracking: z.boolean().optional(),
  session_timeout: z.number().int().positive().optional(),
  batch_size: z.number().int().positive().optional(),
  batch_timeout: z.number().int().positive().optional()
});

/**
 * GET /v1/config - Public endpoint for tracking tag to fetch config
 * This endpoint is called by the clearlift.js tag on page load
 */
export class GetTagConfig extends OpenAPIRoute {
  public schema = {
    tags: ["Tracking Config"],
    summary: "Get tracking configuration by org tag (public)",
    operationId: "get-tag-config",
    request: {
      query: z.object({
        org_tag: z.string().min(1)
      })
    },
    responses: {
      "200": {
        description: "Tracking configuration",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                goals: z.record(z.string(), GoalConfigSchema).optional(),
                enable_fingerprinting: z.boolean().optional(),
                enable_cross_domain_tracking: z.boolean().optional(),
                enable_performance_tracking: z.boolean().optional(),
                session_timeout: z.number().optional(),
                batch_size: z.number().optional(),
                batch_timeout: z.number().optional()
              })
            })
          }
        }
      },
      "404": {
        description: "Organization not found"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const orgTag = data.query.org_tag;

    // Lookup organization by org_tag
    const orgMapping = await c.env.DB.prepare(`
      SELECT organization_id
      FROM org_tag_mappings
      WHERE short_tag = ? AND is_active = 1
    `).bind(orgTag).first<{ organization_id: string }>();

    if (!orgMapping) {
      return error(c, "ORG_NOT_FOUND", "Organization not found", 404);
    }

    // Get tracking config
    const config = await c.env.DB.prepare(`
      SELECT
        goals,
        enable_fingerprinting,
        enable_cross_domain_tracking,
        enable_performance_tracking,
        session_timeout,
        batch_size,
        batch_timeout
      FROM org_tracking_configs
      WHERE organization_id = ?
    `).bind(orgMapping.organization_id).first();

    if (!config) {
      // Return defaults if no config exists
      return success(c, {
        goals: {},
        enable_fingerprinting: true,
        enable_cross_domain_tracking: true,
        enable_performance_tracking: true,
        session_timeout: 1800000,
        batch_size: 10,
        batch_timeout: 5000
      });
    }

    // Parse goals JSON
    let goals = {};
    try {
      goals = JSON.parse(config.goals as string || '{}');
    } catch (e) {
      structuredLog('ERROR', 'Failed to parse goals JSON', { endpoint: '/v1/tracking-config', error: e instanceof Error ? e.message : String(e) });
    }

    return success(c, {
      goals,
      enable_fingerprinting: config.enable_fingerprinting !== 0,
      enable_cross_domain_tracking: config.enable_cross_domain_tracking !== 0,
      enable_performance_tracking: config.enable_performance_tracking !== 0,
      session_timeout: config.session_timeout,
      batch_size: config.batch_size,
      batch_timeout: config.batch_timeout
    });
  }
}

/**
 * GET /v1/tracking-config - Get tracking configuration for dashboard
 */
export class GetTrackingConfig extends OpenAPIRoute {
  public schema = {
    tags: ["Tracking Config"],
    summary: "Get tracking configuration (authenticated)",
    operationId: "get-tracking-config",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      })
    },
    responses: {
      "200": {
        description: "Tracking configuration",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: TrackingConfigSchema
            })
          }
        }
      },
      "403": {
        description: "No organization selected or access denied"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const orgId = data.query?.org_id || c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Verify user has access to this organization
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    // Get tracking config
    const config = await c.env.DB.prepare(`
      SELECT
        goals,
        enable_fingerprinting,
        enable_cross_domain_tracking,
        enable_performance_tracking,
        session_timeout,
        batch_size,
        batch_timeout,
        snippet_complexity,
        custom_snippet
      FROM org_tracking_configs
      WHERE organization_id = ?
    `).bind(orgId).first();

    if (!config) {
      // Return defaults if no config exists
      return success(c, {
        goals: {},
        enable_fingerprinting: true,
        enable_cross_domain_tracking: true,
        enable_performance_tracking: true,
        session_timeout: 1800000,
        batch_size: 10,
        batch_timeout: 5000
      });
    }

    // Parse goals JSON
    let goals = {};
    try {
      goals = JSON.parse(config.goals as string || '{}');
    } catch (e) {
      structuredLog('ERROR', 'Failed to parse goals JSON', { endpoint: '/v1/tracking-config', error: e instanceof Error ? e.message : String(e) });
    }

    return success(c, {
      goals,
      enable_fingerprinting: config.enable_fingerprinting !== 0,
      enable_cross_domain_tracking: config.enable_cross_domain_tracking !== 0,
      enable_performance_tracking: config.enable_performance_tracking !== 0,
      session_timeout: config.session_timeout,
      batch_size: config.batch_size,
      batch_timeout: config.batch_timeout
    });
  }
}

/**
 * PUT /v1/tracking-config - Update tracking configuration
 */
export class UpdateTrackingConfig extends OpenAPIRoute {
  public schema = {
    tags: ["Tracking Config"],
    summary: "Update tracking configuration",
    operationId: "update-tracking-config",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      }),
      body: contentJson(TrackingConfigSchema)
    },
    responses: {
      "200": {
        description: "Configuration updated",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                message: z.string()
              })
            })
          }
        }
      },
      "403": {
        description: "No organization selected or access denied"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const orgId = data.query?.org_id || c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Verify user has access to this organization
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const config = data.body;

    // Check if config exists
    const existing = await c.env.DB.prepare(`
      SELECT id FROM org_tracking_configs WHERE organization_id = ?
    `).bind(orgId).first<{ id: string }>();

    const goalsJson = JSON.stringify(config.goals || {});

    if (existing) {
      // Update existing config
      await c.env.DB.prepare(`
        UPDATE org_tracking_configs
        SET
          goals = ?,
          enable_fingerprinting = ?,
          enable_cross_domain_tracking = ?,
          enable_performance_tracking = ?,
          session_timeout = ?,
          batch_size = ?,
          batch_timeout = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE organization_id = ?
      `).bind(
        goalsJson,
        config.enable_fingerprinting !== false ? 1 : 0,
        config.enable_cross_domain_tracking !== false ? 1 : 0,
        config.enable_performance_tracking !== false ? 1 : 0,
        config.session_timeout || 1800000,
        config.batch_size || 10,
        config.batch_timeout || 5000,
        orgId
      ).run();
    } else {
      // Create new config
      const { randomUUID } = await import('node:crypto');
      const configId = randomUUID();

      await c.env.DB.prepare(`
        INSERT INTO org_tracking_configs (
          id,
          organization_id,
          goals,
          enable_fingerprinting,
          enable_cross_domain_tracking,
          enable_performance_tracking,
          session_timeout,
          batch_size,
          batch_timeout,
          created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        configId,
        orgId,
        goalsJson,
        config.enable_fingerprinting !== false ? 1 : 0,
        config.enable_cross_domain_tracking !== false ? 1 : 0,
        config.enable_performance_tracking !== false ? 1 : 0,
        config.session_timeout || 1800000,
        config.batch_size || 10,
        config.batch_timeout || 5000,
        session.user_id
      ).run();
    }

    return success(c, {
      message: "Tracking configuration updated successfully"
    });
  }
}

/**
 * POST /v1/tracking-config/snippet - Generate tracking snippet for onboarding
 */
export class GenerateTrackingSnippet extends OpenAPIRoute {
  public schema = {
    tags: ["Tracking Config"],
    summary: "Generate tracking snippet for embedding",
    operationId: "generate-tracking-snippet",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      }),
      body: contentJson(z.object({
        complexity: z.enum(['simple', 'advanced']).default('simple'),
        goals: z.record(z.string(), GoalConfigSchema).optional()
      }))
    },
    responses: {
      "200": {
        description: "Tracking snippet generated",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                snippet: z.string(),
                org_tag: z.string()
              })
            })
          }
        }
      },
      "403": {
        description: "No organization selected or access denied"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const orgId = data.query?.org_id || c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Verify user has access to this organization
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    // Get org_tag
    const orgMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings
      WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgMapping) {
      return error(c, "ORG_NOT_FOUND", "Organization tag not found", 404);
    }

    const orgTag = orgMapping.short_tag;
    const complexity = data.body.complexity;
    const goals = data.body.goals || {};

    let snippet = '';

    if (complexity === 'simple') {
      // Simple snippet with data attributes only
      const goalsAttr = Object.keys(goals).length > 0
        ? `\n    data-goals='${JSON.stringify(goals)}'`
        : '';

      const cdnBase = c.env.CDN_BASE_URL || 'https://cdn.clearlift.ai';
      snippet = `<!-- Clearlift Analytics - Simple Integration -->
<script
    src="${cdnBase}/v3/clearlift-3.0.0.js"
    data-org-tag="${orgTag}"${goalsAttr}
    async
></script>`;
    } else {
      // Advanced snippet with JavaScript API
      const goalsCode = Object.keys(goals).length > 0
        ? `\n\n  // Configure goals
  clearlift.setGoals(${JSON.stringify(goals, null, 2)});`
        : '';

      const cdnBaseAdv = c.env.CDN_BASE_URL || 'https://cdn.clearlift.ai';
      snippet = `<!-- Clearlift Analytics - Advanced Integration -->
<script
    src="${cdnBaseAdv}/v3/clearlift-3.0.0.js"
    data-org-tag="${orgTag}"
    async
></script>

<script>
  // Wait for clearlift to load
  window.addEventListener('load', function() {
    if (window.clearlift) {${goalsCode}

      // Track custom events
      // clearlift.track('custom_event', { key: 'value' });

      // Identify user after login
      // clearlift.identify('user@example.com', { plan: 'pro' });

      // Reset on logout
      // clearlift.reset();
    }
  });
</script>`;
    }

    return success(c, {
      snippet,
      org_tag: orgTag
    });
  }
}
