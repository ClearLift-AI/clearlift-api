import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";
import { CacheService } from "../../services/cache";

const MatrixSettingsSchema = z.object({
  growth_strategy: z.enum(['lean', 'balanced', 'bold']),
  budget_optimization: z.enum(['conservative', 'moderate', 'aggressive']),
  ai_control: z.enum(['copilot', 'autopilot']),
  daily_cap_cents: z.number().int().positive().optional().nullable(),
  monthly_cap_cents: z.number().int().positive().optional().nullable(),
  pause_threshold_percent: z.number().int().min(0).max(100).optional().nullable(),
  conversion_source: z.enum(['ad_platforms', 'tag', 'connectors']).optional(),
  // Platforms to exclude from conversion display (e.g., ['stripe', 'jobber'])
  disabled_conversion_sources: z.array(z.string()).optional(),
  custom_instructions: z.string().max(5000).optional().nullable(),
  // Business type determines how conversions/revenue are calculated in Real-Time:
  // - 'ecommerce': Conversions = Stripe charges, Revenue = Stripe revenue
  // - 'lead_gen': Conversions = Tag goal events, Revenue hidden
  // - 'saas': Conversions = New subscriptions, Revenue = MRR from Stripe
  business_type: z.enum(['ecommerce', 'lead_gen', 'saas']).optional(),
  // LLM provider settings
  llm_default_provider: z.enum(['auto', 'claude', 'gemini']).optional(),
  llm_claude_model: z.enum(['opus', 'sonnet', 'haiku']).optional(),
  llm_gemini_model: z.enum(['pro', 'flash', 'flash_lite']).optional(),
  llm_max_recommendations: z.number().int().min(1).max(10).optional(),
  llm_enable_exploration: z.boolean().optional()
});

/**
 * GET /v1/settings/matrix - Get optimization matrix settings
 */
export class GetMatrixSettings extends OpenAPIRoute {
  public schema = {
    tags: ["Settings"],
    summary: "Get optimization matrix settings",
    operationId: "get-matrix-settings",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      })
    },
    responses: {
      "200": {
        description: "Matrix settings",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: MatrixSettingsSchema
            })
          }
        }
      },
      "403": {
        description: "No organization selected"
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

    // Verify user has access to this organization (handles super admin bypass)
    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    // Use KV cache for settings (5 min TTL)
    const cache = new CacheService(c.env.CACHE);
    const cacheKey = CacheService.orgSettingsKey(orgId);

    const settingsData = await cache.getOrSet(cacheKey, async () => {
      const settings = await c.env.DB.prepare(`
        SELECT
          growth_strategy,
          budget_optimization,
          ai_control,
          daily_cap_cents,
          monthly_cap_cents,
          pause_threshold_percent,
          conversion_source,
          disabled_conversion_sources,
          custom_instructions,
          business_type,
          llm_default_provider,
          llm_claude_model,
          llm_gemini_model,
          llm_max_recommendations,
          llm_enable_exploration
        FROM ai_optimization_settings
        WHERE org_id = ?
      `).bind(orgId).first();

      if (!settings) {
        // Return defaults if no settings exist
        return {
          growth_strategy: 'balanced',
          budget_optimization: 'moderate',
          ai_control: 'copilot',
          daily_cap_cents: null,
          monthly_cap_cents: null,
          pause_threshold_percent: null,
          conversion_source: 'tag',
          disabled_conversion_sources: [],
          custom_instructions: null,
          business_type: 'lead_gen',
          llm_default_provider: 'auto',
          llm_claude_model: 'haiku',
          llm_gemini_model: 'flash',
          llm_max_recommendations: 3,
          llm_enable_exploration: true
        };
      }

      // Parse disabled_conversion_sources from JSON string
      let disabledSources: string[] = [];
      try {
        const raw = (settings as any).disabled_conversion_sources;
        if (raw) {
          disabledSources = JSON.parse(raw);
        }
      } catch {
        disabledSources = [];
      }

      return {
        growth_strategy: settings.growth_strategy,
        budget_optimization: settings.budget_optimization,
        ai_control: settings.ai_control,
        daily_cap_cents: settings.daily_cap_cents,
        monthly_cap_cents: settings.monthly_cap_cents,
        pause_threshold_percent: settings.pause_threshold_percent,
        conversion_source: settings.conversion_source,
        disabled_conversion_sources: disabledSources,
        custom_instructions: settings.custom_instructions,
        business_type: (settings as any).business_type || 'lead_gen',
        llm_default_provider: (settings as any).llm_default_provider || 'auto',
        llm_claude_model: (settings as any).llm_claude_model || 'haiku',
        llm_gemini_model: (settings as any).llm_gemini_model || 'flash',
        llm_max_recommendations: (settings as any).llm_max_recommendations || 3,
        llm_enable_exploration: (settings as any).llm_enable_exploration !== 0
      };
    }, 300); // 5 min TTL

    return success(c, settingsData);
  }
}

