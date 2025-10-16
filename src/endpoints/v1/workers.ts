import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";

/**
 * Worker health status schema
 */
const WorkerHealthSchema = z.object({
  worker: z.string(),
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  lastCheck: z.string(),
  message: z.string().optional(),
  metadata: z.record(z.any()).optional()
});

const WorkersStatusSchema = z.object({
  cron: WorkerHealthSchema,
  queue: WorkerHealthSchema,
  overall: z.enum(['healthy', 'degraded', 'unhealthy'])
});

/**
 * GET /v1/workers/health - Check health of cron and queue workers
 */
export class GetWorkersHealth extends OpenAPIRoute {
  public schema = {
    tags: ["Workers"],
    summary: "Get workers health status",
    description: "Checks the health status of cron and queue consumer workers",
    operationId: "get-workers-health",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "Workers health status",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: WorkersStatusSchema
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    // Check cron worker health
    const cronHealth = await this.checkWorkerHealth(
      'https://clearlift-cron-worker.paul-33c.workers.dev/health',
      'cron'
    );

    // Check queue consumer health
    const queueHealth = await this.checkWorkerHealth(
      'https://clearlift-queue-consumer.paul-33c.workers.dev/health',
      'queue'
    );

    // Determine overall health
    let overall: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (cronHealth.status === 'unhealthy' || queueHealth.status === 'unhealthy') {
      overall = 'unhealthy';
    } else if (cronHealth.status === 'degraded' || queueHealth.status === 'degraded') {
      overall = 'degraded';
    }

    return success(c, {
      cron: cronHealth,
      queue: queueHealth,
      overall
    });
  }

  private async checkWorkerHealth(url: string, workerName: string): Promise<any> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      if (response.ok) {
        const data = await response.json();
        return {
          worker: workerName,
          status: 'healthy',
          lastCheck: new Date().toISOString(),
          message: data.message || 'Worker is healthy',
          metadata: data
        };
      } else {
        return {
          worker: workerName,
          status: 'degraded',
          lastCheck: new Date().toISOString(),
          message: `Worker returned status ${response.status}`
        };
      }
    } catch (err) {
      return {
        worker: workerName,
        status: 'unhealthy',
        lastCheck: new Date().toISOString(),
        message: err instanceof Error ? err.message : 'Failed to contact worker'
      };
    }
  }
}

/**
 * GET /v1/workers/queue/status - Get queue processing status
 */
export class GetQueueStatus extends OpenAPIRoute {
  public schema = {
    tags: ["Workers"],
    summary: "Get queue processing status",
    description: "Returns recent job processing statistics from the queue consumer",
    operationId: "get-queue-status",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "Queue status and recent jobs",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                recentJobs: z.array(z.any()),
                stats: z.object({
                  totalJobs: z.number(),
                  successfulJobs: z.number(),
                  failedJobs: z.number(),
                  averageProcessingTime: z.number().optional()
                }).optional()
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    try {
      const response = await fetch('https://clearlift-queue-consumer.paul-33c.workers.dev/status', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });

      if (!response.ok) {
        return error(c, "WORKER_ERROR", `Queue worker returned status ${response.status}`, 503);
      }

      const data = await response.json();

      // Calculate stats from recent jobs if available
      let stats;
      if (data.recentJobs && Array.isArray(data.recentJobs)) {
        const totalJobs = data.recentJobs.length;
        const successfulJobs = data.recentJobs.filter((j: any) => j.status === 'completed').length;
        const failedJobs = data.recentJobs.filter((j: any) => j.status === 'failed').length;

        stats = {
          totalJobs,
          successfulJobs,
          failedJobs
        };
      }

      return success(c, {
        recentJobs: data.recentJobs || [],
        stats
      });
    } catch (err) {
      return error(c, "WORKER_UNAVAILABLE", "Failed to contact queue worker", 503);
    }
  }
}

/**
 * GET /v1/workers/dlq - Get dead letter queue items
 */
