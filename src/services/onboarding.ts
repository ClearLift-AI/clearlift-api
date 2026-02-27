/**
 * Onboarding Service
 *
 * Manages user onboarding state progression and completion tracking.
 * Auto-advances users through steps as they complete prerequisites.
 */

export interface OnboardingProgress {
  user_id: string;
  organization_id: string;
  current_step: 'welcome' | 'connect_services' | 'first_sync' | 'completed';
  steps_completed: string[];
  services_connected: number;
  first_sync_completed: boolean;
  has_verified_tag: boolean;
  has_defined_goal: boolean;
  verified_domains_count: number;
  goals_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface OnboardingStep {
  name: string;
  display_name: string;
  description: string;
  is_completed: boolean;
  is_current: boolean;
  order: number;
}

export class OnboardingService {
  constructor(private db: D1Database) {}

  /**
   * Initialize onboarding for a new user
   */
  async startOnboarding(userId: string, organizationId: string): Promise<OnboardingProgress> {
    const existing = await this.getProgress(userId);

    if (existing) {
      return existing;
    }

    await this.db.prepare(`
      INSERT INTO onboarding_progress (user_id, organization_id, current_step, steps_completed)
      VALUES (?, ?, 'welcome', '["welcome"]')
    `).bind(userId, organizationId).run();

    return await this.getProgress(userId) as OnboardingProgress;
  }

  /**
   * Get current onboarding progress for user
   */
  async getProgress(userId: string): Promise<OnboardingProgress | null> {
    const result = await this.db.prepare(`
      SELECT * FROM onboarding_progress WHERE user_id = ?
    `).bind(userId).first<OnboardingProgress>();

    if (!result) {
      return null;
    }

    // Parse JSON fields
    return {
      ...result,
      steps_completed: JSON.parse(result.steps_completed as any)
    };
  }

  /**
   * Get detailed onboarding steps with completion status
   */
  async getDetailedProgress(userId: string): Promise<OnboardingStep[]> {
    const progress = await this.getProgress(userId);

    const allSteps: OnboardingStep[] = [
      {
        name: 'welcome',
        display_name: 'Welcome',
        description: 'Get started with ClearLift',
        is_completed: false,
        is_current: false,
        order: 1
      },
      {
        name: 'connect_services',
        display_name: 'Connect Services',
        description: 'Connect at least one advertising platform',
        is_completed: false,
        is_current: false,
        order: 2
      },
      {
        name: 'first_sync',
        display_name: 'First Sync',
        description: 'Complete your first data sync',
        is_completed: false,
        is_current: false,
        order: 3
      },
      {
        name: 'completed',
        display_name: 'Setup Complete',
        description: 'You\'re all set!',
        is_completed: false,
        is_current: false,
        order: 4
      }
    ];

    if (!progress) {
      return allSteps;
    }

    // Mark completed steps and current step
    return allSteps.map(step => ({
      ...step,
      is_completed: progress.steps_completed.includes(step.name),
      is_current: step.name === progress.current_step
    }));
  }

  /**
   * Mark a step as completed and advance to next step
   */
  async completeStep(userId: string, stepName: string, organizationId?: string): Promise<OnboardingProgress> {
    let progress = await this.getProgress(userId);

    if (!progress) {
      if (!organizationId) {
        throw new Error('Onboarding not started and no organization_id provided');
      }
      progress = await this.startOnboarding(userId, organizationId);
    }

    // Add step to completed list if not already there
    if (!progress.steps_completed.includes(stepName)) {
      progress.steps_completed.push(stepName);
    }

    // Determine next step
    const nextStep = this.getNextStep(stepName);

    await this.db.prepare(`
      UPDATE onboarding_progress
      SET current_step = ?,
          steps_completed = ?,
          updated_at = datetime('now'),
          completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE completed_at END
      WHERE user_id = ?
    `).bind(
      nextStep,
      JSON.stringify(progress.steps_completed),
      nextStep,
      userId
    ).run();

    return await this.getProgress(userId) as OnboardingProgress;
  }

  /**
   * Update service connection count (called when user connects a platform)
   */
  async incrementServicesConnected(userId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE onboarding_progress
      SET services_connected = services_connected + 1,
          updated_at = datetime('now')
      WHERE user_id = ?
    `).bind(userId).run();

    // Check if we should advance to first_sync step
    const progress = await this.getProgress(userId);
    if (progress && progress.current_step === 'connect_services' && progress.services_connected >= 1) {
      await this.completeStep(userId, 'connect_services');
    }
  }

  /**
   * Decrement service connection count (called when user disconnects a platform)
   */
  async decrementServicesConnected(userId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE onboarding_progress
      SET services_connected = CASE
          WHEN services_connected > 0 THEN services_connected - 1
          ELSE 0
        END,
        updated_at = datetime('now')
      WHERE user_id = ?
    `).bind(userId).run();
  }

