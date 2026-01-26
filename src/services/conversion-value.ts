/**
 * Conversion Value Service
 *
 * Handles value allocation for conversions across multiple goals:
 * - Match conversions to applicable goals
 * - Allocate value using various methods (equal, weighted, explicit)
 * - Calculate multi-goal attribution
 */

// =============================================================================
// Types
// =============================================================================

export interface ValueAllocation {
  goalId: string;
  valueCents: number;
  method: AllocationMethod;
  weight?: number;
}

export type AllocationMethod = 'equal' | 'weighted' | 'explicit' | 'proportional';

export interface Conversion {
  id: string;
  organization_id: string;
  value_cents: number;
  connector?: string;
  event_type?: string;
  metadata?: string;
  goal_id?: string;  // Legacy single-goal
  goal_ids?: string; // New multi-goal (JSON array)
  goal_values?: string; // JSON object: {goal_id: value_cents}
}

export interface Goal {
  id: string;
  name: string;
  trigger_config?: string;
  fixed_value_cents?: number;
  connector?: string;
  connector_event_type?: string;
}

export interface GoalGroupMember {
  goal_id: string;
  weight: number;
}

export interface AttributionResult {
  goalId: string;
  allocatedValue: number;
  touchpointCount: number;
  channels: { channel: string; value: number }[];
}

// =============================================================================
// Conversion Value Service
// =============================================================================

export class ConversionValueService {
  constructor(private db: D1Database) {}

  // ===========================================================================
  // Value Allocation
  // ===========================================================================

  /**
   * Allocate conversion value across matched goals
   */
  async allocateConversionValue(
    conversionId: string,
    totalValueCents: number,
    matchedGoalIds: string[],
    method: AllocationMethod,
    groupId?: string
  ): Promise<ValueAllocation[]> {
    if (matchedGoalIds.length === 0) {
      return [];
    }

    const orgId = await this.getConversionOrgId(conversionId);
    if (!orgId) {
      throw new Error(`Conversion ${conversionId} not found`);
    }

    let allocations: ValueAllocation[];

    switch (method) {
      case 'equal':
        allocations = this.allocateEqual(totalValueCents, matchedGoalIds);
        break;

      case 'weighted':
        allocations = await this.allocateWeighted(totalValueCents, matchedGoalIds, groupId!);
        break;

      case 'explicit':
        allocations = await this.allocateExplicit(matchedGoalIds, orgId);
        break;

      case 'proportional':
        // Default to equal for now; proportional needs touchpoint data
        allocations = this.allocateEqual(totalValueCents, matchedGoalIds);
        break;

      default:
        allocations = this.allocateEqual(totalValueCents, matchedGoalIds);
    }

    // Save allocations to database
    await this.saveAllocations(orgId, conversionId, allocations);

    // Update conversion record
    await this.updateConversionGoals(conversionId, allocations, groupId);

    return allocations;
  }

  /**
   * Allocate value equally across goals
   */
  private allocateEqual(
    totalValueCents: number,
    goalIds: string[]
  ): ValueAllocation[] {
    const valuePerGoal = Math.floor(totalValueCents / goalIds.length);
    const remainder = totalValueCents - (valuePerGoal * goalIds.length);

    return goalIds.map((goalId, index) => ({
      goalId,
      valueCents: valuePerGoal + (index === 0 ? remainder : 0),
      method: 'equal' as AllocationMethod,
    }));
  }

  /**
   * Allocate value using weights from goal group
   */
  private async allocateWeighted(
    totalValueCents: number,
    goalIds: string[],
    groupId: string
  ): Promise<ValueAllocation[]> {
    // Get weights for goals in this group
    const members = await this.db
      .prepare(
        `SELECT goal_id, weight FROM goal_group_members
         WHERE group_id = ? AND goal_id IN (${goalIds.map(() => '?').join(', ')})`
      )
      .bind(groupId, ...goalIds)
      .all<GoalGroupMember>();

    const weightMap = new Map<string, number>();
    let totalWeight = 0;

    for (const member of members.results || []) {
      weightMap.set(member.goal_id, member.weight);
      totalWeight += member.weight;
    }

    // Assign default weight to goals not in group
    for (const goalId of goalIds) {
      if (!weightMap.has(goalId)) {
        const defaultWeight = 1.0 / goalIds.length;
        weightMap.set(goalId, defaultWeight);
        totalWeight += defaultWeight;
      }
    }

    // Allocate proportionally
    const allocations: ValueAllocation[] = [];
    let remainingValue = totalValueCents;

    for (let i = 0; i < goalIds.length; i++) {
      const goalId = goalIds[i];
      const weight = weightMap.get(goalId) || 0;
      const normalizedWeight = weight / totalWeight;

      let valueCents: number;
      if (i === goalIds.length - 1) {
        // Last goal gets remainder to avoid rounding errors
        valueCents = remainingValue;
      } else {
        valueCents = Math.floor(totalValueCents * normalizedWeight);
        remainingValue -= valueCents;
      }

      allocations.push({
        goalId,
        valueCents,
        method: 'weighted',
        weight: normalizedWeight,
      });
    }

    return allocations;
  }

