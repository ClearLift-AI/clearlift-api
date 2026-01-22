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

const DiagnosticsSchema = z.object({
  keyMode: z.string().optional(),
  hasAnyData: z.boolean().optional(),
  newestCharge: z.string().optional(),
  accountId: z.string().optional(),
  suggestion: z.string().optional(),
  error: z.string().optional()
}).optional();

const SyncJobSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  type: z.enum(['full', 'incremental']),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  records_synced: z.number(),
  total_records: z.number().nullable(),
  progress_percentage: z.number(),
  current_phase: z.string().nullable(),
  error: z.string().nullable(),
  diagnostics: DiagnosticsSchema.nullable()
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

    // Get connection info
    const connection = await c.env.DB.prepare(`
      SELECT
        pc.platform,
        pc.account_name,
        pc.last_synced_at,
        pc.sync_status,
        pc.is_active,
        pc.organization_id
      FROM platform_connections pc
      WHERE pc.id = ?
    `).bind(connectionId).first();

    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }

    // Verify user has access (checkOrgAccess handles super admin bypass)
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, connection.organization_id as string);

    if (!hasAccess) {
      return c.json({ error: "Access denied" }, 403);
    }

    // Get latest sync job (including new progress tracking columns)
    const latestJob = await c.env.DB.prepare(`
      SELECT
        status,
        job_type,
        started_at,
        completed_at,
        records_synced,
        total_records,
        progress_percentage,
        current_phase,
        error_message,
        metadata
      FROM sync_jobs
      WHERE connection_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(connectionId).first();

    // Use dedicated columns first, fall back to metadata for backwards compatibility
    let recordsSynced = latestJob?.records_synced || 0;

    // Debug logging
    console.log(`[SyncStatus] Connection ${connectionId}: status=${latestJob?.status}, records_synced=${latestJob?.records_synced}, computed=${recordsSynced}`);
    let totalRecords: number | null = (latestJob?.total_records as number) ?? null;
    let progressPercentage = (latestJob?.progress_percentage as number) ?? 0;
    let currentPhase: string | null = (latestJob?.current_phase as string) ?? null;

    // Parse metadata for backwards compatibility and diagnostics
    let diagnostics: any = null;
    if (latestJob?.metadata) {
      try {
        const metadata = JSON.parse(latestJob.metadata as string);
        if (!totalRecords) totalRecords = metadata.total_records ?? null;
        if (!currentPhase) currentPhase = metadata.current_phase ?? null;
        if (progressPercentage === 0 && metadata.progress_percentage !== undefined) {
          progressPercentage = metadata.progress_percentage;
        }
        // Extract diagnostics if present (for no-data scenarios)
        if (metadata.diagnostics) {
          diagnostics = metadata.diagnostics;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Calculate progress percentage based on status if still not set
    if (progressPercentage === 0 && latestJob) {
      if (latestJob.status === 'completed') {
        progressPercentage = 100;
      } else if (latestJob.status === 'running') {
        // If we have total_records, calculate actual progress
        if (totalRecords !== null && totalRecords > 0) {
          progressPercentage = Math.min(Math.round((Number(recordsSynced) / Number(totalRecords)) * 100), 99);
        } else {
          progressPercentage = 25; // Default to 25% if we don't know total
        }
      } else if (latestJob.status === 'pending') {
        progressPercentage = 5;
        currentPhase = currentPhase || 'Queued...';
      }
    }

    // More debug logging
    if (latestJob?.status === 'completed' && recordsSynced === 0) {
      console.log(`[SyncStatus] WARNING: Completed job with 0 records! Raw value: ${JSON.stringify(latestJob.records_synced)}, type: ${typeof latestJob.records_synced}`);
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
        error: latestJob.error_message,
        diagnostics: diagnostics
      } : null
    }, 200);
  }
}