/**
 * POST /v1/settings/matrix - Update optimization matrix settings
 */
export class UpdateMatrixSettings extends OpenAPIRoute {
  public schema = {
    tags: ["Settings"],
    summary: "Update optimization matrix settings",
    operationId: "update-matrix-settings",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      }),
      body: contentJson(MatrixSettingsSchema)
    },
    responses: {
      "200": {
        description: "Settings updated",
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

    // Verify user has access to this organization (handles super admin bypass)
    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const body = data.body;

    // Serialize disabled_conversion_sources to JSON
    const disabledSourcesJson = JSON.stringify(body.disabled_conversion_sources || []);

    // Upsert settings (insert or update if exists)
    await c.env.DB.prepare(`
      INSERT INTO ai_optimization_settings (
        org_id,
        growth_strategy,
        budget_optimization,
        ai_control,
        daily_cap_cents,
        monthly_cap_cents,
        pause_threshold_percent,
        conversion_source,
        disabled_conversion_sources,
        custom_instructions,
        business_type,
        llm_default_provider,
        llm_claude_model,
        llm_gemini_model,
        llm_max_recommendations,
        llm_enable_exploration,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(org_id) DO UPDATE SET
        growth_strategy = excluded.growth_strategy,
        budget_optimization = excluded.budget_optimization,
        ai_control = excluded.ai_control,
        daily_cap_cents = excluded.daily_cap_cents,
        monthly_cap_cents = excluded.monthly_cap_cents,
        pause_threshold_percent = excluded.pause_threshold_percent,
        conversion_source = excluded.conversion_source,
        disabled_conversion_sources = excluded.disabled_conversion_sources,
        custom_instructions = excluded.custom_instructions,
        business_type = excluded.business_type,
        llm_default_provider = excluded.llm_default_provider,
        llm_claude_model = excluded.llm_claude_model,
        llm_gemini_model = excluded.llm_gemini_model,
        llm_max_recommendations = excluded.llm_max_recommendations,
        llm_enable_exploration = excluded.llm_enable_exploration,
        updated_at = datetime('now')
    `).bind(
      orgId,
      body.growth_strategy,
      body.budget_optimization,
      body.ai_control,
      body.daily_cap_cents || null,
      body.monthly_cap_cents || null,
      body.pause_threshold_percent || null,
      body.conversion_source || 'tag',
      disabledSourcesJson,
      body.custom_instructions || null,
      body.business_type || 'lead_gen',
      body.llm_default_provider || 'auto',
      body.llm_claude_model || 'haiku',
      body.llm_gemini_model || 'flash',
      body.llm_max_recommendations || 3,
      body.llm_enable_exploration !== false ? 1 : 0
    ).run();

    // Invalidate cache after update
    const cache = new CacheService(c.env.CACHE);
    await cache.invalidate(CacheService.orgSettingsKey(orgId));

    return success(c, { message: "Settings updated successfully" });
  }
}

/**
 * GET /v1/settings/ai-decisions - Get AI recommendations/decisions
 */
