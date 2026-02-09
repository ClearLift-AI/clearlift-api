/**
 * Admin Tasks Endpoints
 *
 * Internal task management for system administrators
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

const TASK_TYPES = ['follow_up', 'investigation', 'support', 'bug', 'feature', 'other'] as const;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const STATUSES = ['open', 'in_progress', 'blocked', 'completed', 'cancelled'] as const;

/**
 * GET /v1/admin/tasks - List tasks
 */
export class AdminListTasks extends OpenAPIRoute {
  public schema = {
    tags: ['Admin Tasks'],
    summary: 'List tasks',
    description: 'Get all admin tasks with filtering (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        search: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        task_type: z.string().optional(),
        organization_id: z.string().optional(),
        assigned_to: z.string().optional(),
        limit: z.string().optional().default('20'),
        offset: z.string().optional().default('0'),
      })
    },
    responses: {
      '200': {
        description: 'List of tasks',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { search, status, priority, task_type, organization_id, assigned_to } = data.query;
    const limit = parseInt(data.query.limit) || 20;
    const offset = parseInt(data.query.offset) || 0;

    let query = `
      SELECT
        t.*,
        o.name as organization_name,
        u.email as user_email,
        assigned.name as assigned_to_name,
        creator.name as created_by_name
      FROM admin_tasks t
      LEFT JOIN organizations o ON t.organization_id = o.id
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN users assigned ON t.assigned_to = assigned.id
      LEFT JOIN users creator ON t.created_by = creator.id
      WHERE 1=1
    `;

    const params: any[] = [];

    if (search) {
      query += ` AND (t.title LIKE ? OR t.description LIKE ?)`;
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern);
    }
    if (status) {
      query += ` AND t.status = ?`;
      params.push(status);
    }
    if (priority) {
      query += ` AND t.priority = ?`;
      params.push(priority);
    }
    if (task_type) {
      query += ` AND t.task_type = ?`;
      params.push(task_type);
    }
    if (organization_id) {
      query += ` AND t.organization_id = ?`;
      params.push(organization_id);
    }
    if (assigned_to) {
      query += ` AND t.assigned_to = ?`;
      params.push(assigned_to);
    }

    // Count query
    let countQuery = `SELECT COUNT(*) as count FROM admin_tasks t WHERE 1=1`;
    const countParams: any[] = [];
    if (search) {
      countQuery += ` AND (t.title LIKE ? OR t.description LIKE ?)`;
      countParams.push(`%${search}%`, `%${search}%`);
    }
    if (status) {
      countQuery += ` AND t.status = ?`;
      countParams.push(status);
    }
    if (priority) {
      countQuery += ` AND t.priority = ?`;
      countParams.push(priority);
    }
    if (task_type) {
      countQuery += ` AND t.task_type = ?`;
      countParams.push(task_type);
    }
    if (organization_id) {
      countQuery += ` AND t.organization_id = ?`;
      countParams.push(organization_id);
    }
    if (assigned_to) {
      countQuery += ` AND t.assigned_to = ?`;
      countParams.push(assigned_to);
    }

    const totalResult = await c.env.DB.prepare(countQuery).bind(...countParams).first<{ count: number }>();

    query += ` ORDER BY
      CASE t.priority
        WHEN 'urgent' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        ELSE 4
      END,
      t.created_at DESC
      LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const tasks = await c.env.DB.prepare(query).bind(...params).all();

    return success(c, {
      items: tasks.results || [],
      total: totalResult?.count || 0,
    });
  }
}

/**
 * POST /v1/admin/tasks - Create task
 */
export class AdminCreateTask extends OpenAPIRoute {
  public schema = {
    tags: ['Admin Tasks'],
    summary: 'Create task',
    description: 'Create a new admin task (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          title: z.string().min(1, 'Title is required'),
          description: z.string().nullable().optional(),
          task_type: z.enum(TASK_TYPES),
          priority: z.enum(PRIORITIES).default('medium'),
          status: z.enum(STATUSES).default('open'),
          organization_id: z.string().nullable().optional(),
          user_id: z.string().nullable().optional(),
          assigned_to: z.string().nullable().optional(),
          due_date: z.string().nullable().optional(),
        })
      )
    },
    responses: {
      '201': {
        description: 'Task created',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;
    const { user } = result;

    const data = await this.getValidatedData<typeof this.schema>();
    const task = data.body;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO admin_tasks (
        id, title, description, task_type, priority, status,
        organization_id, user_id, assigned_to, created_by,
        due_date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      task.title,
      task.description || null,
      task.task_type,
      task.priority,
      task.status,
      task.organization_id || null,
      task.user_id || null,
      task.assigned_to || null,
      user.id,
      task.due_date || null,
      now,
      now
    ).run();

    // Fetch the created task with joins
    const created = await c.env.DB.prepare(`
      SELECT
        t.*,
        o.name as organization_name,
        creator.name as created_by_name
      FROM admin_tasks t
      LEFT JOIN organizations o ON t.organization_id = o.id
      LEFT JOIN users creator ON t.created_by = creator.id
      WHERE t.id = ?
    `).bind(id).first();

    return success(c, created, undefined, 201);
  }
}

/**
 * PATCH /v1/admin/tasks/:id - Update task
 */
export class AdminUpdateTask extends OpenAPIRoute {
  public schema = {
    tags: ['Admin Tasks'],
    summary: 'Update task',
    description: 'Update an admin task (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe('Task ID'),
      }),
      body: contentJson(
        z.object({
          title: z.string().optional(),
          description: z.string().nullable().optional(),
          task_type: z.enum(TASK_TYPES).optional(),
          priority: z.enum(PRIORITIES).optional(),
          status: z.enum(STATUSES).optional(),
          organization_id: z.string().nullable().optional(),
          user_id: z.string().nullable().optional(),
          assigned_to: z.string().nullable().optional(),
          due_date: z.string().nullable().optional(),
          resolution_notes: z.string().nullable().optional(),
        })
      )
    },
    responses: {
      '200': {
        description: 'Task updated',
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

    const allowedFields = [
      'title', 'description', 'task_type', 'priority', 'status',
      'organization_id', 'user_id', 'assigned_to', 'due_date', 'resolution_notes'
    ];

    for (const field of allowedFields) {
      if (updates[field as keyof typeof updates] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(updates[field as keyof typeof updates]);
      }
    }

    // Handle status change to completed
    if (updates.status === 'completed') {
      fields.push('resolved_at = ?', 'resolved_by = ?');
      values.push(new Date().toISOString(), user.id);
    }

    if (fields.length === 0) {
      return error(c, 'BAD_REQUEST', 'No fields to update', 400);
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    await c.env.DB.prepare(`
      UPDATE admin_tasks SET ${fields.join(', ')} WHERE id = ?
    `).bind(...values).run();

    // Fetch updated task
    const updated = await c.env.DB.prepare(`
      SELECT
        t.*,
        o.name as organization_name,
        assigned.name as assigned_to_name,
        creator.name as created_by_name
      FROM admin_tasks t
      LEFT JOIN organizations o ON t.organization_id = o.id
      LEFT JOIN users assigned ON t.assigned_to = assigned.id
      LEFT JOIN users creator ON t.created_by = creator.id
      WHERE t.id = ?
    `).bind(id).first();

    return success(c, updated);
  }
}

/**
 * DELETE /v1/admin/tasks/:id - Delete task
 */
export class AdminDeleteTask extends OpenAPIRoute {
  public schema = {
    tags: ['Admin Tasks'],
    summary: 'Delete task',
    description: 'Delete an admin task (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe('Task ID'),
      })
    },
    responses: {
      '200': {
        description: 'Task deleted',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { id } = data.params;

    await c.env.DB.prepare(`DELETE FROM admin_tasks WHERE id = ?`).bind(id).run();

    return success(c, { message: 'Task deleted' });
  }
}

/**
 * GET /v1/admin/tasks/:id/comments - List task comments
 */
export class AdminListTaskComments extends OpenAPIRoute {
  public schema = {
    tags: ['Admin Tasks'],
    summary: 'List task comments',
    description: 'Get all comments for a task (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe('Task ID'),
      })
    },
    responses: {
      '200': {
        description: 'List of comments',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { id } = data.params;

    const comments = await c.env.DB.prepare(`
      SELECT
        c.*,
        u.name as author_name
      FROM admin_task_comments c
      JOIN users u ON c.author_id = u.id
      WHERE c.task_id = ?
      ORDER BY c.created_at ASC
    `).bind(id).all();

    return success(c, comments.results || []);
  }
}

/**
 * POST /v1/admin/tasks/:id/comments - Add task comment
 */
export class AdminAddTaskComment extends OpenAPIRoute {
  public schema = {
    tags: ['Admin Tasks'],
    summary: 'Add task comment',
    description: 'Add a comment to a task (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe('Task ID'),
      }),
      body: contentJson(
        z.object({
          content: z.string().min(1, 'Content is required'),
        })
      )
    },
    responses: {
      '201': {
        description: 'Comment added',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;
    const { user } = result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { id } = data.params;
    const { content } = data.body;

    const commentId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO admin_task_comments (id, task_id, author_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(commentId, id, user.id, content, now).run();

    // Update task updated_at
    await c.env.DB.prepare(`
      UPDATE admin_tasks SET updated_at = ? WHERE id = ?
    `).bind(now, id).run();

    // Fetch comment with author
    const comment = await c.env.DB.prepare(`
      SELECT c.*, u.name as author_name
      FROM admin_task_comments c
      JOIN users u ON c.author_id = u.id
      WHERE c.id = ?
    `).bind(commentId).first();

    return success(c, comment, undefined, 201);
  }
}

/**
 * POST /v1/admin/impersonate - Start impersonation
 */
export class AdminStartImpersonation extends OpenAPIRoute {
  public schema = {
    tags: ['Admin'],
    summary: 'Start impersonation',
    description: 'Impersonate a user for support purposes (admin only)',
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          target_user_id: z.string(),
          reason: z.string().min(1, 'Reason is required'),
        })
      )
    },
    responses: {
      '200': {
        description: 'Impersonation started',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;
    const { user, d1 } = result;

    const data = await this.getValidatedData<typeof this.schema>();
    const { target_user_id, reason } = data.body;

    // Get target user
    const targetUser = await d1.getUser(target_user_id);
    if (!targetUser) {
      return error(c, 'NOT_FOUND', 'User not found', 404);
    }

    // Cannot impersonate other admins
    if (targetUser.is_admin) {
      return error(c, 'FORBIDDEN', 'Cannot impersonate admin users', 403);
    }

    // Create impersonation log
    const logId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO admin_impersonation_logs (
        id, admin_user_id, target_user_id, reason, started_at, ip_address
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      logId,
      user.id,
      target_user_id,
      reason,
      now,
      c.req.header('cf-connecting-ip') || 'unknown'
    ).run();

    // Create short-lived impersonation token (30 min)
    const expires = new Date(Date.now() + 30 * 60 * 1000);
    const tokenPayload = {
      user_id: target_user_id,
      impersonating_admin: user.id,
      impersonation_log_id: logId,
      exp: Math.floor(expires.getTime() / 1000),
    };

    // HMAC-sign the impersonation token to prevent forgery
    const payload = btoa(JSON.stringify(tokenPayload));
    const encoder = new TextEncoder();
    const keyData = encoder.encode(c.env.SESSION_SECRET || 'impersonation-fallback-key');
    const key = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const sigHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
    const token = `${payload}.${sigHex}`;

    return success(c, {
      token,
      expires_at: expires.toISOString(),
      target_user: {
        id: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
      },
    });
  }
}

/**
 * POST /v1/admin/end-impersonation - End impersonation
 */
export class AdminEndImpersonation extends OpenAPIRoute {
  public schema = {
    tags: ['Admin'],
    summary: 'End impersonation',
    description: 'End current impersonation session (admin only)',
    security: [{ bearerAuth: [] }],
    responses: {
      '200': {
        description: 'Impersonation ended',
      },
    },
  };

  public async handle(c: AppContext) {
    const result = await requireAdmin(c);
    if (result instanceof Response) return result;

    // Mark impersonation as ended
    // In a real implementation, you'd track the active session

    return success(c, { message: 'Impersonation ended' });
  }
}
