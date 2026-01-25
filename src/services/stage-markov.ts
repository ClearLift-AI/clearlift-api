/**
 * Stage Markov Analysis Service
 *
 * Calculates "removal effects" for funnel stages using Markov chain analysis.
 * Adapts the existing channel-level Markov logic to work with goal/stage data
 * from the funnel_transitions table (computed by aggregation workflow).
 *
 * The removal effect answers: "If users skip this stage, how much do conversions drop?"
 * This identifies critical stages in the funnel that significantly impact conversion rates.
 *
 * Uses existing infrastructure:
 * - funnel_transitions table (migration 0013) - stage-to-stage transition rates
 * - goal_completion_metrics table - daily completions with by_channel JSON
 * - conversion_goals table - stage definitions with position_row
 */

/**
 * Stage removal effect result
 */
export interface StageRemovalEffect {
  stage_id: string;
  stage_name: string;
  position_row: number;
  removal_effect: number;  // 0-1: fraction of conversions lost if stage is removed
  is_critical: boolean;    // true if removal_effect > threshold (default 0.3)
  baseline_conversion_rate: number;
  conversion_rate_without: number;
}

/**
 * Stage Markov analysis result
 */
export interface StageMarkovResult {
  stages: StageRemovalEffect[];
  baseline_conversion_rate: number;
  most_critical_stage_id: string | null;
  most_critical_removal_effect: number;
  analysis_quality: 'high' | 'medium' | 'low';  // Based on sample size
  sample_size: number;
}

/**
 * Internal transition data
 */
interface TransitionData {
  from_id: string;
  from_name: string;
  to_id: string;
  to_name: string;
  visitors_at_from: number;
  visitors_transitioned: number;
  transition_rate: number;
  conversion_rate: number;
}

/**
 * Internal stage data
 */
interface StageData {
  id: string;
  name: string;
  position_row: number;
  is_conversion: boolean;
  visitors: number;
}

import { CacheService } from './cache';

/**
 * Stage Markov Service
 *
 * Computes removal effects using a simplified Markov chain approach:
 * 1. Build transition probabilities from funnel_transitions table
 * 2. Calculate baseline conversion rate (start → conversion absorption probability)
 * 3. For each stage, remove it and recalculate conversion probability
 * 4. Removal effect = (baseline - without) / baseline
 *
 * Supports optional KV caching to avoid repeated Monte Carlo simulations.
 */
export class StageMarkovService {
  private analyticsDb: D1Database;
  private mainDb: D1Database;
  private cache: CacheService | null;

  constructor(analyticsDb: D1Database, mainDb: D1Database, kv?: KVNamespace) {
    this.analyticsDb = analyticsDb;
    this.mainDb = mainDb;
    this.cache = kv ? new CacheService(kv) : null;
  }

