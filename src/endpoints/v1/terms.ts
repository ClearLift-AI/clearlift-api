import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";

/**
 * POST /v1/terms/accept - Accept Terms of Service and Data Processing Agreement
 */
export class AcceptTerms extends OpenAPIRoute {
  public schema = {
    tags: ["Terms"],
    summary: "Accept Terms of Service and Data Processing Agreement",
    operationId: "accept-terms",
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          organization_id: z.string().uuid(),
          terms_version: z.string().default('1.0')
        })
      )
    },
    responses: {
      "201": {
        description: "Terms accepted successfully",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                id: z.string(),
                user_id: z.string(),
                organization_id: z.string(),
                terms_version: z.string(),
                accepted_at: z.string()
              })
            })
          }
        }
      },
      "403": {
        description: "Access denied to organization"
      },
      "409": {
        description: "Terms already accepted for this organization"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const { organization_id, terms_version } = data.body;

    // Verify user has access to this organization
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(organization_id, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    // Check if already accepted
    const existing = await c.env.DB.prepare(`
      SELECT id FROM terms_acceptance
      WHERE user_id = ? AND organization_id = ? AND terms_version = ?
    `).bind(session.user_id, organization_id, terms_version).first();

    if (existing) {
      // Return success anyway - don't block the user, just don't insert a duplicate
      return success(c, {
        id: existing.id as string,
        user_id: session.user_id,
        organization_id,
        terms_version,
        accepted_at: new Date().toISOString(),
        already_accepted: true
      });
    }

    // Record acceptance with request metadata
    const id = crypto.randomUUID();
    const ipAddress = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const userAgent = c.req.header('User-Agent') || 'unknown';

    await c.env.DB.prepare(`
      INSERT INTO terms_acceptance (id, user_id, organization_id, terms_version, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, session.user_id, organization_id, terms_version, ipAddress, userAgent).run();

    const record = await c.env.DB.prepare(`
      SELECT id, user_id, organization_id, terms_version, accepted_at
      FROM terms_acceptance WHERE id = ?
    `).bind(id).first();

    return c.json({
      success: true,
      data: {
        id: record?.id,
        user_id: record?.user_id,
        organization_id: record?.organization_id,
        terms_version: record?.terms_version,
        accepted_at: record?.accepted_at
      }
    }, 201);
  }
}

/**
 * GET /v1/terms/status - Get terms acceptance status for current user
 */
export class GetTermsStatus extends OpenAPIRoute {
  public schema = {
    tags: ["Terms"],
    summary: "Get terms acceptance status",
    operationId: "get-terms-status",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      })
    },
    responses: {
      "200": {
        description: "Terms acceptance status",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                has_accepted: z.boolean(),
                acceptance: z.object({
                  terms_version: z.string(),
                  accepted_at: z.string()
                }).optional()
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
    const orgId = data.query?.org_id;

    // If org_id provided, check acceptance for that specific org
    // Otherwise, check if user has accepted for any org (for UI state)
    let acceptance;

    if (orgId) {
      // Verify user has access to this organization
      const memberCheck = await c.env.DB.prepare(`
        SELECT 1 FROM organization_members
        WHERE organization_id = ? AND user_id = ?
      `).bind(orgId, session.user_id).first();

      if (!memberCheck) {
        return error(c, "FORBIDDEN", "Access denied to this organization", 403);
      }

      acceptance = await c.env.DB.prepare(`
        SELECT terms_version, accepted_at
        FROM terms_acceptance
        WHERE user_id = ? AND organization_id = ?
        ORDER BY accepted_at DESC
        LIMIT 1
      `).bind(session.user_id, orgId).first();
    } else {
      // Get latest acceptance for any org
      acceptance = await c.env.DB.prepare(`
        SELECT terms_version, accepted_at
        FROM terms_acceptance
        WHERE user_id = ?
        ORDER BY accepted_at DESC
        LIMIT 1
      `).bind(session.user_id).first();
    }

    return success(c, {
      has_accepted: !!acceptance,
      acceptance: acceptance ? {
        terms_version: acceptance.terms_version as string,
        accepted_at: acceptance.accepted_at as string
      } : undefined
    });
  }
}
