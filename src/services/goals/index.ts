/**
 * Conversion Goals Service
 *
 * Manages conversion goal definitions and queries metrics per goal.
 * Goals can be of type:
 * - 'revenue_source': Uses the revenue source plugin system (Stripe, Shopify, Jobber)
 * - 'tag_event': Filters events from the tracking tag (form submits, etc.)
 * - 'manual': Manually logged conversions (future)
 */

import { revenueSourceRegistry } from '../revenue-sources/index';
import { structuredLog } from '../../utils/structured-logger';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Goal type determines where conversion data comes from
 */
export type GoalType = 'revenue_source' | 'tag_event' | 'manual';

/**
 * How to calculate the conversion value
 */
export type ValueType = 'from_source' | 'fixed' | 'none';

/**
 * Event filters for tag_event goals
 */
export interface EventFilters {
  event_type?: string;      // 'form_submit', 'purchase', 'click'
  goal_id?: string;         // Specific goal_id from tag
  url_pattern?: string;     // Regex pattern to match URL
  [key: string]: string | undefined;
}

/**
 * Conversion goal configuration
 */
export interface ConversionGoal {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description?: string;
  goal_type: GoalType;
  revenue_sources?: string[];     // For revenue_source goals: ['stripe', 'shopify']
  event_filters?: EventFilters;   // For tag_event goals
  value_type: ValueType;
  fixed_value_cents?: number;
  display_order: number;
  is_primary: boolean;
  color?: string;
  icon?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Input for creating/updating a goal
 */
export interface ConversionGoalInput {
  name: string;
  slug?: string;
  description?: string;
  goal_type: GoalType;
  revenue_sources?: string[];
  event_filters?: EventFilters;
  value_type?: ValueType;
  fixed_value_cents?: number;
  display_order?: number;
  is_primary?: boolean;
  color?: string;
  icon?: string;
  is_active?: boolean;
}

/**
 * Metrics for a single goal
 */
export interface GoalMetrics {
  goal_id: string;
  goal_name: string;
  goal_slug: string;
  goal_type: GoalType;
  is_primary: boolean;
  color?: string;
  icon?: string;
  conversions: number;
  revenue: number;
  unique_customers?: number;
  // For revenue_source goals: breakdown by source
  sources?: Record<string, { conversions: number; revenue: number }>;
}

/**
 * Time series data point for a goal
 */
export interface GoalTimeSeriesPoint {
  bucket: string;
  conversions: number;
  revenue: number;
}

/**
 * Combined result for all goals
 */
export interface AllGoalsMetrics {
  goals: GoalMetrics[];
  primary_goal?: GoalMetrics;
  total_conversions: number;
  total_revenue: number;
}

// =============================================================================
// GOAL SERVICE
// =============================================================================

export class GoalService {
  private db: D1Database;
  private analyticsDb: D1Database;

  constructor(db: D1Database, analyticsDb: D1Database) {
    this.db = db;
    this.analyticsDb = analyticsDb;
  }

  // ---------------------------------------------------------------------------
  // CRUD Operations
  // ---------------------------------------------------------------------------

  /**
   * Get all goals for an organization
   */
  async getGoals(orgId: string, activeOnly: boolean = true): Promise<ConversionGoal[]> {
    let query = `
      SELECT * FROM conversion_goals
      WHERE organization_id = ?
    `;

    if (activeOnly) {
      query += ` AND is_active = 1`;
    }

    query += ` ORDER BY display_order ASC, created_at ASC`;

    const result = await this.db.prepare(query).bind(orgId).all<ConversionGoalRow>();

    return result.results.map((row) => this.rowToGoal(row));
  }

  /**
   * Get a single goal by ID
   */
  async getGoal(orgId: string, goalId: string): Promise<ConversionGoal | null> {
    const result = await this.db.prepare(`
      SELECT * FROM conversion_goals
      WHERE id = ? AND organization_id = ?
    `).bind(goalId, orgId).first<ConversionGoalRow>();

    if (!result) return null;
    return this.rowToGoal(result);
  }