  /**
   * Calculate removal effects for all stages in a funnel
   * Results are cached for 5 minutes to avoid repeated Monte Carlo simulations.
   */
  async calculateRemovalEffects(
    orgId: string,
    orgTag: string,
    startDate: string,
    endDate: string,
    criticalThreshold: number = 0.3
  ): Promise<StageMarkovResult> {
    console.log(`[StageMarkov] Calculating removal effects for org=${orgId}, ${startDate} to ${endDate}`);

    // Check cache first
    if (this.cache) {
      const cacheKey = CacheService.stageMarkovKey(orgId, startDate, endDate);
      const cached = await this.cache.get<StageMarkovResult>(cacheKey);
      if (cached) {
        console.log(`[StageMarkov] Cache hit for ${cacheKey}`);
        return cached;
      }
    }

    // 1. Get funnel stages ordered by position
    const stages = await this.getStages(orgId);
    if (stages.length === 0) {
      return this.emptyResult();
    }

    // 2. Get transition data from funnel_transitions table
    const transitions = await this.getTransitions(orgTag, startDate, endDate);
    if (transitions.length === 0) {
      console.log(`[StageMarkov] No transition data found, using fallback calculation`);
      // Fallback: estimate from stage visitors
      return this.calculateFromVisitors(stages, criticalThreshold);
    }

    // 3. Build transition matrix
    const { matrix, stateIndex, states } = this.buildTransitionMatrix(stages, transitions);

    // 4. Calculate baseline conversion probability
    const startIdx = stateIndex.get('start')!;
    const conversionIdx = stateIndex.get('conversion')!;
    const nullIdx = stateIndex.get('null')!;

    const baselineConversionRate = this.calculateAbsorptionProbability(
      matrix, startIdx, conversionIdx, nullIdx
    );

    console.log(`[StageMarkov] Baseline conversion rate: ${(baselineConversionRate * 100).toFixed(1)}%`);

    // 5. Calculate removal effect for each stage
    const stageEffects: StageRemovalEffect[] = [];
    let mostCriticalId: string | null = null;
    let maxRemovalEffect = 0;

    for (const stage of stages) {
      if (stage.is_conversion) continue; // Don't calculate removal effect for conversion stage itself

      const stageIdx = stateIndex.get(stage.id);
      if (stageIdx === undefined) continue;

      // Create modified matrix with stage removed
      const modifiedMatrix = this.removeStageFromMatrix(matrix, stageIdx, nullIdx);

      // Calculate conversion probability without this stage
      const conversionRateWithout = this.calculateAbsorptionProbability(
        modifiedMatrix, startIdx, conversionIdx, nullIdx
      );

      // Removal effect = relative drop in conversion rate
      const removalEffect = baselineConversionRate > 0
        ? Math.max(0, (baselineConversionRate - conversionRateWithout) / baselineConversionRate)
        : 0;

      const isCritical = removalEffect > criticalThreshold;

      stageEffects.push({
        stage_id: stage.id,
        stage_name: stage.name,
        position_row: stage.position_row,
        removal_effect: Math.round(removalEffect * 1000) / 1000,
        is_critical: isCritical,
        baseline_conversion_rate: baselineConversionRate,
        conversion_rate_without: conversionRateWithout,
      });

      if (removalEffect > maxRemovalEffect) {
        maxRemovalEffect = removalEffect;
        mostCriticalId = stage.id;
      }
    }

    // Sort by removal effect descending
    stageEffects.sort((a, b) => b.removal_effect - a.removal_effect);

    // Assess analysis quality based on sample size
    const totalVisitors = transitions.reduce((sum, t) => sum + t.visitors_at_from, 0);
    const analysisQuality: 'high' | 'medium' | 'low' =
      totalVisitors >= 1000 ? 'high' :
      totalVisitors >= 100 ? 'medium' : 'low';

    const result: StageMarkovResult = {
      stages: stageEffects,
      baseline_conversion_rate: baselineConversionRate,
      most_critical_stage_id: mostCriticalId,
      most_critical_removal_effect: maxRemovalEffect,
      analysis_quality: analysisQuality,
      sample_size: totalVisitors,
    };

    // Cache the result for 5 minutes
    if (this.cache) {
      const cacheKey = CacheService.stageMarkovKey(orgId, startDate, endDate);
      this.cache.set(cacheKey, result, 300).catch(err => {
        console.error(`[StageMarkov] Failed to cache result:`, err);
      });
      console.log(`[StageMarkov] Cached result to ${cacheKey}`);
    }

    return result;
  }

  /**
   * Get stage removal effects as a Map for easy lookup
   */
  async getRemovalEffectsMap(
    orgId: string,
    orgTag: string,
    startDate: string,
    endDate: string
  ): Promise<Map<string, number>> {
    const result = await this.calculateRemovalEffects(orgId, orgTag, startDate, endDate);
    const map = new Map<string, number>();
    for (const stage of result.stages) {
      map.set(stage.stage_id, stage.removal_effect);
    }
    return map;
  }

  /**
   * Get stages from conversion_goals table
   */
  private async getStages(orgId: string): Promise<StageData[]> {
    const result = await this.mainDb.prepare(`
      SELECT
        id,
        name,
        COALESCE(position_row, priority, 0) as position_row,
        is_conversion,
        type
      FROM conversion_goals
      WHERE organization_id = ? AND is_active = 1
      ORDER BY position_row ASC
    `).bind(orgId).all<{
      id: string;
      name: string;
      position_row: number;
      is_conversion: number | null;
      type: string;
    }>();

    return (result.results || []).map(row => ({
      id: row.id,
      name: row.name,
      position_row: row.position_row,
      is_conversion: Boolean(row.is_conversion) || row.type === 'conversion',
      visitors: 0, // Will be populated from transitions
    }));
  }

