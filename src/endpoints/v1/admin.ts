/**
 * Admin Endpoints
 *
 * Protected endpoints for system administrators
 */

import { OpenAPIRoute, contentJson } from 'chanfana';
import { z } from 'zod';
import { createEmailService } from '../../utils/email';
import { success, error } from '../../utils/response';
import { AppContext } from '../../types';
import { D1Adapter } from '../../adapters/d1';
import { structuredLog } from '../../utils/structured-logger';

/**
 * POST /v1/admin/invites - Send admin invite email
 */
export class SendAdminInvite extends OpenAPIRoute {
  public schema = {
    tags: ['Admin'],
    summary: 'Send admin invite email',
    description: 'Send a welcome invite email to a new user (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          to: z.array(z.string().email('Invalid email address')).min(1, 'At least one recipient required'),
          cc: z.array(z.string().email('Invalid CC email')).optional(),
          bcc: z.array(z.string().email('Invalid BCC email')).optional(),
        })
      )
    },
    responses: {
      '200': {
        description: 'Invite sent successfully',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                invites: z.array(z.object({
                  id: z.string(),
                  email: z.string(),
                  sent_at: z.string(),
                  status: z.string(),
                })),
                cc: z.array(z.string()).optional(),
                bcc: z.array(z.string()).optional(),
              }),
            }),
          },
        },
      },
      '401': {
        description: 'Unauthorized',
      },
      '403': {
        description: 'Forbidden - not an admin',
      },
      '500': {
        description: 'Server error',
      },
    },
  };

  public async handle(c: AppContext) {
    const session = c.get('session');
    const data = await this.getValidatedData<typeof this.schema>();
    const { to, cc, bcc } = data.body;

    // Check if user is admin
    const d1 = new D1Adapter(c.env.DB);
    const user = await d1.getUser(session.user_id);

    if (!user || !user.is_admin) {
      return error(c, 'FORBIDDEN', 'Admin access required', 403);
    }

    const now = new Date().toISOString();

    try {
      // Send the welcome email
      const emailService = createEmailService(c.env);
      const result = await emailService.sendAdminWelcomeInvite(to, cc, bcc);

      // Record each recipient in database
      const invites: { id: string; email: string; sent_at: string; status: string }[] = [];
      for (const email of to) {
        const id = crypto.randomUUID();
        await c.env.DB.prepare(`
          INSERT INTO admin_invites (id, email, sent_by, sent_at, status, sendgrid_message_id, error_message)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id,
          email.toLowerCase(),
          session.user_id,
          now,
          result.success ? 'sent' : 'failed',
          result.messageId || null,
          result.error || null
        ).run();
        invites.push({ id, email: email.toLowerCase(), sent_at: now, status: result.success ? 'sent' : 'failed' });
      }

      if (!result.success) {
        return error(c, 'EMAIL_FAILED', result.error || 'Failed to send email', 500);
      }

      return success(c, {
        invites,
        ...(cc?.length ? { cc } : {}),
        ...(bcc?.length ? { bcc } : {}),
      });

    } catch (err: any) {
      structuredLog('ERROR', 'Admin invite error', { endpoint: 'POST /v1/admin/invites', error: err instanceof Error ? err.message : String(err) });

      // Still record the failed attempts
      for (const email of to) {
        try {
          await c.env.DB.prepare(`
            INSERT INTO admin_invites (id, email, sent_by, sent_at, status, error_message)
            VALUES (?, ?, ?, ?, 'failed', ?)
          `).bind(crypto.randomUUID(), email.toLowerCase(), session.user_id, now, err.message).run();
        } catch (dbErr) {
          structuredLog('ERROR', 'Failed to record invite error', { endpoint: 'POST /v1/admin/invites', error: dbErr instanceof Error ? dbErr.message : String(dbErr) });
        }
      }

      return error(c, 'INVITE_FAILED', 'Failed to send invite', 500);
    }
  }
}

/**
 * GET /v1/admin/invites - List recent admin invites
 */
export class ListAdminInvites extends OpenAPIRoute {
  public schema = {
    tags: ['Admin'],
    summary: 'List admin invites',
    description: 'Get list of recently sent admin invites (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.string().optional().default('20'),
      })
    },
    responses: {
      '200': {
        description: 'List of invites',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                invites: z.array(z.object({
                  id: z.string(),
                  email: z.string(),
                  sent_by: z.string(),
                  sent_by_name: z.string().nullable(),
                  sent_at: z.string(),
                  status: z.string(),
                })),
              }),
            }),
          },
        },
      },
      '401': {
        description: 'Unauthorized',
      },
      '403': {
        description: 'Forbidden - not an admin',
      },
    },
  };

  public async handle(c: AppContext) {
    const session = c.get('session');
    const data = await this.getValidatedData<typeof this.schema>();
    const limit = parseInt(data.query.limit) || 20;

    // Check if user is admin
    const d1 = new D1Adapter(c.env.DB);
    const user = await d1.getUser(session.user_id);

    if (!user || !user.is_admin) {
      return error(c, 'FORBIDDEN', 'Admin access required', 403);
    }

    const invites = await c.env.DB.prepare(`
      SELECT
        ai.id,
        ai.email,
        ai.sent_by,
        u.name as sent_by_name,
        ai.sent_at,
        ai.status
      FROM admin_invites ai
      LEFT JOIN users u ON ai.sent_by = u.id
      ORDER BY ai.sent_at DESC
      LIMIT ?
    `).bind(limit).all();

    return success(c, {
      invites: invites.results || [],
    });
  }
}

/**
 * GET /v1/admin/events-sync/status - Get events sync status across all orgs
 */
export class AdminGetEventsSyncStatus extends OpenAPIRoute {
  public schema = {
    tags: ['Admin'],
    summary: 'Get events sync status (admin)',
    description: 'Get events sync status across all organizations (admin only)',
    security: [{ bearerAuth: [] }],
    responses: {
      '200': {
        description: 'Events sync status',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                watermarks: z.array(z.object({
                  org_tag: z.string(),
                  org_name: z.string().nullable(),
                  last_synced_timestamp: z.string().nullable(),
                  records_synced: z.number(),
                  last_sync_status: z.string().nullable(),
                  updated_at: z.string().nullable(),
                })),
                active_workflows: z.array(z.object({
                  org_tag: z.string(),
                  workflow_id: z.string(),
                  created_at: z.string(),
                })),
              }),
            }),
          },
        },
      },
      '401': {
        description: 'Unauthorized',
      },
      '403': {
        description: 'Forbidden - not an admin',
      },
    },
  };

  public async handle(c: AppContext) {
    const session = c.get('session');

    // Check if user is admin
    const d1 = new D1Adapter(c.env.DB);
    const user = await d1.getUser(session.user_id);

    if (!user || !user.is_admin) {
      return error(c, 'FORBIDDEN', 'Admin access required', 403);
    }

    // Get all watermarks with org names
    const watermarks = await c.env.DB.prepare(`
      SELECT
        esw.org_tag,
        o.name as org_name,
        esw.last_synced_timestamp,
        esw.records_synced,
        esw.last_sync_status,
        esw.updated_at
      FROM event_sync_watermarks esw
      LEFT JOIN org_tag_mappings otm ON esw.org_tag = otm.short_tag
      LEFT JOIN organizations o ON otm.organization_id = o.id
      ORDER BY esw.updated_at DESC
    `).all();

    // Clean up stale workflow records (older than 2 hours - workflows shouldn't run that long)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await c.env.DB.prepare(`
      DELETE FROM active_event_workflows WHERE created_at < ?
    `).bind(twoHoursAgo).run();

    // Get all active workflows (after cleanup)
    const activeWorkflows = await c.env.DB.prepare(`
      SELECT org_tag, workflow_id, created_at
      FROM active_event_workflows
      ORDER BY created_at DESC
    `).all();

    return success(c, {
      watermarks: watermarks.results || [],
      active_workflows: activeWorkflows.results || [],
    });
  }
}

/**
 * GET /v1/admin/waitlist - Get waitlist entries
 */
export class AdminGetWaitlist extends OpenAPIRoute {
  public schema = {
    tags: ['Admin'],
    summary: 'Get waitlist entries',
    description: 'Get all waitlist signups with filtering and pagination (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.string().optional().default('50'),
        offset: z.string().optional().default('0'),
        status: z.string().optional().describe('Filter by status: pending, contacted, converted, rejected'),
      })
    },
    responses: {
      '200': {
        description: 'Waitlist entries',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                entries: z.array(z.object({
                  id: z.string(),
                  email: z.string(),
                  name: z.string().nullable(),
                  phone: z.string().nullable(),
                  source: z.string().nullable(),
                  utm: z.string().nullable(),
                  status: z.string(),
                  attempt_count: z.number(),
                  created_at: z.string(),
                  updated_at: z.string(),
                })),
                total: z.number(),
                stats: z.object({
                  pending: z.number(),
                  contacted: z.number(),
                  converted: z.number(),
                  rejected: z.number(),
                }),
              }),
            }),
          },
        },
      },
      '401': {
        description: 'Unauthorized',
      },
      '403': {
        description: 'Forbidden - not an admin',
      },
    },
  };

  public async handle(c: AppContext) {
    const session = c.get('session');
    const data = await this.getValidatedData<typeof this.schema>();
    const limit = parseInt(data.query.limit) || 50;
    const offset = parseInt(data.query.offset) || 0;
    const statusFilter = data.query.status;

    // Check if user is admin
    const d1 = new D1Adapter(c.env.DB);
    const user = await d1.getUser(session.user_id);

    if (!user || !user.is_admin) {
      return error(c, 'FORBIDDEN', 'Admin access required', 403);
    }

    // Build query with optional status filter
    let entriesQuery = `
      SELECT id, email, name, phone, source, utm, status,
             COALESCE(attempt_count, 1) as attempt_count, created_at, updated_at
      FROM waitlist
    `;
    const params: any[] = [];

    if (statusFilter) {
      entriesQuery += ' WHERE status = ?';
      params.push(statusFilter);
    }

    entriesQuery += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const entries = await c.env.DB.prepare(entriesQuery).bind(...params).all();

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM waitlist';
    if (statusFilter) {
      countQuery += ' WHERE status = ?';
    }
    const totalResult = await c.env.DB.prepare(countQuery)
      .bind(...(statusFilter ? [statusFilter] : []))
      .first<{ count: number }>();

    // Get stats by status
    const statsResult = await c.env.DB.prepare(`
      SELECT status, COUNT(*) as count
      FROM waitlist
      GROUP BY status
    `).all<{ status: string; count: number }>();

    const stats = {
      pending: 0,
      contacted: 0,
      converted: 0,
      rejected: 0,
    };
    for (const row of statsResult.results || []) {
      if (row.status in stats) {
        stats[row.status as keyof typeof stats] = row.count;
      }
    }

    return success(c, {
      entries: entries.results || [],
      total: totalResult?.count || 0,
      stats,
    });
  }
}

/**
 * PATCH /v1/admin/waitlist/:id/status - Update waitlist entry status
 */
export class AdminUpdateWaitlistStatus extends OpenAPIRoute {
  public schema = {
    tags: ['Admin'],
    summary: 'Update waitlist entry status',
    description: 'Update the status of a waitlist entry (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe('Waitlist entry ID'),
      }),
      body: contentJson(
        z.object({
          status: z.enum(['pending', 'contacted', 'converted', 'rejected']),
        })
      )
    },
    responses: {
      '200': {
        description: 'Status updated',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                id: z.string(),
                status: z.string(),
                updated_at: z.string(),
              }),
            }),
          },
        },
      },
      '401': {
        description: 'Unauthorized',
      },
      '403': {
        description: 'Forbidden - not an admin',
      },
      '404': {
        description: 'Entry not found',
      },
    },
  };

  public async handle(c: AppContext) {
    const session = c.get('session');
    const data = await this.getValidatedData<typeof this.schema>();
    const { id } = data.params;
    const { status } = data.body;

    // Check if user is admin
    const d1 = new D1Adapter(c.env.DB);
    const user = await d1.getUser(session.user_id);

    if (!user || !user.is_admin) {
      return error(c, 'FORBIDDEN', 'Admin access required', 403);
    }

    const now = new Date().toISOString();

    const result = await c.env.DB.prepare(`
      UPDATE waitlist
      SET status = ?, updated_at = ?
      WHERE id = ?
      RETURNING id, status, updated_at
    `).bind(status, now, id).first();

    if (!result) {
      return error(c, 'NOT_FOUND', 'Waitlist entry not found', 404);
    }

    return success(c, result);
  }
}

/**
 * POST /v1/admin/events-sync/trigger - Trigger events sync for an org
 */
export class AdminTriggerEventsSync extends OpenAPIRoute {
  public schema = {
    tags: ['Admin'],
    summary: 'Trigger events sync',
    description: 'Manually trigger events sync for any organization (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          org_id: z.string().describe('Organization ID'),
          lookback_hours: z.number().optional().default(3).describe('Hours to look back'),
        })
      )
    },
    responses: {
      '200': {
        description: 'Sync triggered',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                job_id: z.string(),
                org_tag: z.string(),
                status: z.string(),
                message: z.string(),
              }),
            }),
          },
        },
      },
      '401': {
        description: 'Unauthorized',
      },
      '403': {
        description: 'Forbidden - not an admin',
      },
      '404': {
        description: 'Org tag not found',
      },
    },
  };

  public async handle(c: AppContext) {
    const session = c.get('session');
    const data = await this.getValidatedData<typeof this.schema>();
    const { org_id, lookback_hours } = data.body;

    // Check if user is admin
    const d1 = new D1Adapter(c.env.DB);
    const user = await d1.getUser(session.user_id);

    if (!user || !user.is_admin) {
      return error(c, 'FORBIDDEN', 'Admin access required', 403);
    }

    // Get org_tag for this organization
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings
      WHERE organization_id = ? AND is_active = 1
    `).bind(org_id).first<{ short_tag: string }>();

    if (!tagMapping) {
      return error(c, 'NOT_FOUND', 'Organization does not have an event tracking tag', 404);
    }

    const orgTag = tagMapping.short_tag;

    // Clear any stuck workflow record
    await c.env.DB.prepare(`
      DELETE FROM active_event_workflows WHERE org_tag = ?
    `).bind(orgTag).run();

    // Calculate sync window
    const now = new Date();
    const lookbackMs = (lookback_hours || 3) * 60 * 60 * 1000;
    const startTime = new Date(now.getTime() - lookbackMs);

    // Create sync job
    const jobId = crypto.randomUUID();
    const nowStr = now.toISOString();

    await c.env.DB.prepare(`
      INSERT INTO sync_jobs (
        id, organization_id, connection_id, status, job_type, created_at, metadata
      ) VALUES (?, ?, ?, 'pending', 'events', ?, ?)
    `).bind(
      jobId,
      org_id,
      orgTag,
      nowStr,
      JSON.stringify({
        triggered_by: session.user_id,
        manual: true,
        admin_trigger: true,
        org_tag: orgTag,
        sync_window: { start: startTime.toISOString(), end: now.toISOString() }
      })
    ).run();

    // Send to queue
    const queueMessage = {
      job_id: jobId,
      organization_id: org_id,
      connection_id: orgTag,
      platform: 'events',
      account_id: orgTag,
      job_type: 'events',
      sync_window: {
        start: startTime.toISOString(),
        end: now.toISOString(),
        type: 'events'
      },
      metadata: {
        triggered_by: session.user_id,
        manual: true,
        admin_trigger: true,
        created_at: nowStr
      }
    };

    await c.env.SYNC_QUEUE.send(queueMessage);

    return success(c, {
      job_id: jobId,
      org_tag: orgTag,
      status: 'queued',
      message: `Events sync triggered for ${orgTag} (${lookback_hours || 3}h lookback)`,
    });
  }
}
