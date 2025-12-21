/**
 * Events Sync Status Endpoint
 *
 * Returns the status of events sync workflows for an organization.
 * Reads from the active_event_workflows D1 table which tracks running workflows.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";

/**
 * GET /v1/analytics/events/sync-status - Get events sync workflow status
 */
export class GetEventsSyncStatus extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get events sync workflow status",
    description: "Returns the status of events sync workflows for the organization",
    operationId: "get-events-sync-status",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
      }),
    },
    responses: {
      "200": {
        description: "Events sync status",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(
                z.object({
                  org_tag: z.string().describe("Organization short tag"),
                  workflow_id: z.string().nullable().describe("Active workflow ID if running"),
                  status: z.enum(["running", "idle", "unknown"]).describe("Current sync status"),
                  started_at: z.string().nullable().describe("When the workflow started"),
                  chunks_total: z.number().nullable().describe("Total number of chunks (168 for 7 days)"),
                  message: z.string().nullable().describe("Human-readable status message"),
                })
              ),
            }),
          },
        },
      },
      "401": { description: "Missing or invalid session" },
      "403": { description: "No access to this organization" },
      "500": { description: "Query failed" },
    },
  };

  async handle(c: AppContext) {
    try {
      const { org_id } = c.req.query();

      if (!org_id) {
        return error(c, "VALIDATION_ERROR", "org_id is required", 400);
      }

      // Get org slug for this organization
      const orgResult = await c.env.DB.prepare(`
        SELECT slug FROM organizations WHERE id = ?
      `)
        .bind(org_id)
        .first<{ slug: string }>();

      if (!orgResult) {
        return error(c, "NOT_FOUND", "Organization not found", 404);
      }

      // Get all active workflows for this org's accounts
      // The org_tag in active_event_workflows corresponds to account IDs (e.g., "nicol", "nicol-1")
      const activeWorkflows = await c.env.DB.prepare(`
        SELECT org_tag, workflow_id, created_at
        FROM active_event_workflows
        WHERE org_tag LIKE ?
        ORDER BY created_at DESC
      `)
        .bind(`${orgResult.slug}%`)
        .all<{
          org_tag: string;
          workflow_id: string;
          created_at: string;
        }>();

      // Map to response format
      const statusData = activeWorkflows.results.map((w) => {
        const startedAt = new Date(w.created_at);
        const runningMinutes = Math.floor((Date.now() - startedAt.getTime()) / 60000);

        // Estimate progress based on time (rough: ~30 seconds per chunk)
        const estimatedChunks = Math.min(Math.floor(runningMinutes * 2), 168);
        const progressPercent = Math.min(Math.floor((estimatedChunks / 168) * 100), 99);

        return {
          org_tag: w.org_tag,
          workflow_id: w.workflow_id,
          status: "running" as const,
          started_at: w.created_at,
          chunks_total: 168, // 7 days * 24 hours
          message: `Syncing events: ~${progressPercent}% complete (running for ${runningMinutes} min)`,
        };
      });

      // If no active workflows, return idle status
      if (statusData.length === 0) {
        return success(c, [
          {
            org_tag: orgResult.slug,
            workflow_id: null,
            status: "idle" as const,
            started_at: null,
            chunks_total: null,
            message: "Events sync is idle. Next sync runs automatically.",
          },
        ]);
      }

      return success(c, statusData);
    } catch (err) {
      console.error("Error getting events sync status:", err);
      return error(c, "INTERNAL_ERROR", err instanceof Error ? err.message : "Unknown error", 500);
    }
  }
}
