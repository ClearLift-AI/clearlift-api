import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";
import { getSecret } from "../../utils/secrets";

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
        const data = await response.json() as { message?: string; [key: string]: any };
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

      const data = await response.json() as { recentJobs?: Array<{ status: string; [key: string]: any }> };

      // Calculate stats from recent jobs if available
      let stats;
      if (data.recentJobs && Array.isArray(data.recentJobs)) {
        const totalJobs = data.recentJobs.length;
        const successfulJobs = data.recentJobs.filter((j) => j.status === 'completed').length;
        const failedJobs = data.recentJobs.filter((j) => j.status === 'failed').length;

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
 * GET /v1/workers/test-token/:connection_id - Test connection token permissions
 */
export class TestConnectionToken extends OpenAPIRoute {
  public schema = {
    tags: ["Workers"],
    summary: "Test connection token",
    description: "Tests if the access token for a connection has the correct permissions and can fetch data",
    operationId: "test-connection-token",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Token test results",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connection_id: z.string(),
                platform: z.string(),
                token_valid: z.boolean(),
                permissions: z.array(z.string()).optional(),
                can_fetch_data: z.boolean(),
                test_results: z.any(),
                error: z.string().optional()
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
    const connection_id = data.params.connection_id;

    try {
      // Verify user has access
      const connection = await c.env.DB.prepare(`
        SELECT pc.*, om.role
        FROM platform_connections pc
        JOIN organization_members om ON pc.organization_id = om.organization_id
        WHERE pc.id = ? AND om.user_id = ?
      `).bind(connection_id, session.user_id).first();

      if (!connection) {
        return error(c, "NOT_FOUND", "Connection not found or access denied", 404);
      }

      // Get decrypted access token
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const { ConnectorService } = await import('../../services/connectors');
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);

      const accessToken = await connectorService.getAccessToken(connection_id);

      if (!accessToken) {
        return success(c, {
          connection_id,
          platform: connection.platform,
          token_valid: false,
          can_fetch_data: false,
          error: "No access token found"
        });
      }

      // Test based on platform
      if (connection.platform === 'facebook') {
        // Test Facebook token
        const debugResponse = await fetch(
          `https://graph.facebook.com/v24.0/debug_token?input_token=${accessToken}&access_token=${accessToken}`,
          { signal: AbortSignal.timeout(5000) }
        );

        if (!debugResponse.ok) {
          return success(c, {
            connection_id,
            platform: 'facebook',
            token_valid: false,
            can_fetch_data: false,
            error: `Token debug failed: ${debugResponse.status}`
          });
        }

        const debugData = await debugResponse.json() as any;
        const permissions = debugData.data?.scopes || [];
        const hasReadInsights = permissions.includes('read_insights');
        const hasAdsRead = permissions.includes('ads_read');

        // Try to fetch a test campaign
        let canFetchData = false;
        let testResults: any = {};

        try {
          const campaignsResponse = await fetch(
            `https://graph.facebook.com/v24.0/${connection.account_id}/campaigns?fields=id,name&limit=1&access_token=${accessToken}`,
            { signal: AbortSignal.timeout(5000) }
          );

          if (campaignsResponse.ok) {
            const campaignsData = await campaignsResponse.json() as any;
            testResults.campaigns = campaignsData;
            canFetchData = true;

            // Try to fetch insights for the first campaign
            if (campaignsData.data && Array.isArray(campaignsData.data) && campaignsData.data.length > 0) {
              const campaignId = campaignsData.data[0].id;
              const insightsResponse = await fetch(
                `https://graph.facebook.com/v24.0/${campaignId}/insights?fields=impressions,clicks,spend&time_range={"since":"2025-11-18","until":"2025-11-19"}&access_token=${accessToken}`,
                { signal: AbortSignal.timeout(5000) }
              );

              if (insightsResponse.ok) {
                const insightsData = await insightsResponse.json();
                testResults.insights = insightsData;
              } else {
                testResults.insights_error = `Status ${insightsResponse.status}`;
              }
            }
          }
        } catch (e) {
          testResults.fetch_error = e instanceof Error ? e.message : 'Unknown error';
        }

        return success(c, {
          connection_id,
          platform: 'facebook',
          token_valid: debugData.data?.is_valid || false,
          permissions,
          can_fetch_data: canFetchData && hasReadInsights && hasAdsRead,
          test_results: testResults
        });
      }

      return success(c, {
        connection_id,
        platform: connection.platform,
        token_valid: true,
        can_fetch_data: false,
        error: "Token testing not implemented for this platform yet"
      });
    } catch (err) {
      console.error("Test token error:", err);
      return error(c, "TEST_ERROR", err instanceof Error ? err.message : "Failed to test token", 500);
    }
  }
}

