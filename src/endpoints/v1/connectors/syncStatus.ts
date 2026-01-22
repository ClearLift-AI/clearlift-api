import { OpenAPIRoute, Str, Num, Bool } from "chanfana";
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

/**
 * GET /v1/sync-jobs/:job_id/status
 *
 * Get sync job status by job ID with optional re-queue for stuck jobs.
 * Used for error recovery when jobs get lost in the queue.
 */
export class GetSyncJobStatus extends OpenAPIRoute {
  schema = {
    tags: ["Sync Jobs"],
    summary: "Get sync job status by job ID",
    description: "Returns the status of a sync job. If the job is stuck (pending > 10 min), can optionally trigger a re-queue.",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        job_id: Str({ description: "Sync job ID" })
      }),
      query: z.object({
        requeue_if_stuck: z.string().optional().describe("Set to 'true' to re-queue the job if it's stuck in pending state")
      })
    },
    responses: {
      "200": {
        description: "Job status retrieved successfully",
        schema: z.object({
          job: z.object({
            id: z.string(),
            connection_id: z.string(),
            organization_id: z.string(),
            status: z.enum(['pending', 'syncing', 'completed', 'failed']),
            job_type: z.string().nullable(),
            created_at: z.string(),
            started_at: z.string().nullable(),
            completed_at: z.string().nullable(),
            records_synced: z.number(),
            error_message: z.string().nullable(),
            is_stuck: z.boolean(),
            age_minutes: z.number()
          }),
          requeued: z.boolean(),
          message: z.string().optional()
        })
      },
      "404": {
        description: "Job not found"
      }
    }
  };

  async handle(c: AppContext) {
    const jobId = c.req.param("job_id");
    const session = c.get("session");
    const requeueIfStuck = c.req.query("requeue_if_stuck") === "true";

    const STUCK_THRESHOLD_MINUTES = 10;
    const MAX_RETRIES = 3;

    // Get job info
    const job = await c.env.DB.prepare(`
      SELECT
        sj.id, sj.connection_id, sj.organization_id, sj.status, sj.job_type,
        sj.created_at, sj.started_at, sj.completed_at, sj.records_synced,
        sj.error_message, sj.metadata,
        pc.platform, pc.account_id
      FROM sync_jobs sj
      LEFT JOIN platform_connections pc ON sj.connection_id = pc.id
      WHERE sj.id = ?
    `).bind(jobId).first<{
      id: string;
      connection_id: string;
      organization_id: string;
      status: string;
      job_type: string | null;
      created_at: string;
      started_at: string | null;
      completed_at: string | null;
      records_synced: number;
      error_message: string | null;
      metadata: string | null;
      platform: string | null;
      account_id: string | null;
    }>();

    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    // Verify user has access to the organization
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, job.organization_id);

    if (!hasAccess) {
      return c.json({ error: "Access denied" }, 403);
    }

    // Calculate job age
    const createdAt = new Date(job.created_at);
    const ageMinutes = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60));
    const isStuck = job.status === 'pending' && ageMinutes >= STUCK_THRESHOLD_MINUTES;

    let requeued = false;
    let message: string | undefined;

    // Re-queue if requested and job is stuck
    if (requeueIfStuck && isStuck && job.platform && job.account_id) {
      const metadata = job.metadata ? JSON.parse(job.metadata) : {};
      const retryCount = metadata.retry_count || 0;

      if (retryCount >= MAX_RETRIES) {
        // Too many retries - mark as failed
        await c.env.DB.prepare(`
          UPDATE sync_jobs
          SET status = 'failed',
              error_message = 'Job stuck after manual re-queue attempts',
              completed_at = datetime('now'),
              metadata = ?
          WHERE id = ?
        `).bind(
          JSON.stringify({ ...metadata, retry_count: retryCount, failed_reason: 'max_retries_exceeded' }),
          job.id
        ).run();

        message = `Job exceeded max retries (${MAX_RETRIES}), marked as failed`;
      } else {
        // Re-queue the job
        const updatedMetadata = {
          ...metadata,
          retry_count: retryCount + 1,
          last_retry: new Date().toISOString(),
          requeued_by: session.user_id
        };

        await c.env.DB.prepare(`
          UPDATE sync_jobs SET metadata = ? WHERE id = ?
        `).bind(JSON.stringify(updatedMetadata), job.id).run();

        try {
          await c.env.SYNC_QUEUE.send({
            job_id: job.id,
            connection_id: job.connection_id,
            organization_id: job.organization_id,
            platform: job.platform,
            account_id: job.account_id,
            sync_window: metadata.sync_window || {
              type: job.job_type || 'incremental',
              start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
              end: new Date().toISOString()
            },
            metadata: updatedMetadata
          });

          requeued = true;
          message = `Job re-queued successfully (attempt ${retryCount + 1}/${MAX_RETRIES})`;
        } catch (queueErr) {
          message = `Failed to re-queue job: ${queueErr instanceof Error ? queueErr.message : 'Unknown error'}`;
        }
      }
    } else if (requeueIfStuck && !isStuck) {
      message = `Job is not stuck (status: ${job.status}, age: ${ageMinutes} min)`;
    } else if (requeueIfStuck && (!job.platform || !job.account_id)) {
      message = `Cannot re-queue: missing connection info (platform or account_id)`;
    }

    return c.json({
      job: {
        id: job.id,
        connection_id: job.connection_id,
        organization_id: job.organization_id,
        status: job.status,
        job_type: job.job_type,
        created_at: job.created_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
        records_synced: job.records_synced || 0,
        error_message: job.error_message,
        is_stuck: isStuck,
        age_minutes: ageMinutes
      },
      requeued,
      message
    }, 200);
  }
}