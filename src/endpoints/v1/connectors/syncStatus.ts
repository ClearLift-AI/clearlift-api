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
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  records_synced: z.number(),
  total_records: z.number().nullable(),
  progress_percentage: z.number(),
  current_phase: z.string().nullable(),
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

    // Parse metadata for progress info
    let recordsSynced = latestJob?.records_synced || 0;
    let totalRecords: number | null = null;
    let progressPercentage = 0;
    let currentPhase: string | null = null;

    if (latestJob?.metadata) {
      try {
        const metadata = JSON.parse(latestJob.metadata as string);
        recordsSynced = metadata.records_synced ?? recordsSynced;
        totalRecords = metadata.total_records ?? null;
        currentPhase = metadata.current_phase ?? null;

        // Calculate progress from metadata if available
        if (metadata.progress_percentage !== undefined) {
          progressPercentage = metadata.progress_percentage;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Calculate progress percentage based on status if not set
    if (progressPercentage === 0 && latestJob) {
      if (latestJob.status === 'completed') {
        progressPercentage = 100;
      } else if (latestJob.status === 'running') {
        // If we have total_records, calculate actual progress
        if (totalRecords !== null && totalRecords > 0) {
          progressPercentage = Math.min(Math.round((Number(recordsSynced) / Number(totalRecords)) * 100), 99);
        } else {
          progressPercentage = 50; // Default to 50% if we don't know total
        }
      } else if (latestJob.status === 'pending') {
        progressPercentage = 0;
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
        started_at: latestJob.started_at,
        completed_at: latestJob.completed_at,
        records_synced: recordsSynced,
        total_records: totalRecords,
        progress_percentage: progressPercentage,
        current_phase: currentPhase,
        error: latestJob.error_message
      } : null
    }, 200);
  }
}