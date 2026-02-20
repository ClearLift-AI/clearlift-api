/**
 * Analysis Status Endpoint
 *
 * GET /v1/analysis/status/:job_id
 * Poll for analysis job status and progress
 * Supports cursor-based event streaming via ?after_event_id=N
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { JobManager } from "../../../services/analysis";

export class GetAnalysisStatus extends OpenAPIRoute {
  public schema = {
    tags: ["Analysis"],
    summary: "Get analysis job status",
    operationId: "get-analysis-status",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        job_id: z.string()
      }),
      query: z.object({
        after_event_id: z.coerce.number().optional()
      }).optional()
    },
    responses: {
      "200": {
        description: "Job status",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                job_id: z.string(),
                status: z.enum(["pending", "running", "completed", "failed"]),
                progress: z.object({
                  processed: z.number(),
                  total: z.number().nullable(),
                  current_level: z.string().nullable(),
                  percent_complete: z.number().nullable()
                }),
                result: z.object({
                  run_id: z.string(),
                  stopped_reason: z.enum(['max_recommendations', 'no_tool_calls', 'max_iterations', 'early_termination']).optional(),
                  termination_reason: z.string().optional()
                }).optional(),
                error: z.string().optional(),
                events: z.array(z.object({
                  id: z.number(),
                  iteration: z.number(),
                  event_type: z.string(),
                  tool_name: z.string().nullable(),
                  tool_input_summary: z.string().nullable(),
                  tool_status: z.string().nullable(),
                  created_at: z.string()
                })).optional(),
                latest_event_id: z.number().optional(),
                created_at: z.string(),
                completed_at: z.string().nullable()
              })
            })
          }
        }
      },
      "404": {
        description: "Job not found"
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");
    if (!orgId) {
      return error(c, "UNAUTHORIZED", "Organization not found", 400);
    }

    const { job_id } = c.req.param();
    const afterEventId = Number(c.req.query("after_event_id")) || 0;

    const jobs = new JobManager(c.env.DB);
    const job = await jobs.getJob(job_id);

    if (!job) {
      return error(c, "NOT_FOUND", "Job not found", 404);
    }

    // Verify job belongs to this org
    if (job.organization_id !== orgId) {
      return error(c, "NOT_FOUND", "Job not found", 404);
    }

    const progress = await jobs.getJobProgress(job_id);

    const response: Record<string, any> = {
      job_id: job.id,
      status: job.status,
      progress: {
        processed: progress?.processed || 0,
        total: progress?.total || null,
        current_level: progress?.currentLevel || null,
        percent_complete: progress?.percentComplete || null
      },
      created_at: job.created_at,
      completed_at: job.completed_at
    };

    if (job.status === "completed" && job.analysis_run_id) {
      response.result = {
        run_id: job.analysis_run_id,
        stopped_reason: job.stopped_reason || undefined,
        termination_reason: job.termination_reason || undefined
      };
    }

    if (job.status === "failed" && job.error_message) {
      response.error = job.error_message;
    }

    // Fetch new events since cursor (piggybacks on existing poll — zero additional requests)
    try {
      const eventsResult = await c.env.DB.prepare(
        `SELECT id, iteration, event_type, tool_name, tool_input_summary, tool_status, created_at
         FROM analysis_events
         WHERE job_id = ? AND id > ?
         ORDER BY id ASC
         LIMIT 50`
      ).bind(job_id, afterEventId).all<{
        id: number;
        iteration: number;
        event_type: string;
        tool_name: string | null;
        tool_input_summary: string | null;
        tool_status: string | null;
        created_at: string;
      }>();

      const events = eventsResult.results || [];
      if (events.length > 0) {
        response.events = events;
        response.latest_event_id = events[events.length - 1].id;
      }
    } catch (e) {
      // Table may not exist yet (pre-migration) — gracefully omit events
    }

    return success(c, response);
  }
}