export class GetAIDecisions extends OpenAPIRoute {
  public schema = {
    tags: ["Settings"],
    summary: "Get AI recommendations",
    operationId: "get-ai-decisions",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional(),
        status: z.enum(['pending', 'approved', 'rejected', 'executed', 'failed', 'expired', 'acknowledged']).optional(),
        min_confidence: z.enum(['low', 'medium', 'high']).optional()
      })
    },
    responses: {
      "200": {
        description: "AI decisions",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                id: z.string(),
                organization_id: z.string(),
                tool: z.string(),
                platform: z.string(),
                entity_type: z.string(),
                entity_id: z.string(),
                entity_name: z.string(),
                parameters: z.any(),
                current_state: z.any(),
                reason: z.string(),
                predicted_impact: z.number().nullable(),
                confidence: z.enum(['low', 'medium', 'high']),
                supporting_data: z.any(),
                status: z.string(),
                expires_at: z.string(),
                created_at: z.string(),
                reviewed_at: z.string().nullable(),
                executed_at: z.string().nullable()
              }))
            })
          }
        }
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

    // Verify user has access (handles super admin bypass)
    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    let query = `SELECT * FROM ai_decisions WHERE organization_id = ?`;
    const bindings: any[] = [orgId];

    // Filter by status if provided
    if (data.query?.status) {
      query += ` AND status = ?`;
      bindings.push(data.query.status);
    } else {
      // Default to pending only
      query += ` AND status = 'pending' AND expires_at > datetime('now')`;
    }

    // Filter by confidence if provided
    if (data.query?.min_confidence) {
      const confidenceOrder = ['low', 'medium', 'high'];
      const minIndex = confidenceOrder.indexOf(data.query.min_confidence);
      const allowedConfidences = confidenceOrder.slice(minIndex);
      query += ` AND confidence IN (${allowedConfidences.map(() => '?').join(',')})`;
      bindings.push(...allowedConfidences);
    }

    // Sort by confidence (high first) then predicted impact
    query += ` ORDER BY
      CASE confidence WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      predicted_impact ASC,
      created_at DESC
      LIMIT 50
    `;

    const result = await c.env.AI_DB.prepare(query).bind(...bindings).all();

    // Parse JSON fields
    const decisions = (result.results || []).map((row: any) => ({
      ...row,
      parameters: JSON.parse(row.parameters || '{}'),
      current_state: JSON.parse(row.current_state || '{}'),
      supporting_data: JSON.parse(row.supporting_data || '{}'),
      // Include simulation data for detailed display
      simulation_data: row.simulation_data ? JSON.parse(row.simulation_data) : null,
      simulation_confidence: row.simulation_confidence || null
    }));

    return success(c, decisions);
  }
}

/**
 * POST /v1/settings/ai-decisions/:decision_id/accept - Accept and execute a recommendation
 */
