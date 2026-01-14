/**
 * Admin CRM Endpoints
 *
 * Organization and connection management for system administrators
 */

import { OpenAPIRoute, contentJson } from 'chanfana';
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
 * GET /v1/admin/organizations - List all organizations
 */
export class AdminListOrganizations extends OpenAPIRoute {
  public schema = {
    tags: ['Admin CRM'],
    summary: 'List all organizations',
    description: 'Get all organizations with optional search and filtering (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        search: z.string().optional().describe('Search by name, slug, or org_tag'),
        subscription_tier: z.string().optional().describe('Filter by tier'),
        limit: z.string().optional().default('20'),
        offset: z.string().optional().default('0'),
      })
    },
    responses: {
      '200': {
        description: 'List of organizations',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                items: z.array(z.any()),
                total: z.number(),
              }),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { search, subscription_tier } = data.query;
    const limit = parseInt(data.query.limit) || 20;
    const offset = parseInt(data.query.offset) || 0;

    // Build query
    let query = `
      SELECT
        o.id,
        o.name,
        o.slug,
        otm.short_tag as org_tag,
        o.subscription_tier,
        o.created_at,
        (SELECT MAX(u.last_login_at) FROM users u
         JOIN organization_members om2 ON u.id = om2.user_id
         WHERE om2.organization_id = o.id) as last_activity_at,
        (SELECT COUNT(*) FROM organization_members om WHERE om.organization_id = o.id) as members_count,
        (SELECT COUNT(*) FROM platform_connections pc WHERE pc.organization_id = o.id AND pc.is_active = 1) as connections_count
      FROM organizations o
      LEFT JOIN org_tag_mappings otm ON o.id = otm.organization_id AND otm.is_active = 1
      WHERE 1=1
    `;

    const params: any[] = [];

    if (search) {
      query += ` AND (o.name LIKE ? OR o.slug LIKE ? OR otm.short_tag LIKE ?)`;
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    if (subscription_tier) {
      query += ` AND o.subscription_tier = ?`;
      params.push(subscription_tier);
    }

    // Count query
    let countQuery = `SELECT COUNT(DISTINCT o.id) as count FROM organizations o
      LEFT JOIN org_tag_mappings otm ON o.id = otm.organization_id AND otm.is_active = 1
      WHERE 1=1`;
    if (search) {
      countQuery += ` AND (o.name LIKE ? OR o.slug LIKE ? OR otm.short_tag LIKE ?)`;
    }
    if (subscription_tier) {
      countQuery += ` AND o.subscription_tier = ?`;
    }

    const countParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];
    if (subscription_tier) countParams.push(subscription_tier);

    const totalResult = await c.env.DB.prepare(countQuery).bind(...countParams).first<{ count: number }>();

    // Main query with pagination
    query += ` ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const orgs = await c.env.DB.prepare(query).bind(...params).all();

    return success(c, {
      items: orgs.results || [],
      total: totalResult?.count || 0,
    });
  }
}

/**
 * GET /v1/admin/organizations/:id - Get organization details
 */
export class AdminGetOrganization extends OpenAPIRoute {
  public schema = {
    tags: ['Admin CRM'],
    summary: 'Get organization details',
    description: 'Get detailed information about an organization including members and connections (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe('Organization ID'),
      })
    },
    responses: {
      '200': {
        description: 'Organization details',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              data: z.any(),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { id } = data.params;

    // Get organization
    const org = await c.env.DB.prepare(`
      SELECT
        o.*,
        otm.short_tag as org_tag
      FROM organizations o
      LEFT JOIN org_tag_mappings otm ON o.id = otm.organization_id AND otm.is_active = 1
      WHERE o.id = ?
    `).bind(id).first();

    if (!org) {
      return error(c, 'NOT_FOUND', 'Organization not found', 404);
    }

    // Get members
    const members = await c.env.DB.prepare(`
      SELECT
        u.id, u.name, u.email, u.is_admin, u.last_login_at,
        om.role, om.joined_at
      FROM organization_members om
      JOIN users u ON om.user_id = u.id
      WHERE om.organization_id = ?
      ORDER BY om.joined_at ASC
    `).bind(id).all();

    // Get connections
    const connections = await c.env.DB.prepare(`
      SELECT
        id, platform, account_id, account_name, is_active,
        sync_status, sync_error, last_synced_at, connected_at
      FROM platform_connections
      WHERE organization_id = ?
      ORDER BY connected_at DESC
    `).bind(id).all();

    // Get settings
    const settings = {
      default_attribution_model: org.default_attribution_model,
      attribution_window_days: org.attribution_window_days,
      ai_control: org.ai_control,
      growth_strategy: org.growth_strategy,
      budget_optimization: org.budget_optimization,
      custom_instructions: org.custom_instructions,
    };

    return success(c, {
      ...org,
      settings,
      members: members.results || [],
      connections: connections.results || [],
    });
  }
}

/**
 * PATCH /v1/admin/organizations/:id - Update organization
 */
export class AdminUpdateOrganization extends OpenAPIRoute {
  public schema = {
    tags: ['Admin CRM'],
    summary: 'Update organization',
    description: 'Update organization settings (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe('Organization ID'),
      }),
      body: contentJson(
        z.object({
          name: z.string().optional(),
          slug: z.string().optional(),
          subscription_tier: z.string().optional(),
        })
      )
    },
    responses: {
      '200': {
        description: 'Organization updated',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;
    const { user } = result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { id } = data.params;
    const updates = data.body;

    // Build update query
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.slug !== undefined) {
      fields.push('slug = ?');
      values.push(updates.slug);
    }
    if (updates.subscription_tier !== undefined) {
      fields.push('subscription_tier = ?');
      values.push(updates.subscription_tier);
    }

    if (fields.length === 0) {
      return error(c, 'BAD_REQUEST', 'No fields to update', 400);
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    await c.env.DB.prepare(`
      UPDATE organizations SET ${fields.join(', ')} WHERE id = ?
    `).bind(...values).run();

    // Log the admin action
    await c.env.DB.prepare(`
      INSERT INTO audit_logs (id, timestamp, user_id, action, resource_type, resource_id, success, metadata)
      VALUES (?, ?, ?, 'admin_update_org', 'organization', ?, 1, ?)
    `).bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      user.id,
      id,
      JSON.stringify({ updates, admin_action: true })
    ).run();

    return success(c, { message: 'Organization updated' });
  }
}

/**
 * POST /v1/admin/connections/:id/sync - Force sync a connection
 */
export class AdminForceSync extends OpenAPIRoute {
  public schema = {
    tags: ['Admin CRM'],
    summary: 'Force sync connection',
    description: 'Force trigger a sync for a specific connection (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe('Connection ID'),
      })
    },
    responses: {
      '200': {
        description: 'Sync triggered',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;
    const { user } = result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { id } = data.params;

    // Get connection
    const connection = await c.env.DB.prepare(`
      SELECT * FROM platform_connections WHERE id = ?
    `).bind(id).first();

    if (!connection) {
      return error(c, 'NOT_FOUND', 'Connection not found', 404);
    }

    // Create sync job
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO sync_jobs (id, organization_id, connection_id, status, job_type, created_at, metadata)
      VALUES (?, ?, ?, 'pending', 'full', ?, ?)
    `).bind(
      jobId,
      connection.organization_id,
      id,
      now,
      JSON.stringify({
        triggered_by: user.id,
        admin_force_sync: true,
        platform: connection.platform,
      })
    ).run();

    // Send to queue
    await c.env.SYNC_QUEUE.send({
      job_id: jobId,
      organization_id: connection.organization_id,
      connection_id: id,
      platform: connection.platform,
      account_id: connection.account_id,
      job_type: 'full',
      metadata: {
        triggered_by: user.id,
        admin_force_sync: true,
        created_at: now,
      }
    });

    return success(c, { job_id: jobId });
  }
}

