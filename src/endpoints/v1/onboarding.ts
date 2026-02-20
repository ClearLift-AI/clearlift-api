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

    // Get user's primary organization
    const orgResult = await c.env.DB.prepare(`
      SELECT organization_id FROM organization_members
      WHERE user_id = ?
      ORDER BY joined_at ASC
      LIMIT 1
    `).bind(session.user_id).first<{ organization_id: string }>();

    // If user has no organization, return gracefully with organization step
    if (!orgResult) {
      const organizationStep = {
        name: 'organization',
        display_name: 'Organization',
        description: 'Create or join an organization',
        is_completed: false,
        is_current: true,
        order: 1
      };

      return success(c, {
        current_step: 'organization',
        steps: [
          organizationStep,
          { name: 'connect_services', display_name: 'Connect Services', description: 'Connect at least one advertising platform', is_completed: false, is_current: false, order: 2 },
          { name: 'first_sync', display_name: 'First Sync', description: 'Complete your first data sync', is_completed: false, is_current: false, order: 3 },
          { name: 'completed', display_name: 'Setup Complete', description: "You're all set!", is_completed: false, is_current: false, order: 4 }
        ],
        services_connected: 0,
        first_sync_completed: false,
        is_complete: false,
        needs_organization: true
      });
    }

    let progress = await onboarding.getProgress(session.user_id);

    // Auto-initialize onboarding if not started (user has org but no progress)
    if (!progress) {
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

    // 2. Ensure ai_optimization_settings exist for this org
    // Creates default settings if missing - enables AI recommendation generation
    const aiSettings = await c.env.DB.prepare(`
      SELECT org_id FROM ai_optimization_settings WHERE org_id = ?
    `).bind(orgId).first();

    if (!aiSettings) {
      await c.env.DB.prepare(`
        INSERT INTO ai_optimization_settings (
          org_id, run_frequency, budget_optimization, ai_control,
          daily_cap_cents, monthly_cap_cents, created_at, updated_at
        ) VALUES (?, 'weekly', 'moderate', 'copilot', 100000, 3000000, ?, ?)
      `).bind(orgId, now, now).run();

      console.log(`[ONBOARDING_HEAL] Created default ai_optimization_settings for org ${orgId}`);
    }

    // 3. Sync services_connected with actual platform connections
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
    // Handle case where user connected services but is still stuck at 'welcome'
    if (progress.current_step === 'welcome' && actualConnections >= 1) {
      progress = await onboarding.completeStep(session.user_id, 'welcome');
      console.log(`[ONBOARDING_HEAL] Auto-advanced user ${session.user_id} past welcome (had ${actualConnections} connections)`);
    }
    // Handle connect_services → first_sync
    if (progress.current_step === 'connect_services' && actualConnections >= 1) {
      progress = await onboarding.completeStep(session.user_id, 'connect_services');
      console.log(`[ONBOARDING_HEAL] Auto-advanced user ${session.user_id} past connect_services`);
    }

    // 5. Check if first sync completed (first_sync → completed)
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

    // 6. Sync has_verified_tag with tracking_domains
    const verifiedDomains = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM tracking_domains
      WHERE organization_id = ? AND is_verified = 1
    `).bind(orgId).first<{ count: number }>();

    const verifiedCount = verifiedDomains?.count || 0;
    if ((verifiedCount > 0) !== Boolean(progress.has_verified_tag)) {
      await c.env.DB.prepare(`
        UPDATE onboarding_progress
        SET has_verified_tag = ?, verified_domains_count = ?, updated_at = ?
        WHERE user_id = ?
      `).bind(verifiedCount > 0 ? 1 : 0, verifiedCount, now, session.user_id).run();

      progress.has_verified_tag = verifiedCount > 0;
      progress.verified_domains_count = verifiedCount;
      console.log(`[ONBOARDING_HEAL] Synced has_verified_tag for user ${session.user_id}: ${verifiedCount}`);
    }

    // 7. Sync goals_count with platform_connections that have conversion_events configured
    const goalsCount = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM platform_connections
      WHERE organization_id = ? AND is_active = 1
        AND json_extract(settings, '$.conversion_events') IS NOT NULL
    `).bind(orgId).first<{ count: number }>();

    const gCount = goalsCount?.count || 0;
    if (gCount !== (progress.goals_count || 0)) {
      await c.env.DB.prepare(`
        UPDATE onboarding_progress
        SET goals_count = ?, has_defined_goal = ?, updated_at = ?
        WHERE user_id = ?
      `).bind(gCount, gCount > 0 ? 1 : 0, now, session.user_id).run();

      progress.goals_count = gCount;
      progress.has_defined_goal = gCount > 0;
      console.log(`[ONBOARDING_HEAL] Synced goals_count for user ${session.user_id}: ${gCount}`);
    }

    const steps = await onboarding.getDetailedProgress(session.user_id);
    const isComplete = await onboarding.isOnboardingComplete(session.user_id);

    return success(c, {
      current_step: progress.current_step,
      steps,
      services_connected: progress.services_connected,
      first_sync_completed: progress.first_sync_completed,
      has_verified_tag: Boolean(progress.has_verified_tag),
      has_defined_goal: Boolean(progress.has_defined_goal),
      verified_domains_count: progress.verified_domains_count || 0,
      goals_count: progress.goals_count || 0,
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
 * GET /v1/onboarding/validate - Validate onboarding completion requirements
 */
export class ValidateOnboarding extends OpenAPIRoute {
  public schema = {
    tags: ["Onboarding"],
    summary: "Validate onboarding completion",
    operationId: "validate-onboarding",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional(),
      }),
    },
    responses: {
      "200": {
        description: "Validation result",
      },
      "401": {
        description: "Unauthorized"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");

    // Get org
    const data = await this.getValidatedData<typeof this.schema>();
    let orgId = data.query.org_id;

    if (!orgId) {
      const orgResult = await c.env.DB.prepare(`
        SELECT organization_id FROM organization_members
        WHERE user_id = ? ORDER BY joined_at ASC LIMIT 1
      `).bind(session.user_id).first<{ organization_id: string }>();

      if (!orgResult) {
        return success(c, {
          hasOrganization: false,
          hasConnectedPlatform: false,
          hasInstalledTag: false,
          hasDefinedGoal: false,
          isComplete: false,
          missingSteps: ['organization', 'platforms', 'tracking', 'goals'],
          details: { connectedPlatforms: 0, verifiedDomains: 0, definedGoals: 0 }
        });
      }
      orgId = orgResult.organization_id;
    }

    // Check platform connections
    const connections = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM platform_connections
      WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ count: number }>();

    // Check verified domains
    const domains = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM tracking_domains
      WHERE organization_id = ? AND is_verified = 1
    `).bind(orgId).first<{ count: number }>();

    // Check goals (conversion criteria now in platform_connections.settings.conversion_events)
    const goals = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM platform_connections
      WHERE organization_id = ? AND is_active = 1
        AND json_extract(settings, '$.conversion_events') IS NOT NULL
    `).bind(orgId).first<{ count: number }>();

    const connectedPlatforms = connections?.count || 0;
    const verifiedDomains = domains?.count || 0;
    const definedGoals = goals?.count || 0;

    const hasConnectedPlatform = connectedPlatforms > 0;
    const hasInstalledTag = verifiedDomains > 0;
    const hasDefinedGoal = definedGoals > 0;

    const missingSteps: string[] = [];
    if (!hasConnectedPlatform) missingSteps.push('platforms');
    if (!hasInstalledTag) missingSteps.push('tracking');
    if (!hasDefinedGoal) missingSteps.push('goals');

    return success(c, {
      hasOrganization: true,
      hasConnectedPlatform,
      hasInstalledTag,
      hasDefinedGoal,
      isComplete: missingSteps.length === 0,
      missingSteps,
      details: { connectedPlatforms, verifiedDomains, definedGoals }
    });
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