/**
 * POST /v1/workers/events-sync/trigger - Manually trigger events sync for an organization
 */
export class TriggerEventsSync extends OpenAPIRoute {
  public schema = {
    tags: ["Workers"],
    summary: "Trigger events sync",
    description: "Manually triggers an events sync workflow for the specified organization. Syncs events from R2 Datalake to Supabase.",
    operationId: "trigger-events-sync",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              org_id: z.string().describe("Organization ID"),
              lookback_hours: z.number().optional().default(3).describe("Hours to look back for events (default: 3)")
            })
          }
        }
      }
    },
    responses: {
      "200": {
        description: "Events sync triggered",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                job_id: z.string(),
                org_tag: z.string(),
                status: z.string(),
                message: z.string(),
                sync_window: z.object({
                  start: z.string(),
                  end: z.string()
                })
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
    const { org_id, lookback_hours } = data.body;

    try {
      // Verify user has access to this organization
      const access = await c.env.DB.prepare(`
        SELECT om.role FROM organization_members om
        WHERE om.organization_id = ? AND om.user_id = ?
      `).bind(org_id, session.user_id).first();

      if (!access) {
        return error(c, "FORBIDDEN", "Access denied to this organization", 403);
      }

      // Get org_tag for this organization
      const tagMapping = await c.env.DB.prepare(`
        SELECT short_tag FROM org_tag_mappings
        WHERE organization_id = ? AND is_active = 1
      `).bind(org_id).first<{ short_tag: string }>();

      if (!tagMapping) {
        return error(c, "NOT_FOUND", "Organization does not have an event tracking tag configured", 404);
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

      // Create a sync job and send to queue
      const jobId = crypto.randomUUID();
      const nowStr = now.toISOString();

      await c.env.DB.prepare(`
        INSERT INTO sync_jobs (
          id,
          organization_id,
          connection_id,
          status,
          job_type,
          created_at,
          metadata
        ) VALUES (?, ?, ?, 'pending', 'events', ?, ?)
      `).bind(
        jobId,
        org_id,
        orgTag, // Use org_tag as connection_id for events
        nowStr,
        JSON.stringify({
          triggered_by: session.user_id,
          manual: true,
          org_tag: orgTag,
          sync_window: {
            start: startTime.toISOString(),
            end: now.toISOString()
          }
        })
      ).run();

      // Send to queue with events platform
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
          created_at: nowStr
        }
      };

      await c.env.SYNC_QUEUE.send(queueMessage);

      return success(c, {
        job_id: jobId,
        org_tag: orgTag,
        status: 'queued',
        message: `Events sync triggered for org_tag "${orgTag}". Workflow will sync events from last ${lookback_hours || 3} hours.`,
        sync_window: {
          start: startTime.toISOString(),
          end: now.toISOString()
        }
      });
    } catch (err) {
      console.error("Trigger events sync error:", err);
      return error(c, "QUEUE_ERROR", err instanceof Error ? err.message : "Failed to queue events sync", 500);
    }
  }
}

/**
 * GET /v1/workers/d1/stats - Get D1 database statistics
 */
