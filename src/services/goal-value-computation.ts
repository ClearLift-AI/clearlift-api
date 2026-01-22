/**
 * Goal Value Computation Service
 *
 * Calculates expected values for goals based on their relationship to macro-conversions.
 *
 * Methods:
 * 1. Expected Value: P(upstream → downstream) × downstream_value
 * 2. Bayesian: Beta distribution with prior + observed data
 * 3. Funnel Position: Decay based on distance from conversion
 * 4. Markov Removal: Uses existing Markov chain removal effect
 */

// D1Database type is provided by wrangler-generated types (worker-configuration.d.ts)
// Using global declaration to avoid external package dependency
declare const D1Database: any;
type D1Database = {
  prepare(query: string): D1PreparedStatement;
};
type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
};
type D1Result<T> = {
  results?: T[];
  success: boolean;
  meta?: Record<string, unknown>;
};

export interface GoalRelationship {
  id: string;
  organization_id: string;
  upstream_goal_id: string;
  downstream_goal_id: string;
  relationship_type: "funnel" | "correlated";
  funnel_position?: number;
}

export interface GoalConversionStats {
  upstream_goal_id: string;
  downstream_goal_id: string;
  upstream_count: number;
  downstream_count: number;
  converted_count: number;
  conversion_rate: number;
  avg_time_to_convert_hours: number;
  prior_alpha: number;
  prior_beta: number;
}

export interface ComputedGoalValue {
  goal_id: string;
  value_method: string;
  computed_value_cents: number;
  confidence_lower_cents: number;
  confidence_upper_cents: number;
  sample_size: number;
  computation_details: {
    conversion_rate?: number;
    downstream_value_cents?: number;
    funnel_position?: number;
    bayesian_mean?: number;
    bayesian_alpha?: number;
    bayesian_beta?: number;
    source?: string;
    conversion_sources?: string[];
    message?: string;
  };
}

export interface GoalHierarchyNode {
  goal_id: string;
  goal_name: string;
  category: "macro_conversion" | "micro_conversion" | "engagement";
  explicit_value_cents?: number;
  computed_value_cents?: number;
  conversion_rate_to_macro?: number;
  children: GoalHierarchyNode[];
}

export class GoalValueComputationService {
  constructor(private db: D1Database, private analyticsDb?: D1Database) {}

  /**
   * Compute conversion statistics between two goals
   * Looks at sessions where upstream goal was triggered and checks if downstream followed
   */
  async computeConversionStats(
    orgId: string,
    upstreamGoalId: string,
    downstreamGoalId: string,
    days: number = 90
  ): Promise<GoalConversionStats> {
    const analyticsDb = this.analyticsDb || this.db;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    // Get goal trigger configs to identify events
    const [upstreamGoal, downstreamGoal] = await Promise.all([
      this.db
        .prepare(`SELECT * FROM conversion_goals WHERE id = ?`)
        .bind(upstreamGoalId)
        .first(),
      this.db
        .prepare(`SELECT * FROM conversion_goals WHERE id = ?`)
        .bind(downstreamGoalId)
        .first(),
    ]);

    if (!upstreamGoal || !downstreamGoal) {
      throw new Error("Goal not found");
    }

    // For page-view goals, count page visits
    // For tag-event goals, count events matching the trigger
    // For revenue-source goals, count transactions

    let upstreamCount = 0;
    let downstreamCount = 0;
    let convertedCount = 0;

    // Get upstream events (simplified - in production would use proper event matching)
    const upstreamResult = await analyticsDb
      .prepare(
        `
      SELECT COUNT(DISTINCT session_id) as count
      FROM events
      WHERE organization_id = ?
        AND timestamp >= ?
        AND (
          (? = 'page_view' AND page_path LIKE ?) OR
          (? = 'tag_event' AND event_type = ?) OR
          (? = 'revenue_source')
        )
    `
      )
      .bind(
        orgId,
        startDate,
        (upstreamGoal as any).goal_type,
        this.extractPagePattern(upstreamGoal),
        (upstreamGoal as any).goal_type,
        this.extractEventType(upstreamGoal),
        (upstreamGoal as any).goal_type
      )
      .first<{ count: number }>();

    upstreamCount = upstreamResult?.count || 0;

    // Get sessions that had both upstream and downstream events
    // This is a simplified version - production would use proper session tracking
    const convertedResult = await analyticsDb
      .prepare(
        `
      SELECT COUNT(DISTINCT e1.session_id) as count
      FROM events e1
      INNER JOIN events e2 ON e1.session_id = e2.session_id AND e2.timestamp > e1.timestamp
      WHERE e1.organization_id = ?
        AND e1.timestamp >= ?
        AND e2.organization_id = ?
    `
      )
      .bind(orgId, startDate, orgId)
      .first<{ count: number }>();

    convertedCount = Math.min(convertedResult?.count || 0, upstreamCount);

    const conversionRate =
      upstreamCount > 0 ? convertedCount / upstreamCount : 0;

    return {
      upstream_goal_id: upstreamGoalId,
      downstream_goal_id: downstreamGoalId,
      upstream_count: upstreamCount,
      downstream_count: downstreamCount,
      converted_count: convertedCount,
      conversion_rate: conversionRate,
      avg_time_to_convert_hours: 0, // Would calculate from actual data
      prior_alpha: 1 + convertedCount,
      prior_beta: 1 + (upstreamCount - convertedCount),
    };
  }

