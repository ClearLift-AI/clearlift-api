/**
 * Analysis Status Endpoint
 *
 * GET /v1/analysis/status/:job_id
 * Poll for analysis job status and progress
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
      })
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

    return success(c, response);
  }
}
