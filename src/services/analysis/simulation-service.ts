/**
 * Campaign Change Simulation Service
 *
 * Provides mathematical simulation of campaign changes to calculate
 * REAL impact on CAC and conversions. No guessing - only math.
 *
 * Supports:
 * - Pause/Enable: Simple subtraction/addition
 * - Budget changes: Diminishing returns modeling
 * - Budget reallocation: Combined simulation
 * - Audience changes: Reach/frequency modeling
 * - Bid changes: Auction dynamics modeling
 * - Schedule changes: Dayparting analysis
 *
 * Works with all entity levels: campaigns, ad sets/groups, and ads
 *
 * @module simulation-service
 */

import { structuredLog } from '../../utils/structured-logger';

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

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type SimulationAction =
  | 'pause'
  | 'enable'
  | 'increase_budget'
  | 'decrease_budget'
  | 'reallocate_budget'
  | 'change_audience'
  | 'change_bid'
  | 'change_schedule';

export type EntityLevel = 'campaign' | 'ad_set' | 'ad_group' | 'ad';

export interface SimulateChangeParams {
  action: SimulationAction;
  entity_type: EntityLevel;
  entity_id: string;
  platform?: string;
  days?: number;
  budget_change_percent?: number;
  // For reallocation
  target_entity_id?: string;
  reallocation_amount_cents?: number;
  // For audience changes
  audience_change?: {
    type: 'expand' | 'narrow' | 'shift';
    estimated_reach_change_percent?: number;
  };
  // For bid changes
  bid_change?: {
    current_bid_cents?: number;
    new_bid_cents?: number;
    strategy_change?: string;
  };
  // For schedule changes
  schedule_change?: {
    hours_to_add?: number[];
    hours_to_remove?: number[];
  };
}

export interface EntityMetrics {
  id: string;
  name: string;
  platform: string;
  entity_type: EntityLevel;
  spend_cents: number;
  conversions: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc_cents: number;
}

export interface EntityState {
  id: string;
  name: string;
  platform: string;
  spend_cents: number;
  conversions: number;
  cac_cents: number;
  efficiency_vs_average: number;
}

export interface PortfolioState {
  total_spend_cents: number;
  total_conversions: number;
  blended_cac_cents: number;
  entity: EntityState;
}

export interface SimulatedState {
  total_spend_cents: number;
  total_conversions: number;
  blended_cac_cents: number;
  cac_change_percent: number;
  conversion_change_percent: number;
  spend_change_percent: number;
}

export interface SimulationResult {
  success: boolean;
  current_state: PortfolioState;
  simulated_state: SimulatedState;
  confidence: 'high' | 'medium' | 'low';
  assumptions: string[];
  math_explanation: string;
  diminishing_returns_model?: {
    k: number;
    alpha: number;
    r_squared: number;
    data_points: number;
  };
}

