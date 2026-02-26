import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { nanoid } from "nanoid";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { structuredLog } from "../../../utils/structured-logger";

export class EnsureTagConnection extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Ensure adbliss_tag platform_connections row exists",
    operationId: "tag-ensure",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Tag connection ensured",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connection_id: z.string(),
                created: z.boolean()
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    try {
      const session = c.get("session");
      const orgId = c.req.query("org_id");

      if (!orgId) {
        return error(c, "MISSING_ORG", "org_id is required", 400);
      }

      // Check if connection already exists
      const existing = await c.env.DB.prepare(
        `SELECT id FROM platform_connections WHERE organization_id = ? AND platform = 'adbliss_tag' AND account_id = 'internal'`
      ).bind(orgId).first<{ id: string }>();

      if (existing) {
        return success(c, { connection_id: existing.id, created: false });
      }

      // Auto-create platform_connections row for adbliss_tag
      const connectionId = nanoid(21);
      await c.env.DB.prepare(`
        INSERT INTO platform_connections (
          id, organization_id, platform, account_id, account_name,
          connected_by, connected_at, is_active, settings
        ) VALUES (?, ?, 'adbliss_tag', 'internal', 'AdBliss Tag', ?, datetime('now'), 1,
          json('{"auto_sync":false}'))
        ON CONFLICT(organization_id, platform, account_id) DO NOTHING
      `).bind(connectionId, orgId, session.user_id).run();

      structuredLog('INFO', 'Tag connection ensured', {
        endpoint: 'tag-ensure',
        organization_id: orgId,
        connection_id: connectionId
      });

      return success(c, { connection_id: connectionId, created: true });
    } catch (err: any) {
      structuredLog('ERROR', 'Failed to ensure tag connection', {
        endpoint: 'tag-ensure',
        error: err instanceof Error ? err.message : String(err)
      });
      return error(c, "INTERNAL_ERROR", `Failed to ensure tag connection: ${err.message}`, 500);
    }
  }
}