/**
 * POST /v1/admin/connections/:id/reset - Reset connection
 */
export class AdminResetConnection extends OpenAPIRoute {
  public schema = {
    tags: ['Admin CRM'],
    summary: 'Reset connection',
    description: 'Reset connection error state and refresh tokens (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe('Connection ID'),
      })
    },
    responses: {
      '200': {
        description: 'Connection reset',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;
    const { user } = result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { id } = data.params;

    // Reset connection error state
    await c.env.DB.prepare(`
      UPDATE platform_connections
      SET sync_status = 'pending', sync_error = NULL, updated_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), id).run();

    // Log the action
    await c.env.DB.prepare(`
      INSERT INTO audit_logs (id, timestamp, user_id, action, resource_type, resource_id, success, metadata)
      VALUES (?, ?, ?, 'admin_reset_connection', 'connection', ?, 1, ?)
    `).bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      user.id,
      id,
      JSON.stringify({ admin_action: true })
    ).run();

    return success(c, { message: 'Connection reset' });
  }
}

/**
 * DELETE /v1/admin/connections/:id - Disconnect connection
 */
export class AdminDisconnect extends OpenAPIRoute {
  public schema = {
    tags: ['Admin CRM'],
    summary: 'Disconnect connection',
    description: 'Deactivate a platform connection (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe('Connection ID'),
      })
    },
    responses: {
      '200': {
        description: 'Connection disconnected',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;
    const { user } = result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { id } = data.params;

    // Deactivate connection
    await c.env.DB.prepare(`
      UPDATE platform_connections
      SET is_active = 0, updated_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), id).run();

    // Log the action
    await c.env.DB.prepare(`
      INSERT INTO audit_logs (id, timestamp, user_id, action, resource_type, resource_id, success, metadata)
      VALUES (?, ?, ?, 'admin_disconnect', 'connection', ?, 1, ?)
    `).bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      user.id,
      id,
      JSON.stringify({ admin_action: true })
    ).run();

    return success(c, { message: 'Connection disconnected' });
  }
}

