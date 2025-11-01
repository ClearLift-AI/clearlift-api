import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";

const MatrixSettingsSchema = z.object({
  growth_strategy: z.enum(['lean', 'balanced', 'bold']),
  budget_optimization: z.enum(['conservative', 'moderate', 'aggressive']),
  ai_control: z.enum(['copilot', 'autopilot']),
  daily_cap_cents: z.number().int().positive().optional().nullable(),
  monthly_cap_cents: z.number().int().positive().optional().nullable(),
  pause_threshold_percent: z.number().int().min(0).max(100).optional().nullable()
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

    // Verify user has access to this organization
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const settings = await c.env.DB.prepare(`
      SELECT
        growth_strategy,
        budget_optimization,
        ai_control,
        daily_cap_cents,
        monthly_cap_cents,
        pause_threshold_percent
      FROM ai_optimization_settings
      WHERE org_id = ?
    `).bind(orgId).first();

    if (!settings) {
      // Return defaults if no settings exist
      return success(c, {
        growth_strategy: 'balanced',
        budget_optimization: 'moderate',
        ai_control: 'copilot',
        daily_cap_cents: null,
        monthly_cap_cents: null,
        pause_threshold_percent: null
      });
    }

    return success(c, {
      growth_strategy: settings.growth_strategy,
      budget_optimization: settings.budget_optimization,
      ai_control: settings.ai_control,
      daily_cap_cents: settings.daily_cap_cents,
      monthly_cap_cents: settings.monthly_cap_cents,
      pause_threshold_percent: settings.pause_threshold_percent
    });
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

    // Verify user has access to this organization
    const memberCheck = await c.env.DB.prepare(`
      SELECT role FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const body = data.body;

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
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(org_id) DO UPDATE SET
        growth_strategy = excluded.growth_strategy,
        budget_optimization = excluded.budget_optimization,
        ai_control = excluded.ai_control,
        daily_cap_cents = excluded.daily_cap_cents,
        monthly_cap_cents = excluded.monthly_cap_cents,
        pause_threshold_percent = excluded.pause_threshold_percent,
        updated_at = datetime('now')
    `).bind(
      orgId,
      body.growth_strategy,
      body.budget_optimization,
      body.ai_control,
      body.daily_cap_cents || null,
      body.monthly_cap_cents || null,
      body.pause_threshold_percent || null
    ).run();

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
        status: z.enum(['pending', 'accepted', 'rejected', 'expired']).optional(),
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
                decision_id: z.string(),
                org_id: z.string(),
                recommended_action: z.string(),
                parameters: z.any(),
                reason: z.string(),
                impact: z.number(), // 7-day CaC impact percentage
                confidence: z.enum(['low', 'medium', 'high']),
                status: z.enum(['pending', 'accepted', 'rejected', 'expired']),
                expires_at: z.string(),
                created_at: z.string(),
                reviewed_at: z.string().nullable(),
                applied_at: z.string().nullable()
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

    // Verify user has access
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    let query = `
      SELECT
        decision_id,
        org_id,
        recommended_action,
        parameters,
        reason,
        impact,
        confidence,
        status,
        expires_at,
        created_at,
        reviewed_at,
        applied_at
      FROM ai_decisions
      WHERE org_id = ?
    `;

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

    // Sort by confidence (high first) then created date
    query += ` ORDER BY
      CASE confidence
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 1
      END DESC,
      created_at DESC
    `;

    const stmt = c.env.DB.prepare(query);
    const result = await stmt.bind(...bindings).all();

    // Parse JSON parameters
    const decisions = (result.results || []).map((row: any) => ({
      ...row,
      parameters: JSON.parse(row.parameters)
    }));

    return success(c, decisions);
  }
}

/**
 * POST /v1/settings/ai-decisions/:decision_id/accept - Accept a recommendation
 */
export class AcceptAIDecision extends OpenAPIRoute {
  public schema = {
    tags: ["Settings"],
    summary: "Accept an AI recommendation",
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
        description: "Decision accepted",
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

    // Verify decision exists and belongs to org
    const decision = await c.env.DB.prepare(`
      SELECT status FROM ai_decisions
      WHERE decision_id = ? AND org_id = ?
    `).bind(data.params.decision_id, orgId).first();

    if (!decision) {
      return error(c, "NOT_FOUND", "Decision not found", 404);
    }

    if (decision.status !== 'pending') {
      return error(c, "INVALID_STATUS", "Decision has already been reviewed", 400);
    }

    // Update status
    await c.env.DB.prepare(`
      UPDATE ai_decisions
      SET status = 'accepted',
          reviewed_at = datetime('now')
      WHERE decision_id = ?
    `).bind(data.params.decision_id).run();

    return success(c, { message: "Decision accepted successfully" });
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
        description: "Decision rejected",
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

    // Verify decision exists and belongs to org
    const decision = await c.env.DB.prepare(`
      SELECT status FROM ai_decisions
      WHERE decision_id = ? AND org_id = ?
    `).bind(data.params.decision_id, orgId).first();

    if (!decision) {
      return error(c, "NOT_FOUND", "Decision not found", 404);
    }

    if (decision.status !== 'pending') {
      return error(c, "INVALID_STATUS", "Decision has already been reviewed", 400);
    }

    // Update status
    await c.env.DB.prepare(`
      UPDATE ai_decisions
      SET status = 'rejected',
          reviewed_at = datetime('now')
      WHERE decision_id = ?
    `).bind(data.params.decision_id).run();

    return success(c, { message: "Decision rejected successfully" });
  }
}