  /**
   * Compute expected value for a goal
   * Expected Value = P(goal → macro) × macro_value
   *
   * Priority:
   * 1. Use explicit goal relationship if defined
   * 2. Use explicit macro-conversion goal if exists
   * 3. Auto-detect conversions from unified sources (Stripe, Shopify, etc.)
   */
  async computeExpectedValue(
    orgId: string,
    goalId: string
  ): Promise<ComputedGoalValue> {
    // Get the goal and its relationships
    const goal = await this.db
      .prepare(`SELECT * FROM conversion_goals WHERE id = ? AND organization_id = ?`)
      .bind(goalId, orgId)
      .first<any>();

    if (!goal) {
      throw new Error("Goal not found");
    }

    // If this is a macro-conversion, use explicit value
    if (goal.category === "macro_conversion") {
      const value = goal.fixed_value_cents || goal.default_value_cents || 0;
      return {
        goal_id: goalId,
        value_method: "explicit",
        computed_value_cents: value,
        confidence_lower_cents: value,
        confidence_upper_cents: value,
        sample_size: 0,
        computation_details: {},
      };
    }

    // Find downstream macro-conversion from explicit relationship
    const relationship = await this.db
      .prepare(
        `
      SELECT gr.*, cg.fixed_value_cents, cg.default_value_cents, cg.category
      FROM goal_relationships gr
      JOIN conversion_goals cg ON gr.downstream_goal_id = cg.id
      WHERE gr.organization_id = ?
        AND gr.upstream_goal_id = ?
        AND cg.category = 'macro_conversion'
      LIMIT 1
    `
      )
      .bind(orgId, goalId)
      .first<any>();

    if (relationship) {
      // Use existing relationship
      const stats = await this.getOrComputeStats(
        orgId,
        goalId,
        relationship.downstream_goal_id
      );
      const macroValue =
        relationship.fixed_value_cents || relationship.default_value_cents || 0;
      const expectedValue = Math.round(stats.conversion_rate * macroValue);

      const { lower, upper } = this.bayesianConfidenceInterval(
        stats.prior_alpha,
        stats.prior_beta,
        0.95
      );

      return {
        goal_id: goalId,
        value_method: "expected_value",
        computed_value_cents: expectedValue,
        confidence_lower_cents: Math.round(lower * macroValue),
        confidence_upper_cents: Math.round(upper * macroValue),
        sample_size: stats.upstream_count,
        computation_details: {
          conversion_rate: stats.conversion_rate,
          downstream_value_cents: macroValue,
          bayesian_alpha: stats.prior_alpha,
          bayesian_beta: stats.prior_beta,
          source: "explicit_relationship",
        },
      };
    }

    // No explicit relationship - try to find macro goal
    const macroGoal = await this.db
      .prepare(
        `
      SELECT * FROM conversion_goals
      WHERE organization_id = ? AND category = 'macro_conversion' AND is_primary = 1
      LIMIT 1
    `
      )
      .bind(orgId)
      .first<any>();

    if (macroGoal) {
      const stats = await this.computeConversionStats(orgId, goalId, macroGoal.id);
      const macroValue = macroGoal.fixed_value_cents || macroGoal.default_value_cents || 0;
      const expectedValue = Math.round(stats.conversion_rate * macroValue);

      return {
        goal_id: goalId,
        value_method: "expected_value",
        computed_value_cents: expectedValue,
        confidence_lower_cents: Math.round(expectedValue * 0.7),
        confidence_upper_cents: Math.round(expectedValue * 1.3),
        sample_size: stats.upstream_count,
        computation_details: {
          conversion_rate: stats.conversion_rate,
          downstream_value_cents: macroValue,
          source: "macro_goal",
        },
      };
    }

    // NO MACRO GOAL DEFINED - Auto-detect from unified conversions
    // This handles the case where user only sets up micro-conversions
    // but has Stripe/Shopify/etc. sending conversion data
    const unifiedStats = await this.computeUnifiedConversionStats(orgId, goalId);

    if (unifiedStats.conversion_count > 0) {
      const expectedValue = Math.round(unifiedStats.conversion_rate * unifiedStats.avg_value_cents);

      const { lower, upper } = this.bayesianConfidenceInterval(
        unifiedStats.prior_alpha,
        unifiedStats.prior_beta,
        0.95
      );

      return {
        goal_id: goalId,
        value_method: "expected_value",
        computed_value_cents: expectedValue,
        confidence_lower_cents: Math.round(lower * unifiedStats.avg_value_cents),
        confidence_upper_cents: Math.round(upper * unifiedStats.avg_value_cents),
        sample_size: unifiedStats.goal_count,
        computation_details: {
          conversion_rate: unifiedStats.conversion_rate,
          downstream_value_cents: unifiedStats.avg_value_cents,
          bayesian_alpha: unifiedStats.prior_alpha,
          bayesian_beta: unifiedStats.prior_beta,
          source: "unified_conversions",
          conversion_sources: unifiedStats.sources,
        },
      };
    }

    // No conversion data available
    return {
      goal_id: goalId,
      value_method: "expected_value",
      computed_value_cents: goal.fixed_value_cents || 0,
      confidence_lower_cents: 0,
      confidence_upper_cents: 0,
      sample_size: 0,
      computation_details: {
        conversion_rate: 0,
        downstream_value_cents: 0,
        source: "no_data",
        message: "No conversions detected. Connect Stripe/Shopify or define a macro-conversion goal.",
      },
    };
  }

