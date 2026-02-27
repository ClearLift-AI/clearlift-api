/**
 * Simulation-Required Recommendation Executor
 *
 * Enforces that ALL recommendations must be backed by mathematical simulation.
 * If the LLM tries to create a recommendation without first running a simulation,
 * this executor will:
 * 1. Auto-run the simulation
 * 2. Return an error asking the LLM to review the results
 * 3. Only allow the recommendation on the second call (after LLM acknowledges)
 *
 * This makes it IMPOSSIBLE to create recommendations with hallucinated impact numbers.
 */

import { SimulationService, SimulationResult, SimulateChangeParams } from './simulation-service';
import { Recommendation } from './recommendation-tools';

// D1Database type from Cloudflare Workers
type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
};

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta?: { changes: number; last_row_id: number; };
}

interface D1ExecResult {
  count: number;
}

// Helper to add days to a date
function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface SimulationCache {
  simulations: Map<string, SimulationResult>;
}

export interface ToolExecutionContext {
  orgId: string;
  analysisRunId: string;
  analyticsDb: D1Database;
  aiDb: D1Database;
  simulationCache: SimulationCache;
  platform?: string;
}

export interface ToolResult {
  success: boolean;
  error?: string;
  message: string;
  simulation_result?: SimulationResult;
  recommendation?: string;
  recommendation_id?: string;
  data?: any;
}

export interface CreateRecommendationParams {
  action: 'pause' | 'enable' | 'increase_budget' | 'decrease_budget';
  entity_type: 'campaign' | 'ad_set' | 'ad';
  entity_id: string;
  entity_name?: string;
  platform: string;
  reason: string;
  budget_change_percent?: number;
  current_budget_cents?: number;
  recommended_budget_cents?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMULATION CACHE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

export function createSimulationCache(): SimulationCache {
  return {
    simulations: new Map()
  };
}

function getSimulationKey(action: string, entityId: string): string {
  return `${action}:${entityId}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: simulate_change
// ═══════════════════════════════════════════════════════════════════════════

export const SIMULATE_CHANGE_TOOL = {
  name: 'simulate_change',
  description: `Simulate the mathematical impact of a campaign change on CAC and conversions.

ALWAYS call this tool BEFORE making a recommendation to get the REAL numbers.
Do NOT guess impact percentages - this tool calculates them mathematically.

The simulation uses:
- For pause/enable: Simple subtraction/addition of spend and conversions
- For budget changes: Diminishing returns model fitted to historical data
- For reallocation: Combined decrease/increase simulation
- For audience changes: Reach/frequency modeling
- For bid changes: Auction dynamics modeling
- For schedule changes: Hourly performance analysis

Returns detailed math explanation showing exactly how the numbers were calculated.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['pause', 'enable', 'increase_budget', 'decrease_budget', 'reallocate_budget', 'change_audience', 'change_bid', 'change_schedule'],
        description: 'The change to simulate'
      },
      entity_type: {
        type: 'string',
        enum: ['campaign', 'ad_set', 'ad_group', 'ad'],
        description: 'Type of entity'
      },
      entity_id: {
        type: 'string',
        description: 'Name or ID of the campaign/ad_set/ad to simulate changes for. Can use the human-readable name from analysis summaries (e.g. "DTC US = Refurb Classic Post-Labor Day 2025") or the entity_ref UUID.'
      },
      days: {
        type: 'number',
        description: 'Lookback window in days for portfolio metrics (default 30). Use larger values (60, 90) for entities that may not have recent spend.'
      },
      budget_change_percent: {
        type: 'number',
        description: 'For budget changes: percentage change (e.g., 50 for +50%, -30 for -30%)'
      },
      target_entity_id: {
        type: 'string',
        description: 'For reallocation: the entity to receive the budget'
      },
      reallocation_amount_cents: {
        type: 'number',
        description: 'For reallocation: amount in cents to move'
      },
      audience_change_type: {
        type: 'string',
        enum: ['expand', 'narrow', 'shift'],
        description: 'For audience changes: type of change'
      },
      reach_change_percent: {
        type: 'number',
        description: 'For audience changes: estimated reach change (e.g., 20 for +20%)'
      },
      current_bid_cents: {
        type: 'number',
        description: 'For bid changes: current bid'
      },
      new_bid_cents: {
        type: 'number',
        description: 'For bid changes: proposed new bid'
      },
      bid_strategy: {
        type: 'string',
        description: 'For bid changes: strategy change (maximize_conversions, target_cpa, etc.)'
      },
      hours_to_add: {
        type: 'array',
        items: { type: 'number' },
        description: 'For schedule changes: hours (0-23) to add'
      },
      hours_to_remove: {
        type: 'array',
        items: { type: 'number' },
        description: 'For schedule changes: hours (0-23) to remove'
      }
    },
    required: ['action', 'entity_type', 'entity_id']
  }
};