export class GetDeadLetterQueue extends OpenAPIRoute {
  public schema = {
    tags: ["Workers"],
    summary: "Get dead letter queue items",
    description: "Returns failed jobs that ended up in the dead letter queue",
    operationId: "get-dlq",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.string().optional().describe("Number of items to return (default: 10)")
      })
    },
    responses: {
      "200": {
        description: "Dead letter queue items",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                items: z.array(z.object({
                  id: z.string(),
                  connection_id: z.string(),
                  platform: z.string().optional(),
                  error_message: z.string().nullable(),
                  failed_at: z.string().nullable(),
                  retry_count: z.number().optional()
                })),
                total: z.number().optional()
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const limit = parseInt(c.req.query("limit") || "10");

    try {
      // Query failed sync jobs from D1
      const failedJobs = await c.env.DB.prepare(`
        SELECT
          sj.id,
          sj.connection_id,
          pc.platform,
          sj.error_message,
          sj.completed_at as failed_at,
          sj.metadata
        FROM sync_jobs sj
        JOIN platform_connections pc ON sj.connection_id = pc.id
        JOIN organization_members om ON pc.organization_id = om.organization_id
        WHERE sj.status = 'failed'
          AND om.user_id = ?
        ORDER BY sj.completed_at DESC
        LIMIT ?
      `).bind(session.user_id, limit).all();

      const items = (failedJobs.results || []).map((job: any) => {
        let retryCount = 0;
        if (job.metadata) {
          try {
            const metadata = JSON.parse(job.metadata);
            retryCount = metadata.retry_count || 0;
          } catch (e) {
            // Ignore parse errors
          }
        }

        return {
          id: job.id,
          connection_id: job.connection_id,
          platform: job.platform,
          error_message: job.error_message,
          failed_at: job.failed_at,
          retry_count: retryCount
        };
      });

      // Get total count
      const countResult = await c.env.DB.prepare(`
        SELECT COUNT(*) as total
        FROM sync_jobs sj
        JOIN platform_connections pc ON sj.connection_id = pc.id
        JOIN organization_members om ON pc.organization_id = om.organization_id
        WHERE sj.status = 'failed'
          AND om.user_id = ?
      `).bind(session.user_id).first();

      return success(c, {
        items,
        total: countResult?.total || 0
      });
    } catch (err) {
      console.error("DLQ query error:", err);
      return error(c, "DATABASE_ERROR", "Failed to query dead letter queue", 500);
    }
  }
}

/**
 * POST /v1/workers/sync/trigger - Manually trigger a sync job
 */
export class TriggerSync extends OpenAPIRoute {
  public schema = {
    tags: ["Workers"],
    summary: "Manually trigger sync",
    description: "Manually triggers a sync job for a specific connection",
    operationId: "trigger-sync",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              connection_id: z.string(),
              job_type: z.enum(['full', 'incremental']).optional().default('incremental')
            })
          }
        }
      }
    },
    responses: {
      "200": {
        description: "Sync job created",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                job_id: z.string(),
                status: z.string(),
                message: z.string()
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const { connection_id, job_type } = data.body;

    try {
      // Verify user has access to this connection
      const connection = await c.env.DB.prepare(`
        SELECT pc.*, om.role
        FROM platform_connections pc
        JOIN organization_members om ON pc.organization_id = om.organization_id
        WHERE pc.id = ? AND om.user_id = ?
      `).bind(connection_id, session.user_id).first();

      if (!connection) {
        return error(c, "NOT_FOUND", "Connection not found or access denied", 404);
      }

      if (!connection.is_active) {
        return error(c, "INACTIVE_CONNECTION", "Connection is not active", 400);
      }

      // Create a new sync job
      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();

      await c.env.DB.prepare(`
        INSERT INTO sync_jobs (
          id,
          organization_id,
          connection_id,
          status,
          job_type,
          created_at,
          metadata
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
      `).bind(
        jobId,
        connection.organization_id,
        connection_id,
        job_type || 'incremental',
        now,
        JSON.stringify({
          triggered_by: session.user_id,
          manual: true
        })
      ).run();

      return success(c, {
        job_id: jobId,
        status: 'pending',
        message: `Sync job created. The cron worker will pick it up in the next run (max 15 minutes).`
      });
    } catch (err) {
      console.error("Trigger sync error:", err);
      return error(c, "DATABASE_ERROR", "Failed to create sync job", 500);
    }
  }
}