  /**
   * Allocate using each goal's explicit fixed value
   */
  private async allocateExplicit(
    goalIds: string[],
    orgId: string
  ): Promise<ValueAllocation[]> {
    const goals = await this.db
      .prepare(
        `SELECT id, fixed_value_cents FROM conversion_goals
         WHERE organization_id = ? AND id IN (${goalIds.map(() => '?').join(', ')})`
      )
      .bind(orgId, ...goalIds)
      .all<{ id: string; fixed_value_cents: number | null }>();

    const valueMap = new Map<string, number>();
    for (const goal of goals.results || []) {
      valueMap.set(goal.id, goal.fixed_value_cents || 0);
    }

    return goalIds.map(goalId => ({
      goalId,
      valueCents: valueMap.get(goalId) || 0,
      method: 'explicit' as AllocationMethod,
    }));
  }

  // ===========================================================================
  // Goal Matching
  // ===========================================================================

  /**
   * Match a conversion to applicable goals
   */
  async matchConversionToGoals(
    orgId: string,
    conversion: Conversion
  ): Promise<string[]> {
    // Get all active goals for the org
    const goals = await this.db
      .prepare(
        `SELECT id, name, trigger_config, connector, connector_event_type
         FROM conversion_goals
         WHERE organization_id = ? AND is_active = 1`
      )
      .bind(orgId)
      .all<Goal>();

    const matchedGoals: string[] = [];

    for (const goal of goals.results || []) {
      if (this.doesConversionMatchGoal(conversion, goal)) {
        matchedGoals.push(goal.id);
      }
    }

    return matchedGoals;
  }

  /**
   * Check if a conversion matches a goal's trigger config
   */
  private doesConversionMatchGoal(conversion: Conversion, goal: Goal): boolean {
    // Match by connector and event type
    if (goal.connector && goal.connector_event_type) {
      if (
        conversion.connector === goal.connector &&
        conversion.event_type === goal.connector_event_type
      ) {
        return true;
      }
    }

    // Match by trigger config (legacy)
    if (goal.trigger_config) {
      try {
        const config = JSON.parse(goal.trigger_config);
        if (config.event_type && conversion.event_type) {
          if (config.event_type === conversion.event_type) {
            return true;
          }
        }
      } catch {
        // Invalid config, skip
      }
    }

    return false;
  }

  // ===========================================================================
  // Multi-Goal Attribution
  // ===========================================================================

