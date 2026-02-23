/**
 * Admin Analysis Costs Endpoint
 *
 * Returns LLM cost tracking data from analysis_jobs for admin monitoring.
 */

import { OpenAPIRoute } from 'chanfana';
import { z } from 'zod';
import { success, error } from '../../../utils/response';
import { AppContext } from '../../../types';
import { D1Adapter } from '../../../adapters/d1';

/**
 * Helper to check admin access
 */
async function requireAdmin(c: AppContext): Promise<{ user: any; d1: D1Adapter } | Response> {
  const session = c.get('session');
  const d1 = new D1Adapter(c.env.DB);
  const user = await d1.getUser(session.user_id);

  if (!user || !user.is_admin) {
    return error(c, 'FORBIDDEN', 'Admin access required', 403);
  }

  return { user, d1 };
}

/**
 * GET /v1/admin/analysis/costs - Get LLM cost tracking data
 */
export class AdminGetAnalysisCosts extends OpenAPIRoute {
  public schema = {
    tags: ['Admin Analysis'],
    summary: 'Get analysis LLM costs',
    description: 'Returns per-run and per-org LLM cost data from analysis jobs (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        date_from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        date_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
        org_id: z.string().optional().describe('Filter by organization'),
        limit: z.string().optional().default('50'),
        offset: z.string().optional().default('0'),
      })
    },
    responses: {
      '200': {
        description: 'Analysis cost data',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { date_from, date_to, org_id } = data.query;
    const limit = parseInt(data.query.limit) || 50;
    const offset = parseInt(data.query.offset) || 0;

    // Build WHERE conditions
    const conditions: string[] = ['aj.status = \'completed\''];
    const bindings: any[] = [];

    if (date_from) {
      conditions.push('aj.created_at >= ?');
      bindings.push(date_from);
    }
    if (date_to) {
      conditions.push('aj.created_at <= ?');
      bindings.push(date_to + 'T23:59:59Z');
    }
    if (org_id) {
      conditions.push('aj.organization_id = ?');
      bindings.push(org_id);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // 1. Per-run data (paginated)
    const runsQuery = `
      SELECT
        aj.id,
        aj.organization_id,
        o.name as org_name,
        aj.created_at,
        aj.completed_at,
        aj.days,
        aj.total_input_tokens,
        aj.total_output_tokens,
        aj.estimated_cost_cents,
        aj.llm_provider,
        aj.llm_model,
        aj.stopped_reason
      FROM analysis_jobs aj
      LEFT JOIN organizations o ON aj.organization_id = o.id
      ${whereClause}
      ORDER BY aj.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const runsResult = await c.env.DB.prepare(runsQuery)
      .bind(...bindings, limit, offset)
      .all<{
        id: string;
        organization_id: string;
        org_name: string | null;
        created_at: string;
        completed_at: string | null;
        days: number;
        total_input_tokens: number;
        total_output_tokens: number;
        estimated_cost_cents: number;
        llm_provider: string | null;
        llm_model: string | null;
        stopped_reason: string | null;
      }>();

    // 2. Per-org aggregation
    const orgAggQuery = `
      SELECT
        aj.organization_id,
        o.name as org_name,
        COUNT(*) as run_count,
        SUM(aj.total_input_tokens) as total_input_tokens,
        SUM(aj.total_output_tokens) as total_output_tokens,
        SUM(aj.estimated_cost_cents) as total_cost_cents,
        MAX(aj.created_at) as last_run_at
      FROM analysis_jobs aj
      LEFT JOIN organizations o ON aj.organization_id = o.id
      ${whereClause}
      GROUP BY aj.organization_id
      ORDER BY total_cost_cents DESC
    `;

    const orgAggResult = await c.env.DB.prepare(orgAggQuery)
      .bind(...bindings)
      .all<{
        organization_id: string;
        org_name: string | null;
        run_count: number;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cost_cents: number;
        last_run_at: string;
      }>();

    // 3. Platform totals
    const totalsQuery = `
      SELECT
        COUNT(*) as total_runs,
        SUM(aj.total_input_tokens) as total_input_tokens,
        SUM(aj.total_output_tokens) as total_output_tokens,
        SUM(aj.estimated_cost_cents) as total_cost_cents
      FROM analysis_jobs aj
      ${whereClause}
    `;

    const totalsResult = await c.env.DB.prepare(totalsQuery)
      .bind(...bindings)
      .first<{
        total_runs: number;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cost_cents: number;
      }>();

    // 4. Count total for pagination
    const countQuery = `
      SELECT COUNT(*) as total FROM analysis_jobs aj ${whereClause}
    `;
    const countResult = await c.env.DB.prepare(countQuery)
      .bind(...bindings)
      .first<{ total: number }>();

    return success(c, {
      runs: runsResult.results || [],
      per_org: orgAggResult.results || [],
      totals: {
        total_runs: totalsResult?.total_runs || 0,
        total_input_tokens: totalsResult?.total_input_tokens || 0,
        total_output_tokens: totalsResult?.total_output_tokens || 0,
        total_cost_cents: totalsResult?.total_cost_cents || 0,
      },
      pagination: {
        total: countResult?.total || 0,
        limit,
        offset,
      }
    });
  }
}