  /**
   * Mark first sync as completed
   */
  async markFirstSyncCompleted(userId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE onboarding_progress
      SET first_sync_completed = TRUE,
          updated_at = datetime('now')
      WHERE user_id = ?
    `).bind(userId).run();

    // Advance to completed step
    const progress = await this.getProgress(userId);
    if (progress && progress.current_step === 'first_sync') {
      await this.completeStep(userId, 'first_sync');
    }
  }

  /**
   * Mark that a domain tag has been verified
   */
  async markTagVerified(userId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE onboarding_progress
      SET has_verified_tag = 1,
          verified_domains_count = verified_domains_count + 1,
          updated_at = datetime('now')
      WHERE user_id = ?
    `).bind(userId).run();
  }

  /**
   * Increment goals count (called when a goal is created)
   */
  async incrementGoalsCount(userId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE onboarding_progress
      SET goals_count = goals_count + 1,
          has_defined_goal = 1,
          updated_at = datetime('now')
      WHERE user_id = ?
    `).bind(userId).run();
  }

  /**
   * Decrement goals count (called when a goal is deleted)
   */
  async decrementGoalsCount(userId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE onboarding_progress
      SET goals_count = CASE WHEN goals_count > 0 THEN goals_count - 1 ELSE 0 END,
          has_defined_goal = CASE WHEN goals_count > 1 THEN 1 ELSE 0 END,
          updated_at = datetime('now')
      WHERE user_id = ?
    `).bind(userId).run();
  }

  /**
   * Sync onboarding state with actual data from tables
   */
  async syncOnboardingState(userId: string, orgId: string): Promise<void> {
    const now = new Date().toISOString();

    // Sync verified domains
    const verifiedDomains = await this.db.prepare(`
      SELECT COUNT(*) as count FROM tracking_domains
      WHERE organization_id = ? AND is_verified = 1
    `).bind(orgId).first<{ count: number }>();

    // Sync goals (conversion criteria now in platform_connections.settings.conversion_events)
    const goalsCount = await this.db.prepare(`
      SELECT COUNT(*) as count FROM platform_connections
      WHERE organization_id = ? AND is_active = 1
        AND json_array_length(json_extract(settings, '$.conversion_events')) > 0
    `).bind(orgId).first<{ count: number }>();

    const vCount = verifiedDomains?.count || 0;
    const gCount = goalsCount?.count || 0;

    await this.db.prepare(`
      UPDATE onboarding_progress
      SET has_verified_tag = ?,
          verified_domains_count = ?,
          has_defined_goal = ?,
          goals_count = ?,
          updated_at = ?
      WHERE user_id = ?
    `).bind(
      vCount > 0 ? 1 : 0,
      vCount,
      gCount > 0 ? 1 : 0,
      gCount,
      now,
      userId
    ).run();
  }

  /**
   * Check if user has completed onboarding
   */
  async isOnboardingComplete(userId: string): Promise<boolean> {
    const progress = await this.getProgress(userId);
    if (!progress) {
      return false;
    }

    return progress.current_step === 'completed';
  }

  /**
   * Reset onboarding (for testing or admin purposes)
   */
  async resetOnboarding(userId: string): Promise<void> {
    await this.db.prepare(`
      UPDATE onboarding_progress
      SET current_step = 'welcome',
          steps_completed = '["welcome"]',
          services_connected = 0,
          first_sync_completed = FALSE,
          has_verified_tag = 0,
          has_defined_goal = 0,
          verified_domains_count = 0,
          goals_count = 0,
          updated_at = datetime('now'),
          completed_at = NULL
      WHERE user_id = ?
    `).bind(userId).run();
  }

  /**
   * Get next step in sequence
   */
  private getNextStep(currentStep: string): string {
    const stepSequence: Record<string, string> = {
      'welcome': 'connect_services',
      'connect_services': 'first_sync',
      'first_sync': 'completed',
      'completed': 'completed'
    };

    return stepSequence[currentStep] || 'welcome';
  }

  /**
   * Get onboarding statistics for organization
   */
  async getOrganizationStats(organizationId: string): Promise<{
    total_users: number;
    completed_onboarding: number;
    in_progress: number;
    completion_rate: number;
  }> {
    const stats = await this.db.prepare(`
      SELECT
        COUNT(*) as total_users,
        SUM(CASE WHEN current_step = 'completed' THEN 1 ELSE 0 END) as completed_onboarding,
        SUM(CASE WHEN current_step != 'completed' THEN 1 ELSE 0 END) as in_progress
      FROM onboarding_progress
      WHERE organization_id = ?
    `).bind(organizationId).first<any>();

    return {
      total_users: stats.total_users || 0,
      completed_onboarding: stats.completed_onboarding || 0,
      in_progress: stats.in_progress || 0,
      completion_rate: stats.total_users > 0
        ? (stats.completed_onboarding / stats.total_users) * 100
        : 0
    };
  }
}