  /**
   * Calculate attribution for a conversion across multiple goals
   */
  async calculateMultiGoalAttribution(
    conversionId: string,
    touchpoints: { channel: string; timestamp: string; goalId?: string }[]
  ): Promise<Map<string, AttributionResult>> {
    const results = new Map<string, AttributionResult>();

    // Get conversion details
    const conversion = await this.db
      .prepare(`SELECT * FROM conversions WHERE id = ?`)
      .bind(conversionId)
      .first<Conversion>();

    if (!conversion) {
      return results;
    }

    // Parse goal_ids and goal_values
    const goalIds: string[] = conversion.goal_ids
      ? JSON.parse(conversion.goal_ids)
      : conversion.goal_id
      ? [conversion.goal_id]
      : [];

    const goalValues: Record<string, number> = conversion.goal_values
      ? JSON.parse(conversion.goal_values)
      : {};

    // Group touchpoints by goal
    const touchpointsByGoal = new Map<string, typeof touchpoints>();
    for (const tp of touchpoints) {
      const goalId = tp.goalId || 'unassigned';
      if (!touchpointsByGoal.has(goalId)) {
        touchpointsByGoal.set(goalId, []);
      }
      touchpointsByGoal.get(goalId)!.push(tp);
    }

    // Calculate attribution for each goal
    for (const goalId of goalIds) {
      const goalTouchpoints = touchpointsByGoal.get(goalId) || touchpoints;
      const allocatedValue = goalValues[goalId] || 0;

      // Simple linear attribution across channels
      const channelCounts = new Map<string, number>();
      for (const tp of goalTouchpoints) {
        channelCounts.set(tp.channel, (channelCounts.get(tp.channel) || 0) + 1);
      }

      const totalTouchpoints = goalTouchpoints.length;
      const channels: { channel: string; value: number }[] = [];

      for (const [channel, count] of channelCounts) {
        const channelValue = totalTouchpoints > 0
          ? Math.floor(allocatedValue * (count / totalTouchpoints))
          : 0;
        channels.push({ channel, value: channelValue });
      }

      results.set(goalId, {
        goalId,
        allocatedValue,
        touchpointCount: totalTouchpoints,
        channels,
      });
    }

    return results;
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  private async getConversionOrgId(conversionId: string): Promise<string | null> {
    const result = await this.db
      .prepare(`SELECT organization_id FROM conversions WHERE id = ?`)
      .bind(conversionId)
      .first<{ organization_id: string }>();

    return result?.organization_id || null;
  }

  private async saveAllocations(
    orgId: string,
    conversionId: string,
    allocations: ValueAllocation[]
  ): Promise<void> {
    for (const alloc of allocations) {
      await this.db
        .prepare(
          `INSERT INTO conversion_value_allocations
           (id, organization_id, conversion_id, goal_id, allocated_value_cents, allocation_method, weight_used, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .bind(
          crypto.randomUUID(),
          orgId,
          conversionId,
          alloc.goalId,
          alloc.valueCents,
          alloc.method,
          alloc.weight || null
        )
        .run();
    }
  }

  private async updateConversionGoals(
    conversionId: string,
    allocations: ValueAllocation[],
    groupId?: string
  ): Promise<void> {
    const goalIds = allocations.map(a => a.goalId);
    const goalValues: Record<string, number> = {};
    for (const alloc of allocations) {
      goalValues[alloc.goalId] = alloc.valueCents;
    }

    await this.db
      .prepare(
        `UPDATE conversions
         SET goal_ids = ?, goal_values = ?, attribution_group_id = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(
        JSON.stringify(goalIds),
        JSON.stringify(goalValues),
        groupId || null,
        conversionId
      )
      .run();
  }
}

// =============================================================================
// Goal Group Service
// =============================================================================

export class GoalGroupService {
  constructor(private db: D1Database) {}

  /**
   * Create a goal group
   */
  async createGroup(
    orgId: string,
    name: string,
    groupType: string = 'conversion',
    description?: string
  ): Promise<string> {
    const groupId = crypto.randomUUID();

    await this.db
      .prepare(
        `INSERT INTO goal_groups
         (id, organization_id, name, description, group_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(groupId, orgId, name, description || null, groupType)
      .run();

    return groupId;
  }

  /**
   * Add goals to a group with weights
   */
  async updateGroupMembers(
    groupId: string,
    members: { goalId: string; weight: number }[]
  ): Promise<void> {
    // Remove existing members
    await this.db
      .prepare(`DELETE FROM goal_group_members WHERE group_id = ?`)
      .bind(groupId)
      .run();

    // Add new members
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      await this.db
        .prepare(
          `INSERT INTO goal_group_members (id, group_id, goal_id, weight, display_order, created_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`
        )
        .bind(crypto.randomUUID(), groupId, member.goalId, member.weight, i)
        .run();
    }
  }

  /**
   * Get groups for an organization
   */
  async getGroups(orgId: string): Promise<{
    id: string;
    name: string;
    description: string | null;
    group_type: string;
    is_default_attribution: number;
    member_count: number;
  }[]> {
    const result = await this.db
      .prepare(
        `SELECT g.id, g.name, g.description, g.group_type, g.is_default_attribution,
                COUNT(m.id) as member_count
         FROM goal_groups g
         LEFT JOIN goal_group_members m ON m.group_id = g.id
         WHERE g.organization_id = ? AND g.is_active = 1
         GROUP BY g.id
         ORDER BY g.display_order, g.created_at`
      )
      .bind(orgId)
      .all();

    return (result.results || []) as any;
  }

  /**
   * Get members of a group
   */
  async getGroupMembers(groupId: string): Promise<{
    goal_id: string;
    goal_name: string;
    weight: number;
  }[]> {
    const result = await this.db
      .prepare(
        `SELECT m.goal_id, g.name as goal_name, m.weight
         FROM goal_group_members m
         JOIN conversion_goals g ON g.id = m.goal_id
         WHERE m.group_id = ?
         ORDER BY m.display_order`
      )
      .bind(groupId)
      .all();

    return (result.results || []) as any;
  }

  /**
   * Set a group as the default for attribution
   */
  async setDefaultAttributionGroup(orgId: string, groupId: string): Promise<void> {
    // Clear existing default
    await this.db
      .prepare(
        `UPDATE goal_groups SET is_default_attribution = 0 WHERE organization_id = ?`
      )
      .bind(orgId)
      .run();

    // Set new default
    await this.db
      .prepare(
        `UPDATE goal_groups SET is_default_attribution = 1, updated_at = datetime('now')
         WHERE id = ? AND organization_id = ?`
      )
      .bind(groupId, orgId)
      .run();
  }
}