export class AcceptAIDecision extends OpenAPIRoute {
  public schema = {
    tags: ["Settings"],
    summary: "Accept and execute an AI recommendation",
    operationId: "accept-ai-decision",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        decision_id: z.string()
      }),
      query: z.object({
        org_id: z.string().optional()
      })
    },
    responses: {
      "200": {
        description: "Decision accepted and executed"
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

    // Verify user has access to this organization (handles super admin bypass)
    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    // Get decision from AI_DB
    const decision = await c.env.AI_DB.prepare(`
      SELECT * FROM ai_decisions WHERE id = ? AND organization_id = ?
    `).bind(data.params.decision_id, orgId).first<any>();

    if (!decision) {
      return error(c, "NOT_FOUND", "Decision not found", 404);
    }

    if (decision.status !== 'pending') {
      return error(c, "INVALID_STATUS", `Decision is ${decision.status}, not pending`, 400);
    }

    if (new Date(decision.expires_at) < new Date()) {
      await c.env.AI_DB.prepare(`UPDATE ai_decisions SET status = 'expired' WHERE id = ?`).bind(decision.id).run();
      return error(c, "EXPIRED", "Decision has expired", 400);
    }

    // Mark as approved
    await c.env.AI_DB.prepare(`
      UPDATE ai_decisions
      SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ?
      WHERE id = ?
    `).bind(session.user_id, decision.id).run();

    // Execute the action
    try {
      const result = await this.executeDecision(c, decision, orgId);

      await c.env.AI_DB.prepare(`
        UPDATE ai_decisions
        SET status = 'executed', executed_at = datetime('now'), execution_result = ?
        WHERE id = ?
      `).bind(JSON.stringify(result), decision.id).run();

      return success(c, { id: decision.id, status: "executed", result });
    } catch (err: any) {
      await c.env.AI_DB.prepare(`
        UPDATE ai_decisions SET status = 'failed', error_message = ? WHERE id = ?
      `).bind(err.message, decision.id).run();

      return error(c, "EXECUTION_FAILED", err.message, 500);
    }
  }

  private async executeDecision(c: AppContext, decision: any, orgId: string): Promise<any> {
    const { platform, entity_type, entity_id } = decision;
    const params = JSON.parse(decision.parameters || '{}');

    // Normalize tool name: simulation-executor renames set_status → pause/enable in DB
    let tool = decision.tool;
    if (tool === 'pause') { tool = 'set_status'; if (!params.status) params.status = params.recommended_status || 'PAUSED'; }
    else if (tool === 'enable') { tool = 'set_status'; if (!params.status) params.status = params.recommended_status || 'ENABLED'; }
    // Normalize param: LLM stores recommended_status, execute expects status
    if (tool === 'set_status' && !params.status && params.recommended_status) {
      params.status = params.recommended_status;
    }

    // Get platform connection
    const connection = await c.env.DB.prepare(`
      SELECT id FROM platform_connections
      WHERE organization_id = ? AND platform = ? AND is_active = 1
      LIMIT 1
    `).bind(orgId, platform).first<{ id: string }>();

    if (!connection) {
      throw new Error(`No active ${platform} connection`);
    }

    // Get access token
    const { getSecret } = await import("../../utils/secrets");
    const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
    if (!encryptionKey) throw new Error("Encryption key not configured");

    const { ConnectorService } = await import("../../services/connectors");
    const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
    const accessToken = await connectorService.getAccessToken(connection.id);

    if (!accessToken) throw new Error("Failed to retrieve access token");

    // Execute based on platform
    if (platform === 'facebook') {
      const { FacebookAdsOAuthProvider } = await import("../../services/oauth/facebook");
      const appId = await getSecret(c.env.FACEBOOK_APP_ID);
      const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
      if (!appId || !appSecret) throw new Error("Facebook credentials not configured");

      const fb = new FacebookAdsOAuthProvider(appId, appSecret, '');

      if (tool === 'set_status') {
        if (entity_type === 'campaign') return fb.updateCampaignStatus(accessToken, entity_id, params.status);
        if (entity_type === 'ad_set') return fb.updateAdSetStatus(accessToken, entity_id, params.status);
        if (entity_type === 'ad') return fb.updateAdStatus(accessToken, entity_id, params.status);
      }
      if (tool === 'set_budget') {
        const budget = {
          daily_budget: params.budget_type === 'daily' ? params.amount_cents : undefined,
          lifetime_budget: params.budget_type === 'lifetime' ? params.amount_cents : undefined
        };
        if (entity_type === 'campaign') return fb.updateCampaignBudget(accessToken, entity_id, budget);
        if (entity_type === 'ad_set') return fb.updateAdSetBudget(accessToken, entity_id, budget);
      }
      if (tool === 'set_age_range') {
        return fb.updateAdSetTargeting(accessToken, entity_id, {
          age_min: params.min_age,
          age_max: params.max_age
        });
      }
    }

    if (platform === 'google') {
      const { GoogleAdsOAuthProvider } = await import("../../services/oauth/google");
      const clientId = await getSecret(c.env.GOOGLE_CLIENT_ID);
      const clientSecret = await getSecret(c.env.GOOGLE_CLIENT_SECRET);
      const developerToken = await getSecret(c.env.GOOGLE_ADS_DEVELOPER_TOKEN);
      if (!clientId || !clientSecret) throw new Error("Google credentials not configured");
      if (!developerToken) throw new Error("Google Ads developer token not configured");

      // Get customer ID from connection
      const connectionDetails = await c.env.DB.prepare(`
        SELECT account_id FROM platform_connections WHERE id = ?
      `).bind(connection.id).first<{ account_id: string }>();

      if (!connectionDetails?.account_id) throw new Error("No Google Ads customer ID found");
      const customerId = connectionDetails.account_id;

      const google = new GoogleAdsOAuthProvider(clientId, clientSecret, '');

      if (tool === 'set_status') {
        // Map status to Google Ads format (ENABLED, PAUSED, REMOVED)
        const googleStatus = params.status === 'ACTIVE' ? 'ENABLED' : params.status;
        if (entity_type === 'campaign') return google.updateCampaignStatus(accessToken, developerToken, customerId, entity_id, googleStatus);
        if (entity_type === 'ad_group') return google.updateAdGroupStatus(accessToken, developerToken, customerId, entity_id, googleStatus);
      }
      if (tool === 'set_budget') {
        // Google Ads uses micros (1 dollar = 1,000,000 micros), convert from cents
        const budgetMicros = params.amount_cents * 10000;
        if (entity_type === 'campaign') return google.updateCampaignBudget(accessToken, developerToken, customerId, entity_id, budgetMicros);
      }
    }

    if (platform === 'tiktok') {
      const { TikTokAdsOAuthProvider } = await import("../../services/oauth/tiktok");
      const appId = await getSecret(c.env.TIKTOK_APP_ID);
      const appSecret = await getSecret(c.env.TIKTOK_APP_SECRET);
      if (!appId || !appSecret) throw new Error("TikTok credentials not configured");

      // Get advertiser ID from connection
      const connectionDetails = await c.env.DB.prepare(`
        SELECT account_id FROM platform_connections WHERE id = ?
      `).bind(connection.id).first<{ account_id: string }>();

      if (!connectionDetails?.account_id) throw new Error("No TikTok advertiser ID found");
      const advertiserId = connectionDetails.account_id;

      const tiktok = new TikTokAdsOAuthProvider(appId, appSecret, '');

      // set_active tool (or legacy set_status)
      if (tool === 'set_status' || tool === 'set_active') {
        // Map ACTIVE/PAUSED to TikTok's ENABLE/DISABLE
        const tiktokStatus = (params.status === 'ACTIVE' || params.status === 'ENABLE') ? 'ENABLE' : 'DISABLE';
        if (entity_type === 'campaign') return tiktok.updateCampaignStatus(accessToken, advertiserId, entity_id, tiktokStatus);
        if (entity_type === 'adgroup' || entity_type === 'ad_group') return tiktok.updateAdGroupStatus(accessToken, advertiserId, entity_id, tiktokStatus);
      }

      // set_budget tool
      if (tool === 'set_budget') {
        const budgetMode = params.budget_type === 'lifetime' ? 'BUDGET_MODE_TOTAL' : 'BUDGET_MODE_DAY';
        if (entity_type === 'campaign') return tiktok.updateCampaignBudget(accessToken, advertiserId, entity_id, params.amount_cents, budgetMode);
        if (entity_type === 'adgroup' || entity_type === 'ad_group') return tiktok.updateAdGroupBudget(accessToken, advertiserId, entity_id, params.amount_cents, budgetMode);
      }

      // set_audience tool (or legacy set_age_range)
      if (tool === 'set_age_range' || tool === 'set_audience') {
        // Convert age range to TikTok age groups
        const ageGroups: string[] = [];
        const minAge = params.min_age || 18;
        const maxAge = params.max_age || 65;

        // Map age ranges to TikTok's age group enum values
        if (minAge <= 17 && maxAge >= 13) ageGroups.push('AGE_13_17');
        if (minAge <= 24 && maxAge >= 18) ageGroups.push('AGE_18_24');
        if (minAge <= 34 && maxAge >= 25) ageGroups.push('AGE_25_34');
        if (minAge <= 44 && maxAge >= 35) ageGroups.push('AGE_35_44');
        if (minAge <= 54 && maxAge >= 45) ageGroups.push('AGE_45_54');
        if (maxAge >= 55) ageGroups.push('AGE_55_100');

        return tiktok.updateAdGroupTargeting(accessToken, advertiserId, entity_id, {
          age: ageGroups,
          gender: params.gender,
          interest_category_ids: params.interest_ids,
          location_ids: params.location_ids
        });
      }
    }

    throw new Error(`Unsupported: ${tool} on ${platform}/${entity_type}`);
  }
}