  /**
   * Compute conversion stats from goal triggers to unified conversions
   * This auto-detects conversions from Stripe, Shopify, etc. without requiring
   * an explicit macro-conversion goal
   */
  async computeUnifiedConversionStats(
    orgId: string,
    goalId: string,
    days: number = 90
  ): Promise<{
    goal_count: number;
    conversion_count: number;
    conversion_rate: number;
    avg_value_cents: number;
    prior_alpha: number;
    prior_beta: number;
    sources: string[];
  }> {
    const analyticsDb = this.analyticsDb || this.db;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    // Get the goal config to understand what we're tracking
    const goal = await this.db
      .prepare(`SELECT * FROM conversion_goals WHERE id = ?`)
      .bind(goalId)
      .first<any>();

    if (!goal) {
      return {
        goal_count: 0,
        conversion_count: 0,
        conversion_rate: 0,
        avg_value_cents: 0,
        prior_alpha: 1,
        prior_beta: 1,
        sources: [],
      };
    }

    // Count goal triggers (page views, events, etc.)
    let goalCount = 0;
    const pagePattern = this.extractPagePattern(goal);

    if (goal.goal_type === "page_view" && pagePattern !== "%") {
      // Count page views matching the pattern
      try {
        const pageResult = await analyticsDb
          .prepare(
            `
          SELECT COUNT(*) as count FROM events
          WHERE organization_id = ?
            AND event_type = 'page_view'
            AND page_path LIKE ?
            AND timestamp >= ?
        `
          )
          .bind(orgId, pagePattern, startDate)
          .first<{ count: number }>();
        goalCount = pageResult?.count || 0;
      } catch {
        // Events table might not exist, try hourly_metrics
        const orgTag = await this.db
          .prepare(`SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?`)
          .bind(orgId)
          .first<{ short_tag: string }>();

        if (orgTag?.short_tag) {
          const metricsResult = await analyticsDb
            .prepare(
              `
            SELECT SUM(page_views) as count FROM hourly_metrics
            WHERE org_tag = ? AND hour >= ?
          `
            )
            .bind(orgTag.short_tag, startDate)
            .first<{ count: number }>();
          // Estimate based on total page views (rough approximation)
          goalCount = Math.round((metricsResult?.count || 0) * 0.1); // Assume 10% are target pages
        }
      }
    }

    // Get unified conversions from all sources
    let conversionCount = 0;
    let totalValueCents = 0;
    const sources: string[] = [];

    // Check Stripe charges
    try {
      const stripeResult = await analyticsDb
        .prepare(
          `
        SELECT COUNT(*) as count, COALESCE(SUM(amount_cents), 0) as total
        FROM stripe_charges
        WHERE organization_id = ?
          AND status = 'succeeded'
          AND created_at >= ?
      `
        )
        .bind(orgId, startDate)
        .first<{ count: number; total: number }>();

      if (stripeResult && stripeResult.count > 0) {
        conversionCount += stripeResult.count;
        totalValueCents += stripeResult.total;
        sources.push("stripe");
      }
    } catch {
      // Table doesn't exist
    }

    // Check Shopify orders
    try {
      const shopifyResult = await analyticsDb
        .prepare(
          `
        SELECT COUNT(*) as count, COALESCE(SUM(total_price_cents), 0) as total
        FROM shopify_orders
        WHERE organization_id = ?
          AND financial_status = 'paid'
          AND created_at >= ?
      `
        )
        .bind(orgId, startDate)
        .first<{ count: number; total: number }>();

      if (shopifyResult && shopifyResult.count > 0) {
        conversionCount += shopifyResult.count;
        totalValueCents += shopifyResult.total;
        sources.push("shopify");
      }
    } catch {
      // Table doesn't exist
    }

    // Check conversions table (from tag events)
    try {
      const tagResult = await analyticsDb
        .prepare(
          `
        SELECT COUNT(*) as count, COALESCE(SUM(value_cents), 0) as total
        FROM conversions
        WHERE organization_id = ?
          AND conversion_timestamp >= ?
      `
        )
        .bind(orgId, startDate)
        .first<{ count: number; total: number }>();

      if (tagResult && tagResult.count > 0) {
        conversionCount += tagResult.count;
        totalValueCents += tagResult.total;
        sources.push("tag");
      }
    } catch {
      // Table doesn't exist
    }

    // If no goal count but we have page views in hourly_metrics, estimate
    if (goalCount === 0) {
      const orgTag = await this.db
        .prepare(`SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?`)
        .bind(orgId)
        .first<{ short_tag: string }>();

      if (orgTag?.short_tag) {
        try {
          const sessionsResult = await analyticsDb
            .prepare(
              `
            SELECT COALESCE(SUM(sessions), 0) as sessions FROM hourly_metrics
            WHERE org_tag = ? AND hour >= ?
          `
            )
            .bind(orgTag.short_tag, startDate)
            .first<{ sessions: number }>();
          // Use sessions as proxy for goal triggers
          goalCount = sessionsResult?.sessions || 0;
        } catch {
          // Fallback
        }
      }
    }

    const conversionRate = goalCount > 0 ? conversionCount / goalCount : 0;
    const avgValueCents = conversionCount > 0 ? Math.round(totalValueCents / conversionCount) : 0;

    return {
      goal_count: goalCount,
      conversion_count: conversionCount,
      conversion_rate: conversionRate,
      avg_value_cents: avgValueCents,
      prior_alpha: 1 + conversionCount,
      prior_beta: 1 + Math.max(0, goalCount - conversionCount),
      sources,
    };
  }

