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