/**
 * GET /v1/admin/sync-jobs - List sync jobs
 */
export class AdminListSyncJobs extends OpenAPIRoute {
  public schema = {
    tags: ['Admin CRM'],
    summary: 'List sync jobs',
    description: 'Get all sync jobs with filtering (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        platform: z.string().optional(),
        status: z.string().optional(),
        organization_id: z.string().optional(),
        limit: z.string().optional().default('20'),
        offset: z.string().optional().default('0'),
      })
    },
    responses: {
      '200': {
        description: 'List of sync jobs',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { platform, status, organization_id } = data.query;
    const limit = parseInt(data.query.limit) || 20;
    const offset = parseInt(data.query.offset) || 0;

    let query = `
      SELECT
        sj.id, sj.status, sj.job_type, sj.created_at as started_at, sj.completed_at,
        sj.metadata,
        o.name as organization_name,
        otm.short_tag as org_tag,
        pc.platform, pc.account_id
      FROM sync_jobs sj
      LEFT JOIN organizations o ON sj.organization_id = o.id
      LEFT JOIN org_tag_mappings otm ON o.id = otm.organization_id AND otm.is_active = 1
      LEFT JOIN platform_connections pc ON sj.connection_id = pc.id
      WHERE 1=1
    `;

    const params: any[] = [];

    if (platform) {
      query += ` AND pc.platform = ?`;
      params.push(platform);
    }
    if (status) {
      query += ` AND sj.status = ?`;
      params.push(status);
    }
    if (organization_id) {
      query += ` AND sj.organization_id = ?`;
      params.push(organization_id);
    }

    query += ` ORDER BY sj.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const jobs = await c.env.DB.prepare(query).bind(...params).all();

    // Get total count
    let countQuery = `
      SELECT COUNT(*) as count FROM sync_jobs sj
      LEFT JOIN platform_connections pc ON sj.connection_id = pc.id
      WHERE 1=1
    `;
    const countParams: any[] = [];
    if (platform) {
      countQuery += ` AND pc.platform = ?`;
      countParams.push(platform);
    }
    if (status) {
      countQuery += ` AND sj.status = ?`;
      countParams.push(status);
    }
    if (organization_id) {
      countQuery += ` AND sj.organization_id = ?`;
      countParams.push(organization_id);
    }

    const totalResult = await c.env.DB.prepare(countQuery).bind(...countParams).first<{ count: number }>();

    // Parse metadata for each job
    const items = (jobs.results || []).map((job: any) => {
      const metadata = job.metadata ? JSON.parse(job.metadata) : {};
      return {
        ...job,
        duration_ms: job.completed_at && job.started_at
          ? new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()
          : null,
        records_processed: metadata.records_processed,
        error: metadata.error,
      };
    });

    return success(c, {
      items,
      total: totalResult?.count || 0,
    });
  }
}

/**
 * POST /v1/admin/sync-jobs/:id/retry - Retry failed sync job
 */
export class AdminRetrySyncJob extends OpenAPIRoute {
  public schema = {
    tags: ['Admin CRM'],
    summary: 'Retry sync job',
    description: 'Retry a failed sync job (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe('Job ID'),
      })
    },
    responses: {
      '200': {
        description: 'Job retried',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;
    const { user } = result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { id } = data.params;

    // Get original job
    const job = await c.env.DB.prepare(`
      SELECT * FROM sync_jobs WHERE id = ?
    `).bind(id).first();

    if (!job) {
      return error(c, 'NOT_FOUND', 'Job not found', 404);
    }

    // Reset job status
    await c.env.DB.prepare(`
      UPDATE sync_jobs SET status = 'pending', completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), id).run();

    // Re-queue the job
    const metadata = job.metadata ? JSON.parse(job.metadata as string) : {};
    await c.env.SYNC_QUEUE.send({
      job_id: id,
      organization_id: job.organization_id,
      connection_id: job.connection_id,
      platform: metadata.platform || 'unknown',
      account_id: metadata.account_id,
      job_type: job.job_type,
      metadata: {
        ...metadata,
        retry: true,
        retried_by: user.id,
        retried_at: new Date().toISOString(),
      }
    });

    return success(c, { message: 'Job queued for retry' });
  }
}
