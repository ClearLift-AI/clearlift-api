/**
 * Analysis Audit Endpoint
 *
 * GET /v1/analysis/runs/:run_id/audit
 * Returns the full audit trail for a completed analysis run:
 * events, summaries, and optionally LLM logs.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";

export class GetAnalysisAudit extends OpenAPIRoute {
  public schema = {
    tags: ["Analysis"],
    summary: "Get audit trail for a completed analysis run",
    operationId: "get-analysis-audit",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        run_id: z.string()
      }),
      query: z.object({
        include: z.string().optional().default("events,summaries")
      })
    },
    responses: {
      "200": {
        description: "Audit trail for the analysis run",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                job: z.object({
                  job_id: z.string(),
                  status: z.string(),
                  days: z.number(),
                  total_entities: z.number().nullable(),
                  processed_entities: z.number().nullable(),
                  stopped_reason: z.string().nullable(),
                  termination_reason: z.string().nullable(),
                  created_at: z.string(),
                  completed_at: z.string().nullable()
                }),
                events: z.array(z.object({
                  id: z.number(),
                  iteration: z.number(),
                  event_type: z.string(),
                  tool_name: z.string().nullable(),
                  tool_input_summary: z.string().nullable(),
                  tool_status: z.string().nullable(),
                  tool_input: z.any().nullable(),
                  tool_output: z.any().nullable(),
                  created_at: z.string()
                })),
                summaries: z.array(z.object({
                  entity_id: z.string(),
                  entity_name: z.string().nullable(),
                  level: z.string(),
                  platform: z.string().nullable(),
                  summary: z.string(),
                  metrics_snapshot: z.any(),
                  created_at: z.string()
                })),
                logs: z.array(z.object({
                  id: z.string(),
                  level: z.string(),
                  platform: z.string().nullable(),
                  entity_name: z.string().nullable(),
                  provider: z.string(),
                  model: z.string(),
                  input_tokens: z.number().nullable(),
                  output_tokens: z.number().nullable(),
                  latency_ms: z.number().nullable(),
                  prompt: z.string().nullable(),
                  response: z.string().nullable()
                })).optional()
              })
            })
          }
        }
      },
      "404": {
        description: "Analysis run not found"
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");
    if (!orgId) {
      return error(c, "UNAUTHORIZED", "Organization not found", 400);
    }

    const { run_id } = c.req.param();
    const includeParam = c.req.query("include") || "events,summaries";
    const includes = new Set(includeParam.split(",").map(s => s.trim()));

    // Find the job by analysis_run_id
    const job = await c.env.DB.prepare(
      `SELECT id, status, days, total_entities, processed_entities,
              stopped_reason, termination_reason, created_at, completed_at
       FROM analysis_jobs
       WHERE analysis_run_id = ? AND organization_id = ?
       LIMIT 1`
    ).bind(run_id, orgId).first<{
      id: string;
      status: string;
      days: number;
      total_entities: number | null;
      processed_entities: number | null;
      stopped_reason: string | null;
      termination_reason: string | null;
      created_at: string;
      completed_at: string | null;
    }>();

    if (!job) {
      return error(c, "NOT_FOUND", "Analysis run not found", 404);
    }

    const response: Record<string, any> = {
      job: {
        job_id: job.id,
        status: job.status,
        days: job.days,
        total_entities: job.total_entities,
        processed_entities: job.processed_entities,
        stopped_reason: job.stopped_reason,
        termination_reason: job.termination_reason,
        created_at: job.created_at,
        completed_at: job.completed_at
      },
      events: [],
      summaries: []
    };

    // Fetch events
    if (includes.has("events")) {
      try {
        const eventsResult = await c.env.DB.prepare(
          `SELECT id, iteration, event_type, tool_name, tool_input_summary, tool_status, tool_input, tool_output, created_at
           FROM analysis_events
           WHERE job_id = ?
           ORDER BY id ASC`
        ).bind(job.id).all<{
          id: number;
          iteration: number;
          event_type: string;
          tool_name: string | null;
          tool_input_summary: string | null;
          tool_status: string | null;
          tool_input: string | null;
          tool_output: string | null;
          created_at: string;
        }>();
        response.events = (eventsResult.results || []).map(e => ({
          ...e,
          tool_input: e.tool_input ? (() => { try { return JSON.parse(e.tool_input!); } catch { return e.tool_input; } })() : null,
          tool_output: e.tool_output ? (() => { try { return JSON.parse(e.tool_output!); } catch { return e.tool_output; } })() : null,
        }));
      } catch {
        // Table may not exist (pre-migration)
      }
    }

    // Fetch summaries
    if (includes.has("summaries")) {
      try {
        const summariesResult = await c.env.DB.prepare(
          `SELECT entity_id, entity_name, level, platform, summary, metrics_snapshot, created_at
           FROM analysis_summaries
           WHERE analysis_run_id = ? AND organization_id = ?
           ORDER BY created_at ASC`
        ).bind(run_id, orgId).all<{
          entity_id: string;
          entity_name: string | null;
          level: string;
          platform: string | null;
          summary: string;
          metrics_snapshot: string;
          created_at: string;
        }>();
        response.summaries = (summariesResult.results || []).map(s => ({
          ...s,
          metrics_snapshot: (() => {
            try { return JSON.parse(s.metrics_snapshot || "{}"); } catch { return {}; }
          })()
        }));
      } catch {
        // Table may not exist (pre-migration)
      }
    }

    // Fetch LLM logs (optional, large payload)
    if (includes.has("logs")) {
      try {
        const logsResult = await c.env.DB.prepare(
          `SELECT id, level, platform, entity_name, provider, model,
                  input_tokens, output_tokens, latency_ms, prompt, response
           FROM analysis_logs
           WHERE analysis_run_id = ? AND organization_id = ?
           ORDER BY created_at ASC`
        ).bind(run_id, orgId).all<{
          id: string;
          level: string;
          platform: string | null;
          entity_name: string | null;
          provider: string;
          model: string;
          input_tokens: number | null;
          output_tokens: number | null;
          latency_ms: number | null;
          prompt: string | null;
          response: string | null;
        }>();
        response.logs = logsResult.results || [];
      } catch {
        // Table may not exist (pre-migration)
      }
    }

    return success(c, response);
  }
}