  /**
   * Compute value using funnel position decay
   * Value = macro_value × decay_factor^(distance_from_conversion)
   */
  async computeFunnelPositionValue(
    orgId: string,
    goalId: string,
    decayFactor: number = 0.6
  ): Promise<ComputedGoalValue> {
    const goal = await this.db
      .prepare(`SELECT * FROM conversion_goals WHERE id = ? AND organization_id = ?`)
      .bind(goalId, orgId)
      .first<any>();

    if (!goal) {
      throw new Error("Goal not found");
    }

    // Get funnel position from relationship
    const relationship = await this.db
      .prepare(
        `
      SELECT gr.funnel_position, cg.fixed_value_cents, cg.default_value_cents
      FROM goal_relationships gr
      JOIN conversion_goals cg ON gr.downstream_goal_id = cg.id
      WHERE gr.organization_id = ? AND gr.upstream_goal_id = ?
        AND cg.category = 'macro_conversion'
    `
      )
      .bind(orgId, goalId)
      .first<any>();

    const funnelPosition = relationship?.funnel_position || 1;
    const macroValue =
      relationship?.fixed_value_cents ||
      relationship?.default_value_cents ||
      10000; // Default $100

    const decayMultiplier = Math.pow(decayFactor, funnelPosition);
    const computedValue = Math.round(macroValue * decayMultiplier);

    return {
      goal_id: goalId,
      value_method: "funnel_position",
      computed_value_cents: computedValue,
      confidence_lower_cents: computedValue,
      confidence_upper_cents: computedValue,
      sample_size: 0,
      computation_details: {
        funnel_position: funnelPosition,
        downstream_value_cents: macroValue,
      },
    };
  }