  /**
   * Get transition data from funnel_transitions table
   */
  private async getTransitions(
    orgTag: string,
    startDate: string,
    endDate: string
  ): Promise<TransitionData[]> {
    try {
      const result = await this.analyticsDb.prepare(`
        SELECT
          from_id,
          from_name,
          to_id,
          to_name,
          visitors_at_from,
          visitors_transitioned,
          transition_rate,
          conversion_rate
        FROM funnel_transitions
        WHERE org_tag = ?
          AND period_start >= ?
          AND period_end <= ?
          AND from_type = 'goal'
          AND to_type = 'goal'
        ORDER BY period_start DESC
      `).bind(orgTag, startDate, endDate).all<{
        from_id: string;
        from_name: string;
        to_id: string;
        to_name: string;
        visitors_at_from: number;
        visitors_transitioned: number;
        transition_rate: number;
        conversion_rate: number;
      }>();

      return result.results || [];
    } catch (err) {
      console.warn('[StageMarkov] Failed to get transitions:', err);
      return [];
    }
  }

  /**
   * Build transition matrix from stage and transition data
   *
   * States: ['start', ...stage_ids, 'conversion', 'null']
   * Matrix[i][j] = probability of transitioning from state i to state j
   */
  private buildTransitionMatrix(
    stages: StageData[],
    transitions: TransitionData[]
  ): {
    matrix: number[][];
    stateIndex: Map<string, number>;
    states: string[];
  } {
    // Build state list: start, stages, conversion, null
    const states = ['start', ...stages.map(s => s.id), 'conversion', 'null'];
    const stateIndex = new Map<string, number>();
    states.forEach((s, i) => stateIndex.set(s, i));
    const n = states.length;

    // Initialize matrix with zeros
    const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));

    // Build transition lookup
    const transitionMap = new Map<string, TransitionData>();
    for (const t of transitions) {
      transitionMap.set(`${t.from_id}->${t.to_id}`, t);
    }

    // Find the first stage (entry point) - lowest position_row
    const sortedStages = [...stages].sort((a, b) => a.position_row - b.position_row);
    const entryStage = sortedStages[0];
    const conversionStages = stages.filter(s => s.is_conversion);

    // Start -> entry stage (100% probability)
    if (entryStage) {
      const entryIdx = stateIndex.get(entryStage.id)!;
      matrix[stateIndex.get('start')!][entryIdx] = 1.0;
    }

    // Stage -> stage transitions from funnel_transitions data
    for (const t of transitions) {
      const fromIdx = stateIndex.get(t.from_id);
      const toIdx = stateIndex.get(t.to_id);
      if (fromIdx !== undefined && toIdx !== undefined) {
        matrix[fromIdx][toIdx] = t.transition_rate;
      }
    }

    // For each stage, calculate dropoff (transition to null)
    for (const stage of stages) {
      const stageIdx = stateIndex.get(stage.id)!;

      // Sum of outgoing transitions
      let outgoingSum = 0;
      for (let j = 0; j < n; j++) {
        outgoingSum += matrix[stageIdx][j];
      }

      // If conversion stage, any remaining probability goes to 'conversion'
      if (stage.is_conversion) {
        const remaining = Math.max(0, 1 - outgoingSum);
        matrix[stageIdx][stateIndex.get('conversion')!] += remaining;
      } else {
        // Dropoff goes to 'null'
        const dropoff = Math.max(0, 1 - outgoingSum);
        matrix[stageIdx][stateIndex.get('null')!] = dropoff;
      }
    }

    // Absorbing states (conversion, null) stay in place
    matrix[stateIndex.get('conversion')!][stateIndex.get('conversion')!] = 1.0;
    matrix[stateIndex.get('null')!][stateIndex.get('null')!] = 1.0;

    return { matrix, stateIndex, states };
  }

  /**
   * Calculate absorption probability using Monte Carlo simulation
   *
   * Simulates random walks from start state to find the probability
   * of ending in the conversion state vs null state.
   */
  private calculateAbsorptionProbability(
    matrix: number[][],
    startIndex: number,
    conversionIndex: number,
    nullIndex: number,
    simulations: number = 10000,
    maxIterations: number = 100
  ): number {
    let conversionCount = 0;

    for (let sim = 0; sim < simulations; sim++) {
      let currentState = startIndex;
      let iterations = 0;

      while (iterations < maxIterations) {
        // Check if absorbed
        if (currentState === conversionIndex) {
          conversionCount++;
          break;
        }
        if (currentState === nullIndex) {
          break;
        }

        // Transition to next state based on probabilities
        const rand = Math.random();
        let cumProb = 0;
        let nextState = currentState;

        for (let j = 0; j < matrix.length; j++) {
          cumProb += matrix[currentState][j];
          if (rand < cumProb) {
            nextState = j;
            break;
          }
        }

        // Prevent infinite loops on zero-probability rows
        if (nextState === currentState && matrix[currentState].every(p => p === 0)) {
          break;
        }

        currentState = nextState;
        iterations++;
      }
    }

    return conversionCount / simulations;
  }

  /**
   * Create a modified matrix with a stage removed
   *
   * When a stage is removed:
   * - All incoming transitions to that stage go directly to null
   * - The stage's outgoing transitions are redirected to null
   */
  private removeStageFromMatrix(
    originalMatrix: number[][],
    stageIndex: number,
    nullIndex: number
  ): number[][] {
    const n = originalMatrix.length;
    const modified = originalMatrix.map(row => [...row]);

    // Redirect all transitions TO this stage to null
    for (let i = 0; i < n; i++) {
      if (i === stageIndex) continue;
      const probToStage = modified[i][stageIndex];
      if (probToStage > 0) {
        modified[i][stageIndex] = 0;
        modified[i][nullIndex] += probToStage;
      }
    }

    // Redirect all transitions FROM this stage to null
    for (let j = 0; j < n; j++) {
      modified[stageIndex][j] = 0;
    }
    modified[stageIndex][nullIndex] = 1;

    return modified;
  }

  /**
   * Fallback calculation when no funnel_transitions data exists
   *
   * Uses visitor counts at each stage to estimate removal effects
   * based on funnel position. Less accurate but provides baseline.
   */
  private async calculateFromVisitors(
    stages: StageData[],
    criticalThreshold: number
  ): Promise<StageMarkovResult> {
    // Sort by position_row
    const sorted = [...stages].sort((a, b) => a.position_row - b.position_row);

    // Simple heuristic: earlier stages have higher removal effects
    // because removing them removes all downstream visitors
    const totalStages = sorted.length;
    const effects: StageRemovalEffect[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const stage = sorted[i];
      if (stage.is_conversion) continue;

      // Simple position-based estimate
      // Early stages have higher impact: effect = (remaining stages) / total
      const remainingStages = totalStages - i - 1;
      const estimatedEffect = totalStages > 1
        ? (remainingStages / (totalStages - 1)) * 0.5  // Cap at 50%
        : 0;

      effects.push({
        stage_id: stage.id,
        stage_name: stage.name,
        position_row: stage.position_row,
        removal_effect: estimatedEffect,
        is_critical: estimatedEffect > criticalThreshold,
        baseline_conversion_rate: 0.05, // Placeholder
        conversion_rate_without: 0.05 * (1 - estimatedEffect),
      });
    }

    effects.sort((a, b) => b.removal_effect - a.removal_effect);
    const mostCritical = effects[0];

    return {
      stages: effects,
      baseline_conversion_rate: 0.05,
      most_critical_stage_id: mostCritical?.stage_id || null,
      most_critical_removal_effect: mostCritical?.removal_effect || 0,
      analysis_quality: 'low',
      sample_size: 0,
    };
  }

  /**
   * Return empty result when no stages exist
   */
  private emptyResult(): StageMarkovResult {
    return {
      stages: [],
      baseline_conversion_rate: 0,
      most_critical_stage_id: null,
      most_critical_removal_effect: 0,
      analysis_quality: 'low',
      sample_size: 0,
    };
  }
}
