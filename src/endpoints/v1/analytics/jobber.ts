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

    const dateFrom = query.query.date_from;
    const dateTo = query.query.date_to;
    const groupBy = query.query.group_by || 'day';

    // Query completed jobs summary from ANALYTICS_DB
    const summaryResult = await c.env.ANALYTICS_DB.prepare(`
      SELECT
        COUNT(*) as job_count,
        COALESCE(SUM(total_amount_cents), 0) as total_revenue_cents,
        COUNT(DISTINCT client_id) as unique_clients
      FROM jobber_jobs
      WHERE organization_id = ?
        AND connection_id = ?
        AND is_completed = 1
        AND completed_at >= ?
        AND completed_at <= ?
    `).bind(orgId, connection.id, dateFrom, dateTo + 'T23:59:59Z').first<{
      job_count: number;
      total_revenue_cents: number;
      unique_clients: number;
    }>();

    const jobCount = summaryResult?.job_count || 0;
    const totalRevenueCents = summaryResult?.total_revenue_cents || 0;
    const uniqueClients = summaryResult?.unique_clients || 0;

    // Query time series
    let dateFormat: string;
    switch (groupBy) {
      case 'week':
        dateFormat = "strftime('%Y-W%W', completed_at)";
        break;
      case 'month':
        dateFormat = "strftime('%Y-%m', completed_at)";
        break;
      default:
        dateFormat = "date(completed_at)";
    }

    const timeSeriesResult = await c.env.ANALYTICS_DB.prepare(`
      SELECT
        ${dateFormat} as date,
        COUNT(*) as jobs,
        COALESCE(SUM(total_amount_cents), 0) as revenue_cents
      FROM jobber_jobs
      WHERE organization_id = ?
        AND connection_id = ?
        AND is_completed = 1
        AND completed_at >= ?
        AND completed_at <= ?
      GROUP BY ${dateFormat}
      ORDER BY date ASC
    `).bind(orgId, connection.id, dateFrom, dateTo + 'T23:59:59Z').all<{
      date: string;
      jobs: number;
      revenue_cents: number;
    }>();

    const timeSeries = (timeSeriesResult.results || []).map(row => ({
      date: row.date,
      revenue: row.revenue_cents / 100,
      jobs: row.jobs,
    }));

    console.log(`[Jobber] Query for org ${orgId} returned ${jobCount} completed jobs`);

    return success(c, {
      summary: {
        total_revenue: totalRevenueCents / 100,
        job_count: jobCount,
        avg_job_value: jobCount > 0 ? (totalRevenueCents / 100) / jobCount : 0,
        unique_clients: uniqueClients
      },
      time_series: timeSeries
    });
  }
}

/**
 * GET /v1/analytics/jobber/invoices
 * Get Jobber invoice details
 * NOTE: Requires jobber_invoices table in D1 ANALYTICS_DB
 */
export class GetJobberInvoices extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get Jobber invoices",
    description: "Retrieve Jobber invoice data",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional(),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        status: z.enum(['paid', 'unpaid', 'overdue', 'all']).optional().default('all'),
        limit: z.coerce.number().int().min(1).max(100).optional().default(50),
      })
    },
    responses: {
      "200": {
        description: "Jobber invoices data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                invoices: z.array(z.object({
                  id: z.string(),
                  invoice_number: z.string(),
                  client_name: z.string(),
                  amount_cents: z.number(),
                  status: z.string(),
                  due_date: z.string().nullable(),
                  paid_at: z.string().nullable(),
                  created_at: z.string(),
                })),
                summary: z.object({
                  total_invoices: z.number(),
                  total_amount_cents: z.number(),
                  paid_amount_cents: z.number(),
                  unpaid_amount_cents: z.number(),
                })
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
        invoices: [],
        summary: {
          total_invoices: 0,
          total_amount_cents: 0,
          paid_amount_cents: 0,
          unpaid_amount_cents: 0,
        },
        sync_status: "No Jobber connection found. Connect Jobber to see invoice data."
      });
    }

    const dateFrom = query.query.date_from || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateTo = query.query.date_to || new Date().toISOString().slice(0, 10);
    const statusFilter = query.query.status || 'all';
    const limit = query.query.limit || 50;

    // Build status filter
    let statusClause = '';
    if (statusFilter === 'paid') {
      statusClause = 'AND is_paid = 1';
    } else if (statusFilter === 'unpaid') {
      statusClause = "AND is_paid = 0 AND status != 'overdue'";
    } else if (statusFilter === 'overdue') {
      statusClause = "AND status = 'overdue'";
    }

    // Query invoices from ANALYTICS_DB
    const invoicesResult = await c.env.ANALYTICS_DB.prepare(`
      SELECT
        id,
        invoice_number,
        client_name,
        total_cents as amount_cents,
        status,
        due_date,
        paid_at,
        jobber_created_at as created_at
      FROM jobber_invoices
      WHERE organization_id = ?
        AND connection_id = ?
        AND jobber_created_at >= ?
        AND jobber_created_at <= ?
        ${statusClause}
      ORDER BY jobber_created_at DESC
      LIMIT ?
    `).bind(orgId, connection.id, dateFrom, dateTo + 'T23:59:59Z', limit).all<{
      id: string;
      invoice_number: string;
      client_name: string;
      amount_cents: number;
      status: string;
      due_date: string | null;
      paid_at: string | null;
      created_at: string;
    }>();

    const invoices = (invoicesResult.results || []).map(row => ({
      id: row.id,
      invoice_number: row.invoice_number || '',
      client_name: row.client_name || 'Unknown',
      amount_cents: row.amount_cents || 0,
      status: row.status || 'unknown',
      due_date: row.due_date,
      paid_at: row.paid_at,
      created_at: row.created_at,
    }));

    // Query summary
    const summaryResult = await c.env.ANALYTICS_DB.prepare(`
      SELECT
        COUNT(*) as total_invoices,
        COALESCE(SUM(total_cents), 0) as total_amount_cents,
        COALESCE(SUM(CASE WHEN is_paid = 1 THEN total_cents ELSE 0 END), 0) as paid_amount_cents,
        COALESCE(SUM(CASE WHEN is_paid = 0 THEN balance_due_cents ELSE 0 END), 0) as unpaid_amount_cents
      FROM jobber_invoices
      WHERE organization_id = ?
        AND connection_id = ?
        AND jobber_created_at >= ?
        AND jobber_created_at <= ?
    `).bind(orgId, connection.id, dateFrom, dateTo + 'T23:59:59Z').first<{
      total_invoices: number;
      total_amount_cents: number;
      paid_amount_cents: number;
      unpaid_amount_cents: number;
    }>();

    console.log(`[Jobber] Invoices query for org ${orgId} returned ${invoices.length} invoices`);

    return success(c, {
      invoices,
      summary: {
        total_invoices: summaryResult?.total_invoices || 0,
        total_amount_cents: summaryResult?.total_amount_cents || 0,
        paid_amount_cents: summaryResult?.paid_amount_cents || 0,
        unpaid_amount_cents: summaryResult?.unpaid_amount_cents || 0,
      }
    });
  }
}
