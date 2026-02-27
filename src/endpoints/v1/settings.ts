import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";
import { CacheService } from "../../services/cache";

/** Safely parse a JSON string, returning fallback on any error */
function safeJsonParse(value: string | null | undefined, fallback: any = {}): any {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const MatrixSettingsSchema = z.object({
  run_frequency: z.enum(['weekly', 'daily', 'twice_daily']),
  budget_optimization: z.enum(['conservative', 'moderate', 'aggressive']),
  ai_control: z.enum(['copilot', 'autopilot']),
  daily_cap_cents: z.number().int().positive().optional().nullable(),
  monthly_cap_cents: z.number().int().positive().optional().nullable(),
  max_cac_cents: z.number().int().positive().optional().nullable(),
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
    // requireOrg middleware already validated access and resolved org_id
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Use KV cache for settings (5 min TTL)
    const cache = new CacheService(c.env.CACHE);
    const cacheKey = CacheService.orgSettingsKey(orgId);

    const settingsData = await cache.getOrSet(cacheKey, async () => {
      const settings = await c.env.DB.prepare(`
        SELECT
          run_frequency,
          budget_optimization,
          ai_control,
          daily_cap_cents,
          monthly_cap_cents,
          max_cac_cents,
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
          run_frequency: 'weekly',
          budget_optimization: 'moderate',
          ai_control: 'copilot',
          daily_cap_cents: null,
          monthly_cap_cents: null,
          max_cac_cents: null,
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
        run_frequency: (settings as any).run_frequency || 'weekly',
        budget_optimization: settings.budget_optimization,
        ai_control: settings.ai_control,
        daily_cap_cents: settings.daily_cap_cents,
        monthly_cap_cents: settings.monthly_cap_cents,
        max_cac_cents: (settings as any).max_cac_cents || null,
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
    const data = await this.getValidatedData<typeof this.schema>();
    // requireOrg middleware already validated access and resolved org_id
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    const body = data.body;

    // Serialize disabled_conversion_sources to JSON
    const disabledSourcesJson = JSON.stringify(body.disabled_conversion_sources || []);

    // Upsert settings (insert or update if exists)
    await c.env.DB.prepare(`
      INSERT INTO ai_optimization_settings (
        org_id,
        run_frequency,
        budget_optimization,
        ai_control,
        daily_cap_cents,
        monthly_cap_cents,
        max_cac_cents,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(org_id) DO UPDATE SET
        run_frequency = excluded.run_frequency,
        budget_optimization = excluded.budget_optimization,
        ai_control = excluded.ai_control,
        daily_cap_cents = excluded.daily_cap_cents,
        monthly_cap_cents = excluded.monthly_cap_cents,
        max_cac_cents = excluded.max_cac_cents,
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
      body.run_frequency,
      body.budget_optimization,
      body.ai_control,
      body.daily_cap_cents || null,
      body.monthly_cap_cents || null,
      body.max_cac_cents || null,
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
    const data = await this.getValidatedData<typeof this.schema>();
    // requireOrg middleware already validated access and resolved org_id
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    let query = `SELECT * FROM ai_decisions WHERE organization_id = ?`;
    const bindings: any[] = [orgId];

    // Filter by status if provided
    if (data.query?.status) {
      query += ` AND status = ?`;
      bindings.push(data.query.status);
    } else {
      // Default to pending only (expires_at check removed — Workflow Date bug caused premature expiry)
      query += ` AND status = 'pending'`;
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
      predicted_impact DESC,
      created_at DESC
      LIMIT 50
    `;

    const result = await c.env.DB.prepare(query).bind(...bindings).all();

    // Parse JSON fields — safe parse prevents one corrupted row from crashing the entire response
    const decisions = (result.results || []).map((row: any) => ({
      ...row,
      parameters: safeJsonParse(row.parameters),
      current_state: safeJsonParse(row.current_state),
      supporting_data: safeJsonParse(row.supporting_data),
      simulation_data: safeJsonParse(row.simulation_data, null),
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
    // requireOrg middleware already validated access and resolved org_id
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Get decision from DB
    const decision = await c.env.DB.prepare(`
      SELECT * FROM ai_decisions WHERE id = ? AND organization_id = ?
    `).bind(data.params.decision_id, orgId).first<any>();

    if (!decision) {
      return error(c, "NOT_FOUND", "Decision not found", 404);
    }

    if (decision.status !== 'pending') {
      return error(c, "INVALID_STATUS", `Decision is ${decision.status}, not pending`, 400);
    }

    // Expiry check removed — Cloudflare Workflows Date bug caused expires_at to be set
    // to ~current time instead of +7 days. Decisions are cleaned up by the next analysis run.

    // Pre-validate platform connection BEFORE marking as approved
    // This prevents the bad state where a decision is "approved" but can't execute
    const { platform } = decision;
    const connection = await c.env.DB.prepare(`
      SELECT id FROM platform_connections
      WHERE organization_id = ? AND platform = ? AND is_active = 1
      LIMIT 1
    `).bind(orgId, platform).first<{ id: string }>();

    if (!connection) {
      return error(c, "CONNECTION_INACTIVE", `No active ${platform} connection. Reconnect ${platform} in Connectors and try again.`, 400);
    }

    // Mark as approved
    await c.env.DB.prepare(`
      UPDATE ai_decisions
      SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ?
      WHERE id = ?
    `).bind(session.user_id, decision.id).run();

    // Execute the action
    try {
      const result = await this.executeDecision(c, decision, orgId);

      await c.env.DB.prepare(`
        UPDATE ai_decisions
        SET status = 'executed', executed_at = datetime('now'), execution_result = ?
        WHERE id = ?
      `).bind(JSON.stringify(result), decision.id).run();

      return success(c, { id: decision.id, status: "executed", result });
    } catch (err: any) {
      await c.env.DB.prepare(`
        UPDATE ai_decisions SET status = 'failed', error_message = ? WHERE id = ?
      `).bind(err.message, decision.id).run();

      return error(c, "EXECUTION_FAILED", err.message, 500);
    }
  }

  private async executeDecision(c: AppContext, decision: any, orgId: string): Promise<any> {
    const { platform, entity_type, entity_id } = decision;
    const params = JSON.parse(decision.parameters || '{}');

    // ── Normalize tool names ──
    // Simulation-executor renames set_status → pause/enable in DB
    let tool = decision.tool;
    if (tool === 'pause') { tool = 'set_status'; params.status = params.status || params.recommended_status || 'PAUSED'; }
    else if (tool === 'enable') { tool = 'set_status'; params.status = params.status || params.recommended_status || 'ENABLED'; }
    // LLM stores recommended_status, execution expects status
    if (tool === 'set_status' && !params.status && params.recommended_status) {
      params.status = params.recommended_status;
    }
    // Legacy set_age_range → set_audience
    if (tool === 'set_age_range') { tool = 'set_audience'; }

    // ── Normalize budget field names ──
    // LLM tool schema sends recommended_budget_cents; dashboard formatApiPayload sends amount_cents.
    // Accept both, prefer recommended_budget_cents.
    const budgetCents = params.recommended_budget_cents ?? params.amount_cents;

    // ── compound_action: execute sub-actions sequentially ──
    if (tool === 'compound_action') {
      const actions: Array<{ tool: string; entity_type?: string; entity_id: string; entity_name: string; parameters: any }> = params.actions;
      if (!actions || actions.length === 0) throw new Error('compound_action requires at least one sub-action');

      const results: any[] = [];
      const completedActions: Array<{ index: number; tool: string; entity_id: string }> = [];

      for (let i = 0; i < actions.length; i++) {
        const subAction = actions[i];
        try {
          // Build a synthetic decision object for the sub-action
          const subDecision = {
            ...decision,
            tool: subAction.tool,
            entity_type: subAction.entity_type || entity_type,
            entity_id: subAction.entity_id,
            parameters: JSON.stringify(subAction.parameters),
            platform: params.platform || platform,
          };
          const subResult = await this.executeDecision(c, subDecision, orgId);
          results.push({ step: i + 1, tool: subAction.tool, entity: subAction.entity_name, success: true, result: subResult });
          completedActions.push({ index: i, tool: subAction.tool, entity_id: subAction.entity_id });
        } catch (err: any) {
          // Record the failure and stop — don't execute remaining steps
          results.push({ step: i + 1, tool: subAction.tool, entity: subAction.entity_name, success: false, error: err.message });
          return {
            success: false,
            strategy: params.strategy,
            completed_steps: completedActions.length,
            total_steps: actions.length,
            error: `Step ${i + 1}/${actions.length} failed: ${subAction.tool} on ${subAction.entity_name}: ${err.message}`,
            results,
            note: completedActions.length > 0
              ? `${completedActions.length} step(s) already executed before failure. Manual review may be needed.`
              : 'No steps were executed before failure.',
          };
        }
      }

      return {
        success: true,
        strategy: params.strategy,
        completed_steps: actions.length,
        total_steps: actions.length,
        results,
      };
    }

    // ── Get platform connection + access token ──
    const connection = await c.env.DB.prepare(`
      SELECT id, account_id FROM platform_connections
      WHERE organization_id = ? AND platform = ? AND is_active = 1
      LIMIT 1
    `).bind(orgId, platform).first<{ id: string; account_id: string }>();

    if (!connection) {
      throw new Error(`No active ${platform} connection`);
    }

    const { getSecret } = await import("../../utils/secrets");
    const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
    if (!encryptionKey) throw new Error("Encryption key not configured");

    const { ConnectorService } = await import("../../services/connectors");
    const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
    const accessToken = await connectorService.getAccessToken(connection.id);
    if (!accessToken) throw new Error("Failed to retrieve access token");

    // ════════════════════════════════════════════════════════════
    //  FACEBOOK / META
    // ════════════════════════════════════════════════════════════
    if (platform === 'facebook') {
      const { FacebookAdsOAuthProvider } = await import("../../services/oauth/facebook");
      const appId = await getSecret(c.env.FACEBOOK_APP_ID);
      const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
      if (!appId || !appSecret) throw new Error("Facebook credentials not configured");

      const fb = new FacebookAdsOAuthProvider(appId, appSecret, '');

      // ── set_status ──
      if (tool === 'set_status') {
        // Meta uses ACTIVE/PAUSED/ARCHIVED
        const metaStatus = params.status === 'ENABLED' ? 'ACTIVE' : params.status;
        if (entity_type === 'campaign') return fb.updateCampaignStatus(accessToken, entity_id, metaStatus);
        if (entity_type === 'ad_set') return fb.updateAdSetStatus(accessToken, entity_id, metaStatus);
        if (entity_type === 'ad') return fb.updateAdStatus(accessToken, entity_id, metaStatus);
      }

      // ── set_budget ──
      if (tool === 'set_budget') {
        if (!budgetCents) throw new Error('set_budget requires recommended_budget_cents or amount_cents');
        const budget = {
          daily_budget: params.budget_type === 'daily' ? budgetCents : undefined,
          lifetime_budget: params.budget_type === 'lifetime' ? budgetCents : undefined
        };
        if (entity_type === 'campaign') return fb.updateCampaignBudget(accessToken, entity_id, budget);
        if (entity_type === 'ad_set') return fb.updateAdSetBudget(accessToken, entity_id, budget);
      }

      // ── set_bid ──
      // Maps LLM strategy names to Meta v24.0 bid_strategy enum.
      // Meta bid strategy is set at campaign level (CBO) or ad_set level.
      if (tool === 'set_bid') {
        if (entity_type !== 'campaign' && entity_type !== 'ad_set') {
          throw new Error(`set_bid for Meta only supports campaign or ad_set entities, got: ${entity_type}`);
        }
        const metaStrategy = this.mapToMetaBidStrategy(params.recommended_strategy);
        return fb.updateBidStrategy(accessToken, entity_id, {
          bid_strategy: metaStrategy,
          bid_amount: params.recommended_bid_cents,
          roas_average_floor: params.target_roas_floor,
        });
      }

      // ── set_schedule ──
      // Meta ad scheduling is ad_set level only. Requires lifetime_budget.
      if (tool === 'set_schedule') {
        if (entity_type !== 'ad_set') {
          throw new Error(`set_schedule for Meta only supports ad_set entities, got: ${entity_type}`);
        }
        const schedule = this.buildMetaSchedule(params);
        return fb.updateAdSetSchedule(accessToken, entity_id, schedule);
      }

      // ── set_audience ──
      // Meta targeting is ad_set level only.
      if (tool === 'set_audience') {
        if (entity_type !== 'ad_set') {
          throw new Error(`set_audience for Meta only supports ad_set entities, got: ${entity_type}`);
        }
        const targeting = this.buildMetaTargeting(params);
        return fb.updateAdSetTargeting(accessToken, entity_id, targeting);
      }

      // ── reallocate_budget ──
      // Compound operation: read both budgets, decrease source, increase target.
      if (tool === 'reallocate_budget') {
        return this.executeMetaReallocateBudget(fb, accessToken, params, budgetCents);
      }
    }

    // ════════════════════════════════════════════════════════════
    //  GOOGLE ADS
    // ════════════════════════════════════════════════════════════
    if (platform === 'google') {
      const { GoogleAdsOAuthProvider } = await import("../../services/oauth/google");
      const clientId = await getSecret(c.env.GOOGLE_CLIENT_ID);
      const clientSecret = await getSecret(c.env.GOOGLE_CLIENT_SECRET);
      const developerToken = await getSecret(c.env.GOOGLE_ADS_DEVELOPER_TOKEN);
      if (!clientId || !clientSecret) throw new Error("Google credentials not configured");
      if (!developerToken) throw new Error("Google Ads developer token not configured");

      const customerId = connection.account_id;
      if (!customerId) throw new Error("No Google Ads customer ID found");

      const google = new GoogleAdsOAuthProvider(clientId, clientSecret, '');

      // ── set_status ──
      if (tool === 'set_status') {
        const googleStatus = params.status === 'ACTIVE' ? 'ENABLED' : params.status;
        if (entity_type === 'campaign') return google.updateCampaignStatus(accessToken, developerToken, customerId, entity_id, googleStatus);
        if (entity_type === 'ad_group') return google.updateAdGroupStatus(accessToken, developerToken, customerId, entity_id, googleStatus);
      }

      // ── set_budget ──
      if (tool === 'set_budget') {
        if (!budgetCents) throw new Error('set_budget requires recommended_budget_cents or amount_cents');
        // Google Ads uses micros: 1 cent = 10,000 micros
        const budgetMicros = budgetCents * 10000;
        if (entity_type === 'campaign') return google.updateCampaignBudget(accessToken, developerToken, customerId, entity_id, budgetMicros);
      }

      // ── set_bid ──
      if (tool === 'set_bid') {
        const googleStrategy = this.mapToGoogleBidStrategy(params.recommended_strategy);
        return google.updateCampaignBiddingStrategy(accessToken, developerToken, customerId, entity_id, {
          type: googleStrategy,
          // Google uses micros: 1 cent = 10,000 micros
          target_cpa_micros: params.target_cpa_cents ? params.target_cpa_cents * 10000 : undefined,
          // target_roas is a float in Google (e.g. 2.0 = 200% ROAS)
          target_roas: params.target_roas_floor ? params.target_roas_floor / 10000 : undefined,
        });
      }

      // ── reallocate_budget ──
      if (tool === 'reallocate_budget') {
        return this.executeGoogleReallocateBudget(google, accessToken, developerToken, customerId, params, budgetCents);
      }

      // Note: set_schedule and set_audience are not supported for Google Ads
      // Google ad scheduling uses campaign criteria (AdSchedule), not ad set level scheduling.
      // Google audience targeting uses UserList resources, not inline targeting updates.
      // These require fundamentally different API patterns and will produce a clear error below.
    }

    // ════════════════════════════════════════════════════════════
    //  TIKTOK
    // ════════════════════════════════════════════════════════════
    if (platform === 'tiktok') {
      const { TikTokAdsOAuthProvider } = await import("../../services/oauth/tiktok");
      const appId = await getSecret(c.env.TIKTOK_APP_ID);
      const appSecret = await getSecret(c.env.TIKTOK_APP_SECRET);
      if (!appId || !appSecret) throw new Error("TikTok credentials not configured");

      const advertiserId = connection.account_id;
      if (!advertiserId) throw new Error("No TikTok advertiser ID found");

      const tiktok = new TikTokAdsOAuthProvider(appId, appSecret, '');
      const isTikTokAdGroup = entity_type === 'adgroup' || entity_type === 'ad_group';

      // ── set_status ──
      if (tool === 'set_status' || tool === 'set_active') {
        const tiktokStatus = (params.status === 'ACTIVE' || params.status === 'ENABLE' || params.status === 'ENABLED')
          ? 'ENABLE' : 'DISABLE';
        if (entity_type === 'campaign') return tiktok.updateCampaignStatus(accessToken, advertiserId, entity_id, tiktokStatus);
        if (isTikTokAdGroup) return tiktok.updateAdGroupStatus(accessToken, advertiserId, entity_id, tiktokStatus);
      }

      // ── set_budget ──
      if (tool === 'set_budget') {
        if (!budgetCents) throw new Error('set_budget requires recommended_budget_cents or amount_cents');
        const budgetMode = params.budget_type === 'lifetime' ? 'BUDGET_MODE_TOTAL' : 'BUDGET_MODE_DAY';
        if (entity_type === 'campaign') return tiktok.updateCampaignBudget(accessToken, advertiserId, entity_id, budgetCents, budgetMode);
        if (isTikTokAdGroup) return tiktok.updateAdGroupBudget(accessToken, advertiserId, entity_id, budgetCents, budgetMode);
      }

      // ── set_bid ──
      if (tool === 'set_bid') {
        // TikTok API expects bid in currency units (dollars), not cents
        const bidDollars = params.recommended_bid_cents ? params.recommended_bid_cents / 100 : undefined;
        const bidType = params.recommended_strategy === 'BID_TYPE_NO_BID' ? 'BID_TYPE_NO_BID' : 'BID_TYPE_CUSTOM';
        return tiktok.updateAdGroupBidding(accessToken, advertiserId, entity_id, {
          bid_type: bidType,
          bid_price: bidDollars,
          optimization_goal: params.optimization_goal,
        });
      }

      // ── set_schedule ──
      if (tool === 'set_schedule') {
        // TikTok dayparting: 48-char string per day (30-min slots, '0'=off '1'=on)
        const dayparting = this.buildTikTokDayparting(params);
        return tiktok.updateAdGroupSchedule(accessToken, advertiserId, entity_id, {
          dayparting: dayparting || undefined,
        });
      }

      // ── set_audience ──
      if (tool === 'set_audience') {
        const targeting = this.buildTikTokTargeting(params);
        return tiktok.updateAdGroupTargeting(accessToken, advertiserId, entity_id, targeting);
      }

      // ── reallocate_budget ──
      if (tool === 'reallocate_budget') {
        // TikTok reallocation: decrease source, increase target
        // Note: TikTok lacks a read-budget API, so we rely on LLM-provided current values.
        const fromBudgetMode = params.from_budget_type === 'lifetime' ? 'BUDGET_MODE_TOTAL' : 'BUDGET_MODE_DAY';
        const toBudgetMode = params.to_budget_type === 'lifetime' ? 'BUDGET_MODE_TOTAL' : 'BUDGET_MODE_DAY';
        const amount = params.amount_cents;
        if (!amount || amount <= 0) throw new Error('reallocate_budget requires a positive amount_cents');

        const fromId = params.from_entity_id;
        const toId = params.to_entity_id;
        if (!fromId || !toId) throw new Error('reallocate_budget requires from_entity_id and to_entity_id');

        const fromBudget = params.from_current_budget_cents;
        const toBudget = params.to_current_budget_cents;

        if (fromBudget == null) throw new Error('reallocate_budget requires from_current_budget_cents for TikTok');
        if (toBudget == null) throw new Error('reallocate_budget requires to_current_budget_cents for TikTok');

        const newFromBudget = fromBudget - amount;
        const newToBudget = toBudget + amount;

        // TikTok minimum budget: $1/day for daily, $50 lifetime
        const minBudgetCents = fromBudgetMode === 'BUDGET_MODE_TOTAL' ? 5000 : 100;
        if (newFromBudget < minBudgetCents) {
          throw new Error(
            `Cannot reallocate: source budget would drop to $${(newFromBudget / 100).toFixed(2)}, ` +
            `below $${(minBudgetCents / 100).toFixed(2)} minimum. Current: $${(fromBudget / 100).toFixed(2)}, moving: $${(amount / 100).toFixed(2)}`
          );
        }

        // Execute decrease then increase
        const isFromCampaign = (params.from_entity_type || entity_type) === 'campaign';
        const isToCampaign = (params.to_entity_type || entity_type) === 'campaign';

        const decreaseResult = isFromCampaign
          ? await tiktok.updateCampaignBudget(accessToken, advertiserId, fromId, newFromBudget, fromBudgetMode)
          : await tiktok.updateAdGroupBudget(accessToken, advertiserId, fromId, newFromBudget, fromBudgetMode);

        try {
          const increaseResult = isToCampaign
            ? await tiktok.updateCampaignBudget(accessToken, advertiserId, toId, newToBudget, toBudgetMode)
            : await tiktok.updateAdGroupBudget(accessToken, advertiserId, toId, newToBudget, toBudgetMode);

          return { success: true, decreased: decreaseResult, increased: increaseResult };
        } catch (increaseErr: any) {
          // Rollback decrease
          try {
            if (isFromCampaign) await tiktok.updateCampaignBudget(accessToken, advertiserId, fromId, fromBudget, fromBudgetMode);
            else await tiktok.updateAdGroupBudget(accessToken, advertiserId, fromId, fromBudget, fromBudgetMode);
          } catch (rollbackErr) {
            throw new Error(
              `Budget increase failed AND rollback failed. Source entity ${fromId} budget is now $${(newFromBudget / 100).toFixed(2)} ` +
              `(was $${(fromBudget / 100).toFixed(2)}). Manual correction required. ` +
              `Increase error: ${increaseErr.message}`
            );
          }
          throw new Error(`Budget increase failed (decrease was rolled back): ${increaseErr.message}`);
        }
      }
    }

    throw new Error(`Unsupported: ${tool} on ${platform}/${entity_type}`);
  }

  // ════════════════════════════════════════════════════════════
  //  Strategy mapping helpers
  // ════════════════════════════════════════════════════════════

  /**
   * Map LLM strategy name to Meta v24.0 bid_strategy enum.
   * The LLM sends platform-specific names when possible, but we also handle
   * generic names (target_cpa → COST_CAP) for robustness.
   */
  private mapToMetaBidStrategy(strategy: string): 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP' | 'LOWEST_COST_WITH_BID_CAP' | 'LOWEST_COST_WITH_MIN_ROAS' {
    const normalized = (strategy || '').toUpperCase().replace(/-/g, '_');
    const map: Record<string, 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP' | 'LOWEST_COST_WITH_BID_CAP' | 'LOWEST_COST_WITH_MIN_ROAS'> = {
      // Native Meta names
      'LOWEST_COST_WITHOUT_CAP': 'LOWEST_COST_WITHOUT_CAP',
      'COST_CAP': 'COST_CAP',
      'LOWEST_COST_WITH_BID_CAP': 'LOWEST_COST_WITH_BID_CAP',
      'LOWEST_COST_WITH_MIN_ROAS': 'LOWEST_COST_WITH_MIN_ROAS',
      // Generic fallbacks (LLM may use cross-platform names)
      'TARGET_CPA': 'COST_CAP',
      'MAXIMIZE_CONVERSIONS': 'LOWEST_COST_WITHOUT_CAP',
      'MAXIMIZE_CLICKS': 'LOWEST_COST_WITHOUT_CAP',
      'MANUAL_CPC': 'LOWEST_COST_WITH_BID_CAP',
      'TARGET_ROAS': 'LOWEST_COST_WITH_MIN_ROAS',
    };
    const result = map[normalized];
    if (!result) throw new Error(`Unknown Meta bid strategy: ${strategy}. Valid: LOWEST_COST_WITHOUT_CAP, COST_CAP, LOWEST_COST_WITH_BID_CAP, LOWEST_COST_WITH_MIN_ROAS`);
    return result;
  }

  /**
   * Map LLM strategy name to Google Ads bidding strategy type.
   */
  private mapToGoogleBidStrategy(strategy: string): 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE' | 'MANUAL_CPC' | 'TARGET_IMPRESSION_SHARE' {
    const normalized = (strategy || '').toUpperCase().replace(/-/g, '_');
    const map: Record<string, 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE' | 'MANUAL_CPC' | 'TARGET_IMPRESSION_SHARE'> = {
      // Native Google names
      'MAXIMIZE_CONVERSIONS': 'MAXIMIZE_CONVERSIONS',
      'MAXIMIZE_CONVERSION_VALUE': 'MAXIMIZE_CONVERSION_VALUE',
      'MANUAL_CPC': 'MANUAL_CPC',
      'TARGET_IMPRESSION_SHARE': 'TARGET_IMPRESSION_SHARE',
      // Aliases
      'TARGET_CPA': 'MAXIMIZE_CONVERSIONS',  // maximize_conversions + target_cpa_micros
      'TARGET_ROAS': 'MAXIMIZE_CONVERSION_VALUE',  // maximize_conversion_value + target_roas
      // Note: Google has no native MAXIMIZE_CLICKS in standard bidding.
      // Closest approximation is MANUAL_CPC (control clicks via bid).
      'MAXIMIZE_CLICKS': 'MANUAL_CPC',
    };
    const result = map[normalized];
    if (!result) throw new Error(`Unknown Google bid strategy: ${strategy}. Valid: MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, MANUAL_CPC, TARGET_IMPRESSION_SHARE`);
    return result;
  }

  // ════════════════════════════════════════════════════════════
  //  Meta schedule builder
  // ════════════════════════════════════════════════════════════

  /**
   * Convert LLM's diff-based schedule (hours_to_add/remove, days_to_add/remove)
   * into Meta's full-replacement adset_schedule format.
   *
   * The LLM sends incremental intent. We build a schedule that runs during
   * the specified hours on the specified days.
   *
   * If only days_to_remove with no additions: returns empty array (removes scheduling).
   * If hours_to_add + days_to_add: creates schedule entries for those hours on those days.
   */
  private buildMetaSchedule(params: Record<string, any>): Array<{ start_minute: number; end_minute: number; days: number[] }> {
    const hoursToAdd: number[] = params.hours_to_add || [];
    const hoursToRemove: number[] = params.hours_to_remove || [];
    const daysToAdd: number[] = params.days_to_add || [];
    const daysToRemove: number[] = params.days_to_remove || [];

    // If the LLM only wants to remove days/hours and add nothing, clear the schedule
    if (hoursToAdd.length === 0 && daysToAdd.length === 0) {
      return [];
    }

    // Determine active days: if days_to_add specified, use those minus removals.
    // If no days specified, default to all 7 days minus removals.
    let activeDays: number[];
    if (daysToAdd.length > 0) {
      activeDays = daysToAdd.filter(d => !daysToRemove.includes(d));
    } else {
      activeDays = [0, 1, 2, 3, 4, 5, 6].filter(d => !daysToRemove.includes(d));
    }

    if (activeDays.length === 0) return [];

    // Determine active hours: if hours_to_add specified, use those minus removals.
    // If no hours specified, this is a days-only change — no hour-level scheduling.
    let activeHours: number[];
    if (hoursToAdd.length > 0) {
      activeHours = hoursToAdd.filter(h => h >= 0 && h <= 23 && !hoursToRemove.includes(h)).sort((a, b) => a - b);
    } else {
      // No specific hours → run all day on the specified days
      return [{ start_minute: 0, end_minute: 1440, days: activeDays }];
    }

    if (activeHours.length === 0) return [];

    // Collapse consecutive hours into schedule entries
    // e.g. [8, 9, 10, 14, 15] → [{start_minute: 480, end_minute: 660}, {start_minute: 840, end_minute: 960}]
    const entries: Array<{ start_minute: number; end_minute: number; days: number[] }> = [];
    let rangeStart = activeHours[0];
    let rangeEnd = activeHours[0];

    for (let i = 1; i < activeHours.length; i++) {
      if (activeHours[i] === rangeEnd + 1) {
        rangeEnd = activeHours[i];
      } else {
        entries.push({
          start_minute: rangeStart * 60,
          end_minute: (rangeEnd + 1) * 60,  // end is exclusive (hour 10 ends at minute 660)
          days: activeDays
        });
        rangeStart = activeHours[i];
        rangeEnd = activeHours[i];
      }
    }
    // Push final range
    entries.push({
      start_minute: rangeStart * 60,
      end_minute: (rangeEnd + 1) * 60,
      days: activeDays
    });

    return entries;
  }

  // ════════════════════════════════════════════════════════════
  //  TikTok dayparting builder
  // ════════════════════════════════════════════════════════════

  /**
   * Convert LLM's diff-based schedule into TikTok's dayparting format.
   *
   * TikTok dayparting: JSON object where each day maps to a 48-character string
   * (48 half-hour slots, '0'=off '1'=on). Days: monday, tuesday, ..., sunday.
   *
   * Returns null if no dayparting changes (remove scheduling).
   */
  private buildTikTokDayparting(params: Record<string, any>): Record<string, string> | null {
    const hoursToAdd: number[] = params.hours_to_add || [];
    const daysToAdd: number[] = params.days_to_add || [];

    if (hoursToAdd.length === 0 && daysToAdd.length === 0) return null;

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const hoursToRemove: number[] = params.hours_to_remove || [];
    const daysToRemove: number[] = params.days_to_remove || [];

    // Determine active days (0=Sunday .. 6=Saturday)
    let activeDays: number[];
    if (daysToAdd.length > 0) {
      activeDays = daysToAdd.filter(d => !daysToRemove.includes(d));
    } else {
      activeDays = [0, 1, 2, 3, 4, 5, 6].filter(d => !daysToRemove.includes(d));
    }

    // Determine active hours
    let activeHours: number[];
    if (hoursToAdd.length > 0) {
      activeHours = hoursToAdd.filter(h => !hoursToRemove.includes(h));
    } else {
      // All hours active on specified days
      activeHours = Array.from({ length: 24 }, (_, i) => i);
    }

    const result: Record<string, string> = {};
    for (let d = 0; d < 7; d++) {
      const isActiveDay = activeDays.includes(d);
      const slots = new Array(48).fill('0');

      if (isActiveDay) {
        for (const hour of activeHours) {
          // Each hour = 2 half-hour slots
          if (hour >= 0 && hour < 24) {
            slots[hour * 2] = '1';
            slots[hour * 2 + 1] = '1';
          }
        }
      }

      result[dayNames[d]] = slots.join('');
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════
  //  Meta targeting builder
  // ════════════════════════════════════════════════════════════

  /**
   * Convert LLM set_audience params into Meta v24.0 targeting spec.
   *
   * LLM sends: age_groups (["18-24", "25-34"]), gender ("MALE"/"FEMALE"/"ALL"),
   * locations (country codes), interests (IDs), exclude_interests (IDs),
   * and legacy min_age/max_age fields.
   */
  private buildMetaTargeting(params: Record<string, any>): Record<string, any> {
    const targeting: Record<string, any> = {};

    // ── Age ──
    // LLM may send age_groups as ["18-24", "25-34"] or legacy min_age/max_age
    if (params.age_groups && params.age_groups.length > 0) {
      // Parse age ranges to find min/max
      let minAge = 65, maxAge = 18;
      for (const group of params.age_groups as string[]) {
        const match = group.match(/(\d+)[- ](\d+|\+)/);
        if (match) {
          const low = parseInt(match[1], 10);
          const high = match[2] === '+' ? 65 : parseInt(match[2], 10);
          if (low < minAge) minAge = low;
          if (high > maxAge) maxAge = high;
        }
      }
      targeting.age_min = Math.max(18, minAge);
      targeting.age_max = Math.min(65, maxAge);
    } else if (params.min_age || params.max_age) {
      if (params.min_age) targeting.age_min = Math.max(18, params.min_age);
      if (params.max_age) targeting.age_max = Math.min(65, params.max_age);
    }

    // ── Gender ──
    // Meta: genders = [1] (male), [2] (female), omit for all
    if (params.gender) {
      if (params.gender === 'MALE') targeting.genders = [1];
      else if (params.gender === 'FEMALE') targeting.genders = [2];
      // 'ALL' = omit genders field (targets all)
    }

    // ── Locations ──
    // LLM sends country codes ["US", "CA"] or location IDs
    if (params.locations && params.locations.length > 0) {
      // Detect: if items look like 2-letter codes, they're countries; otherwise region/city IDs
      const looksLikeCountryCodes = params.locations.every((l: string) => /^[A-Z]{2}$/.test(l));
      if (looksLikeCountryCodes) {
        targeting.geo_locations = { countries: params.locations };
      } else {
        targeting.geo_locations = {
          regions: params.locations.map((id: string) => ({ key: id }))
        };
      }
    }

    // ── Interests ──
    if (params.interests && params.interests.length > 0) {
      targeting.interests = params.interests.map((id: string) => ({ id }));
    }

    // ── Exclusions ──
    if (params.exclude_interests && params.exclude_interests.length > 0) {
      targeting.exclusions = {
        interests: params.exclude_interests.map((id: string) => ({ id }))
      };
    }

    return targeting;
  }

  // ════════════════════════════════════════════════════════════
  //  TikTok targeting builder
  // ════════════════════════════════════════════════════════════

  /**
   * Convert LLM set_audience params into TikTok targeting format.
   * Handles both the new set_audience format and legacy set_age_range fields.
   */
  private buildTikTokTargeting(params: Record<string, any>): { age?: string[]; gender?: 'MALE' | 'FEMALE' | 'UNLIMITED'; interest_category_ids?: string[]; location_ids?: string[] } {
    const targeting: any = {};

    // ── Age ──
    // LLM may send age_groups as TikTok-native ["AGE_18_24"] or generic ["18-24"]
    if (params.age_groups && params.age_groups.length > 0) {
      const tiktokAgeGroups: string[] = [];
      for (const group of params.age_groups as string[]) {
        if (group.startsWith('AGE_')) {
          tiktokAgeGroups.push(group);
        } else {
          // Convert generic "18-24" to "AGE_18_24"
          const match = group.match(/(\d+)[- ](\d+|\+)/);
          if (match) {
            const low = parseInt(match[1], 10);
            const high = match[2] === '+' ? 100 : parseInt(match[2], 10);
            // Map to TikTok age buckets
            if (low <= 17 && high >= 13) tiktokAgeGroups.push('AGE_13_17');
            if (low <= 24 && high >= 18) tiktokAgeGroups.push('AGE_18_24');
            if (low <= 34 && high >= 25) tiktokAgeGroups.push('AGE_25_34');
            if (low <= 44 && high >= 35) tiktokAgeGroups.push('AGE_35_44');
            if (low <= 54 && high >= 45) tiktokAgeGroups.push('AGE_45_54');
            if (high >= 55) tiktokAgeGroups.push('AGE_55_100');
          }
        }
      }
      const unique = [...new Set(tiktokAgeGroups)];
      if (unique.length > 0) targeting.age = unique;
    } else if (params.min_age || params.max_age) {
      // Legacy set_age_range format
      const ageGroups: string[] = [];
      const minAge = params.min_age || 18;
      const maxAge = params.max_age || 65;
      if (minAge <= 17 && maxAge >= 13) ageGroups.push('AGE_13_17');
      if (minAge <= 24 && maxAge >= 18) ageGroups.push('AGE_18_24');
      if (minAge <= 34 && maxAge >= 25) ageGroups.push('AGE_25_34');
      if (minAge <= 44 && maxAge >= 35) ageGroups.push('AGE_35_44');
      if (minAge <= 54 && maxAge >= 45) ageGroups.push('AGE_45_54');
      if (maxAge >= 55) ageGroups.push('AGE_55_100');
      if (ageGroups.length > 0) targeting.age = ageGroups;
    }

    // ── Gender ──
    if (params.gender) {
      if (params.gender === 'ALL') targeting.gender = 'UNLIMITED';
      else targeting.gender = params.gender;
    }

    // ── Interests ──
    if (params.interests && params.interests.length > 0) {
      targeting.interest_category_ids = params.interests;
    } else if (params.interest_ids) {
      targeting.interest_category_ids = params.interest_ids;
    }

    // ── Locations ──
    if (params.locations && params.locations.length > 0) {
      targeting.location_ids = params.locations;
    } else if (params.location_ids) {
      targeting.location_ids = params.location_ids;
    }

    return targeting;
  }

  // ════════════════════════════════════════════════════════════
  //  Meta budget reallocation (compound operation)
  // ════════════════════════════════════════════════════════════

  /**
   * Execute budget reallocation for Meta/Facebook.
   *
   * 1. Read current budgets of both entities (validates they exist)
   * 2. Decrease source budget by amount_cents
   * 3. Increase target budget by amount_cents
   * 4. If increase fails, rollback the decrease
   *
   * Validates: minimum budget constraints, budget type consistency, CBO conflicts.
   */
  private async executeMetaReallocateBudget(
    fb: InstanceType<typeof import("../../services/oauth/facebook").FacebookAdsOAuthProvider>,
    accessToken: string,
    params: Record<string, any>,
    amountCents: number | undefined
  ): Promise<any> {
    const amount = amountCents ?? params.amount_cents;
    if (!amount || amount <= 0) throw new Error('reallocate_budget requires a positive amount_cents');

    const fromId = params.from_entity_id;
    const toId = params.to_entity_id;
    if (!fromId || !toId) throw new Error('reallocate_budget requires from_entity_id and to_entity_id');

    // Read current budgets
    const [fromBudget, toBudget] = await Promise.all([
      fb.readEntityBudget(accessToken, fromId),
      fb.readEntityBudget(accessToken, toId),
    ]);

    // Determine budget type (daily or lifetime) from source entity
    const isDaily = fromBudget.daily_budget !== null;
    const isLifetime = fromBudget.lifetime_budget !== null;
    if (!isDaily && !isLifetime) throw new Error(`Source entity ${fromId} has no budget set`);

    const currentFromBudget = isDaily ? fromBudget.daily_budget! : fromBudget.lifetime_budget!;
    const currentToBudget = isDaily
      ? (toBudget.daily_budget ?? 0)
      : (toBudget.lifetime_budget ?? 0);

    const newFromBudget = currentFromBudget - amount;
    const newToBudget = currentToBudget + amount;

    // Validate minimum budget
    if (newFromBudget < 100) {  // $1.00 minimum
      throw new Error(
        `Cannot reallocate: source budget would drop to $${(newFromBudget / 100).toFixed(2)}, ` +
        `below $1.00 minimum. Current: $${(currentFromBudget / 100).toFixed(2)}, moving: $${(amount / 100).toFixed(2)}`
      );
    }

    // For lifetime budgets, validate minimum: Meta requires lifetime ≥ daily spend * remaining days.
    // We use a conservative $1.00 floor already checked above; the API will enforce stricter rules.
    // Note: We cannot validate the 10% spent rule client-side since spend requires the Insights API.

    // Build budget objects
    const budgetKey = isDaily ? 'daily_budget' : 'lifetime_budget';
    const fromBudgetObj = { [budgetKey]: newFromBudget };
    const toBudgetObj = { [budgetKey]: newToBudget };

    // Step 1: Decrease source
    const fromEntityType = params.from_entity_type || 'campaign';
    const toEntityType = params.to_entity_type || 'campaign';

    const decreaseResult = fromEntityType === 'ad_set'
      ? await fb.updateAdSetBudget(accessToken, fromId, fromBudgetObj)
      : await fb.updateCampaignBudget(accessToken, fromId, fromBudgetObj);

    // Step 2: Increase target
    try {
      const increaseResult = toEntityType === 'ad_set'
        ? await fb.updateAdSetBudget(accessToken, toId, toBudgetObj)
        : await fb.updateCampaignBudget(accessToken, toId, toBudgetObj);

      return {
        success: true,
        from: { entity_id: fromId, old_budget: currentFromBudget, new_budget: newFromBudget },
        to: { entity_id: toId, old_budget: currentToBudget, new_budget: newToBudget },
        amount_moved: amount,
        decreased: decreaseResult,
        increased: increaseResult,
      };
    } catch (increaseErr: any) {
      // Rollback: restore source budget
      try {
        const rollbackObj = { [budgetKey]: currentFromBudget };
        if (fromEntityType === 'ad_set') await fb.updateAdSetBudget(accessToken, fromId, rollbackObj);
        else await fb.updateCampaignBudget(accessToken, fromId, rollbackObj);
      } catch (rollbackErr) {
        throw new Error(
          `Budget increase failed AND rollback failed. Source entity ${fromId} budget is now ` +
          `$${(newFromBudget / 100).toFixed(2)} (was $${(currentFromBudget / 100).toFixed(2)}). ` +
          `Manual correction required. Increase error: ${increaseErr.message}`
        );
      }
      throw new Error(`Budget increase on ${toId} failed (decrease on ${fromId} was rolled back): ${increaseErr.message}`);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  Google budget reallocation (compound operation)
  // ════════════════════════════════════════════════════════════

  private async executeGoogleReallocateBudget(
    google: InstanceType<typeof import("../../services/oauth/google").GoogleAdsOAuthProvider>,
    accessToken: string,
    developerToken: string,
    customerId: string,
    params: Record<string, any>,
    amountCents: number | undefined
  ): Promise<any> {
    const amount = amountCents ?? params.amount_cents;
    if (!amount || amount <= 0) throw new Error('reallocate_budget requires a positive amount_cents');

    const fromId = params.from_entity_id;
    const toId = params.to_entity_id;
    if (!fromId || !toId) throw new Error('reallocate_budget requires from_entity_id and to_entity_id');

    // Google Ads: budgets are in micros (1 cent = 10,000 micros)
    const amountMicros = amount * 10000;

    // Read current budgets
    const [fromBudget, toBudget] = await Promise.all([
      google.readCampaignBudget(accessToken, developerToken, customerId, fromId),
      google.readCampaignBudget(accessToken, developerToken, customerId, toId),
    ]);

    const newFromMicros = fromBudget.budget_amount_micros - amountMicros;
    const newToMicros = toBudget.budget_amount_micros + amountMicros;

    // Google minimum daily budget: $1.00 = 1,000,000 micros
    if (newFromMicros < 1000000) {
      throw new Error(
        `Cannot reallocate: source budget would drop to $${(newFromMicros / 1000000).toFixed(2)}, below $1.00 minimum`
      );
    }

    // Step 1: Decrease source
    await google.updateCampaignBudget(accessToken, developerToken, customerId, fromId, newFromMicros);

    // Step 2: Increase target
    try {
      await google.updateCampaignBudget(accessToken, developerToken, customerId, toId, newToMicros);

      return {
        success: true,
        from: { entity_id: fromId, old_budget_micros: fromBudget.budget_amount_micros, new_budget_micros: newFromMicros },
        to: { entity_id: toId, old_budget_micros: toBudget.budget_amount_micros, new_budget_micros: newToMicros },
        amount_moved_cents: amount,
      };
    } catch (increaseErr: any) {
      // Rollback
      try {
        await google.updateCampaignBudget(accessToken, developerToken, customerId, fromId, fromBudget.budget_amount_micros);
      } catch (rollbackErr) {
        throw new Error(
          `Budget increase failed AND rollback failed. Source campaign ${fromId} budget is now ` +
          `$${(newFromMicros / 1000000).toFixed(2)}. Manual correction required. Error: ${increaseErr.message}`
        );
      }
      throw new Error(`Budget increase on ${toId} failed (decrease on ${fromId} was rolled back): ${increaseErr.message}`);
    }
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
    // requireOrg middleware already validated access and resolved org_id
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    const decision = await c.env.DB.prepare(`
      SELECT status FROM ai_decisions WHERE id = ? AND organization_id = ?
    `).bind(data.params.decision_id, orgId).first();

    if (!decision) {
      return error(c, "NOT_FOUND", "Decision not found", 404);
    }

    if ((decision as any).status !== 'pending') {
      return error(c, "INVALID_STATUS", "Decision has already been reviewed", 400);
    }

    await c.env.DB.prepare(`
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
    // requireOrg middleware already validated access and resolved org_id
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Get decision from DB
    const decision = await c.env.DB.prepare(`
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

    await c.env.DB.prepare(`
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