export class GetD1Stats extends OpenAPIRoute {
  public schema = {
    tags: ["Workers"],
    summary: "Get D1 database statistics",
    description: "Returns size, performance, and usage statistics for all D1 databases",
    operationId: "get-d1-stats",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "D1 database statistics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                databases: z.array(z.object({
                  name: z.string(),
                  size_bytes: z.number(),
                  size_formatted: z.string(),
                  tables: z.number(),
                  storage_limit_gb: z.number(),
                  storage_used_percent: z.number(),
                  last_query_ms: z.number().optional(),
                  status: z.enum(['healthy', 'warning', 'critical'])
                })),
                total_size_bytes: z.number(),
                total_size_formatted: z.string(),
                timestamp: z.string()
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const STORAGE_LIMIT_GB = 10; // D1 limit per database
    const STORAGE_LIMIT_BYTES = STORAGE_LIMIT_GB * 1024 * 1024 * 1024;

    const formatBytes = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    };

    const getStatus = (usedPercent: number): 'healthy' | 'warning' | 'critical' => {
      if (usedPercent > 90) return 'critical';
      if (usedPercent > 70) return 'warning';
      return 'healthy';
    };

    const databases: any[] = [];
    let totalSizeBytes = 0;

    // Query Main DB (DB)
    try {
      const start = Date.now();
      const result = await c.env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM sqlite_master WHERE type='table') as table_count
      `).first<{ table_count: number }>();
      const queryMs = Date.now() - start;

      // Get database size - D1 doesn't support pragma functions in queries
      // Use a simpler estimation based on table count (rough estimate: 1MB per table average)
      // This is a fallback since D1 doesn't expose direct size metrics via SQL
      let sizeBytes = 0;
      try {
        const pageCount = await c.env.DB.prepare(`PRAGMA page_count`).first<{ page_count: number }>();
        const pageSize = await c.env.DB.prepare(`PRAGMA page_size`).first<{ page_size: number }>();
        if (pageCount?.page_count && pageSize?.page_size) {
          sizeBytes = pageCount.page_count * pageSize.page_size;
        }
      } catch (pragmaErr) {
        // Fallback: estimate based on table count
        sizeBytes = (result?.table_count || 0) * 1024 * 1024; // ~1MB per table estimate
      }
      totalSizeBytes += sizeBytes;

      databases.push({
        name: 'Main DB (clearlift-db-prod)',
        size_bytes: sizeBytes,
        size_formatted: formatBytes(sizeBytes),
        tables: result?.table_count || 0,
        storage_limit_gb: STORAGE_LIMIT_GB,
        storage_used_percent: (sizeBytes / STORAGE_LIMIT_BYTES) * 100,
        last_query_ms: queryMs,
        status: getStatus((sizeBytes / STORAGE_LIMIT_BYTES) * 100)
      });
    } catch (err) {
      console.error('DB stats error:', err);
      databases.push({
        name: 'Main DB (clearlift-db-prod)',
        size_bytes: 0,
        size_formatted: 'Error',
        tables: 0,
        storage_limit_gb: STORAGE_LIMIT_GB,
        storage_used_percent: 0,
        status: 'critical'
      });
    }

    // Query AI DB (AI_DB)
    if (c.env.AI_DB) {
      try {
        const start = Date.now();
        const result = await c.env.AI_DB.prepare(`
          SELECT
            (SELECT COUNT(*) FROM sqlite_master WHERE type='table') as table_count
        `).first<{ table_count: number }>();
        const queryMs = Date.now() - start;

        let sizeBytes = 0;
        try {
          const pageCount = await c.env.AI_DB.prepare(`PRAGMA page_count`).first<{ page_count: number }>();
          const pageSize = await c.env.AI_DB.prepare(`PRAGMA page_size`).first<{ page_size: number }>();
          if (pageCount?.page_count && pageSize?.page_size) {
            sizeBytes = pageCount.page_count * pageSize.page_size;
          }
        } catch (pragmaErr) {
          sizeBytes = (result?.table_count || 0) * 1024 * 1024;
        }
        totalSizeBytes += sizeBytes;

        databases.push({
          name: 'AI DB (clearlift-ai-prod)',
          size_bytes: sizeBytes,
          size_formatted: formatBytes(sizeBytes),
          tables: result?.table_count || 0,
          storage_limit_gb: STORAGE_LIMIT_GB,
          storage_used_percent: (sizeBytes / STORAGE_LIMIT_BYTES) * 100,
          last_query_ms: queryMs,
          status: getStatus((sizeBytes / STORAGE_LIMIT_BYTES) * 100)
        });
      } catch (err) {
        console.error('AI_DB stats error:', err);
      }
    }

    // Query Analytics DB (ANALYTICS_DB)
    if (c.env.ANALYTICS_DB) {
      try {
        const start = Date.now();
        const result = await c.env.ANALYTICS_DB.prepare(`
          SELECT
            (SELECT COUNT(*) FROM sqlite_master WHERE type='table') as table_count
        `).first<{ table_count: number }>();
        const queryMs = Date.now() - start;

        let sizeBytes = 0;
        try {
          const pageCount = await c.env.ANALYTICS_DB.prepare(`PRAGMA page_count`).first<{ page_count: number }>();
          const pageSize = await c.env.ANALYTICS_DB.prepare(`PRAGMA page_size`).first<{ page_size: number }>();
          if (pageCount?.page_count && pageSize?.page_size) {
            sizeBytes = pageCount.page_count * pageSize.page_size;
          }
        } catch (pragmaErr) {
          sizeBytes = (result?.table_count || 0) * 1024 * 1024;
        }
        totalSizeBytes += sizeBytes;

        // Also get row counts for key tables
        let dailyMetricsCount = 0;
        let hourlyMetricsCount = 0;
        try {
          const dailyResult = await c.env.ANALYTICS_DB.prepare(`SELECT COUNT(*) as count FROM daily_metrics`).first<{ count: number }>();
          const hourlyResult = await c.env.ANALYTICS_DB.prepare(`SELECT COUNT(*) as count FROM hourly_metrics`).first<{ count: number }>();
          dailyMetricsCount = dailyResult?.count || 0;
          hourlyMetricsCount = hourlyResult?.count || 0;
        } catch (e) {
          // Tables might not exist
        }

        databases.push({
          name: 'Analytics DB (clearlift-analytics-dev)',
          size_bytes: sizeBytes,
          size_formatted: formatBytes(sizeBytes),
          tables: result?.table_count || 0,
          storage_limit_gb: STORAGE_LIMIT_GB,
          storage_used_percent: (sizeBytes / STORAGE_LIMIT_BYTES) * 100,
          last_query_ms: queryMs,
          status: getStatus((sizeBytes / STORAGE_LIMIT_BYTES) * 100),
          metrics: {
            daily_metrics_rows: dailyMetricsCount,
            hourly_metrics_rows: hourlyMetricsCount
          }
        });
      } catch (err) {
        console.error('ANALYTICS_DB stats error:', err);
      }
    }

    return success(c, {
      databases,
      total_size_bytes: totalSizeBytes,
      total_size_formatted: formatBytes(totalSizeBytes),
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * POST /v1/workers/sync/trigger - Manually trigger a sync job
 */
export class TriggerSync extends OpenAPIRoute {
  public schema = {
    tags: ["Workers"],
    summary: "Manually trigger sync",
    description: "Manually triggers a sync job for a specific connection. For full syncs, specify sync_window with start and end dates.",
    operationId: "trigger-sync",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              connection_id: z.string(),
              job_type: z.enum(['full', 'incremental']).optional().default('incremental'),
              sync_window: z.object({
                start: z.string().describe("Start date (YYYY-MM-DD)"),
                end: z.string().describe("End date (YYYY-MM-DD)")
              }).optional().describe("Custom sync window for full syncs")
            })
          }
        }
      }
    },
    responses: {
      "200": {
        description: "Sync job queued and processing",
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
    const { connection_id, job_type, sync_window } = data.body;

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

      // Determine sync window
      let syncStart: string;
      let syncEnd: string;

      if (sync_window) {
        // Use provided sync window
        syncStart = sync_window.start;
        syncEnd = sync_window.end;
      } else {
        // Default: incremental sync (last 24 hours)
        const now = new Date();
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);

        syncStart = yesterday.toISOString();
        syncEnd = now.toISOString();
      }

      // Create sync job in D1
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
          manual: true,
          sync_window: {
            start: syncStart,
            end: syncEnd
          }
        })
      ).run();

      // Send job to queue immediately
      const queueMessage = {
        job_id: jobId,
        organization_id: connection.organization_id,
        connection_id: connection_id,
        platform: connection.platform,
        account_id: connection.account_id,
        job_type: job_type || 'incremental',
        sync_window: {
          start: syncStart,
          end: syncEnd,
          type: job_type || 'incremental'
        },
        metadata: {
          triggered_by: session.user_id,
          manual: true,
          created_at: now
        }
      };

      await c.env.SYNC_QUEUE.send(queueMessage);

      return success(c, {
        job_id: jobId,
        status: 'queued',
        message: `Sync job queued and processing. ${job_type === 'full' ? `Syncing ${syncStart.split('T')[0]} to ${syncEnd.split('T')[0]}.` : 'Incremental sync in progress.'}`
      });
    } catch (err) {
      console.error("Trigger sync error:", err);
      return error(c, "QUEUE_ERROR", err instanceof Error ? err.message : "Failed to queue sync job", 500);
    }
  }
}