interface HistoricalDataPoint {
  date: string;
  spend_cents: number;
  conversions: number;
  impressions?: number;
  clicks?: number;
  hour?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMULATION SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class SimulationService {
  constructor(
    private analyticsDb: D1Database,
    private orgId: string
  ) {}

  /**
   * Main entry point - simulate any campaign change
   */
  async simulateChange(params: SimulateChangeParams): Promise<SimulationResult> {
    const days = params.days || 30;

    // 1. Get current portfolio state
    const allEntities = await this.getPortfolioMetrics(params.entity_type, days);

    if (allEntities.length === 0) {
      return {
        success: false,
        current_state: this.emptyState(),
        simulated_state: this.emptySimulatedState(),
        confidence: 'low',
        assumptions: ['No metrics data available'],
        math_explanation: `Cannot simulate: no metrics found in the last ${days} days for any entity.`
      };
    }

    // 2. Find target entity — cascading match: exact ID → exact name → partial name
    let target = allEntities.find(e => e.id === params.entity_id);
    if (!target) {
      const needle = params.entity_id.toLowerCase();
      target = allEntities.find(e => e.name.toLowerCase() === needle);
      if (!target) {
        target = allEntities.find(e => e.name.toLowerCase().includes(needle));
      }
    }
    if (!target) {
      const availableNames = allEntities.slice(0, 10).map(e => `  • ${e.name} (${e.id})`).join('\n');
      return {
        success: false,
        current_state: this.buildCurrentState(allEntities, null),
        simulated_state: this.emptySimulatedState(),
        confidence: 'low',
        assumptions: ['Target entity not found'],
        math_explanation: `Cannot simulate: entity "${params.entity_id}" not found in last ${days} days.\n\nAvailable entities:\n${availableNames}`
      };
    }

    // 3. Calculate current state
    const currentState = this.buildCurrentState(allEntities, target);

    // 4. Run appropriate simulation
    switch (params.action) {
      case 'pause':
        return this.simulatePause(currentState, target, allEntities);

      case 'enable':
        return this.simulateEnable(currentState, target, allEntities, params.entity_type);

      case 'increase_budget':
      case 'decrease_budget':
        if (params.budget_change_percent === undefined) {
          return {
            success: false,
            current_state: currentState,
            simulated_state: this.emptySimulatedState(),
            confidence: 'low',
            assumptions: ['budget_change_percent required'],
            math_explanation: 'Cannot simulate budget change without specifying percentage.'
          };
        }
        return this.simulateBudgetChange(
          currentState,
          target,
          allEntities,
          params.budget_change_percent,
          params.entity_type
        );

      case 'reallocate_budget':
        if (!params.target_entity_id || !params.reallocation_amount_cents) {
          return {
            success: false,
            current_state: currentState,
            simulated_state: this.emptySimulatedState(),
            confidence: 'low',
            assumptions: ['target_entity_id and reallocation_amount_cents required'],
            math_explanation: 'Cannot simulate reallocation without target entity and amount.'
          };
        }
        let targetEntity = allEntities.find(e => e.id === params.target_entity_id);
        if (!targetEntity && params.target_entity_id) {
          const needle = params.target_entity_id.toLowerCase();
          targetEntity = allEntities.find(e => e.name.toLowerCase() === needle);
          if (!targetEntity) {
            targetEntity = allEntities.find(e => e.name.toLowerCase().includes(needle));
          }
        }
        if (!targetEntity) {
          return {
            success: false,
            current_state: currentState,
            simulated_state: this.emptySimulatedState(),
            confidence: 'low',
            assumptions: ['Target entity for reallocation not found'],
            math_explanation: `Cannot simulate: target entity ${params.target_entity_id} not found.`
          };
        }
        return this.simulateReallocation(
          currentState,
          target,
          targetEntity,
          allEntities,
          params.reallocation_amount_cents,
          params.entity_type
        );

      case 'change_audience':
        return this.simulateAudienceChange(
          currentState,
          target,
          allEntities,
          params.audience_change
        );

      case 'change_bid':
        return this.simulateBidChange(
          currentState,
          target,
          allEntities,
          params.bid_change
        );

      case 'change_schedule':
        return this.simulateScheduleChange(
          currentState,
          target,
          allEntities,
          params.schedule_change,
          params.entity_type
        );

      default:
        return {
          success: false,
          current_state: currentState,
          simulated_state: this.emptySimulatedState(),
          confidence: 'low',
          assumptions: [`Unknown action: ${params.action}`],
          math_explanation: `Cannot simulate unknown action: ${params.action}`
        };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAUSE SIMULATION (Simple Math - High Confidence)
  // ═══════════════════════════════════════════════════════════════════════

  private simulatePause(
    currentState: PortfolioState,
    target: EntityMetrics,
    allEntities: EntityMetrics[]
  ): SimulationResult {
    const newSpend = currentState.total_spend_cents - target.spend_cents;
    const newConversions = currentState.total_conversions - target.conversions;

    if (newConversions <= 0 || newSpend <= 0) {
      return {
        success: true,
        current_state: currentState,
        simulated_state: {
          total_spend_cents: 0,
          total_conversions: 0,
          blended_cac_cents: 0,
          cac_change_percent: 0,
          conversion_change_percent: -100,
          spend_change_percent: -100
        },
        confidence: 'high',
        assumptions: [
          'This is the only active entity with conversions',
          'Pausing will stop all conversions'
        ],
        math_explanation: `
WARNING: ${target.name} is the only entity with conversions.
Pausing will result in zero conversions.

Current: $${(currentState.total_spend_cents / 100).toFixed(2)} spend → ${currentState.total_conversions} conversions
After pause: $0 spend → 0 conversions`
      };
    }

    const newCAC = newSpend / newConversions;
    const cacChange = ((newCAC - currentState.blended_cac_cents) / currentState.blended_cac_cents) * 100;
    const conversionChange = ((newConversions - currentState.total_conversions) / currentState.total_conversions) * 100;
    const spendChange = ((newSpend - currentState.total_spend_cents) / currentState.total_spend_cents) * 100;

    return {
      success: true,
      current_state: currentState,
      simulated_state: {
        total_spend_cents: newSpend,
        total_conversions: newConversions,
        blended_cac_cents: Math.round(newCAC),
        cac_change_percent: Math.round(cacChange * 10) / 10,
        conversion_change_percent: Math.round(conversionChange * 10) / 10,
        spend_change_percent: Math.round(spendChange * 10) / 10
      },
      confidence: 'high',
      assumptions: [
        'Pausing does not affect other entities',
        'No budget reallocation to other entities',
        'Historical conversion rate is representative'
      ],
      math_explanation: this.buildPauseMathExplanation(currentState, target, newSpend, newConversions, newCAC, cacChange)
    };
  }

  private buildPauseMathExplanation(
    current: PortfolioState,
    target: EntityMetrics,
    newSpend: number,
    newConversions: number,
    newCAC: number,
    cacChange: number
  ): string {
    const targetCAC = target.conversions > 0 ? target.spend_cents / target.conversions : 0;
    return `
PAUSE SIMULATION: ${target.name}
════════════════════════════════════════════════════════════════

CURRENT PORTFOLIO:
  Total Spend:       $${(current.total_spend_cents / 100).toFixed(2)}
  Total Conversions: ${current.total_conversions}
  Blended CAC:       $${(current.blended_cac_cents / 100).toFixed(2)}

TARGET ENTITY (${target.name}):
  Platform:    ${target.platform}
  Spend:       $${(target.spend_cents / 100).toFixed(2)} (${((target.spend_cents / current.total_spend_cents) * 100).toFixed(1)}% of total)
  Conversions: ${target.conversions} (${((target.conversions / current.total_conversions) * 100).toFixed(1)}% of total)
  CAC:         $${(targetCAC / 100).toFixed(2)}
  Efficiency:  ${current.entity.efficiency_vs_average >= 0 ? '+' : ''}${current.entity.efficiency_vs_average.toFixed(1)}% vs average

CALCULATION:
  New Spend       = $${(current.total_spend_cents / 100).toFixed(2)} - $${(target.spend_cents / 100).toFixed(2)} = $${(newSpend / 100).toFixed(2)}
  New Conversions = ${current.total_conversions} - ${target.conversions} = ${newConversions}
  New CAC         = $${(newSpend / 100).toFixed(2)} ÷ ${newConversions} = $${(newCAC / 100).toFixed(2)}

RESULT:
  CAC Change: ${cacChange >= 0 ? '+' : ''}${cacChange.toFixed(1)}%
  ${cacChange < 0 ? '✓ CAC IMPROVEMENT' : '⚠ CAC INCREASE'}
`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ENABLE SIMULATION (Based on Historical Performance)
  // ═══════════════════════════════════════════════════════════════════════

  private async simulateEnable(
    currentState: PortfolioState,
    target: EntityMetrics,
    allEntities: EntityMetrics[],
    entityType: EntityLevel
  ): Promise<SimulationResult> {
    // Look back 90 days to find historical performance for paused entities
    const history = await this.getEntityHistory(target.id, 90, entityType);

    // Filter to only days with actual spend (active days) for averaging
    const activeDays = history.filter(d => d.spend_cents > 0);

    if (activeDays.length < 3) {
      return {
        success: true,
        current_state: currentState,
        simulated_state: this.emptySimulatedState(),
        confidence: 'low',
        assumptions: ['Insufficient historical data'],
        math_explanation: `Cannot reliably simulate enabling ${target.name}: only ${activeDays.length} active days of historical data in last 90 days (need 3+).`
      };
    }

    const avgSpend = activeDays.reduce((s, d) => s + d.spend_cents, 0) / activeDays.length;
    const avgConversions = activeDays.reduce((s, d) => s + d.conversions, 0) / activeDays.length;

    const newSpend = currentState.total_spend_cents + avgSpend;
    const newConversions = currentState.total_conversions + avgConversions;
    const newCAC = newConversions > 0 ? newSpend / newConversions : 0;

    const cacChange = currentState.blended_cac_cents > 0
      ? ((newCAC - currentState.blended_cac_cents) / currentState.blended_cac_cents) * 100
      : 0;

    return {
      success: true,
      current_state: currentState,
      simulated_state: {
        total_spend_cents: Math.round(newSpend),
        total_conversions: Math.round(newConversions),
        blended_cac_cents: Math.round(newCAC),
        cac_change_percent: Math.round(cacChange * 10) / 10,
        conversion_change_percent: Math.round((avgConversions / currentState.total_conversions) * 100 * 10) / 10,
        spend_change_percent: Math.round((avgSpend / currentState.total_spend_cents) * 100 * 10) / 10
      },
      confidence: activeDays.length >= 14 ? 'medium' : 'low',
      assumptions: [
        `Based on ${activeDays.length} active days out of ${history.length}-day lookback`,
        activeDays.length < 14 ? 'Limited data — actual performance may vary significantly' : 'Assumes similar performance to historical period',
        'Market conditions may have changed since entity was paused'
      ],
      math_explanation: `
ENABLE SIMULATION: ${target.name}
════════════════════════════════════════════════════════════════

HISTORICAL PERFORMANCE (${activeDays.length} active days, 90-day lookback):
  Avg Daily Spend:       $${(avgSpend / 100).toFixed(2)}
  Avg Daily Conversions: ${avgConversions.toFixed(1)}
  Historical CAC:        $${avgConversions > 0 ? '$' + (avgSpend / avgConversions / 100).toFixed(2) : 'N/A (no conversions)'}

PROJECTED PORTFOLIO:
  New Spend:       $${(currentState.total_spend_cents / 100).toFixed(2)} + $${(avgSpend / 100).toFixed(2)} = $${(newSpend / 100).toFixed(2)}
  New Conversions: ${currentState.total_conversions} + ${avgConversions.toFixed(1)} = ${newConversions.toFixed(1)}
  New CAC:         $${(newCAC / 100).toFixed(2)}

RESULT:
  CAC Change: ${cacChange >= 0 ? '+' : ''}${cacChange.toFixed(1)}%
`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BUDGET CHANGE SIMULATION (Diminishing Returns Model)
  // ═══════════════════════════════════════════════════════════════════════

  private async simulateBudgetChange(
    currentState: PortfolioState,
    target: EntityMetrics,
    allEntities: EntityMetrics[],
    changePercent: number,
    entityType: EntityLevel
  ): Promise<SimulationResult> {
    const history = await this.getEntityHistory(target.id, 90, entityType);
    const newEntitySpend = target.spend_cents * (1 + changePercent / 100);

    const { predictedConversions, model, confidence } = this.predictConversionsAtSpend(
      target,
      newEntitySpend,
      history
    );

    const spendDelta = newEntitySpend - target.spend_cents;
    const conversionDelta = predictedConversions - target.conversions;

    const newTotalSpend = currentState.total_spend_cents + spendDelta;
    const newTotalConversions = currentState.total_conversions + conversionDelta;
    const newCAC = newTotalSpend / newTotalConversions;

    const cacChange = ((newCAC - currentState.blended_cac_cents) / currentState.blended_cac_cents) * 100;
    const conversionChange = ((newTotalConversions - currentState.total_conversions) / currentState.total_conversions) * 100;
    const spendChange = ((newTotalSpend - currentState.total_spend_cents) / currentState.total_spend_cents) * 100;

    const newEntityCAC = newEntitySpend / predictedConversions;
    const currentEntityCAC = target.spend_cents / target.conversions;
    const entityCACChange = ((newEntityCAC - currentEntityCAC) / currentEntityCAC) * 100;

    return {
      success: true,
      current_state: currentState,
      simulated_state: {
        total_spend_cents: Math.round(newTotalSpend),
        total_conversions: Math.round(newTotalConversions * 10) / 10,
        blended_cac_cents: Math.round(newCAC),
        cac_change_percent: Math.round(cacChange * 10) / 10,
        conversion_change_percent: Math.round(conversionChange * 10) / 10,
        spend_change_percent: Math.round(spendChange * 10) / 10
      },
      confidence,
      assumptions: this.buildBudgetAssumptions(model, history.length, changePercent),
      math_explanation: this.buildBudgetMathExplanation(
        currentState, target, changePercent, newEntitySpend, predictedConversions,
        model, newTotalSpend, newTotalConversions, newCAC, cacChange,
        newEntityCAC, entityCACChange
      ),
      diminishing_returns_model: model
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BUDGET REALLOCATION SIMULATION
  // ═══════════════════════════════════════════════════════════════════════

  private async simulateReallocation(
    currentState: PortfolioState,
    fromEntity: EntityMetrics,
    toEntity: EntityMetrics,
    allEntities: EntityMetrics[],
    amountCents: number,
    entityType: EntityLevel
  ): Promise<SimulationResult> {
    // Get history for both entities
    const fromHistory = await this.getEntityHistory(fromEntity.id, 90, entityType);
    const toHistory = await this.getEntityHistory(toEntity.id, 90, entityType);

    // Calculate new spend levels
    const fromNewSpend = fromEntity.spend_cents - amountCents;
    const toNewSpend = toEntity.spend_cents + amountCents;

    // Predict conversions at new spend levels using diminishing returns
    const fromPrediction = this.predictConversionsAtSpend(fromEntity, fromNewSpend, fromHistory);
    const toPrediction = this.predictConversionsAtSpend(toEntity, toNewSpend, toHistory);

    // Calculate deltas
    const fromConversionDelta = fromPrediction.predictedConversions - fromEntity.conversions;
    const toConversionDelta = toPrediction.predictedConversions - toEntity.conversions;

    // Total portfolio impact (spend stays same, conversions change)
    const newTotalConversions = currentState.total_conversions + fromConversionDelta + toConversionDelta;
    const newCAC = currentState.total_spend_cents / newTotalConversions;

    const cacChange = ((newCAC - currentState.blended_cac_cents) / currentState.blended_cac_cents) * 100;
    const conversionChange = ((newTotalConversions - currentState.total_conversions) / currentState.total_conversions) * 100;

    // Determine confidence based on both models
    const confidence = fromPrediction.confidence === 'high' && toPrediction.confidence === 'high'
      ? 'high'
      : fromPrediction.confidence === 'low' || toPrediction.confidence === 'low'
        ? 'low'
        : 'medium';

    return {
      success: true,
      current_state: currentState,
      simulated_state: {
        total_spend_cents: currentState.total_spend_cents, // Same spend, just reallocated
        total_conversions: Math.round(newTotalConversions * 10) / 10,
        blended_cac_cents: Math.round(newCAC),
        cac_change_percent: Math.round(cacChange * 10) / 10,
        conversion_change_percent: Math.round(conversionChange * 10) / 10,
        spend_change_percent: 0 // No net spend change
      },
      confidence,
      assumptions: [
        `Moving $${(amountCents / 100).toFixed(2)} from ${fromEntity.name} to ${toEntity.name}`,
        `From entity: α=${fromPrediction.model.alpha.toFixed(2)} (R²=${(fromPrediction.model.r_squared * 100).toFixed(0)}%)`,
        `To entity: α=${toPrediction.model.alpha.toFixed(2)} (R²=${(toPrediction.model.r_squared * 100).toFixed(0)}%)`,
        'Assumes both entities respond predictably to budget changes',
        'Total spend remains constant'
      ],
      math_explanation: `
BUDGET REALLOCATION SIMULATION
════════════════════════════════════════════════════════════════

REALLOCATION: $${(amountCents / 100).toFixed(2)} from ${fromEntity.name} → ${toEntity.name}

FROM ENTITY (${fromEntity.name}):
  Current:    $${(fromEntity.spend_cents / 100).toFixed(2)} → ${fromEntity.conversions} conv
  After:      $${(fromNewSpend / 100).toFixed(2)} → ${fromPrediction.predictedConversions.toFixed(1)} conv
  Delta:      ${fromConversionDelta >= 0 ? '+' : ''}${fromConversionDelta.toFixed(1)} conversions

TO ENTITY (${toEntity.name}):
  Current:    $${(toEntity.spend_cents / 100).toFixed(2)} → ${toEntity.conversions} conv
  After:      $${(toNewSpend / 100).toFixed(2)} → ${toPrediction.predictedConversions.toFixed(1)} conv
  Delta:      ${toConversionDelta >= 0 ? '+' : ''}${toConversionDelta.toFixed(1)} conversions

NET IMPACT:
  Conversion Delta: ${fromConversionDelta.toFixed(1)} + ${toConversionDelta.toFixed(1)} = ${(fromConversionDelta + toConversionDelta).toFixed(1)}
  New Total Conv:   ${currentState.total_conversions} + ${(fromConversionDelta + toConversionDelta).toFixed(1)} = ${newTotalConversions.toFixed(1)}
  New Blended CAC:  $${(newCAC / 100).toFixed(2)}

RESULT:
  CAC Change: ${cacChange >= 0 ? '+' : ''}${cacChange.toFixed(1)}%
  ${cacChange < 0 ? '✓ REALLOCATION IMPROVES CAC' : '⚠ REALLOCATION INCREASES CAC'}
`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AUDIENCE CHANGE SIMULATION
  // ═══════════════════════════════════════════════════════════════════════

  private simulateAudienceChange(
    currentState: PortfolioState,
    target: EntityMetrics,
    allEntities: EntityMetrics[],
    audienceChange?: { type: 'expand' | 'narrow' | 'shift'; estimated_reach_change_percent?: number }
  ): SimulationResult {
    if (!audienceChange) {
      return {
        success: false,
        current_state: currentState,
        simulated_state: this.emptySimulatedState(),
        confidence: 'low',
        assumptions: ['audience_change parameters required'],
        math_explanation: 'Cannot simulate audience change without specifying type and reach change.'
      };
    }

    const { type, estimated_reach_change_percent = 0 } = audienceChange;

    // Audience changes affect reach → impressions → clicks → conversions
    // Model: Broader audience = more impressions but lower relevance (lower CTR)
    // Model: Narrower audience = fewer impressions but higher relevance (higher CTR)

    let impressionMultiplier: number;
    let ctrMultiplier: number;
    let cpcMultiplier: number;

    switch (type) {
      case 'expand':
        // More reach but lower relevance
        impressionMultiplier = 1 + (estimated_reach_change_percent / 100);
        ctrMultiplier = 1 - (estimated_reach_change_percent / 200); // CTR drops half as much
        cpcMultiplier = 0.95; // Broader audience = cheaper clicks (less competition)
        break;
      case 'narrow':
        // Less reach but higher relevance
        impressionMultiplier = 1 - Math.abs(estimated_reach_change_percent / 100);
        ctrMultiplier = 1 + Math.abs(estimated_reach_change_percent / 150); // CTR improves
        cpcMultiplier = 1.1; // Narrower = more competition
        break;
      case 'shift':
        // Same reach, different audience - moderate uncertainty
        impressionMultiplier = 1;
        ctrMultiplier = 1 + (estimated_reach_change_percent / 100); // Positive if better targeting
        cpcMultiplier = 1;
        break;
    }

    // Calculate new metrics
    const newImpressions = target.impressions * impressionMultiplier;
    const newCTR = target.ctr * ctrMultiplier;
    const newClicks = newImpressions * newCTR;
    const newCPC = target.cpc_cents * cpcMultiplier;
    const newSpend = newClicks * newCPC;

    // Conversion rate stays same (conversions per click)
    const conversionRate = target.conversions / target.clicks;
    const newConversions = newClicks * conversionRate;

    // Calculate portfolio impact
    const spendDelta = newSpend - target.spend_cents;
    const conversionDelta = newConversions - target.conversions;

    const newTotalSpend = currentState.total_spend_cents + spendDelta;
    const newTotalConversions = currentState.total_conversions + conversionDelta;
    const newCAC = newTotalSpend / newTotalConversions;

    const cacChange = ((newCAC - currentState.blended_cac_cents) / currentState.blended_cac_cents) * 100;
    const conversionChange = ((newTotalConversions - currentState.total_conversions) / currentState.total_conversions) * 100;
    const spendChange = ((newTotalSpend - currentState.total_spend_cents) / currentState.total_spend_cents) * 100;

    return {
      success: true,
      current_state: currentState,
      simulated_state: {
        total_spend_cents: Math.round(newTotalSpend),
        total_conversions: Math.round(newTotalConversions * 10) / 10,
        blended_cac_cents: Math.round(newCAC),
        cac_change_percent: Math.round(cacChange * 10) / 10,
        conversion_change_percent: Math.round(conversionChange * 10) / 10,
        spend_change_percent: Math.round(spendChange * 10) / 10
      },
      confidence: 'low', // Audience changes are inherently uncertain
      assumptions: [
        `Audience ${type}: ${estimated_reach_change_percent >= 0 ? '+' : ''}${estimated_reach_change_percent}% reach change`,
        `Impression multiplier: ${impressionMultiplier.toFixed(2)}x`,
        `CTR multiplier: ${ctrMultiplier.toFixed(2)}x`,
        `CPC multiplier: ${cpcMultiplier.toFixed(2)}x`,
        'Conversion rate per click assumed constant',
        '⚠ Audience impact is difficult to predict - test with small budget first'
      ],
      math_explanation: `
AUDIENCE CHANGE SIMULATION: ${target.name}
════════════════════════════════════════════════════════════════

CHANGE TYPE: ${type.toUpperCase()} (${estimated_reach_change_percent >= 0 ? '+' : ''}${estimated_reach_change_percent}% reach)

CURRENT METRICS:
  Impressions:  ${target.impressions.toLocaleString()}
  CTR:          ${(target.ctr * 100).toFixed(2)}%
  Clicks:       ${target.clicks.toLocaleString()}
  CPC:          $${(target.cpc_cents / 100).toFixed(2)}
  Spend:        $${(target.spend_cents / 100).toFixed(2)}
  Conversions:  ${target.conversions}

PROJECTED METRICS:
  Impressions:  ${target.impressions.toLocaleString()} × ${impressionMultiplier.toFixed(2)} = ${Math.round(newImpressions).toLocaleString()}
  CTR:          ${(target.ctr * 100).toFixed(2)}% × ${ctrMultiplier.toFixed(2)} = ${(newCTR * 100).toFixed(2)}%
  Clicks:       ${Math.round(newClicks).toLocaleString()}
  CPC:          $${(target.cpc_cents / 100).toFixed(2)} × ${cpcMultiplier.toFixed(2)} = $${(newCPC / 100).toFixed(2)}
  Spend:        $${(newSpend / 100).toFixed(2)}
  Conversions:  ${newConversions.toFixed(1)}

RESULT:
  CAC Change: ${cacChange >= 0 ? '+' : ''}${cacChange.toFixed(1)}%
  ⚠ LOW CONFIDENCE - Audience changes are unpredictable. Consider A/B testing.
`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BID CHANGE SIMULATION
  // ═══════════════════════════════════════════════════════════════════════

  private simulateBidChange(
    currentState: PortfolioState,
    target: EntityMetrics,
    allEntities: EntityMetrics[],
    bidChange?: { current_bid_cents?: number; new_bid_cents?: number; strategy_change?: string }
  ): SimulationResult {
    if (!bidChange || (!bidChange.new_bid_cents && !bidChange.strategy_change)) {
      return {
        success: false,
        current_state: currentState,
        simulated_state: this.emptySimulatedState(),
        confidence: 'low',
        assumptions: ['bid_change parameters required'],
        math_explanation: 'Cannot simulate bid change without new_bid_cents or strategy_change.'
      };
    }

    // Bid changes affect auction win rate and average position
    // Higher bid = more impressions, higher costs
    // Model based on auction dynamics

    let winRateMultiplier: number;
    let cpcMultiplier: number;

    if (bidChange.new_bid_cents && bidChange.current_bid_cents) {
      const bidChangePercent = ((bidChange.new_bid_cents - bidChange.current_bid_cents) / bidChange.current_bid_cents) * 100;

      // Win rate follows diminishing returns on bid increases
      // +20% bid ≈ +15% win rate (not linear)
      winRateMultiplier = Math.pow(1 + bidChangePercent / 100, 0.75);

      // CPC increases but not proportionally due to second-price auction dynamics
      // +20% bid cap might only increase CPC by 10%
      cpcMultiplier = Math.pow(1 + bidChangePercent / 100, 0.5);
    } else if (bidChange.strategy_change) {
      // Strategy changes have predefined impacts
      switch (bidChange.strategy_change) {
        case 'maximize_conversions':
          winRateMultiplier = 1.15;
          cpcMultiplier = 1.2;
          break;
        case 'target_cpa':
          winRateMultiplier = 0.9;
          cpcMultiplier = 0.85;
          break;
        case 'maximize_clicks':
          winRateMultiplier = 1.1;
          cpcMultiplier = 0.95;
          break;
        default:
          winRateMultiplier = 1;
          cpcMultiplier = 1;
      }
    } else {
      winRateMultiplier = 1;
      cpcMultiplier = 1;
    }

    // Calculate new metrics
    const newImpressions = target.impressions * winRateMultiplier;
    const newClicks = target.clicks * winRateMultiplier; // Assuming CTR stays same
    const newCPC = target.cpc_cents * cpcMultiplier;
    const newSpend = newClicks * newCPC;

    // Conversion rate stays same
    const conversionRate = target.conversions / target.clicks;
    const newConversions = newClicks * conversionRate;

    // Portfolio impact
    const spendDelta = newSpend - target.spend_cents;
    const conversionDelta = newConversions - target.conversions;

    const newTotalSpend = currentState.total_spend_cents + spendDelta;
    const newTotalConversions = currentState.total_conversions + conversionDelta;
    const newCAC = newTotalSpend / newTotalConversions;

    const cacChange = ((newCAC - currentState.blended_cac_cents) / currentState.blended_cac_cents) * 100;
    const conversionChange = ((newTotalConversions - currentState.total_conversions) / currentState.total_conversions) * 100;
    const spendChange = ((newTotalSpend - currentState.total_spend_cents) / currentState.total_spend_cents) * 100;

    return {
      success: true,
      current_state: currentState,
      simulated_state: {
        total_spend_cents: Math.round(newTotalSpend),
        total_conversions: Math.round(newTotalConversions * 10) / 10,
        blended_cac_cents: Math.round(newCAC),
        cac_change_percent: Math.round(cacChange * 10) / 10,
        conversion_change_percent: Math.round(conversionChange * 10) / 10,
        spend_change_percent: Math.round(spendChange * 10) / 10
      },
      // Bid simulation uses hardcoded auction-dynamics exponents (0.75, 0.5) that are
      // reasonable second-price auction approximations but are NOT fitted to this org's
      // data. The win-rate elasticity and CPC elasticity vary wildly by vertical,
      // competition density, and platform. This is a heuristic, not a regression.
      confidence: 'low',
      assumptions: [
        bidChange.strategy_change
          ? `Strategy change to: ${bidChange.strategy_change}`
          : `Bid change: $${((bidChange.current_bid_cents || 0) / 100).toFixed(2)} → $${((bidChange.new_bid_cents || 0) / 100).toFixed(2)}`,
        `Win rate multiplier: ${winRateMultiplier.toFixed(2)}x`,
        `CPC multiplier: ${cpcMultiplier.toFixed(2)}x`,
        'Based on second-price auction dynamics',
        'Assumes competitive landscape remains stable'
      ],
      math_explanation: `
BID CHANGE SIMULATION: ${target.name}
════════════════════════════════════════════════════════════════

CHANGE: ${bidChange.strategy_change || `$${((bidChange.current_bid_cents || 0) / 100).toFixed(2)} → $${((bidChange.new_bid_cents || 0) / 100).toFixed(2)}`}

AUCTION DYNAMICS MODEL:
  Win Rate Multiplier: ${winRateMultiplier.toFixed(2)}x
  CPC Multiplier:      ${cpcMultiplier.toFixed(2)}x

CURRENT → PROJECTED:
  Impressions: ${target.impressions.toLocaleString()} → ${Math.round(newImpressions).toLocaleString()}
  Clicks:      ${target.clicks.toLocaleString()} → ${Math.round(newClicks).toLocaleString()}
  CPC:         $${(target.cpc_cents / 100).toFixed(2)} → $${(newCPC / 100).toFixed(2)}
  Spend:       $${(target.spend_cents / 100).toFixed(2)} → $${(newSpend / 100).toFixed(2)}
  Conversions: ${target.conversions} → ${newConversions.toFixed(1)}

RESULT:
  CAC Change: ${cacChange >= 0 ? '+' : ''}${cacChange.toFixed(1)}%
`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCHEDULE CHANGE SIMULATION
  // ═══════════════════════════════════════════════════════════════════════

  private async simulateScheduleChange(
    currentState: PortfolioState,
    target: EntityMetrics,
    allEntities: EntityMetrics[],
    scheduleChange: { hours_to_add?: number[]; hours_to_remove?: number[] } | undefined,
    entityType: EntityLevel
  ): Promise<SimulationResult> {
    if (!scheduleChange || (!scheduleChange.hours_to_add?.length && !scheduleChange.hours_to_remove?.length)) {
      return {
        success: false,
        current_state: currentState,
        simulated_state: this.emptySimulatedState(),
        confidence: 'low',
        assumptions: ['schedule_change parameters required'],
        math_explanation: 'Cannot simulate schedule change without hours_to_add or hours_to_remove.'
      };
    }

    // For schedule simulation, we need hourly data
    // If not available, use industry benchmarks for hour performance
    const hourlyHistory = await this.getHourlyHistory(target.id, 30, entityType);

    let hourlyPerformance: Map<number, { spend: number; conversions: number }>;

    if (hourlyHistory.length >= 168) { // At least a week of hourly data
      // Build hourly performance from real data
      hourlyPerformance = new Map();
      for (const h of hourlyHistory) {
        const existing = hourlyPerformance.get(h.hour!) || { spend: 0, conversions: 0 };
        hourlyPerformance.set(h.hour!, {
          spend: existing.spend + h.spend_cents,
          conversions: existing.conversions + h.conversions
        });
      }
    } else {
      // Use industry benchmarks (B2C typical patterns)
      hourlyPerformance = this.getIndustryHourlyBenchmarks(target.spend_cents, target.conversions);
    }

    // Calculate current active hours total
    let currentSpend = 0;
    let currentConversions = 0;
    hourlyPerformance.forEach((v) => {
      currentSpend += v.spend;
      currentConversions += v.conversions;
    });

    // Calculate changes
    let removedSpend = 0;
    let removedConversions = 0;
    for (const hour of (scheduleChange.hours_to_remove || [])) {
      const hourData = hourlyPerformance.get(hour);
      if (hourData) {
        removedSpend += hourData.spend;
        removedConversions += hourData.conversions;
      }
    }

    let addedSpend = 0;
    let addedConversions = 0;
    for (const hour of (scheduleChange.hours_to_add || [])) {
      // Estimate based on average hourly performance
      const avgHourlySpend = currentSpend / 24;
      const avgHourlyConv = currentConversions / 24;
      addedSpend += avgHourlySpend;
      addedConversions += avgHourlyConv;
    }

    const newEntitySpend = target.spend_cents - removedSpend + addedSpend;
    const newEntityConversions = target.conversions - removedConversions + addedConversions;

    // Portfolio impact
    const spendDelta = newEntitySpend - target.spend_cents;
    const conversionDelta = newEntityConversions - target.conversions;

    const newTotalSpend = currentState.total_spend_cents + spendDelta;
    const newTotalConversions = currentState.total_conversions + conversionDelta;
    const newCAC = newTotalSpend / newTotalConversions;

    const cacChange = ((newCAC - currentState.blended_cac_cents) / currentState.blended_cac_cents) * 100;
    const conversionChange = ((newTotalConversions - currentState.total_conversions) / currentState.total_conversions) * 100;
    const spendChange = ((newTotalSpend - currentState.total_spend_cents) / currentState.total_spend_cents) * 100;

    const confidence = hourlyHistory.length >= 168 ? 'medium' : 'low';

    return {
      success: true,
      current_state: currentState,
      simulated_state: {
        total_spend_cents: Math.round(newTotalSpend),
        total_conversions: Math.round(newTotalConversions * 10) / 10,
        blended_cac_cents: Math.round(newCAC),
        cac_change_percent: Math.round(cacChange * 10) / 10,
        conversion_change_percent: Math.round(conversionChange * 10) / 10,
        spend_change_percent: Math.round(spendChange * 10) / 10
      },
      confidence,
      assumptions: [
        scheduleChange.hours_to_remove?.length
          ? `Removing hours: ${scheduleChange.hours_to_remove.join(', ')}`
          : '',
        scheduleChange.hours_to_add?.length
          ? `Adding hours: ${scheduleChange.hours_to_add.join(', ')}`
          : '',
        hourlyHistory.length >= 168
          ? `Based on ${hourlyHistory.length} hours of real data`
          : 'Using industry benchmark hourly patterns (limited historical data)',
        'Assumes user behavior patterns remain consistent'
      ].filter(Boolean),
      math_explanation: `
SCHEDULE CHANGE SIMULATION: ${target.name}
════════════════════════════════════════════════════════════════

CHANGES:
  Hours to remove: ${scheduleChange.hours_to_remove?.join(', ') || 'none'}
  Hours to add:    ${scheduleChange.hours_to_add?.join(', ') || 'none'}

IMPACT FROM REMOVED HOURS:
  Spend saved:       $${(removedSpend / 100).toFixed(2)}
  Conversions lost:  ${removedConversions.toFixed(1)}

IMPACT FROM ADDED HOURS:
  Spend added:       $${(addedSpend / 100).toFixed(2)}
  Conversions added: ${addedConversions.toFixed(1)}

NET CHANGE:
  Entity Spend:       $${(target.spend_cents / 100).toFixed(2)} → $${(newEntitySpend / 100).toFixed(2)}
  Entity Conversions: ${target.conversions} → ${newEntityConversions.toFixed(1)}

RESULT:
  CAC Change: ${cacChange >= 0 ? '+' : ''}${cacChange.toFixed(1)}%
  ${confidence === 'low' ? '⚠ LOW CONFIDENCE - Using industry benchmarks due to limited hourly data' : ''}
`
    };
  }

  private getIndustryHourlyBenchmarks(totalSpend: number, totalConversions: number): Map<number, { spend: number; conversions: number }> {
    // B2C industry typical hourly distribution (% of daily)
    const hourlyDistribution: Record<number, number> = {
      0: 2, 1: 1.5, 2: 1, 3: 0.8, 4: 0.8, 5: 1.5,
      6: 3, 7: 4.5, 8: 5.5, 9: 6, 10: 6.5, 11: 6.5,
      12: 6, 13: 5.5, 14: 5.5, 15: 5.5, 16: 5.5, 17: 6,
      18: 6.5, 19: 7, 20: 7, 21: 6, 22: 4.5, 23: 3
    };

    const result = new Map<number, { spend: number; conversions: number }>();
    for (let hour = 0; hour < 24; hour++) {
      const pct = hourlyDistribution[hour] / 100;
      result.set(hour, {
        spend: totalSpend * pct,
        conversions: totalConversions * pct
      });
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DIMINISHING RETURNS MODEL
  // ═══════════════════════════════════════════════════════════════════════

  private predictConversionsAtSpend(
    target: EntityMetrics,
    newSpend: number,
    history: HistoricalDataPoint[]
  ): { predictedConversions: number; model: any; confidence: 'high' | 'medium' | 'low' } {
    // Attempt a proper power-law fit: conv = k · spend^α via OLS in log-space.
    // Requires ≥14 days of (spend > 0, conv > 0) data for a meaningful regression.
    if (history.length >= 14) {
      const model = this.fitPowerLaw(history);

      if (model.r_squared > 0.6) {
        // Good fit. Confidence thresholds:
        //   R² > 0.8  → 'high'  — model explains >80% of log-variance
        //   R² > 0.6  → 'medium' — decent signal, some noise
        const predicted = model.k * Math.pow(newSpend, model.alpha);

        // Extrapolation penalty: if the proposed spend is outside the observed
        // range, the power-law is extrapolating rather than interpolating.
        // Extrapolation beyond ±50% of observed [min, max] drops confidence one tier.
        const spendValues = history.filter(d => d.spend_cents > 0).map(d => d.spend_cents);
        const minObserved = Math.min(...spendValues);
        const maxObserved = Math.max(...spendValues);
        const range = maxObserved - minObserved;
        const isExtrapolating = newSpend < minObserved - range * 0.5
          || newSpend > maxObserved + range * 0.5;

        let confidence: 'high' | 'medium' | 'low';
        if (isExtrapolating) {
          // Extrapolation: cap at 'medium' regardless of R²
          confidence = model.r_squared > 0.8 ? 'medium' : 'low';
        } else {
          confidence = model.r_squared > 0.8 ? 'high' : 'medium';
        }

        return {
          predictedConversions: predicted,
          model: { ...model, data_points: history.length, extrapolating: isExtrapolating },
          confidence
        };
      }
    }

    // Fallback: single-point calibration with industry-standard α = 0.7.
    //
    // This model has ZERO degrees of freedom — k is solved from the single
    // equation k = conv_current / spend_current^α, so it reproduces today's
    // data point exactly and tells us nothing about how conversions respond
    // to DIFFERENT spend levels. The α = 0.7 is a prior, not evidence.
    //
    // Confidence is ALWAYS 'low'. Having 7 or 30 days of history doesn't help
    // when the power-law fit failed (R² < 0.6 or < 14 valid days) — the data
    // is too noisy or too flat for the model to extract a spend→conversion
    // relationship. Promoting to 'medium' here was a lie.
    const alpha = 0.7;
    const k = target.conversions / Math.pow(target.spend_cents, alpha);
    const predicted = k * Math.pow(newSpend, alpha);

    return {
      predictedConversions: predicted,
      model: {
        k,
        alpha,
        r_squared: 0,
        data_points: history.length
      },
      confidence: 'low'
    };
  }

  private fitPowerLaw(history: HistoricalDataPoint[]): { k: number; alpha: number; r_squared: number } {
    // Power law model:  conv = k · spend^α
    // In log-space:     ln(conv) = ln(k) + α · ln(spend)
    // This is ordinary least squares on (ln(spend), ln(conv)).

    const valid = history.filter(d => d.conversions > 0 && d.spend_cents > 0);

    if (valid.length < 7) {
      return { k: 0, alpha: 0.7, r_squared: 0 };
    }

    const logSpend = valid.map(d => Math.log(d.spend_cents));
    const logConv = valid.map(d => Math.log(d.conversions));
    const n = valid.length;

    // OLS for ln(conv) = β₀ + β₁ · ln(spend)
    //   β₁ = (n·Σxy − Σx·Σy) / (n·Σx² − (Σx)²)
    //   β₀ = ȳ − β₁·x̄
    const sumX = logSpend.reduce((a, b) => a + b, 0);
    const sumY = logConv.reduce((a, b) => a + b, 0);
    const sumXY = logSpend.reduce((acc, x, i) => acc + x * logConv[i], 0);
    const sumX2 = logSpend.reduce((acc, x) => acc + x * x, 0);

    const denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 1e-12) {
      // Degenerate case: all spend values identical → no slope estimable
      return { k: 0, alpha: 0.7, r_squared: 0 };
    }

    const rawAlpha = (n * sumXY - sumX * sumY) / denom;

    // Clamp α ∈ [0.3, 1.0].
    //   α < 0.3 implies pathological super-diminishing returns (likely noise).
    //   α > 1.0 implies increasing returns to scale (violates the model assumption).
    const alpha = Math.max(0.3, Math.min(1.0, rawAlpha));

    // Refit intercept for the clamped α via least-squares on the constrained model:
    //   ln(conv) = ln(k) + α_clamped · ln(spend)
    //   ln(k) = ȳ − α_clamped · x̄
    // This minimises Σ(yᵢ − ln(k) − α · xᵢ)² w.r.t. ln(k) given fixed α.
    const meanX = sumX / n;
    const meanY = sumY / n;
    const logK = meanY - alpha * meanX;
    const k = Math.exp(logK);

    // Recompute R² for the CLAMPED model, not the unclamped one.
    // R² = 1 − SS_res / SS_tot, where residuals use the clamped (α, ln(k)).
    const ssTotal = logConv.reduce((acc, y) => acc + (y - meanY) ** 2, 0);
    const ssResidual = logConv.reduce((acc, y, i) => {
      const predicted = logK + alpha * logSpend[i];
      return acc + (y - predicted) ** 2;
    }, 0);
    const r_squared = ssTotal > 0 ? Math.max(0, 1 - ssResidual / ssTotal) : 0;

    return { k, alpha, r_squared };
  }

  private buildBudgetAssumptions(model: any, dataPoints: number, changePercent: number): string[] {
    const assumptions: string[] = [];

    if (model.r_squared > 0.6) {
      assumptions.push(`Diminishing returns: conv = ${model.k.toFixed(4)} × spend^${model.alpha.toFixed(2)}`);
      assumptions.push(`Model fit: R² = ${(model.r_squared * 100).toFixed(0)}% (${model.data_points || dataPoints} days of valid data)`);
      if (model.extrapolating) {
        assumptions.push('⚠ Proposed spend is outside observed historical range — extrapolating beyond training data');
      }
    } else {
      assumptions.push(`Single-point calibration with assumed α = ${model.alpha} (industry prior, not fitted)`);
      assumptions.push(`Power-law regression failed or insufficient data (${dataPoints} days) — 0 degrees of freedom`);
    }

    if (Math.abs(changePercent) > 50) {
      assumptions.push('⚠ Large budget change (>50%) — diminishing returns curve is steeper far from current spend');
    }

    assumptions.push('Assumes stable market conditions and constant competitive landscape');
    assumptions.push('Does not account for creative fatigue, seasonality, or auction-level variance');

    return assumptions;
  }

  private buildBudgetMathExplanation(
    current: PortfolioState,
    target: EntityMetrics,
    changePercent: number,
    newEntitySpend: number,
    predictedConversions: number,
    model: any,
    newTotalSpend: number,
    newTotalConversions: number,
    newCAC: number,
    cacChange: number,
    newEntityCAC: number,
    entityCACChange: number
  ): string {
    const direction = changePercent > 0 ? 'INCREASE' : 'DECREASE';

    return `
BUDGET ${direction} SIMULATION: ${target.name}
════════════════════════════════════════════════════════════════

DIMINISHING RETURNS MODEL:
  ${model.r_squared > 0.6
    ? `Fitted: conv = ${model.k.toFixed(4)} × spend^${model.alpha.toFixed(2)} (R²=${(model.r_squared * 100).toFixed(0)}%)`
    : `Default: conv = k × spend^${model.alpha.toFixed(2)} (industry standard)`
  }

  Key insight: α = ${model.alpha.toFixed(2)} means:
    • +10% spend → +${((Math.pow(1.1, model.alpha) - 1) * 100).toFixed(1)}% conversions
    • +50% spend → +${((Math.pow(1.5, model.alpha) - 1) * 100).toFixed(1)}% conversions

CURRENT:
  Spend:       $${(target.spend_cents / 100).toFixed(2)}/day
  Conversions: ${target.conversions}/day
  CAC:         $${(target.spend_cents / target.conversions / 100).toFixed(2)}

PROPOSED: ${changePercent >= 0 ? '+' : ''}${changePercent}% budget

PROJECTION:
  New Spend:       $${(newEntitySpend / 100).toFixed(2)}/day
  New Conversions: ${predictedConversions.toFixed(1)}/day
  New CAC:         $${(newEntityCAC / 100).toFixed(2)}

PORTFOLIO IMPACT:
  Total Spend:       $${(current.total_spend_cents / 100).toFixed(2)} → $${(newTotalSpend / 100).toFixed(2)}
  Total Conversions: ${current.total_conversions} → ${newTotalConversions.toFixed(1)}
  Blended CAC:       $${(current.blended_cac_cents / 100).toFixed(2)} → $${(newCAC / 100).toFixed(2)}

RESULT:
  CAC Change: ${cacChange >= 0 ? '+' : ''}${cacChange.toFixed(1)}%
  ${cacChange < 0 ? '✓ CAC IMPROVEMENT' : cacChange > 10 ? '⚠ SIGNIFICANT CAC INCREASE' : '⚠ SLIGHT CAC INCREASE'}
`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DATA FETCHING - Platform-Specific Tables
  // ═══════════════════════════════════════════════════════════════════════

  private async getPortfolioMetrics(entityType: EntityLevel, days: number = 30): Promise<EntityMetrics[]> {
    // Map entity level to unified ad_metrics entity_type
    const entityTypeMap: Record<EntityLevel, string> = {
      campaign: 'campaign',
      ad_set: 'ad_group',    // Facebook ad_sets are unified as ad_groups
      ad_group: 'ad_group',
      ad: 'ad'
    };

    const unifiedEntityType = entityTypeMap[entityType] || 'campaign';

    // Entity-type-aware JOIN for human-readable names
    // entity_ref stores the internal UUID (ad_campaigns.id), not the platform ID (campaign_id)
    const nameJoinMap: Record<string, { table: string; joinCol: string; nameCol: string }> = {
      campaign: { table: 'ad_campaigns', joinCol: 'id', nameCol: 'campaign_name' },
      ad_group: { table: 'ad_groups', joinCol: 'id', nameCol: 'ad_group_name' },
      ad: { table: 'ads', joinCol: 'id', nameCol: 'ad_name' },
    };
    const nameJoin = nameJoinMap[unifiedEntityType] || nameJoinMap.campaign;

    // Query 1: Active entities with recent spend (parameterized days)
    const activeQuery = `
      SELECT
        m.entity_ref as id,
        COALESCE(n.${nameJoin.nameCol}, m.entity_ref) as name,
        m.platform,
        ? as entity_type,
        SUM(m.spend_cents) as spend_cents,
        SUM(m.conversions) as conversions,
        SUM(m.impressions) as impressions,
        SUM(m.clicks) as clicks,
        CASE WHEN SUM(m.impressions) > 0 THEN CAST(SUM(m.clicks) AS REAL) / SUM(m.impressions) ELSE 0 END as ctr,
        CASE WHEN SUM(m.clicks) > 0 THEN SUM(m.spend_cents) / SUM(m.clicks) ELSE 0 END as cpc_cents
      FROM ad_metrics m
      LEFT JOIN ${nameJoin.table} n
        ON n.${nameJoin.joinCol} = m.entity_ref AND n.organization_id = m.organization_id
      WHERE m.organization_id = ?
        AND m.entity_type = ?
        AND m.metric_date >= date('now', '-' || ? || ' days')
        AND m.spend_cents > 0
      GROUP BY m.entity_ref, m.platform
    `;

    // Query 2: Paused/inactive entities — had spend in last days*3 but NOT in last `days`
    // These are candidates for enable recommendations
    const pausedQuery = `
      SELECT
        m.entity_ref as id,
        COALESCE(n.${nameJoin.nameCol}, m.entity_ref) as name,
        m.platform,
        ? as entity_type,
        SUM(m.spend_cents) as spend_cents,
        SUM(m.conversions) as conversions,
        SUM(m.impressions) as impressions,
        SUM(m.clicks) as clicks,
        CASE WHEN SUM(m.impressions) > 0 THEN CAST(SUM(m.clicks) AS REAL) / SUM(m.impressions) ELSE 0 END as ctr,
        CASE WHEN SUM(m.clicks) > 0 THEN SUM(m.spend_cents) / SUM(m.clicks) ELSE 0 END as cpc_cents
      FROM ad_metrics m
      LEFT JOIN ${nameJoin.table} n
        ON n.${nameJoin.joinCol} = m.entity_ref AND n.organization_id = m.organization_id
      WHERE m.organization_id = ?
        AND m.entity_type = ?
        AND m.metric_date >= date('now', '-' || ? || ' days')
        AND m.metric_date < date('now', '-' || ? || ' days')
        AND m.spend_cents > 0
        AND m.entity_ref NOT IN (
          SELECT DISTINCT entity_ref FROM ad_metrics
          WHERE organization_id = ?
            AND entity_type = ?
            AND metric_date >= date('now', '-' || ? || ' days')
            AND spend_cents > 0
        )
      GROUP BY m.entity_ref, m.platform
    `;

    const pausedLookbackDays = days * 3; // Look back 3x the active window for paused entities

    try {
      const [activeResult, pausedResult] = await this.analyticsDb.batch([
        this.analyticsDb.prepare(activeQuery).bind(entityType, this.orgId, unifiedEntityType, days),
        this.analyticsDb.prepare(pausedQuery).bind(entityType, this.orgId, unifiedEntityType, pausedLookbackDays, days, this.orgId, unifiedEntityType, days)
      ]);

      const activeEntities = (activeResult.results || []) as EntityMetrics[];
      const pausedEntities = (pausedResult.results || []) as EntityMetrics[];

      return [...activeEntities, ...pausedEntities];
    } catch (err) {
      structuredLog('ERROR', 'Error fetching portfolio metrics', { service: 'simulation', org_id: this.orgId, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  private async getEntityHistory(entityId: string, days: number, entityType: EntityLevel): Promise<HistoricalDataPoint[]> {
    // Map entity level to unified ad_metrics entity_type
    const entityTypeMap: Record<EntityLevel, string> = {
      campaign: 'campaign',
      ad_set: 'ad_group',    // Facebook ad_sets are unified as ad_groups
      ad_group: 'ad_group',
      ad: 'ad'
    };

    const unifiedEntityType = entityTypeMap[entityType] || 'campaign';

    // Query unified ad_metrics table for entity history
    // No spend_cents > 0 filter — include $0 days to show paused periods
    const query = `
      SELECT metric_date as date, spend_cents, conversions
      FROM ad_metrics
      WHERE organization_id = ?
        AND entity_ref = ?
        AND entity_type = ?
        AND metric_date >= date('now', '-' || ? || ' days')
      ORDER BY date ASC
    `;

    try {
      const result = await this.analyticsDb.prepare(query)
        .bind(this.orgId, entityId, unifiedEntityType, days)
        .all();
      return (result.results || []) as HistoricalDataPoint[];
    } catch (err) {
      structuredLog('ERROR', 'Error fetching entity history', { service: 'simulation', org_id: this.orgId, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  private async getHourlyHistory(entityId: string, days: number, entityType: EntityLevel): Promise<HistoricalDataPoint[]> {
    // Note: Hourly data may not be available in all tables
    // Return empty for now - schedule simulation will use industry benchmarks
    return [];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  private buildCurrentState(entities: EntityMetrics[], target: EntityMetrics | null): PortfolioState {
    const totalSpend = entities.reduce((s, e) => s + e.spend_cents, 0);
    const totalConversions = entities.reduce((s, e) => s + e.conversions, 0);
    const blendedCAC = totalConversions > 0 ? totalSpend / totalConversions : 0;

    let entityState: EntityState;
    if (target && target.conversions > 0) {
      const entityCAC = target.spend_cents / target.conversions;
      entityState = {
        id: target.id,
        name: target.name,
        platform: target.platform,
        spend_cents: target.spend_cents,
        conversions: target.conversions,
        cac_cents: Math.round(entityCAC),
        efficiency_vs_average: blendedCAC > 0 ? ((blendedCAC / entityCAC) - 1) * 100 : 0
      };
    } else {
      entityState = {
        id: target?.id || '',
        name: target?.name || 'Unknown',
        platform: target?.platform || '',
        spend_cents: target?.spend_cents || 0,
        conversions: target?.conversions || 0,
        cac_cents: 0,
        efficiency_vs_average: 0
      };
    }

    return {
      total_spend_cents: totalSpend,
      total_conversions: totalConversions,
      blended_cac_cents: Math.round(blendedCAC),
      entity: entityState
    };
  }

  private emptyState(): PortfolioState {
    return {
      total_spend_cents: 0,
      total_conversions: 0,
      blended_cac_cents: 0,
      entity: {
        id: '',
        name: 'Unknown',
        platform: '',
        spend_cents: 0,
        conversions: 0,
        cac_cents: 0,
        efficiency_vs_average: 0
      }
    };
  }

  private emptySimulatedState(): SimulatedState {
    return {
      total_spend_cents: 0,
      total_conversions: 0,
      blended_cac_cents: 0,
      cac_change_percent: 0,
      conversion_change_percent: 0,
      spend_change_percent: 0
    };
  }
}
