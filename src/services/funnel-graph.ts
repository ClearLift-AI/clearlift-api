/**
 * Funnel Graph Service
 *
 * Manages funnel/goal graph operations including:
 * - Building complete funnel graphs for visualization
 * - Creating branches (split/join points)
 * - Evaluating goal completion with OR/AND logic
 * - Finding valid paths through the funnel
 */

// =============================================================================
// Types
// =============================================================================

export interface FunnelNode {
  id: string;
  name: string;
  type: 'goal' | 'branch_split' | 'branch_join';
  goalType?: 'revenue_source' | 'tag_event' | 'manual';
  category?: 'macro_conversion' | 'micro_conversion' | 'engagement';
  connector?: string;
  isConversion?: boolean;
  flowTag?: string;
  isExclusive?: boolean;
  position?: { col: number; row: number };
}

export interface FunnelEdge {
  id: string;
  source: string;
  target: string;
  relationshipType: 'funnel' | 'correlated';
  operator: 'OR' | 'AND';
  flowTag?: string;
  isExclusive?: boolean;
}

export interface FunnelGraph {
  nodes: FunnelNode[];
  edges: FunnelEdge[];
  entryPoints: string[];  // Goal IDs with no upstream
  exitPoints: string[];   // Goal IDs with no downstream
  flows: string[];        // Distinct flow tags
}

export interface GoalCompletionResult {
  completed: boolean;
  completedVia?: 'direct' | 'or_branch' | 'and_branch';
  pathFlowTag?: string;
  missingUpstream?: string[];  // For AND: which upstream goals are missing
}

export interface FunnelPath {
  goalIds: string[];
  flowTag?: string;
  probability?: number;
}

// =============================================================================
// Funnel Graph Service
// =============================================================================

export class FunnelGraphService {
  constructor(private db: D1Database) {}

  // ===========================================================================
  // Graph Building
  // ===========================================================================

  /**
   * Build complete funnel graph for an organization
   */
  async buildFunnelGraph(orgId: string): Promise<FunnelGraph> {
    // Fetch all goals
    const goalsResult = await this.db
      .prepare(
        `SELECT id, name, goal_type, category, connector, is_conversion, flow_tag, is_exclusive,
                position_col, position_row
         FROM conversion_goals
         WHERE organization_id = ? AND is_active = 1
         ORDER BY display_order, created_at`
      )
      .bind(orgId)
      .all<{
        id: string;
        name: string;
        goal_type: string;
        category: string;
        connector: string;
        is_conversion: number;
        flow_tag: string | null;
        is_exclusive: number;
        position_col: number | null;
        position_row: number | null;
      }>();

    // Fetch all relationships
    const relationshipsResult = await this.db
      .prepare(
        `SELECT id, upstream_goal_id, downstream_goal_id, relationship_type,
                relationship_operator, flow_tag, is_exclusive
         FROM goal_relationships
         WHERE organization_id = ?`
      )
      .bind(orgId)
      .all<{
        id: string;
        upstream_goal_id: string;
        downstream_goal_id: string;
        relationship_type: string;
        relationship_operator: string;
        flow_tag: string | null;
        is_exclusive: number;
      }>();

    // Fetch all branches
    const branchesResult = await this.db
      .prepare(
        `SELECT id, branch_goal_id, branch_type, flow_tags
         FROM goal_branches
         WHERE organization_id = ?`
      )
      .bind(orgId)
      .all<{
        id: string;
        branch_goal_id: string;
        branch_type: 'split' | 'join';
        flow_tags: string | null;
      }>();

    // Build nodes
    const nodes: FunnelNode[] = [];
    const goalIds = new Set<string>();

    for (const goal of goalsResult.results || []) {
      goalIds.add(goal.id);
      nodes.push({
        id: goal.id,
        name: goal.name,
        type: 'goal',
        goalType: goal.goal_type as any,
        category: goal.category as any,
        connector: goal.connector,
        isConversion: !!goal.is_conversion,
        flowTag: goal.flow_tag || undefined,
        isExclusive: !!goal.is_exclusive,
        position: goal.position_col !== null && goal.position_row !== null
          ? { col: goal.position_col, row: goal.position_row }
          : undefined,
      });
    }

    // Add branch nodes
    for (const branch of branchesResult.results || []) {
      const nodeType = branch.branch_type === 'split' ? 'branch_split' : 'branch_join';
      nodes.push({
        id: `branch-${branch.id}`,
        name: nodeType === 'branch_split' ? 'Split' : 'Join',
        type: nodeType,
        flowTag: branch.flow_tags ? undefined : undefined, // Multiple flows
      });
    }

    // Build edges
    const edges: FunnelEdge[] = [];
    const hasUpstream = new Set<string>();
    const hasDownstream = new Set<string>();

    for (const rel of relationshipsResult.results || []) {
      if (goalIds.has(rel.upstream_goal_id) && goalIds.has(rel.downstream_goal_id)) {
        edges.push({
          id: rel.id,
          source: rel.upstream_goal_id,
          target: rel.downstream_goal_id,
          relationshipType: rel.relationship_type as any,
          operator: (rel.relationship_operator || 'OR') as 'OR' | 'AND',
          flowTag: rel.flow_tag || undefined,
          isExclusive: !!rel.is_exclusive,
        });
        hasDownstream.add(rel.upstream_goal_id);
        hasUpstream.add(rel.downstream_goal_id);
      }
    }

    // Find entry and exit points
    const entryPoints = Array.from(goalIds).filter(id => !hasUpstream.has(id));
    const exitPoints = Array.from(goalIds).filter(id => !hasDownstream.has(id));

    // Collect flow tags
    const flowsSet = new Set<string>();
    for (const node of nodes) {
      if (node.flowTag) flowsSet.add(node.flowTag);
    }
    for (const edge of edges) {
      if (edge.flowTag) flowsSet.add(edge.flowTag);
    }

    return {
      nodes,
      edges,
      entryPoints,
      exitPoints,
      flows: Array.from(flowsSet),
    };
  }

