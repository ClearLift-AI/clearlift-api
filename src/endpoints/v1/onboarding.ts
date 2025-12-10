import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { OnboardingService } from "../../services/onboarding";
import { success, error } from "../../utils/response";

/**
 * GET /v1/onboarding/status - Get current onboarding progress
 */
export class GetOnboardingStatus extends OpenAPIRoute {
  public schema = {
    tags: ["Onboarding"],
    summary: "Get onboarding progress",
    operationId: "get-onboarding-status",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "Onboarding status",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                current_step: z.string(),
                steps: z.array(z.object({
                  name: z.string(),
                  display_name: z.string(),
                  description: z.string(),
                  is_completed: z.boolean(),
                  is_current: z.boolean(),
                  order: z.number()
                })),
                services_connected: z.number(),
                first_sync_completed: z.boolean(),
                is_complete: z.boolean()
              })
            })
          }
        }
      },
      "401": {
        description: "Unauthorized"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const onboarding = new OnboardingService(c.env.DB);

    let progress = await onboarding.getProgress(session.user_id);

    // Auto-initialize onboarding if not started
    if (!progress) {
      // Get user's primary organization
      const orgResult = await c.env.DB.prepare(`
        SELECT organization_id FROM organization_members
        WHERE user_id = ?
        ORDER BY joined_at ASC
        LIMIT 1
      `).bind(session.user_id).first<{ organization_id: string }>();

      if (!orgResult) {
        return error(c, "NO_ORGANIZATION", "User has no organization", 400);
      }

      progress = await onboarding.startOnboarding(session.user_id, orgResult.organization_id);
    }

    // === NORMALIZATION / HEALING LOGIC ===
    // Ensure organization is in a valid state regardless of how user was created
    const orgId = progress.organization_id;
    const now = new Date().toISOString();

    // 1. Ensure org_tag_mapping exists
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      // Get org name to generate tag
      const org = await c.env.DB.prepare(`
        SELECT name FROM organizations WHERE id = ?
      `).bind(orgId).first<{ name: string }>();

      if (org) {
        const baseTag = org.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'org';
        let shortTag = baseTag;
        let tagCounter = 1;
        while (await c.env.DB.prepare("SELECT id FROM org_tag_mappings WHERE short_tag = ?").bind(shortTag).first()) {
          shortTag = `${baseTag}${tagCounter}`;
          tagCounter++;
        }

        await c.env.DB.prepare(`
          INSERT INTO org_tag_mappings (id, organization_id, short_tag, created_at)
          VALUES (?, ?, ?, ?)
        `).bind(crypto.randomUUID(), orgId, shortTag, now).run();

        console.log(`[ONBOARDING_HEAL] Created missing org_tag_mapping for org ${orgId}: ${shortTag}`);
      }
    }

    // AI recommendations are generated from real synced data via POST /v1/analysis/run
    // No fake demo data seeding - recommendations come from actual platform data

    // 2. Sync services_connected with actual platform connections
    const connectionCount = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM platform_connections
      WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ count: number }>();

    const actualConnections = connectionCount?.count || 0;
    if (progress.services_connected !== actualConnections) {
      await c.env.DB.prepare(`
        UPDATE onboarding_progress
        SET services_connected = ?, updated_at = ?
        WHERE user_id = ?
      `).bind(actualConnections, now, session.user_id).run();

      progress.services_connected = actualConnections;
      console.log(`[ONBOARDING_HEAL] Synced services_connected for user ${session.user_id}: ${actualConnections}`);
    }

    // 4. Auto-advance onboarding if conditions are met
    if (progress.current_step === 'connect_services' && actualConnections >= 1) {
      progress = await onboarding.completeStep(session.user_id, 'connect_services');
      console.log(`[ONBOARDING_HEAL] Auto-advanced user ${session.user_id} past connect_services`);
    }

    // 5. Check if first sync completed (any successful sync job)
    if (progress.current_step === 'first_sync' && !progress.first_sync_completed) {
      const completedSync = await c.env.DB.prepare(`
        SELECT 1 FROM sync_jobs
        WHERE organization_id = ? AND status = 'completed'
        LIMIT 1
      `).bind(orgId).first();

      if (completedSync) {
        await onboarding.markFirstSyncCompleted(session.user_id);
        progress.first_sync_completed = true;
        progress = await onboarding.getProgress(session.user_id) as typeof progress;
        console.log(`[ONBOARDING_HEAL] Marked first_sync_completed for user ${session.user_id}`);
      }
    }

    const steps = await onboarding.getDetailedProgress(session.user_id);
    const isComplete = await onboarding.isOnboardingComplete(session.user_id);

    return success(c, {
      current_step: progress.current_step,
      steps,
      services_connected: progress.services_connected,
      first_sync_completed: progress.first_sync_completed,
      is_complete: isComplete
    });
  }
}

/**
 * POST /v1/onboarding/start - Start onboarding process
 */
export class StartOnboarding extends OpenAPIRoute {
  public schema = {
    tags: ["Onboarding"],
    summary: "Start onboarding",
    operationId: "start-onboarding",
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          organization_id: z.string().optional()
        })
      )
    },
    responses: {
      "200": {
        description: "Onboarding started"
      },
      "401": {
        description: "Unauthorized"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const { organization_id } = data.body;

    // Determine organization
    let orgId = organization_id;
    if (!orgId) {
      const orgResult = await c.env.DB.prepare(`
        SELECT organization_id FROM organization_members
        WHERE user_id = ?
        ORDER BY joined_at ASC
        LIMIT 1
      `).bind(session.user_id).first<{ organization_id: string }>();

      if (!orgResult) {
        return error(c, "NO_ORGANIZATION", "User has no organization", 400);
      }

      orgId = orgResult.organization_id;
    }

    const onboarding = new OnboardingService(c.env.DB);
    const progress = await onboarding.startOnboarding(session.user_id, orgId);

    return success(c, { progress });
  }
}

/**
 * POST /v1/onboarding/complete-step - Mark a step as completed
 */
export class CompleteOnboardingStep extends OpenAPIRoute {
  public schema = {
    tags: ["Onboarding"],
    summary: "Complete onboarding step",
    operationId: "complete-onboarding-step",
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          step_name: z.enum(['welcome', 'connect_services', 'first_sync'])
        })
      )
    },
    responses: {
      "200": {
        description: "Step completed"
      },
      "401": {
        description: "Unauthorized"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const { step_name } = data.body;

    const onboarding = new OnboardingService(c.env.DB);
    const progress = await onboarding.completeStep(session.user_id, step_name);

    return success(c, { progress });
  }
}

/**
 * POST /v1/onboarding/reset - Reset onboarding (for testing)
 */
export class ResetOnboarding extends OpenAPIRoute {
  public schema = {
    tags: ["Onboarding"],
    summary: "Reset onboarding progress",
    operationId: "reset-onboarding",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "Onboarding reset"
      },
      "401": {
        description: "Unauthorized"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const onboarding = new OnboardingService(c.env.DB);

    await onboarding.resetOnboarding(session.user_id);

    return success(c, { message: "Onboarding reset successfully" });
  }
}
