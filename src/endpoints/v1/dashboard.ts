import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";

/**
 * GET /v1/dashboard/layout - Get dashboard layout for an organization
 */
export class GetDashboardLayout extends OpenAPIRoute {
  public schema = {
    tags: ["Dashboard"],
    summary: "Get dashboard layout",
    operationId: "get-dashboard-layout",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      })
    },
    responses: {
      "200": {
        description: "Dashboard layout (null if none saved)",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.any().nullable()
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

    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const row = await c.env.DB.prepare(
      `SELECT layout_json, updated_at FROM dashboard_layouts WHERE organization_id = ?`
    ).bind(orgId).first();

    if (!row) {
      return success(c, null);
    }

    try {
      const layout = JSON.parse(row.layout_json as string);
      return success(c, { layout, updated_at: row.updated_at });
    } catch {
      return success(c, null);
    }
  }
}

/**
 * POST /v1/dashboard/layout - Save dashboard layout for an organization
 */
export class SaveDashboardLayout extends OpenAPIRoute {
  public schema = {
    tags: ["Dashboard"],
    summary: "Save dashboard layout",
    operationId: "save-dashboard-layout",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional()
      }),
      body: contentJson(
        z.object({
          version: z.number(),
          activeTabId: z.string(),
          tabs: z.array(z.object({
            id: z.string(),
            label: z.string(),
            widgets: z.array(z.any()),
            templateSource: z.string().optional()
          }))
        })
      )
    },
    responses: {
      "200": {
        description: "Layout saved",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean()
            })
          }
        }
      },
      "403": {
        description: "No organization or insufficient permissions"
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

    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const layoutJson = JSON.stringify(data.body);

    await c.env.DB.prepare(`
      INSERT INTO dashboard_layouts (organization_id, layout_json, updated_by)
      VALUES (?, ?, ?)
      ON CONFLICT(organization_id) DO UPDATE SET
        layout_json = excluded.layout_json,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).bind(orgId, layoutJson, session.user_id).run();

    return success(c, { saved: true });
  }
}