/**
 * POST /v1/settings/ai-decisions/:decision_id/reject - Reject a recommendation
 */
export class RejectAIDecision extends OpenAPIRoute {
  public schema = {
    tags: ["Settings"],
    summary: "Reject an AI recommendation",
    operationId: "reject-ai-decision",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        decision_id: z.string()
      }),
      query: z.object({
        org_id: z.string().optional()
      })
    },
    responses: {
      "200": {
        description: "Decision rejected"
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

    // Verify user has access to this organization (handles super admin bypass)
    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const decision = await c.env.AI_DB.prepare(`
      SELECT status FROM ai_decisions WHERE id = ? AND organization_id = ?
    `).bind(data.params.decision_id, orgId).first();

    if (!decision) {
      return error(c, "NOT_FOUND", "Decision not found", 404);
    }

    if ((decision as any).status !== 'pending') {
      return error(c, "INVALID_STATUS", "Decision has already been reviewed", 400);
    }

    await c.env.AI_DB.prepare(`
      UPDATE ai_decisions
      SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ?
      WHERE id = ?
    `).bind(session.user_id, data.params.decision_id).run();

    return success(c, { id: data.params.decision_id, status: "rejected" });
  }
}

/**
 * POST /v1/settings/ai-decisions/:decision_id/rate - Rate an accumulated insight (1-5 stars)
 */
