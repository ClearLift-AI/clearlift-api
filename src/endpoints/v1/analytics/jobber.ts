/**
 * Jobber Analytics Endpoint
 *
 * Retrieve and analyze Jobber revenue data (completed jobs as conversions)
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { getSecret } from "../../../utils/secrets";

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

    // Initialize Supabase client
    const { SupabaseClient } = await import("../../../services/supabase");

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      serviceKey: await getSecret(c.env.SUPABASE_SECRET_KEY) || ''
    });

    // Query completed jobs from Supabase (jobber schema)
    // Jobs are conversions when status = 'COMPLETED'
    const { data: jobs, error: queryError } = await supabase.client
      .schema('jobber')
      .from('jobs')
      .select('*')
      .eq('organization_id', orgId)
      .eq('job_status', 'COMPLETED')
      .gte('completed_at', query.query.date_from)
      .lte('completed_at', query.query.date_to + 'T23:59:59Z')
      .is('deleted_at', null)
      .order('completed_at', { ascending: true });

    if (queryError) {
      console.error('Jobber query error:', queryError);
      return success(c, {
        summary: {
          total_revenue: 0,
          job_count: 0,
          avg_job_value: 0,
          unique_clients: 0
        },
        time_series: [],
        sync_status: "Error querying Jobber data. Sync may not have completed."
      });
    }

    const records = jobs || [];

    // Calculate summary metrics
    const totalRevenueCents = records.reduce((sum, r) => sum + (r.total_amount_cents || 0), 0);
    const jobCount = records.length;
    const uniqueClients = new Set(records.map(r => r.client_id).filter(Boolean)).size;

    const summary = {
      total_revenue: totalRevenueCents / 100,
      job_count: jobCount,
      avg_job_value: jobCount > 0 ? (totalRevenueCents / jobCount) / 100 : 0,
      unique_clients: uniqueClients
    };

    // Generate time series
    const timeSeries = this.generateTimeSeries(records, query.query.group_by || 'day');

    return success(c, {
      summary,
      time_series: timeSeries,
      connection_id: connection.id
    });
  }

  private generateTimeSeries(
    records: any[],
    groupBy: 'day' | 'week' | 'month'
  ): Array<{ date: string; revenue: number; jobs: number }> {
    const grouped: Record<string, { revenue: number; jobs: number }> = {};

    for (const record of records) {
      if (!record.completed_at) continue;

      const date = this.getGroupedDate(record.completed_at.split('T')[0], groupBy);

      if (!grouped[date]) {
        grouped[date] = { revenue: 0, jobs: 0 };
      }

      grouped[date].revenue += record.total_amount_cents || 0;
      grouped[date].jobs += 1;
    }

    return Object.entries(grouped)
      .map(([date, data]) => ({
        date,
        revenue: data.revenue / 100,
        jobs: data.jobs
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private getGroupedDate(date: string, groupBy: 'day' | 'week' | 'month'): string {
    const d = new Date(date);

    switch (groupBy) {
      case 'week':
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff);
        return d.toISOString().split('T')[0];

      case 'month':
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

      default:
        return date;
    }
  }
}

/**
 * GET /v1/analytics/jobber/invoices
 * Get Jobber invoice analytics (paid invoices)
 */
export class GetJobberInvoices extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get Jobber invoice analytics",
    description: "Retrieve Jobber paid invoices as revenue data",
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
        description: "Jobber invoice analytics data"
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

    // Verify user has access
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
          invoice_count: 0,
          avg_invoice_value: 0,
          unique_clients: 0
        },
        time_series: [],
        sync_status: "No Jobber connection found."
      });
    }

    // Initialize Supabase client
    const { SupabaseClient } = await import("../../../services/supabase");

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      serviceKey: await getSecret(c.env.SUPABASE_SECRET_KEY) || ''
    });

    // Query paid invoices from Supabase (jobber schema)
    const { data: invoices, error: queryError } = await supabase.client
      .schema('jobber')
      .from('invoices')
      .select('*')
      .eq('organization_id', orgId)
      .eq('invoice_status', 'PAID')
      .gte('paid_at', query.query.date_from)
      .lte('paid_at', query.query.date_to + 'T23:59:59Z')
      .is('deleted_at', null)
      .order('paid_at', { ascending: true });

    if (queryError) {
      console.error('Jobber invoices query error:', queryError);
      return success(c, {
        summary: {
          total_revenue: 0,
          invoice_count: 0,
          avg_invoice_value: 0,
          unique_clients: 0
        },
        time_series: [],
        sync_status: "Error querying Jobber data."
      });
    }

    const records = invoices || [];

    // Calculate summary
    const totalRevenueCents = records.reduce((sum: number, r: any) => sum + (r.paid_amount_cents || r.total_amount_cents || 0), 0);
    const invoiceCount = records.length;
    const uniqueClients = new Set(records.map((r: any) => r.client_id).filter(Boolean)).size;

    const summary = {
      total_revenue: totalRevenueCents / 100,
      invoice_count: invoiceCount,
      avg_invoice_value: invoiceCount > 0 ? (totalRevenueCents / invoiceCount) / 100 : 0,
      unique_clients: uniqueClients
    };

    // Generate time series
    const grouped: Record<string, { revenue: number; invoices: number }> = {};
    const groupBy = query.query.group_by || 'day';

    for (const record of records) {
      if (!record.paid_at) continue;

      const date = this.getGroupedDate(record.paid_at.split('T')[0], groupBy);

      if (!grouped[date]) {
        grouped[date] = { revenue: 0, invoices: 0 };
      }

      grouped[date].revenue += record.paid_amount_cents || record.total_amount_cents || 0;
      grouped[date].invoices += 1;
    }

    const timeSeries = Object.entries(grouped)
      .map(([date, data]) => ({
        date,
        revenue: data.revenue / 100,
        invoices: data.invoices
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return success(c, {
      summary,
      time_series: timeSeries,
      connection_id: connection.id
    });
  }

  private getGroupedDate(date: string, groupBy: 'day' | 'week' | 'month'): string {
    const d = new Date(date);

    switch (groupBy) {
      case 'week':
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff);
        return d.toISOString().split('T')[0];

      case 'month':
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

      default:
        return date;
    }
  }
}
