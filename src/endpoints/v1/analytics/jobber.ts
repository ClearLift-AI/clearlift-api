/**
 * Jobber Analytics Endpoint
 *
 * Retrieve and analyze Jobber revenue data (completed jobs as conversions)
 * NOTE: Requires jobber tables to be populated in D1 ANALYTICS_DB
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";

/**
 * GET /v1/analytics/jobber/revenue
 * Get Jobber revenue analytics (completed jobs)
 */
export class GetJobberRevenue extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get Jobber revenue analytics",
    description: "Retrieve Jobber completed jobs as conversion revenue data",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional(),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        group_by: z.enum(['day', 'week', 'month']).optional().default('day'),
      })
    },
    responses: {
      "200": {
        description: "Jobber revenue analytics data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                summary: z.object({
                  total_revenue: z.number(),
                  job_count: z.number(),
                  avg_job_value: z.number(),
                  unique_clients: z.number()
                }),
                time_series: z.array(z.object({
                  date: z.string(),
                  revenue: z.number(),
                  jobs: z.number()
                }))
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const query = await this.getValidatedData<typeof this.schema>();
    const orgId = query.query.org_id || c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    // Verify user has access to this organization
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    // Check if Jobber is connected
    const connection = await c.env.DB.prepare(`
      SELECT id FROM platform_connections
      WHERE organization_id = ? AND platform = 'jobber' AND is_active = 1
    `).bind(orgId).first<{ id: string }>();

    if (!connection) {
      return success(c, {
        summary: {
          total_revenue: 0,
          job_count: 0,
          avg_job_value: 0,
          unique_clients: 0
        },
        time_series: [],
        sync_status: "No Jobber connection found. Connect Jobber to see revenue data."
      });
    }

    // TODO: Query Jobber data from D1 when tables are available
    // For now, return empty results as the jobber tables need to be
    // created and populated by the Jobber sync workflow.
    console.log(`[Jobber] Query for org ${orgId} - returning empty (D1 tables not yet populated)`);

    return success(c, {
      summary: {
        total_revenue: 0,
        job_count: 0,
        avg_job_value: 0,
        unique_clients: 0
      },
      time_series: [],
      sync_status: "Jobber data migration to D1 in progress. Data will appear after sync completes."
    });
  }

  private generateTimeSeries(
    records: any[],
    groupBy: string
  ): { date: string; revenue: number; jobs: number }[] {
    const grouped = new Map<string, { revenue: number; jobs: number }>();

    for (const record of records) {
      const completedAt = record.completed_at;
      if (!completedAt) continue;

      const date = this.getGroupKey(completedAt, groupBy);
      const existing = grouped.get(date) || { revenue: 0, jobs: 0 };
      existing.revenue += (record.total_amount_cents || 0) / 100;
      existing.jobs += 1;
      grouped.set(date, existing);
    }

    return Array.from(grouped.entries())
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private getGroupKey(dateStr: string, groupBy: string): string {
    const date = new Date(dateStr);

    switch (groupBy) {
      case 'week': {
        const startOfWeek = new Date(date);
        startOfWeek.setDate(date.getDate() - date.getDay());
        return startOfWeek.toISOString().split('T')[0];
      }
      case 'month':
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
      case 'day':
      default:
        return date.toISOString().split('T')[0];
    }
  }
}