  /**
   * Get full goal hierarchy with computed values
   */
  async getGoalHierarchy(orgId: string): Promise<GoalHierarchyNode[]> {
    // Get all goals
    const goals = await this.db
      .prepare(
        `
      SELECT * FROM conversion_goals
      WHERE organization_id = ? AND is_active = 1
      ORDER BY category DESC, display_order ASC
    `
      )
      .bind(orgId)
      .all<any>();

    // Get all relationships
    const relationships = await this.db
      .prepare(
        `
      SELECT * FROM goal_relationships
      WHERE organization_id = ?
    `
      )
      .bind(orgId)
      .all<GoalRelationship>();

    // Build hierarchy
    const macroGoals = (goals.results || []).filter(
      (g: any) => g.category === "macro_conversion"
    );
    const microGoals = (goals.results || []).filter(
      (g: any) => g.category === "micro_conversion"
    );
    const engagementGoals = (goals.results || []).filter(
      (g: any) => g.category === "engagement"
    );

    const hierarchy: GoalHierarchyNode[] = [];

    // Add macro goals as roots
    for (const macro of macroGoals) {
      const macroNode: GoalHierarchyNode = {
        goal_id: macro.id,
        goal_name: macro.name,
        category: "macro_conversion",
        explicit_value_cents: macro.fixed_value_cents || macro.default_value_cents,
        computed_value_cents: macro.computed_value_cents,
        children: [],
      };

      // Find micro-conversions that lead to this macro
      const childRelationships = (relationships.results || []).filter(
        (r: GoalRelationship) => r.downstream_goal_id === macro.id
      );

      for (const rel of childRelationships) {
        const childGoal = microGoals.find((g: any) => g.id === rel.upstream_goal_id);
        if (childGoal) {
          macroNode.children.push({
            goal_id: childGoal.id,
            goal_name: childGoal.name,
            category: "micro_conversion",
            explicit_value_cents: childGoal.fixed_value_cents,
            computed_value_cents: childGoal.computed_value_cents,
            children: [],
          });
        }
      }

      hierarchy.push(macroNode);
    }

    // Add engagement goals as separate branch
    for (const engagement of engagementGoals) {
      hierarchy.push({
        goal_id: engagement.id,
        goal_name: engagement.name,
        category: "engagement",
        explicit_value_cents: engagement.fixed_value_cents || engagement.default_value_cents,
        computed_value_cents: engagement.computed_value_cents,
        children: [],
      });
    }

    return hierarchy;
  }

