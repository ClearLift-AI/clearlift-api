/**
 * Demo Recommendations Seeding Endpoint
 *
 * Internal endpoint called by clearlift-cron queue-consumer after Facebook sync
 * to generate demo recommendations for Meta App Review.
 *
 * Auth: CF-Worker header (service binding) or X-Internal-Key header (fallback)
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";
import { getSecret } from "../../utils/secrets";
import { generateFacebookDemoRecommendations } from "../../services/demo-recommendations";

/**
 * Verify internal auth (service binding or API key)
 */
async function verifyInternalAuth(c: AppContext): Promise<boolean> {
  // Service binding calls come with CF-Worker header
  // Accept both clearlift-queue-consumer (actual worker name) and clearlift-cron (legacy)
  const cfWorker = c.req.header("CF-Worker");
  if (cfWorker === "clearlift-queue-consumer" || cfWorker === "clearlift-cron") {
    return true;
  }

  // Fallback: Check X-Internal-Key header (for local dev or cross-account calls)
  const internalKey = c.req.header("X-Internal-Key");
  if (!internalKey) {
    return false;
  }

  try {
    // SECURITY: INTERNAL_API_KEY must be configured - no fallback to allow all
    const internalApiKeyBinding = (c.env as any).INTERNAL_API_KEY;
    if (!internalApiKeyBinding) {
      // SECURITY FIX: Do not allow requests when INTERNAL_API_KEY is not configured
      console.error('[verifyInternalAuth] INTERNAL_API_KEY not configured - rejecting request');
      return false;
    }
    const expectedKey = await getSecret(internalApiKeyBinding);
    return internalKey === expectedKey;
  } catch (err) {
    console.error('[verifyInternalAuth] Error verifying key:', err);
    return false;
  }
}

/**
 * POST /v1/recommendations/seed
 *
 * Seeds demo AI recommendations for Meta App Review.
 * Called by queue-consumer after Facebook sync completes.
 */
export class SeedFacebookDemoRecommendations extends OpenAPIRoute {
  public schema = {
    tags: ["Recommendations"],
    summary: "Seed Facebook demo recommendations for Meta App Review",
    operationId: "seed-facebook-demo-recommendations",
    request: {
      body: contentJson(
        z.object({
          connection_id: z.string().describe("The Facebook connection ID"),
          organization_id: z.string().describe("The organization ID")
        })
      )
    },
    responses: {
      "200": {
        description: "Recommendations seeded successfully",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                recommendations_created: z.number(),
                message: z.string()
              })
            })
          }
        }
      },
      "401": {
        description: "Unauthorized - missing or invalid internal auth"
      },
      "500": {
        description: "Internal server error"
      }
    }
  };

  public async handle(c: AppContext) {
    // Verify internal auth
    const isAuthorized = await verifyInternalAuth(c);
    if (!isAuthorized) {
      console.error("[SeedDemoRec] Unauthorized request - missing CF-Worker or X-Internal-Key header");
      return error(c, "UNAUTHORIZED", "Internal auth required", 401);
    }

    try {
      const data = await this.getValidatedData<typeof this.schema>();
      const { connection_id, organization_id } = data.body;

      console.log(`[SeedDemoRec] Received seed request for org ${organization_id}, connection ${connection_id}`);

      // Ensure ANALYTICS_DB is configured
      if (!c.env.ANALYTICS_DB) {
        console.error("[SeedDemoRec] Missing ANALYTICS_DB configuration");
        return error(c, "MISSING_CONFIG", "ANALYTICS_DB not configured", 500);
      }

      // Generate demo recommendations using D1
      const result = await generateFacebookDemoRecommendations(
        c.env.AI_DB,
        c.env.ANALYTICS_DB,
        organization_id,
        connection_id
      );

      if (!result.success) {
        console.error(`[SeedDemoRec] Failed to generate recommendations: ${result.error}`);
        return error(c, "GENERATION_FAILED", result.error || "Failed to generate recommendations", 500);
      }

      console.log(`[SeedDemoRec] Successfully created ${result.recommendations_created} recommendations`);

      return success(c, {
        recommendations_created: result.recommendations_created,
        message: result.recommendations_created > 0
          ? `Created ${result.recommendations_created} demo recommendations for Meta App Review`
          : "Demo recommendations already exist for this organization"
      });

    } catch (err: any) {
      console.error("[SeedDemoRec] Error seeding recommendations:", err);
      return error(c, "INTERNAL_ERROR", err.message || "Failed to seed recommendations", 500);
    }
  }
}