export async function executeSimulateChange(
  params: SimulateChangeParams,
  context: ToolExecutionContext
): Promise<ToolResult> {
  const simulationService = new SimulationService(context.analyticsDb, context.orgId);

  try {
    const result = await simulationService.simulateChange(params);

    if (!result.success) {
      return {
        success: false,
        message: result.math_explanation,
        simulation_result: result
      };
    }

    // Cache the simulation for use in create_recommendation
    const simKey = getSimulationKey(params.action, params.entity_id);
    context.simulationCache.simulations.set(simKey, result);

    // Format a nice response for the LLM
    const cacChange = result.simulated_state.cac_change_percent;
    const convChange = result.simulated_state.conversion_change_percent;

    return {
      success: true,
      message: `
SIMULATION COMPLETE
═══════════════════════════════════════════════════════════════

${result.math_explanation}

═══════════════════════════════════════════════════════════════
SUMMARY:
  CAC Impact:        ${cacChange >= 0 ? '+' : ''}${cacChange.toFixed(1)}%
  Conversion Impact: ${convChange >= 0 ? '+' : ''}${convChange.toFixed(1)}%
  Confidence:        ${result.confidence.toUpperCase()}
═══════════════════════════════════════════════════════════════

${cacChange < 0
  ? '✓ This change is projected to IMPROVE CAC. You may proceed with the recommendation.'
  : cacChange > 10
    ? '⚠ This change shows SIGNIFICANT CAC INCREASE. Only proceed if conversion growth justifies the cost.'
    : '⚠ This change shows slight CAC increase. Consider the tradeoffs carefully.'
}

To create this recommendation, call the appropriate tool (set_status or set_budget).
The simulation results will be automatically attached.`,
      simulation_result: result,
      data: {
        current_cac: result.current_state.blended_cac_cents / 100,
        simulated_cac: result.simulated_state.blended_cac_cents / 100,
        cac_change_percent: cacChange,
        conversion_change_percent: convChange,
        confidence: result.confidence,
        projected_cac_cents: result.simulated_state.blended_cac_cents,
        projected_total_spend_cents: result.simulated_state.total_spend_cents
      }
    };
  } catch (err) {
    return {
      success: false,
      error: 'SIMULATION_FAILED',
      message: `Simulation failed: ${err instanceof Error ? err.message : 'Unknown error'}`
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RECOMMENDATION EXECUTOR (Simulation-Required)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute a recommendation tool call with simulation requirement
 *
 * If no simulation exists for this action+entity, we:
 * 1. Auto-run the simulation
 * 2. Return an error with the results
 * 3. Ask the LLM to confirm
 *
 * On second call (after simulation exists), we proceed with real numbers.
 */
export async function executeRecommendationWithSimulation(
  toolName: string,
  toolInput: Record<string, any>,
  context: ToolExecutionContext
): Promise<ToolResult> {
  // Map tool names to simulation actions
  const getActionForTool = (toolName: string, input: Record<string, any>): string | null => {
    switch (toolName) {
      case 'set_status':
        return input.recommended_status === 'PAUSED' ? 'pause' : 'enable';
      case 'set_budget':
        return input.recommended_budget_cents > (input.current_budget_cents || 0)
          ? 'increase_budget'
          : 'decrease_budget';
      case 'reallocate_budget':
        return 'reallocate_budget';
      case 'set_audience':
        return 'change_audience';
      case 'set_bid':
        return 'change_bid';
      case 'set_schedule':
        return 'change_schedule';
      case 'compound_action': {
        // Find the primary sub-action (first set_budget or largest budget change)
        const actions = input.actions || [];
        const budgetAction = actions.find((a: any) => a.tool === 'set_budget');
        if (budgetAction) {
          const p = budgetAction.parameters || {};
          return p.recommended_budget_cents > (p.current_budget_cents || 0)
            ? 'increase_budget'
            : 'decrease_budget';
        }
        const statusAction = actions.find((a: any) => a.tool === 'set_status');
        if (statusAction) {
          return statusAction.parameters?.recommended_status === 'PAUSED' ? 'pause' : 'enable';
        }
        return 'pause'; // fallback
      }
      default:
        return null; // Tool doesn't require simulation
    }
  };

  const action = getActionForTool(toolName, toolInput);
  if (!action) {
    // Tool doesn't require simulation (e.g., general_insight)
    return {
      success: true,
      message: 'Tool executed (no simulation required)',
      data: toolInput
    };
  }

  // For compound_action, extract entity_id from the primary sub-action
  const entityId = toolName === 'compound_action'
    ? (toolInput.actions?.[0]?.entity_id || toolInput.entity_id)
    : toolInput.entity_id;
  const simKey = getSimulationKey(action, entityId);
  const existingSimulation = context.simulationCache.simulations.get(simKey);

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 1: No simulation exists - ERROR + auto-run + prompt for confirm
  // ═══════════════════════════════════════════════════════════════════════
  if (!existingSimulation) {
    // Auto-run the simulation
    const simulationService = new SimulationService(context.analyticsDb, context.orgId);

    const simParams: SimulateChangeParams = {
      action: action as any,
      entity_type: toolInput.entity_type,
      entity_id: entityId
    };

    // Add action-specific parameters
    if (action === 'increase_budget' || action === 'decrease_budget') {
      if (toolInput.current_budget_cents && toolInput.recommended_budget_cents) {
        simParams.budget_change_percent =
          ((toolInput.recommended_budget_cents - toolInput.current_budget_cents) / toolInput.current_budget_cents) * 100;
      } else {
        return {
          success: false,
          error: 'MISSING_BUDGET_INFO',
          message: 'Budget changes require current_budget_cents and recommended_budget_cents to calculate the simulation.'
        };
      }
    }

    if (action === 'reallocate_budget') {
      simParams.target_entity_id = toolInput.to_entity_id;
      simParams.reallocation_amount_cents = toolInput.amount_cents;
    }

    if (action === 'change_audience') {
      // Determine audience change type from the inputs
      const hasExpansion = toolInput.expand_lookalike || toolInput.add_interests?.length;
      const hasNarrowing = toolInput.exclude_interests?.length || toolInput.narrow_age_range;
      simParams.audience_change = {
        type: hasExpansion ? 'expand' : hasNarrowing ? 'narrow' : 'shift',
        estimated_reach_change_percent: toolInput.estimated_reach_change_percent || (hasExpansion ? 20 : hasNarrowing ? -20 : 0)
      };
    }

    if (action === 'change_bid') {
      simParams.bid_change = {
        current_bid_cents: toolInput.current_bid_cents,
        new_bid_cents: toolInput.recommended_bid_cents,
        strategy_change: toolInput.recommended_strategy !== toolInput.current_strategy
          ? toolInput.recommended_strategy
          : undefined
      };
    }

    if (action === 'change_schedule') {
      simParams.schedule_change = {
        hours_to_add: toolInput.hours_to_add,
        hours_to_remove: toolInput.hours_to_remove
      };
    }

    const simulation = await simulationService.simulateChange(simParams);

    // Cache it for the retry
    context.simulationCache.simulations.set(simKey, simulation);

    // Return error with simulation results - forces LLM to acknowledge
    const cacChange = simulation.simulated_state.cac_change_percent;
    const convChange = simulation.simulated_state.conversion_change_percent;

    return {
      success: false,
      error: 'SIMULATION_REQUIRED',
      message: `
╔═══════════════════════════════════════════════════════════════════════════╗
║  SIMULATION REQUIRED                                                       ║
║  Cannot create recommendation without reviewing mathematical simulation    ║
╚═══════════════════════════════════════════════════════════════════════════╝

I ran the simulation for you. Here are the ACTUAL numbers:

${simulation.math_explanation}

═══════════════════════════════════════════════════════════════════════════════
SIMULATION RESULTS:
  Current blended CAC:    $${(simulation.current_state.blended_cac_cents / 100).toFixed(2)}
  Simulated blended CAC:  $${(simulation.simulated_state.blended_cac_cents / 100).toFixed(2)}

  CAC Impact:        ${cacChange >= 0 ? '+' : ''}${cacChange.toFixed(1)}%
  Conversion Impact: ${convChange >= 0 ? '+' : ''}${convChange.toFixed(1)}%

  Confidence: ${simulation.confidence.toUpperCase()}

  Assumptions:
${simulation.assumptions.map(a => `    • ${a}`).join('\n')}
═══════════════════════════════════════════════════════════════════════════════

${cacChange < 0
  ? '✓ The simulation supports this recommendation. Call the tool again to proceed.'
  : cacChange > 15
    ? '⚠ WARNING: Simulation shows significant CAC INCREASE. Reconsider this recommendation.'
    : convChange > 20
      ? '⚠ Simulation shows CAC increase but strong conversion growth. Consider the tradeoff.'
      : '⚠ Simulation shows negative CAC impact. Proceed only if you have strong justification.'
}

To proceed with this recommendation, call ${toolName} again.
The calculated impact (${cacChange.toFixed(1)}%) will be used instead of any guessed value.

If these numbers don't support your recommendation, do NOT proceed.`,
      simulation_result: simulation,
      recommendation: cacChange < 0
        ? 'PROCEED'
        : cacChange > 15
          ? 'RECONSIDER'
          : 'TRADEOFF'
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 2: Simulation exists - proceed with REAL numbers
  // ═══════════════════════════════════════════════════════════════════════

  const sim = existingSimulation;

  // Build the recommendation with CALCULATED impact
  const recommendation: Recommendation = {
    tool: toolName,
    platform: toolInput.platform || context.platform || 'unknown',
    entity_type: toolInput.entity_type || toolInput.from_entity_type || 'campaign',
    entity_id: toolInput.entity_id || toolInput.from_entity_id || toolInput.campaign_id || 'unknown',
    entity_name: toolInput.entity_name || toolInput.from_entity_name || sim.current_state.entity.name || 'unknown',
    parameters: {
      ...toolInput,
      // Override any guessed impact with calculated value
      predicted_impact: sim.simulated_state.cac_change_percent,
      predicted_conversion_change: sim.simulated_state.conversion_change_percent
    },
    reason: toolInput.reason || 'No reason provided',
    // USE CALCULATED IMPACT, NOT LLM'S GUESS
    predicted_impact: sim.simulated_state.cac_change_percent,
    confidence: sim.confidence
  };

  // Store in database
  const storeResult = await storeRecommendation(context.aiDb, context.orgId, context.analysisRunId, recommendation, sim);

  // Clear from cache (one-time use)
  context.simulationCache.simulations.delete(simKey);

  // If a pending decision already exists for this entity, nudge the LLM to update/delete first
  if (storeResult.isDuplicate) {
    return {
      success: false,
      error: 'DUPLICATE_ENTITY',
      message: `⚠ A pending recommendation already exists for ${recommendation.entity_name} (${toolName}). ` +
        `Use update_recommendation to revise it, or delete_recommendation to withdraw it and free the action slot. ` +
        `Duplicate recommendations for the same entity are not stored.`,
      recommendation: 'UPDATE_OR_DELETE',
      data: {
        existing_recommendation_id: storeResult.id,
        entity_id: recommendation.entity_id,
        entity_name: recommendation.entity_name,
        tool: toolName
      }
    };
  }

  return {
    success: true,
    recommendation_id: storeResult.id,
    message: `
✓ RECOMMENDATION CREATED

  Action:      ${action.replace('_', ' ')} ${toolInput.entity_name}
  CAC Impact:  ${sim.simulated_state.cac_change_percent >= 0 ? '+' : ''}${sim.simulated_state.cac_change_percent.toFixed(1)}% (CALCULATED, not guessed)
  Confidence:  ${sim.confidence}

The recommendation has been saved with full simulation data.
The user will see the mathematical explanation when reviewing.`,
    data: {
      recommendation_id: storeResult.id,
      calculated_impact: sim.simulated_state.cac_change_percent,
      confidence: sim.confidence,
      projected_cac_cents: sim.simulated_state.blended_cac_cents,
      projected_total_spend_cents: sim.simulated_state.total_spend_cents
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE STORAGE
// ═══════════════════════════════════════════════════════════════════════════

async function storeRecommendation(
  aiDb: D1Database,
  orgId: string,
  analysisRunId: string,
  recommendation: Recommendation,
  simulation: SimulationResult
): Promise<{ id: string; isDuplicate: boolean }> {
  // Store canonical tool name — dashboard switches on 'set_status', not 'pause'/'enable'.
  // The recommended_status field inside parameters carries the directional intent.
  const tool = recommendation.tool;

  // Guard against undefined values that crash D1 bind()
  const platform = recommendation.platform || 'unknown';
  const entityType = recommendation.entity_type || 'campaign';
  const entityId = recommendation.entity_id || 'unknown';
  const entityName = recommendation.entity_name || 'unknown';
  const reason = recommendation.reason || '';

  // Check if a pending decision already exists for this entity+tool combination
  const existing = await aiDb.prepare(`
    SELECT id FROM ai_decisions
    WHERE organization_id = ? AND tool = ? AND platform = ? AND entity_type = ? AND entity_id = ?
      AND status = 'pending'
    LIMIT 1
  `).bind(orgId, tool, platform, entityType, entityId)
    .first<{ id: string }>();

  if (existing) return { id: existing.id, isDuplicate: true };

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const expiresAt = addDays(new Date(), 7).toISOString();

  await aiDb.prepare(`
    INSERT INTO ai_decisions (
      id, organization_id, tool, platform, entity_type, entity_id, entity_name,
      parameters, current_state, reason, predicted_impact, confidence,
      supporting_data, simulation_data, simulation_confidence,
      status, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now'))
  `).bind(
    id,
    orgId,
    tool,
    platform,
    entityType,
    entityId,
    entityName,
    JSON.stringify(recommendation.parameters || {}),
    JSON.stringify(simulation.current_state || {}),
    reason,
    simulation.simulated_state?.cac_change_percent ?? 0,
    simulation.confidence ?? 0,
    JSON.stringify({
      analysis_run_id: analysisRunId,
      math_explanation: simulation.math_explanation || '',
      assumptions: simulation.assumptions || []
    }),
    JSON.stringify({
      current_state: simulation.current_state || {},
      simulated_state: simulation.simulated_state || {},
      diminishing_returns_model: simulation.diminishing_returns_model || null
    }),
    simulation.confidence ?? 0,
    expiresAt
  ).run();

  return { id, isDuplicate: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get all tools including the simulation tool
 */
export function getToolsWithSimulation(existingTools: any[]): any[] {
  // Add simulate_change at the beginning (should be called first)
  return [
    {
      name: SIMULATE_CHANGE_TOOL.name,
      description: SIMULATE_CHANGE_TOOL.description,
      input_schema: SIMULATE_CHANGE_TOOL.input_schema
    },
    ...existingTools
  ];
}

// Generic version (provider-agnostic canonical format)
export function getToolsWithSimulationGeneric(
  existingTools: Array<{ name: string; description: string; input_schema: any }>
): Array<{ name: string; description: string; input_schema: any }> {
  return [
    {
      name: SIMULATE_CHANGE_TOOL.name,
      description: SIMULATE_CHANGE_TOOL.description,
      input_schema: SIMULATE_CHANGE_TOOL.input_schema
    },
    ...existingTools
  ];
}

/**
 * Check if a tool requires simulation
 */
export function requiresSimulation(toolName: string): boolean {
  const toolsRequiringSimulation = [
    'set_status',
    'set_budget',
    'reallocate_budget',
    'set_audience',
    'set_bid',
    'set_schedule',
    'compound_action'
  ];
  return toolsRequiringSimulation.includes(toolName);
}