  /**
   * Recompute all goal values for an organization
   */
  async recomputeAllGoalValues(orgId: string): Promise<void> {
    const goals = await this.db
      .prepare(
        `
      SELECT * FROM conversion_goals
      WHERE organization_id = ?
        AND auto_compute_value = 1
        AND category != 'macro_conversion'
    `
      )
      .bind(orgId)
      .all<any>();

    for (const goal of goals.results || []) {
      try {
        const computed = await this.computeExpectedValue(orgId, goal.id);

        // Update goal with computed value
        await this.db
          .prepare(
            `
          UPDATE conversion_goals
          SET computed_value_cents = ?,
              computed_value_lower_cents = ?,
              computed_value_upper_cents = ?,
              value_computed_at = datetime('now')
          WHERE id = ?
        `
          )
          .bind(
            computed.computed_value_cents,
            computed.confidence_lower_cents,
            computed.confidence_upper_cents,
            goal.id
          )
          .run();

        // Store in history
        await this.db
          .prepare(
            `
          INSERT INTO goal_value_history (
            id, organization_id, goal_id, value_method,
            computed_value_cents, confidence_lower_cents, confidence_upper_cents,
            sample_size, computation_details
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
          )
          .bind(
            crypto.randomUUID(),
            orgId,
            goal.id,
            computed.value_method,
            computed.computed_value_cents,
            computed.confidence_lower_cents,
            computed.confidence_upper_cents,
            computed.sample_size,
            JSON.stringify(computed.computation_details)
          )
          .run();
      } catch (err) {
        console.error(`Failed to compute value for goal ${goal.id}:`, err);
      }
    }
  }

  /**
   * Get goal templates for a business type
   */
  async getGoalTemplates(businessType: string): Promise<any[]> {
    const result = await this.db
      .prepare(
        `
      SELECT * FROM goal_templates
      WHERE business_type = ?
      ORDER BY display_order ASC
    `
      )
      .bind(businessType)
      .all();

    return result.results || [];
  }

  /**
   * Create goals from templates
   */
  async createGoalsFromTemplates(
    orgId: string,
    templateIds: string[]
  ): Promise<void> {
    for (const templateId of templateIds) {
      const template = await this.db
        .prepare(`SELECT * FROM goal_templates WHERE id = ?`)
        .bind(templateId)
        .first<any>();

      if (!template) continue;

      const goalId = crypto.randomUUID();
      await this.db
        .prepare(
          `
        INSERT INTO conversion_goals (
          id, organization_id, name, slug, description,
          goal_type, category, trigger_config,
          default_value_cents, value_method, auto_compute_value,
          icon, color, display_order, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `
        )
        .bind(
          goalId,
          orgId,
          template.name,
          template.slug,
          template.description,
          template.goal_type,
          template.category,
          template.trigger_config,
          template.default_value_cents,
          template.value_method,
          template.value_method === "expected_value" ? 1 : 0,
          template.icon,
          template.color,
          template.display_order
        )
        .run();
    }
  }

  // Helper methods

  private async getOrComputeStats(
    orgId: string,
    upstreamId: string,
    downstreamId: string
  ): Promise<GoalConversionStats> {
    // Check for cached stats
    const cached = await this.db
      .prepare(
        `
      SELECT * FROM goal_conversion_stats
      WHERE organization_id = ?
        AND upstream_goal_id = ?
        AND downstream_goal_id = ?
        AND period_type = 'all_time'
        AND computed_at > datetime('now', '-7 days')
      ORDER BY computed_at DESC
      LIMIT 1
    `
      )
      .bind(orgId, upstreamId, downstreamId)
      .first<GoalConversionStats>();

    if (cached) {
      return cached;
    }

    // Compute fresh stats
    return this.computeConversionStats(orgId, upstreamId, downstreamId);
  }

  private bayesianConfidenceInterval(
    alpha: number,
    beta: number,
    confidence: number
  ): { lower: number; upper: number } {
    // Approximate Beta distribution CI using normal approximation
    // For proper implementation, use beta quantile function
    const mean = alpha / (alpha + beta);
    const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
    const std = Math.sqrt(variance);
    const z = 1.96; // 95% CI

    return {
      lower: Math.max(0, mean - z * std),
      upper: Math.min(1, mean + z * std),
    };
  }

  private extractPagePattern(goal: any): string {
    if (goal.trigger_config) {
      try {
        const config = JSON.parse(goal.trigger_config);
        return config.page_pattern?.replace("*", "%") || "%";
      } catch {
        return "%";
      }
    }
    return "%";
  }

  private extractEventType(goal: any): string {
    if (goal.trigger_config) {
      try {
        const config = JSON.parse(goal.trigger_config);
        return config.event_type || "";
      } catch {
        return "";
      }
    }
    if (goal.event_filters_v2) {
      try {
        const filters = JSON.parse(goal.event_filters_v2);
        return filters.event_type || "";
      } catch {
        return "";
      }
    }
    return "";
  }
}