export class RateAIDecision extends OpenAPIRoute {
  public schema = {
    tags: ["Settings"],
    summary: "Rate an accumulated insight (1-5 stars)",
    operationId: "rate-ai-decision",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        decision_id: z.string()
      }),
      query: z.object({
        org_id: z.string().optional()
      }),
      body: contentJson(z.object({
        rating: z.number().int().min(1).max(5),
        feedback_text: z.string().max(500).optional()
      }))
    },
    responses: {
      "200": {
        description: "Rating recorded"
      },
      "400": {
        description: "Invalid request - only accumulated insights can be rated"
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

    // Verify user has access to this organization (handles super admin bypass)
    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    // Get decision from AI_DB
    const decision = await c.env.AI_DB.prepare(`
      SELECT tool, parameters, status FROM ai_decisions WHERE id = ? AND organization_id = ?
    `).bind(data.params.decision_id, orgId).first<any>();

    if (!decision) {
      return error(c, "NOT_FOUND", "Decision not found", 404);
    }

    // Only accumulated insights can be rated
    if (decision.tool !== 'accumulated_insight') {
      return error(c, "INVALID_TYPE", "Only accumulated insights can be rated. Use accept/reject for other recommendations.", 400);
    }

    // Update parameters with rating
    const params = JSON.parse(decision.parameters || '{}');
    params.rating = data.body.rating;
    params.feedback_text = data.body.feedback_text || null;
    params.rated_at = new Date().toISOString();

    await c.env.AI_DB.prepare(`
      UPDATE ai_decisions
      SET parameters = ?,
          status = 'acknowledged',
          reviewed_at = datetime('now'),
          reviewed_by = ?
      WHERE id = ?
    `).bind(JSON.stringify(params), session.user_id, data.params.decision_id).run();

    return success(c, { id: data.params.decision_id, status: "acknowledged", rating: data.body.rating });
  }
}
