/**
 * Identity Resolution Endpoints
 *
 * Internal endpoints called by clearlift-cron to record identity mappings.
 * These link anonymous_id (cookie/device) to user_id (identified user).
 *
 * Auth: Service binding (primary) or X-Internal-Key header (fallback)
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { D1Adapter } from "../../../adapters/d1";
import { getSecret } from "../../../utils/secrets";

/**
 * Verify internal auth (service binding or API key)
 */
async function verifyInternalAuth(c: AppContext): Promise<boolean> {
  // Service binding calls come with CF-Worker header
  const cfWorker = c.req.header("CF-Worker");
  if (cfWorker === "clearlift-cron") {
    return true;
  }

  // Fallback: Check X-Internal-Key header (for local dev or cross-account calls)
  const internalKey = c.req.header("X-Internal-Key");
  if (!internalKey) {
    return false;
  }

  try {
    // INTERNAL_API_KEY is optional - only check if configured
    const internalApiKeyBinding = (c.env as any).INTERNAL_API_KEY;
    if (!internalApiKeyBinding) {
      return false;
    }
    const expectedKey = await getSecret(internalApiKeyBinding);
    return internalKey === expectedKey;
  } catch {
    return false;
  }
}

/**
 * POST /v1/analytics/identify
 *
 * Records an identity mapping when a user is identified.
 * Called by clearlift-cron when processing identify events from R2.
 */
export class PostIdentify extends OpenAPIRoute {
  schema = {
    tags: ["Analytics", "Internal"],
    summary: "Record identity mapping",
    description: "Links an anonymous_id to a user_id. Internal endpoint called by clearlift-cron.",
    security: [{ internalAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              org_id: z.string().uuid().describe("Organization ID"),
              anonymous_id: z.string().min(1).describe("Anonymous ID from cookie/device"),
              user_id: z.string().min(1).describe("Identified user ID (email, external ID, etc.)"),
              identified_at: z.string().datetime().describe("When the identification occurred"),
              first_seen_at: z.string().datetime().optional().describe("First event timestamp for this anonymous_id"),
              source: z.enum(["identify", "login", "merge", "manual"]).optional().default("identify"),
              confidence: z.number().min(0).max(1).optional().default(1.0),
              metadata: z.record(z.any()).optional().describe("Additional context")
            })
          }
        }
      }
    },
    responses: {
      "200": {
        description: "Identity mapping recorded",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                id: z.string(),
                is_new: z.boolean(),
                linked_anonymous_ids: z.number()
              })
            })
          }
        }
      },
      "401": { description: "Unauthorized - invalid or missing internal auth" },
      "400": { description: "Invalid request body" }
    }
  };

  async handle(c: AppContext) {
    // Verify internal auth
    const isAuthorized = await verifyInternalAuth(c);
    if (!isAuthorized) {
      return error(c, "UNAUTHORIZED", "Invalid or missing internal authentication", 401);
    }

    const data = await this.getValidatedData<typeof this.schema>();
    const body = data.body;

    const d1 = new D1Adapter(c.env.DB);

    try {
      // Verify org exists
      const org = await d1.getOrganization(body.org_id);
      if (!org) {
        return error(c, "NOT_FOUND", "Organization not found", 404);
      }

      // Upsert identity mapping
      const result = await d1.upsertIdentityMapping(
        body.org_id,
        body.anonymous_id,
        body.user_id,
        body.identified_at,
        {
          firstSeenAt: body.first_seen_at,
          source: body.source,
          confidence: body.confidence,
          metadata: body.metadata
        }
      );

      // Get count of linked anonymous_ids
      const linkedCount = await d1.getLinkedIdentityCount(body.org_id, body.user_id);

      return success(c, {
        id: result.id,
        is_new: result.isNew,
        linked_anonymous_ids: linkedCount
      });
    } catch (err: any) {
      console.error("Identity mapping error:", err);
      return error(c, "INTERNAL_ERROR", "Failed to record identity mapping", 500);
    }
  }
}

/**
 * POST /v1/analytics/identify/merge
 *
 * Merges two user identities into one canonical identity.
 * Used when the same person has multiple user_ids (e.g., different email addresses).
 */
export class PostIdentityMerge extends OpenAPIRoute {
  schema = {
    tags: ["Analytics", "Internal"],
    summary: "Merge user identities",
    description: "Merges source_user_id into target_user_id (target becomes canonical).",
    security: [{ internalAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              org_id: z.string().uuid().describe("Organization ID"),
              source_user_id: z.string().min(1).describe("User ID to merge FROM"),
              target_user_id: z.string().min(1).describe("User ID to merge INTO (becomes canonical)"),
              reason: z.string().optional().describe("Reason for merge: same_email, sso_link, manual")
            })
          }
        }
      }
    },
    responses: {
      "200": {
        description: "Identities merged successfully",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                merged: z.boolean(),
                canonical_user_id: z.string(),
                total_linked_anonymous_ids: z.number()
              })
            })
          }
        }
      },
      "401": { description: "Unauthorized" },
      "400": { description: "Invalid request" }
    }
  };

  async handle(c: AppContext) {
    const isAuthorized = await verifyInternalAuth(c);
    if (!isAuthorized) {
      return error(c, "UNAUTHORIZED", "Invalid or missing internal authentication", 401);
    }

    const data = await this.getValidatedData<typeof this.schema>();
    const body = data.body;

    if (body.source_user_id === body.target_user_id) {
      return error(c, "INVALID_REQUEST", "Cannot merge a user into themselves", 400);
    }

    const d1 = new D1Adapter(c.env.DB);

    try {
      await d1.mergeIdentities(
        body.org_id,
        body.source_user_id,
        body.target_user_id,
        "system",
        body.reason
      );

      const linkedCount = await d1.getLinkedIdentityCount(body.org_id, body.target_user_id);

      return success(c, {
        merged: true,
        canonical_user_id: body.target_user_id,
        total_linked_anonymous_ids: linkedCount
      });
    } catch (err: any) {
      console.error("Identity merge error:", err);
      return error(c, "INTERNAL_ERROR", "Failed to merge identities", 500);
    }
  }
}

/**
 * GET /v1/analytics/identity/:anonymousId
 *
 * Look up the user_id for an anonymous_id.
 * Useful for real-time identity resolution in the tag.
 */
export class GetIdentityByAnonymousId extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Look up identity by anonymous_id",
    description: "Returns the user_id linked to an anonymous_id, if any.",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        anonymousId: z.string().describe("Anonymous ID to look up")
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID")
      })
    },
    responses: {
      "200": {
        description: "Identity lookup result",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                anonymous_id: z.string(),
                user_id: z.string().nullable(),
                is_identified: z.boolean()
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    if (!session) {
      return error(c, "UNAUTHORIZED", "Session required", 401);
    }

    const params = c.req.param();
    const query = c.req.query();

    const d1 = new D1Adapter(c.env.DB);

    // Verify org access
    const hasAccess = await d1.checkOrgAccess(session.user_id, query.org_id);
    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    const userId = await d1.getUserIdByAnonymousId(query.org_id, params.anonymousId);

    return success(c, {
      anonymous_id: params.anonymousId,
      user_id: userId,
      is_identified: userId !== null
    });
  }
}