  /**
   * Get a goal by slug
   */
  async getGoalBySlug(orgId: string, slug: string): Promise<ConversionGoal | null> {
    const result = await this.db.prepare(`
      SELECT * FROM conversion_goals
      WHERE slug = ? AND organization_id = ?
    `).bind(slug, orgId).first<ConversionGoalRow>();

    if (!result) return null;
    return this.rowToGoal(result);
  }

  /**
   * Create a new goal
   * Writes to both legacy and new columns for backwards compatibility
   */
  async createGoal(orgId: string, input: ConversionGoalInput): Promise<ConversionGoal> {
    const slug = input.slug || this.generateSlug(input.name);

    // Check for slug uniqueness
    const existing = await this.getGoalBySlug(orgId, slug);
    if (existing) {
      throw new Error(`Goal with slug '${slug}' already exists`);
    }

    // Build legacy trigger_config from event_filters for backwards compatibility
    let triggerConfig: string | null = null;
    if (input.goal_type === 'tag_event' && input.event_filters) {
      triggerConfig = JSON.stringify({
        event_type: input.event_filters.event_type,
        custom_event: input.event_filters.goal_id,
        page_pattern: input.event_filters.url_pattern,
      });
    }

    // Map value_type to legacy default_value_cents
    const defaultValueCents = input.value_type === 'fixed' ? (input.fixed_value_cents || 0) : 0;

    const result = await this.db.prepare(`
      INSERT INTO conversion_goals (
        organization_id, name, slug, description, goal_type,
        revenue_sources, filter_config, value_type, fixed_value_cents,
        display_order, is_primary, color, icon, is_active,
        type, trigger_config, default_value_cents, priority, include_in_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).bind(
      orgId,
      input.name,
      slug,
      input.description || null,
      input.goal_type,
      input.revenue_sources ? JSON.stringify(input.revenue_sources) : null,
      input.event_filters ? JSON.stringify(input.event_filters) : null,
      input.value_type || 'from_source',
      input.fixed_value_cents || null,
      input.display_order ?? 0,
      input.is_primary ? 1 : 0,
      input.color || null,
      input.icon || null,
      input.is_active !== false ? 1 : 0,
      // Legacy columns
      'conversion',
      triggerConfig,
      defaultValueCents,
      input.display_order ?? 0,
      1
    ).first<ConversionGoalRow>();

    if (!result) {
      throw new Error('Failed to create goal');
    }

    return this.rowToGoal(result);
  }

  /**
   * Ensure a default conversion goal exists for a revenue-capable platform.
   * Called automatically when a connector is first connected.
   * Idempotent: skips if a goal already references this platform.
   */
  async ensureDefaultGoalForPlatform(orgId: string, platform: string): Promise<ConversionGoal | null> {
    // Revenue-capable connector types
    const REVENUE_TYPES = ['revenue', 'payments', 'ecommerce', 'field_service'];

    // Check connector_configs to see if this platform is revenue-capable
    const connectorDef = await this.db.prepare(`
      SELECT connector_type, has_actual_value, name FROM connector_configs
      WHERE provider = ? AND is_active = 1
    `).bind(platform).first<{ connector_type: string; has_actual_value: number; name: string }>();

    if (!connectorDef) return null;

    const isRevenue = REVENUE_TYPES.includes(connectorDef.connector_type) ||
      (connectorDef.connector_type === 'crm' && connectorDef.has_actual_value);
    if (!isRevenue) return null;

    // Check if a goal already exists for this platform
    const existing = await this.db.prepare(`
      SELECT id FROM conversion_goals
      WHERE organization_id = ? AND is_active = 1
        AND (revenue_sources LIKE ? OR goal_type = 'revenue_source')
        AND revenue_sources LIKE ?
    `).bind(orgId, `%${platform}%`, `%${platform}%`).first();

    if (existing) {
      console.log(`[GoalService] Default goal already exists for ${platform} in org ${orgId}`);
      return null;
    }

    // Default goal names per platform
    const PLATFORM_GOAL_NAMES: Record<string, string> = {
      stripe: 'Stripe Payment',
      shopify: 'Shopify Order',
      jobber: 'Jobber Job Completed',
      hubspot: 'HubSpot Deal Won',
    };

    const goalName = PLATFORM_GOAL_NAMES[platform] || `${connectorDef.name || platform} Conversion`;

    try {
      const goal = await this.createGoal(orgId, {
        name: goalName,
        goal_type: 'revenue_source',
        revenue_sources: [platform],
        value_type: connectorDef.has_actual_value ? 'from_source' : 'none',
        is_primary: false,
      });
      console.log(`[GoalService] Auto-created default goal '${goalName}' for ${platform} in org ${orgId}`);
      return goal;
    } catch (err) {
      // Slug collision or other error — non-fatal
      structuredLog('WARN', 'Failed to auto-create goal for platform', { service: 'GoalService', platform, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * Update an existing goal
   */
  async updateGoal(orgId: string, goalId: string, input: Partial<ConversionGoalInput>): Promise<ConversionGoal> {
    // Build dynamic update query
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (input.name !== undefined) {
      updates.push('name = ?');
      values.push(input.name);
    }
    if (input.slug !== undefined) {
      // Check for slug uniqueness
      const existing = await this.getGoalBySlug(orgId, input.slug);
      if (existing && existing.id !== goalId) {
        throw new Error(`Goal with slug '${input.slug}' already exists`);
      }
      updates.push('slug = ?');
      values.push(input.slug);
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      values.push(input.description || null);
    }
    if (input.goal_type !== undefined) {
      updates.push('goal_type = ?');
      values.push(input.goal_type);
    }
    if (input.revenue_sources !== undefined) {
      updates.push('revenue_sources = ?');
      values.push(input.revenue_sources ? JSON.stringify(input.revenue_sources) : null);
    }
    if (input.event_filters !== undefined) {
      updates.push('filter_config = ?');
      values.push(input.event_filters ? JSON.stringify(input.event_filters) : null);
    }
    if (input.value_type !== undefined) {
      updates.push('value_type = ?');
      values.push(input.value_type);
    }
    if (input.fixed_value_cents !== undefined) {
      updates.push('fixed_value_cents = ?');
      values.push(input.fixed_value_cents);
    }
    if (input.display_order !== undefined) {
      updates.push('display_order = ?');
      values.push(input.display_order);
    }
    if (input.is_primary !== undefined) {
      updates.push('is_primary = ?');
      values.push(input.is_primary ? 1 : 0);
    }
    if (input.color !== undefined) {
      updates.push('color = ?');
      values.push(input.color || null);
    }
    if (input.icon !== undefined) {
      updates.push('icon = ?');
      values.push(input.icon || null);
    }
    if (input.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(input.is_active ? 1 : 0);
    }

    if (updates.length === 0) {
      const existing = await this.getGoal(orgId, goalId);
      if (!existing) throw new Error('Goal not found');
      return existing;
    }

    updates.push("updated_at = datetime('now')");
    values.push(goalId, orgId);

    const result = await this.db.prepare(`
      UPDATE conversion_goals
      SET ${updates.join(', ')}
      WHERE id = ? AND organization_id = ?
      RETURNING *
    `).bind(...values).first<ConversionGoalRow>();

    if (!result) {
      throw new Error('Goal not found');
    }

    return this.rowToGoal(result);
  }

  /**
   * Delete a goal
   */
  async deleteGoal(orgId: string, goalId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM conversion_goals
      WHERE id = ? AND organization_id = ?
    `).bind(goalId, orgId).run();

    return result.meta.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Metrics Queries
  // ---------------------------------------------------------------------------

  /**
   * Get realtime metrics for all active goals
   */
  async getRealtimeMetrics(orgId: string, hours: number = 24): Promise<AllGoalsMetrics> {
    const goals = await this.getGoals(orgId, true);
    const results: GoalMetrics[] = [];
    let primaryGoal: GoalMetrics | undefined;
    let totalConversions = 0;
    let totalRevenue = 0;

    for (const goal of goals) {
      const metrics = await this.getGoalRealtimeMetrics(orgId, goal, hours);
      results.push(metrics);

      if (goal.is_primary) {
        primaryGoal = metrics;
      }

      totalConversions += metrics.conversions;
      totalRevenue += metrics.revenue;
    }

    return {
      goals: results,
      primary_goal: primaryGoal,
      total_conversions: totalConversions,
      total_revenue: totalRevenue,
    };
  }

  /**
   * Get realtime metrics for a single goal
   */
  async getGoalRealtimeMetrics(orgId: string, goal: ConversionGoal, hours: number = 24): Promise<GoalMetrics> {
    switch (goal.goal_type) {
      case 'revenue_source':
        return this.getRevenueSourceGoalMetrics(orgId, goal, hours);
      case 'tag_event':
        return this.getTagEventGoalMetrics(orgId, goal, hours);
      case 'manual':
        return this.getManualGoalMetrics(orgId, goal, hours);
      default:
        return {
          goal_id: goal.id,
          goal_name: goal.name,
          goal_slug: goal.slug,
          goal_type: goal.goal_type,
          is_primary: goal.is_primary,
          color: goal.color,
          icon: goal.icon,
          conversions: 0,
          revenue: 0,
        };
    }
  }

  /**
   * Get metrics for a revenue_source goal (Stripe, Shopify, Jobber)
   */
  private async getRevenueSourceGoalMetrics(
    orgId: string,
    goal: ConversionGoal,
    hours: number
  ): Promise<GoalMetrics> {
    const targetSources = goal.revenue_sources || []; // Empty means all
    const providers = revenueSourceRegistry.getAll();
    const sources: Record<string, { conversions: number; revenue: number }> = {};
    let totalConversions = 0;
    let totalRevenue = 0;
    let totalCustomers = 0;

    for (const provider of providers) {
      // Skip if specific sources are specified and this isn't one
      if (targetSources.length > 0 && !targetSources.includes(provider.meta.platform)) {
        continue;
      }

      try {
        const hasData = await provider.hasData(this.analyticsDb, orgId);
        if (!hasData) continue;

        const summary = await provider.getSummary(this.analyticsDb, orgId, hours);
        sources[provider.meta.platform] = {
          conversions: summary.conversions,
          revenue: this.applyValueType(goal, summary.revenue, summary.conversions),
        };
        totalConversions += summary.conversions;
        totalRevenue += sources[provider.meta.platform].revenue;
        totalCustomers += summary.uniqueCustomers;
      } catch (e) {
        // Provider query failed, skip
        structuredLog('ERROR', 'Provider query failed', { service: 'GoalService', platform: provider.meta.platform, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return {
      goal_id: goal.id,
      goal_name: goal.name,
      goal_slug: goal.slug,
      goal_type: goal.goal_type,
      is_primary: goal.is_primary,
      color: goal.color,
      icon: goal.icon,
      conversions: totalConversions,
      revenue: totalRevenue,
      unique_customers: totalCustomers,
      sources,
    };
  }

  /**
   * Get metrics for a tag_event goal (form submits, etc.)
   *
   * Currently queries hourly_metrics for aggregate tag-based conversions.
   * Note: hourly_metrics tracks all events with goal_id, not per-specific-goal.
   * For full per-goal tracking, the cron needs to write to goal_conversions.
   */
  private async getTagEventGoalMetrics(
    orgId: string,
    goal: ConversionGoal,
    hours: number
  ): Promise<GoalMetrics> {
    // First, try to get org_tag for hourly_metrics query
    let orgTag: string | null = null;
    try {
      const tagResult = await this.db.prepare(`
        SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
      `).bind(orgId).first<{ short_tag: string }>();
      orgTag = tagResult?.short_tag || null;
    } catch (e) {
      // org_tag_mappings may not exist
    }

    // Try goal_conversions first (for future when cron populates it)
    try {
      const gcResult = await this.analyticsDb.prepare(`
        SELECT
          COUNT(*) as conversions,
          COALESCE(SUM(value_cents), 0) as revenue_cents
        FROM goal_conversions
        WHERE organization_id = ?
          AND goal_id = ?
          AND conversion_timestamp >= datetime('now', '-' || ? || ' hours')
      `).bind(orgId, goal.id, hours).first<{ conversions: number; revenue_cents: number }>();

      if (gcResult && gcResult.conversions > 0) {
        const conversions = gcResult.conversions;
        const revenueFromSource = (gcResult.revenue_cents || 0) / 100;
        const revenue = this.applyValueType(goal, revenueFromSource, conversions);

        return {
          goal_id: goal.id,
          goal_name: goal.name,
          goal_slug: goal.slug,
          goal_type: goal.goal_type,
          is_primary: goal.is_primary,
          color: goal.color,
          icon: goal.icon,
          conversions,
          revenue,
        };
      }
    } catch (e) {
      // goal_conversions table may not exist or be empty, fall through
    }

    // Fall back to hourly_metrics for aggregate tag conversions
    // Note: This returns ALL tag-based conversions, not filtered by specific goal filters
    if (orgTag) {
      try {
        const hmResult = await this.analyticsDb.prepare(`
          SELECT
            COALESCE(SUM(conversions), 0) as conversions,
            COALESCE(SUM(revenue_cents), 0) as revenue_cents
          FROM hourly_metrics
          WHERE org_tag = ?
            AND hour >= datetime('now', '-' || ? || ' hours')
        `).bind(orgTag, hours).first<{ conversions: number; revenue_cents: number }>();

        const conversions = hmResult?.conversions || 0;
        const revenueFromSource = (hmResult?.revenue_cents || 0) / 100;
        const revenue = this.applyValueType(goal, revenueFromSource, conversions);

        return {
          goal_id: goal.id,
          goal_name: goal.name,
          goal_slug: goal.slug,
          goal_type: goal.goal_type,
          is_primary: goal.is_primary,
          color: goal.color,
          icon: goal.icon,
          conversions,
          revenue,
        };
      } catch (e) {
        structuredLog('ERROR', 'hourly_metrics query failed', { service: 'GoalService', error: e instanceof Error ? e.message : String(e) });
      }
    }

    // No data available
    return {
      goal_id: goal.id,
      goal_name: goal.name,
      goal_slug: goal.slug,
      goal_type: goal.goal_type,
      is_primary: goal.is_primary,
      color: goal.color,
      icon: goal.icon,
      conversions: 0,
      revenue: 0,
    };
  }

  /**
   * Get metrics for a manual goal (placeholder for future)
   */
  private async getManualGoalMetrics(
    orgId: string,
    goal: ConversionGoal,
    hours: number
  ): Promise<GoalMetrics> {
    // Manual goals would query a separate manual_conversions table
    return {
      goal_id: goal.id,
      goal_name: goal.name,
      goal_slug: goal.slug,
      goal_type: goal.goal_type,
      is_primary: goal.is_primary,
      color: goal.color,
      icon: goal.icon,
      conversions: 0,
      revenue: 0,
    };
  }

  /**
   * Get time series for a goal
   */
  async getGoalTimeSeries(orgId: string, goalId: string, hours: number = 24): Promise<GoalTimeSeriesPoint[]> {
    const goal = await this.getGoal(orgId, goalId);
    if (!goal) return [];

    if (goal.goal_type === 'revenue_source') {
      return this.getRevenueSourceTimeSeries(orgId, goal, hours);
    }

    // For tag_event and manual, query goal_conversions
    return this.getGenericGoalTimeSeries(orgId, goal, hours);
  }

  /**
   * Get time series for revenue_source goals
   */
  private async getRevenueSourceTimeSeries(
    orgId: string,
    goal: ConversionGoal,
    hours: number
  ): Promise<GoalTimeSeriesPoint[]> {
    const targetSources = goal.revenue_sources || [];
    const providers = revenueSourceRegistry.getAll();
    const timeSeriesMap = new Map<string, { conversions: number; revenue: number }>();

    for (const provider of providers) {
      if (targetSources.length > 0 && !targetSources.includes(provider.meta.platform)) {
        continue;
      }

      try {
        const hasData = await provider.hasData(this.analyticsDb, orgId);
        if (!hasData) continue;

        const timeSeries = await provider.getTimeSeries(this.analyticsDb, orgId, hours);
        for (const point of timeSeries) {
          const existing = timeSeriesMap.get(point.bucket) || { conversions: 0, revenue: 0 };
          const pointRevenue = this.applyValueTypePerConversion(goal, point.revenue, point.conversions);
          timeSeriesMap.set(point.bucket, {
            conversions: existing.conversions + point.conversions,
            revenue: existing.revenue + pointRevenue,
          });
        }
      } catch (e) {
        structuredLog('ERROR', 'TimeSeries query failed', { service: 'GoalService', platform: provider.meta.platform, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return Array.from(timeSeriesMap.entries())
      .map(([bucket, data]) => ({ bucket, ...data }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));
  }

  /**
   * Get time series for tag_event/manual goals from goal_conversions
   */
  private async getGenericGoalTimeSeries(
    orgId: string,
    goal: ConversionGoal,
    hours: number
  ): Promise<GoalTimeSeriesPoint[]> {
    try {
      const result = await this.analyticsDb.prepare(`
        SELECT
          strftime('%Y-%m-%d %H:00:00', conversion_timestamp) as bucket,
          COUNT(*) as conversions,
          SUM(value_cents) as revenue_cents
        FROM goal_conversions
        WHERE organization_id = ?
          AND goal_id = ?
          AND conversion_timestamp >= datetime('now', '-' || ? || ' hours')
        GROUP BY bucket
        ORDER BY bucket ASC
      `).bind(orgId, goal.id, hours).all<{
        bucket: string;
        conversions: number;
        revenue_cents: number;
      }>();

      return result.results.map((row: { bucket: string; conversions: number; revenue_cents: number }) => ({
        bucket: row.bucket,
        conversions: row.conversions,
        revenue: this.applyValueType(goal, row.revenue_cents / 100, row.conversions),
      }));
    } catch (e) {
      structuredLog('ERROR', 'GenericTimeSeries query failed', { service: 'GoalService', error: e instanceof Error ? e.message : String(e) });
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply value_type rules to revenue
   */
  private applyValueType(goal: ConversionGoal, sourceRevenue: number, conversions: number): number {
    switch (goal.value_type) {
      case 'from_source':
        return sourceRevenue;
      case 'fixed':
        return ((goal.fixed_value_cents || 0) / 100) * conversions;
      case 'none':
        return 0;
      default:
        return sourceRevenue;
    }
  }

  /**
   * Apply value_type rules per conversion (for time series)
   */
  private applyValueTypePerConversion(goal: ConversionGoal, sourceRevenue: number, conversions: number): number {
    return this.applyValueType(goal, sourceRevenue, conversions);
  }

  /**
   * Generate URL-safe slug from name
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Convert database row to ConversionGoal object
   * Handles both legacy (trigger_config) and new (goal_type) schema
   */
  private rowToGoal(row: ConversionGoalRow): ConversionGoal {
    // Determine goal_type from new column or infer from legacy
    let goalType: GoalType = 'tag_event';
    if (row.goal_type) {
      goalType = row.goal_type as GoalType;
    }

    // Get event_filters from new column or convert from legacy trigger_config
    let eventFilters: EventFilters | undefined;
    if (row.filter_config) {
      eventFilters = JSON.parse(row.filter_config);
    } else if (row.trigger_config && goalType === 'tag_event') {
      // Convert legacy trigger_config to event_filters format
      const legacy = JSON.parse(row.trigger_config);
      eventFilters = {
        event_type: legacy.event_type,
        goal_id: legacy.custom_event,
        url_pattern: legacy.page_pattern,
      };
    }

    // Determine value_type
    let valueType: ValueType = 'from_source';
    if (row.value_type) {
      valueType = row.value_type as ValueType;
    } else if (row.default_value_cents && row.default_value_cents > 0) {
      valueType = 'fixed';
    }

    // Get fixed_value from new column or legacy
    const fixedValueCents = row.fixed_value_cents ?? row.default_value_cents ?? undefined;

    // Generate slug if not present
    const slug = row.slug || this.generateSlug(row.name);

    return {
      id: row.id,
      organization_id: row.organization_id,
      name: row.name,
      slug,
      description: row.description || undefined,
      goal_type: goalType,
      revenue_sources: row.revenue_sources ? JSON.parse(row.revenue_sources) : undefined,
      event_filters: eventFilters,
      value_type: valueType,
      fixed_value_cents: fixedValueCents || undefined,
      display_order: row.display_order ?? row.priority ?? 0,
      is_primary: !!row.is_primary,
      color: row.color || undefined,
      icon: row.icon || undefined,
      is_active: row.is_active !== null ? !!row.is_active : true,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

// Database row type (raw from D1) - combined old + new schema
interface ConversionGoalRow {
  id: string;
  organization_id: string;
  name: string;
  // Legacy columns
  type: string | null;  // 'conversion', 'micro_conversion', 'engagement'
  trigger_config: string | null;
  default_value_cents: number | null;
  priority: number | null;
  include_in_path: number | null;
  // New columns
  slug: string | null;
  description: string | null;
  goal_type: string | null;  // 'revenue_source', 'tag_event', 'manual'
  revenue_sources: string | null;
  filter_config: string | null;
  value_type: string | null;
  fixed_value_cents: number | null;
  display_order: number | null;
  color: string | null;
  icon: string | null;
  is_active: number | null;
  // Shared columns
  is_primary: number;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// DEFAULT GOALS
// =============================================================================

/**
 * Get default goals based on business type
 */
export function getDefaultGoalsForBusinessType(businessType: string): ConversionGoalInput[] {
  switch (businessType) {
    case 'ecommerce':
      return [
        {
          name: 'Purchases',
          slug: 'purchases',
          description: 'Completed purchases from all payment sources',
          goal_type: 'revenue_source',
          revenue_sources: [], // All sources
          value_type: 'from_source',
          display_order: 0,
          is_primary: true,
          icon: 'shopping-cart',
          color: '#10B981',
        },
      ];

    case 'lead_gen':
      return [
        {
          name: 'Lead Form Submissions',
          slug: 'lead-form',
          description: 'Contact form and demo request submissions',
          goal_type: 'tag_event',
          event_filters: { event_type: 'form_submit' },
          value_type: 'fixed',
          fixed_value_cents: 5000, // $50 per lead
          display_order: 0,
          is_primary: true,
          icon: 'user-plus',
          color: '#3B82F6',
        },
        {
          name: 'Phone Calls',
          slug: 'phone-calls',
          description: 'Phone call conversions',
          goal_type: 'tag_event',
          event_filters: { event_type: 'call' },
          value_type: 'fixed',
          fixed_value_cents: 10000, // $100 per call
          display_order: 1,
          is_primary: false,
          icon: 'phone',
          color: '#8B5CF6',
        },
      ];

    case 'saas':
      return [
        {
          name: 'Trial Signups',
          slug: 'trial-signups',
          description: 'Free trial registrations',
          goal_type: 'tag_event',
          event_filters: { event_type: 'signup', goal_id: 'trial' },
          value_type: 'none',
          display_order: 0,
          is_primary: false,
          icon: 'user-plus',
          color: '#3B82F6',
        },
        {
          name: 'Paid Subscriptions',
          slug: 'subscriptions',
          description: 'Paid subscription conversions',
          goal_type: 'revenue_source',
          revenue_sources: ['stripe'],
          value_type: 'from_source',
          display_order: 1,
          is_primary: true,
          icon: 'credit-card',
          color: '#10B981',
        },
      ];

    default:
      return [];
  }
}