  // ===========================================================================
  // Branch Management
  // ===========================================================================

  /**
   * Create a branch point (split or join)
   */
  async createBranch(
    orgId: string,
    branchGoalId: string,
    childGoalIds: string[],
    flowTags: string[],
    branchType: 'split' | 'join' = 'split'
  ): Promise<string> {
    const branchId = crypto.randomUUID();

    // Create branch record
    await this.db
      .prepare(
        `INSERT INTO goal_branches (id, organization_id, branch_goal_id, branch_type, flow_tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(branchId, orgId, branchGoalId, branchType, JSON.stringify(flowTags))
      .run();

    // Create relationships from branch goal to children (for split)
    // Or from children to branch goal (for join)
    for (let i = 0; i < childGoalIds.length; i++) {
      const childId = childGoalIds[i];
      const flowTag = flowTags[i] || flowTags[0];
      const relId = crypto.randomUUID();

      if (branchType === 'split') {
        await this.db
          .prepare(
            `INSERT INTO goal_relationships
             (id, organization_id, upstream_goal_id, downstream_goal_id, relationship_type, relationship_operator, flow_tag, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'funnel', 'OR', ?, datetime('now'), datetime('now'))`
          )
          .bind(relId, orgId, branchGoalId, childId, flowTag)
          .run();
      } else {
        // For join, children point to the branch goal
        await this.db
          .prepare(
            `INSERT INTO goal_relationships
             (id, organization_id, upstream_goal_id, downstream_goal_id, relationship_type, relationship_operator, flow_tag, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'funnel', 'OR', ?, datetime('now'), datetime('now'))`
          )
          .bind(relId, orgId, childId, branchGoalId, flowTag)
          .run();
      }
    }

    return branchId;
  }

  /**
   * Create a merge point where multiple paths converge
   */
  async createMerge(
    orgId: string,
    mergeGoalId: string,
    parentGoalIds: string[],
    operator: 'OR' | 'AND' = 'OR'
  ): Promise<void> {
    // Update the merge goal with parent IDs
    await this.db
      .prepare(
        `UPDATE conversion_goals
         SET parent_goal_ids = ?, updated_at = datetime('now')
         WHERE id = ? AND organization_id = ?`
      )
      .bind(JSON.stringify(parentGoalIds), mergeGoalId, orgId)
      .run();

    // Create relationships with specified operator
    for (const parentId of parentGoalIds) {
      const relId = crypto.randomUUID();
      await this.db
        .prepare(
          `INSERT INTO goal_relationships
           (id, organization_id, upstream_goal_id, downstream_goal_id, relationship_type, relationship_operator, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'funnel', ?, datetime('now'), datetime('now'))
           ON CONFLICT (organization_id, upstream_goal_id, downstream_goal_id) DO UPDATE SET
             relationship_operator = excluded.relationship_operator,
             updated_at = datetime('now')`
        )
        .bind(relId, orgId, parentId, mergeGoalId, operator)
        .run();
    }
  }

  // ===========================================================================
  // Goal Evaluation
  // ===========================================================================

  /**
   * Evaluate if a goal is completed based on user journey
   *
   * @param orgId - Organization ID
   * @param goalId - Goal to evaluate
   * @param completedGoalIds - Goals the user has already completed
   */
  async evaluateGoalCompletion(
    orgId: string,
    goalId: string,
    completedGoalIds: string[]
  ): Promise<GoalCompletionResult> {
    // If already completed, return true
    if (completedGoalIds.includes(goalId)) {
      return { completed: true, completedVia: 'direct' };
    }

    // Get upstream relationships for this goal
    const relationships = await this.db
      .prepare(
        `SELECT upstream_goal_id, relationship_operator, flow_tag
         FROM goal_relationships
         WHERE organization_id = ? AND downstream_goal_id = ?`
      )
      .bind(orgId, goalId)
      .all<{
        upstream_goal_id: string;
        relationship_operator: string;
        flow_tag: string | null;
      }>();

    if (!relationships.results || relationships.results.length === 0) {
      // No upstream requirements, goal can be completed directly
      return { completed: false };
    }

    // Group by operator
    const orUpstreams: string[] = [];
    const andUpstreams: string[] = [];
    let flowTag: string | undefined;

    for (const rel of relationships.results) {
      if (rel.relationship_operator === 'AND') {
        andUpstreams.push(rel.upstream_goal_id);
      } else {
        orUpstreams.push(rel.upstream_goal_id);
      }
      if (rel.flow_tag) flowTag = rel.flow_tag;
    }

    // For AND: all upstream goals must be completed
    if (andUpstreams.length > 0) {
      const missingUpstream = andUpstreams.filter(id => !completedGoalIds.includes(id));
      if (missingUpstream.length > 0) {
        return {
          completed: false,
          completedVia: 'and_branch',
          pathFlowTag: flowTag,
          missingUpstream,
        };
      }
    }

    // For OR: any one upstream goal being completed is sufficient
    if (orUpstreams.length > 0) {
      const anyCompleted = orUpstreams.some(id => completedGoalIds.includes(id));
      if (anyCompleted) {
        return {
          completed: true,
          completedVia: 'or_branch',
          pathFlowTag: flowTag,
        };
      }
    }

    // If we have AND requirements and they're all met, and no OR requirements unsatisfied
    if (andUpstreams.length > 0 && andUpstreams.every(id => completedGoalIds.includes(id))) {
      return {
        completed: true,
        completedVia: 'and_branch',
        pathFlowTag: flowTag,
      };
    }

    return {
      completed: false,
      pathFlowTag: flowTag,
    };
  }

  // ===========================================================================
  // Path Finding
  // ===========================================================================

  /**
   * Find all valid paths from start goals to an end goal
   */
  async getValidPaths(
    orgId: string,
    startGoalIds: string[],
    endGoalId: string
  ): Promise<FunnelPath[]> {
    const graph = await this.buildFunnelGraph(orgId);
    const paths: FunnelPath[] = [];

    // Build adjacency map
    const adjacency = new Map<string, { target: string; flowTag?: string }[]>();
    for (const edge of graph.edges) {
      if (!adjacency.has(edge.source)) {
        adjacency.set(edge.source, []);
      }
      adjacency.get(edge.source)!.push({
        target: edge.target,
        flowTag: edge.flowTag,
      });
    }

    // DFS to find all paths
    const findPaths = (
      current: string,
      path: string[],
      flowTag?: string
    ): void => {
      if (current === endGoalId) {
        paths.push({
          goalIds: [...path],
          flowTag,
        });
        return;
      }

      const neighbors = adjacency.get(current) || [];
      for (const { target, flowTag: edgeFlowTag } of neighbors) {
        if (!path.includes(target)) {  // Avoid cycles
          findPaths(
            target,
            [...path, target],
            edgeFlowTag || flowTag  // Inherit flow tag
          );
        }
      }
    };

    // Start from each start goal
    for (const startId of startGoalIds) {
      if (graph.nodes.some(n => n.id === startId)) {
        findPaths(startId, [startId], undefined);
      }
    }

    return paths;
  }

  /**
   * Get the shortest path from any entry point to a goal
   */
  async getShortestPath(
    orgId: string,
    goalId: string
  ): Promise<FunnelPath | null> {
    const graph = await this.buildFunnelGraph(orgId);

    if (graph.entryPoints.length === 0) {
      return null;
    }

    // BFS from each entry point
    let shortestPath: FunnelPath | null = null;

    for (const entryPoint of graph.entryPoints) {
      const visited = new Set<string>();
      const queue: { goalId: string; path: string[]; flowTag?: string }[] = [
        { goalId: entryPoint, path: [entryPoint], flowTag: undefined },
      ];

      while (queue.length > 0) {
        const { goalId: current, path, flowTag } = queue.shift()!;

        if (current === goalId) {
          if (!shortestPath || path.length < shortestPath.goalIds.length) {
            shortestPath = { goalIds: path, flowTag };
          }
          break;  // BFS guarantees shortest path
        }

        if (visited.has(current)) continue;
        visited.add(current);

        // Find downstream goals
        const downstream = graph.edges
          .filter(e => e.source === current)
          .map(e => ({ target: e.target, flowTag: e.flowTag }));

        for (const { target, flowTag: edgeFlowTag } of downstream) {
          if (!visited.has(target)) {
            queue.push({
              goalId: target,
              path: [...path, target],
              flowTag: edgeFlowTag || flowTag,
            });
          }
        }
      }
    }

    return shortestPath;
  }
}
