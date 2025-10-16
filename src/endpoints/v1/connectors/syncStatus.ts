import { OpenAPIRoute, Str, Num } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";

// Response schemas
const ConnectionStatusSchema = z.object({
  platform: z.string(),
  account_name: z.string().nullable(),
  is_active: z.boolean(),
  last_synced_at: z.string().nullable(),
  sync_status: z.enum(['pending', 'syncing', 'completed', 'failed'])
});

const SyncJobSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  type: z.enum(['full', 'incremental']),
  completed_at: z.string().nullable(),
  records_synced: z.number(),
  error: z.string().nullable()
});

const SyncStatusResponseSchema = z.object({
  connection: ConnectionStatusSchema,
  latest_sync: SyncJobSchema.nullable()
});

export class GetSyncStatus extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Get sync status for a connection",
    description: "Returns the current sync status and latest sync job information for a platform connection",
    request: {
      params: z.object({
        connection_id: Str({ description: "Connection ID" })
      })
    },
    responses: {
      "200": {
        description: "Sync status retrieved successfully",
        schema: SyncStatusResponseSchema
      },
      "404": {
        description: "Connection not found",
        schema: z.object({
          error: z.string()
        })
      }
    }
  };

  async handle(c: AppContext) {
    const connectionId = c.req.param("connection_id");
    const session = c.get("session");

    // Get connection info - verify user has access
    const connection = await c.env.DB.prepare(`
      SELECT
        pc.platform,
        pc.account_name,
        pc.last_synced_at,
        pc.sync_status,
        pc.is_active,
        pc.organization_id
      FROM platform_connections pc
      INNER JOIN organization_members om
        ON pc.organization_id = om.organization_id
      WHERE pc.id = ?
        AND om.user_id = ?
    `).bind(connectionId, session.user_id).first();

    if (!connection) {
      return c.json({ error: "Connection not found or access denied" }, 404);
    }

    // Get latest sync job
    const latestJob = await c.env.DB.prepare(`
      SELECT
        status,
        job_type,
        started_at,
        completed_at,
        records_synced,
        error_message,
        metadata
      FROM sync_jobs
      WHERE connection_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(connectionId).first();

    // Parse metadata to get records_synced if available
    let recordsSynced = latestJob?.records_synced || 0;
    if (latestJob?.metadata) {
      try {
        const metadata = JSON.parse(latestJob.metadata as string);
        recordsSynced = metadata.records_synced || recordsSynced;
      } catch (e) {
        // Ignore parse errors
      }
    }

    return c.json({
      connection: {
        platform: connection.platform,
        account_name: connection.account_name,
        is_active: Boolean(connection.is_active),
        last_synced_at: connection.last_synced_at,
        sync_status: connection.sync_status
      },
      latest_sync: latestJob ? {
        status: latestJob.status,
        type: latestJob.job_type,
        completed_at: latestJob.completed_at,
        records_synced: recordsSynced,
        error: latestJob.error_message
      } : null
    }, 200);
  }
}