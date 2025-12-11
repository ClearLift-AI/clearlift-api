/**
 * Multi-Touch Attribution Models
 *
 * Pure functions for calculating attribution credit across touchpoints.
 * Each model distributes conversion value differently across the customer journey.
 */

export interface Touchpoint {
  id: string;
  session_id: string;
  anonymous_id?: string;
  timestamp: Date;
  utm_source: string;
  utm_medium: string | null;
  utm_campaign: string | null;
  event_type: string;
  page_url?: string;
}

export interface AttributedTouchpoint extends Touchpoint {
  credit: number;          // Fractional credit (0-1 or absolute value)
  credit_percentage: number; // Percentage of total (0-100)
}

export interface ConversionPath {
  conversion_id: string;
  user_id?: string;
  anonymous_ids: string[];
  touchpoints: Touchpoint[];
  conversion_timestamp: Date;
  conversion_value: number;
  conversion_type: string;
}

export interface AttributionResult {
  conversion_id: string;
  model: AttributionModel;
  touchpoints: AttributedTouchpoint[];
  conversion_value: number;
  path_length: number;
  days_to_convert: number;
}

export type AttributionModel =
  | 'first_touch'
  | 'last_touch'
  | 'linear'
  | 'time_decay'
  | 'position_based'
  | 'data_driven'
  | 'markov_chain'
  | 'shapley_value';

export interface AttributionConfig {
  model: AttributionModel;
  attribution_window_days: number;
  time_decay_half_life_days: number;
  position_based_weights?: {
    first: number;   // Default 0.4
    last: number;    // Default 0.4
    middle: number;  // Default 0.2
  };
  // Pre-computed probabilistic model results (required for markov_chain/shapley_value)
  markovCredits?: MarkovAttributionResult[];
  shapleyCredits?: ShapleyAttributionResult[];
}

// ===== Attribution Model Functions =====

/**
 * First-Touch Attribution
 * 100% credit to the first touchpoint in the conversion path
 */
export function firstTouchAttribution(
  touchpoints: Touchpoint[],
  conversionValue: number
): AttributedTouchpoint[] {
  if (touchpoints.length === 0) return [];

  const sorted = [...touchpoints].sort((a, b) =>
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  return sorted.map((tp, i) => ({
    ...tp,
    credit: i === 0 ? conversionValue : 0,
    credit_percentage: i === 0 ? 100 : 0
  }));
}

/**
 * Last-Touch Attribution
 * 100% credit to the last touchpoint before conversion
 */
export function lastTouchAttribution(
  touchpoints: Touchpoint[],
  conversionValue: number
): AttributedTouchpoint[] {
  if (touchpoints.length === 0) return [];

  const sorted = [...touchpoints].sort((a, b) =>
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  return sorted.map((tp, i) => ({
    ...tp,
    credit: i === sorted.length - 1 ? conversionValue : 0,
    credit_percentage: i === sorted.length - 1 ? 100 : 0
  }));
}

/**
 * Linear Attribution
 * Equal credit to all touchpoints
 */
export function linearAttribution(
  touchpoints: Touchpoint[],
  conversionValue: number
): AttributedTouchpoint[] {
  if (touchpoints.length === 0) return [];

  const creditPerTouch = conversionValue / touchpoints.length;
  const percentagePerTouch = 100 / touchpoints.length;

  const sorted = [...touchpoints].sort((a, b) =>
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  return sorted.map(tp => ({
    ...tp,
    credit: creditPerTouch,
    credit_percentage: percentagePerTouch
  }));
}

/**
 * Time-Decay Attribution
 * More credit to touchpoints closer to conversion.
 * Uses exponential decay with configurable half-life.
 *
 * @param halfLifeDays - Days for weight to decay by 50% (default: 7)
 */
export function timeDecayAttribution(
  touchpoints: Touchpoint[],
  conversionValue: number,
  conversionTimestamp: Date,
  halfLifeDays: number = 7
): AttributedTouchpoint[] {
  if (touchpoints.length === 0) return [];

  const sorted = [...touchpoints].sort((a, b) =>
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  // Calculate raw weights using exponential decay
  const weights = sorted.map(tp => {
    const daysBeforeConversion =
      (conversionTimestamp.getTime() - tp.timestamp.getTime()) / (1000 * 60 * 60 * 24);
    // Weight = 2^(-days/halfLife)
    // At halfLife days, weight = 0.5
    // At 0 days (conversion time), weight = 1
    return Math.pow(2, -daysBeforeConversion / halfLifeDays);
  });

  // Normalize weights to sum to 1
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const normalizedWeights = weights.map(w => w / totalWeight);

  return sorted.map((tp, i) => ({
    ...tp,
    credit: normalizedWeights[i] * conversionValue,
    credit_percentage: normalizedWeights[i] * 100
  }));
}

/**
 * Position-Based (U-Shape) Attribution
 * Configurable weights for first, last, and middle touchpoints.
 * Default: 40% first, 40% last, 20% split among middle
 */
export function positionBasedAttribution(
  touchpoints: Touchpoint[],
  conversionValue: number,
  weights: { first: number; last: number; middle: number } = { first: 0.4, last: 0.4, middle: 0.2 }
): AttributedTouchpoint[] {
  if (touchpoints.length === 0) return [];

  const sorted = [...touchpoints].sort((a, b) =>
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  // Single touchpoint gets all credit
  if (sorted.length === 1) {
    return [{
      ...sorted[0],
      credit: conversionValue,
      credit_percentage: 100
    }];
  }

  // Two touchpoints: split between first and last
  if (sorted.length === 2) {
    const firstWeight = weights.first / (weights.first + weights.last);
    const lastWeight = weights.last / (weights.first + weights.last);
    return [
      { ...sorted[0], credit: firstWeight * conversionValue, credit_percentage: firstWeight * 100 },
      { ...sorted[1], credit: lastWeight * conversionValue, credit_percentage: lastWeight * 100 }
    ];
  }

  // Three or more: first, last, and distribute middle
  const firstCredit = weights.first * conversionValue;
  const lastCredit = weights.last * conversionValue;
  const middleCredit = weights.middle * conversionValue;
  const middleCount = sorted.length - 2;
  const perMiddle = middleCredit / middleCount;

  return sorted.map((tp, i) => {
    if (i === 0) {
      return { ...tp, credit: firstCredit, credit_percentage: weights.first * 100 };
    }
    if (i === sorted.length - 1) {
      return { ...tp, credit: lastCredit, credit_percentage: weights.last * 100 };
    }
    return { ...tp, credit: perMiddle, credit_percentage: (weights.middle / middleCount) * 100 };
  });
}

/**
 * Data-Driven Attribution (Simplified)
 *
 * Uses conversion rate lift analysis. For each channel:
 * - Calculate conversion rate WITH the channel in path
 * - Calculate conversion rate WITHOUT the channel in path
 * - Credit proportional to the lift
 *
 * Note: This is a simplified version. Full data-driven (Shapley/Markov)
 * requires significant historical data and is compute-intensive.
 */
export function dataDrivenAttribution(
  conversionPaths: ConversionPath[],
  nonConversionPaths: ConversionPath[]
): Map<string, number> {
  // Build channel presence data
  const channelStats = new Map<string, {
    conversions_with: number;
    conversions_without: number;
    total_with: number;
    total_without: number;
  }>();

  // Get all unique channels
  const allChannels = new Set<string>();
  [...conversionPaths, ...nonConversionPaths].forEach(path => {
    path.touchpoints.forEach(tp => {
      allChannels.add(tp.utm_source);
    });
  });

  // Initialize stats
  allChannels.forEach(channel => {
    channelStats.set(channel, {
      conversions_with: 0,
      conversions_without: 0,
      total_with: 0,
      total_without: 0
    });
  });

  // Count conversions with/without each channel
  allChannels.forEach(channel => {
    const stats = channelStats.get(channel)!;

    conversionPaths.forEach(path => {
      const hasChannel = path.touchpoints.some(tp => tp.utm_source === channel);
      if (hasChannel) {
        stats.conversions_with++;
        stats.total_with++;
      } else {
        stats.conversions_without++;
        stats.total_without++;
      }
    });

    nonConversionPaths.forEach(path => {
      const hasChannel = path.touchpoints.some(tp => tp.utm_source === channel);
      if (hasChannel) {
        stats.total_with++;
      } else {
        stats.total_without++;
      }
    });
  });

  // Calculate lift-based weights
  const weights = new Map<string, number>();
  let totalLift = 0;

  allChannels.forEach(channel => {
    const stats = channelStats.get(channel)!;
    const crWith = stats.total_with > 0 ? stats.conversions_with / stats.total_with : 0;
    const crWithout = stats.total_without > 0 ? stats.conversions_without / stats.total_without : 0;

    // Lift = (CR with channel) / (CR without channel) - 1
    // Clamp to prevent negative or infinite values
    const lift = crWithout > 0 ? Math.max(0, (crWith / crWithout) - 1) : crWith > 0 ? 1 : 0;
    weights.set(channel, lift);
    totalLift += lift;
  });

  // Normalize weights
  if (totalLift > 0) {
    weights.forEach((lift, channel) => {
      weights.set(channel, lift / totalLift);
    });
  }

  return weights;
}

// ===== Markov Chain Attribution =====

/**
 * Markov Transition Matrix
 * Represents probabilities of moving from one channel to another
 */
export interface MarkovTransitionMatrix {
  states: string[];  // Channel names + 'start', 'conversion', 'null'
  matrix: number[][]; // Transition probabilities
  baselineConversionRate: number;
}

/**
 * Markov Attribution Result
 */
export interface MarkovAttributionResult {
  channel: string;
  removal_effect: number;  // 0-1: How much conversion rate drops when removed
  attributed_credit: number; // Normalized credit (sums to 1 across channels)
}

/**
 * Build Markov Transition Matrix from conversion paths
 *
 * Creates a first-order Markov chain where:
 * - States = channels + 'start', 'conversion', 'null'
 * - Transitions = probability of moving from one channel to another
 *
 * @param conversionPaths Paths that led to conversions
 * @param nonConversionPaths Paths that did not convert (ended in 'null')
 */
export function buildMarkovTransitionMatrix(
  conversionPaths: ConversionPath[],
  nonConversionPaths: ConversionPath[]
): MarkovTransitionMatrix {
  // Collect all unique channels
  const channels = new Set<string>();
  [...conversionPaths, ...nonConversionPaths].forEach(path => {
    path.touchpoints.forEach(tp => {
      channels.add(tp.utm_source);
    });
  });

  // States: 'start' + all channels + 'conversion' + 'null'
  const states = ['start', ...Array.from(channels).sort(), 'conversion', 'null'];
  const stateIndex = new Map(states.map((s, i) => [s, i]));
  const n = states.length;

  // Initialize transition counts
  const transitionCounts: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));

  // Count transitions from conversion paths
  for (const path of conversionPaths) {
    if (path.touchpoints.length === 0) continue;

    // Sort touchpoints by time
    const sorted = [...path.touchpoints].sort((a, b) =>
      a.timestamp.getTime() - b.timestamp.getTime()
    );

    // Start -> first channel
    const firstIdx = stateIndex.get(sorted[0].utm_source)!;
    transitionCounts[stateIndex.get('start')!][firstIdx]++;

    // Channel -> channel transitions
    for (let i = 0; i < sorted.length - 1; i++) {
      const fromIdx = stateIndex.get(sorted[i].utm_source)!;
      const toIdx = stateIndex.get(sorted[i + 1].utm_source)!;
      transitionCounts[fromIdx][toIdx]++;
    }

    // Last channel -> conversion
    const lastIdx = stateIndex.get(sorted[sorted.length - 1].utm_source)!;
    transitionCounts[lastIdx][stateIndex.get('conversion')!]++;
  }

  // Count transitions from non-conversion paths
  for (const path of nonConversionPaths) {
    if (path.touchpoints.length === 0) continue;

    const sorted = [...path.touchpoints].sort((a, b) =>
      a.timestamp.getTime() - b.timestamp.getTime()
    );

    // Start -> first channel
    const firstIdx = stateIndex.get(sorted[0].utm_source)!;
    transitionCounts[stateIndex.get('start')!][firstIdx]++;

    // Channel -> channel transitions
    for (let i = 0; i < sorted.length - 1; i++) {
      const fromIdx = stateIndex.get(sorted[i].utm_source)!;
      const toIdx = stateIndex.get(sorted[i + 1].utm_source)!;
      transitionCounts[fromIdx][toIdx]++;
    }

    // Last channel -> null (no conversion)
    const lastIdx = stateIndex.get(sorted[sorted.length - 1].utm_source)!;
    transitionCounts[lastIdx][stateIndex.get('null')!]++;
  }

  // Convert counts to probabilities (row-normalize)
  const matrix: number[][] = transitionCounts.map(row => {
    const rowSum = row.reduce((a, b) => a + b, 0);
    if (rowSum === 0) return row.map(() => 0);
    return row.map(count => count / rowSum);
  });

  // Calculate baseline conversion rate
  const totalPaths = conversionPaths.length + nonConversionPaths.length;
  const baselineConversionRate = totalPaths > 0 ? conversionPaths.length / totalPaths : 0;

  return { states, matrix, baselineConversionRate };
}

/**
 * Calculate conversion probability using absorbing Markov chain
 * Uses matrix inversion to find absorption probabilities
 *
 * @param matrix Transition matrix
 * @param startIndex Starting state index
 * @param conversionIndex Conversion state index
 * @param maxIterations Max iterations for power method (default: 1000)
 */
function calculateAbsorptionProbability(
  matrix: number[][],
  startIndex: number,
  conversionIndex: number,
  nullIndex: number,
  maxIterations: number = 1000
): number {
  const n = matrix.length;

  // Use simulation approach: start at 'start', random walk until absorption
  // More stable than matrix inversion for sparse matrices
  let conversionCount = 0;
  const simulations = 10000;

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

      for (let j = 0; j < n; j++) {
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
 * Calculate Markov Chain Removal Effect Attribution
 *
 * For each channel, calculates the "removal effect":
 * How much does the overall conversion rate drop if we remove this channel?
 *
 * Credit is proportional to the removal effect.
 *
 * @param conversionPaths Paths that converted
 * @param nonConversionPaths Paths that didn't convert
 */
export function calculateMarkovRemovalEffect(
  conversionPaths: ConversionPath[],
  nonConversionPaths: ConversionPath[]
): MarkovAttributionResult[] {
  // Build the full transition matrix
  const { states, matrix, baselineConversionRate } = buildMarkovTransitionMatrix(
    conversionPaths,
    nonConversionPaths
  );

  const startIndex = states.indexOf('start');
  const conversionIndex = states.indexOf('conversion');
  const nullIndex = states.indexOf('null');

  // Get channels (exclude start, conversion, null)
  const channels = states.filter(s => !['start', 'conversion', 'null'].includes(s));

  if (channels.length === 0) {
    return [];
  }

  // Calculate baseline conversion probability from the Markov chain
  const baselineProb = calculateAbsorptionProbability(
    matrix, startIndex, conversionIndex, nullIndex
  );

  // Calculate removal effect for each channel
  const results: MarkovAttributionResult[] = [];

  for (const channel of channels) {
    const channelIndex = states.indexOf(channel);

    // Create modified matrix with channel removed
    // Redirect all transitions TO this channel to 'null' instead
    const modifiedMatrix = matrix.map((row, i) => {
      if (i === channelIndex) {
        // Row for removed channel: redirect all outgoing to null
        const newRow = Array(states.length).fill(0);
        newRow[nullIndex] = 1;
        return newRow;
      }
      // Redistribute transitions that went to this channel
      const newRow = [...row];
      const probToChannel = newRow[channelIndex];
      if (probToChannel > 0) {
        newRow[channelIndex] = 0;
        // Add to null (user would have dropped off)
        newRow[nullIndex] += probToChannel;
      }
      return newRow;
    });

    // Calculate conversion probability without this channel
    const probWithoutChannel = calculateAbsorptionProbability(
      modifiedMatrix, startIndex, conversionIndex, nullIndex
    );

    // Removal effect = (baseline - without) / baseline
    // Represents what fraction of conversions are lost when this channel is removed
    const removalEffect = baselineProb > 0
      ? Math.max(0, (baselineProb - probWithoutChannel) / baselineProb)
      : 0;

    results.push({
      channel,
      removal_effect: removalEffect,
      attributed_credit: removalEffect // Will normalize later
    });
  }

  // Normalize credits to sum to 1
  const totalEffect = results.reduce((sum, r) => sum + r.removal_effect, 0);
  if (totalEffect > 0) {
    results.forEach(r => {
      r.attributed_credit = r.removal_effect / totalEffect;
    });
  }

  return results.sort((a, b) => b.attributed_credit - a.attributed_credit);
}

/**
 * Apply Markov attribution credits to a single conversion path
 */
export function markovChainAttribution(
  touchpoints: Touchpoint[],
  conversionValue: number,
  markovCredits: MarkovAttributionResult[]
): AttributedTouchpoint[] {
  if (touchpoints.length === 0) return [];

  // Build credit lookup
  const creditByChannel = new Map(markovCredits.map(r => [r.channel, r.attributed_credit]));

  // Get channels in this path
  const pathChannels = new Set(touchpoints.map(tp => tp.utm_source));

  // Filter to channels that appear in this path
  const relevantCredits = markovCredits.filter(r => pathChannels.has(r.channel));

  // Normalize credits for this specific path
  const pathTotalCredit = relevantCredits.reduce((sum, r) => sum + r.attributed_credit, 0);

  const sorted = [...touchpoints].sort((a, b) =>
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  return sorted.map(tp => {
    const globalCredit = creditByChannel.get(tp.utm_source) || 0;
    const normalizedCredit = pathTotalCredit > 0 ? globalCredit / pathTotalCredit : 1 / touchpoints.length;

    return {
      ...tp,
      credit: normalizedCredit * conversionValue,
      credit_percentage: normalizedCredit * 100
    };
  });
}

// ===== Shapley Value Attribution =====

/**
 * Shapley Value Attribution Result
 */
export interface ShapleyAttributionResult {
  channel: string;
  shapley_value: number; // The fair value contribution
  attributed_credit: number; // Normalized to sum to 1
}

/**
 * Calculate subset conversion rate
 * Returns the conversion rate when only the given channels are considered
 */
function calculateSubsetConversionRate(
  conversionPaths: ConversionPath[],
  nonConversionPaths: ConversionPath[],
  channelSubset: Set<string>
): number {
  if (channelSubset.size === 0) return 0;

  // Count paths that contain at least one channel from subset
  let pathsWithSubset = 0;
  let conversionsWithSubset = 0;

  for (const path of conversionPaths) {
    const hasSubsetChannel = path.touchpoints.some(tp => channelSubset.has(tp.utm_source));
    if (hasSubsetChannel) {
      pathsWithSubset++;
      conversionsWithSubset++;
    }
  }

  for (const path of nonConversionPaths) {
    const hasSubsetChannel = path.touchpoints.some(tp => channelSubset.has(tp.utm_source));
    if (hasSubsetChannel) {
      pathsWithSubset++;
    }
  }

  return pathsWithSubset > 0 ? conversionsWithSubset / pathsWithSubset : 0;
}

/**
 * Calculate factorial
 */
function factorial(n: number): number {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
}

/**
 * Generate all subsets of a set
 */
function* generateSubsets<T>(set: T[]): Generator<T[]> {
  const n = set.length;
  const total = Math.pow(2, n);
  for (let mask = 0; mask < total; mask++) {
    const subset: T[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        subset.push(set[i]);
      }
    }
    yield subset;
  }
}

/**
 * Calculate Shapley Value Attribution
 *
 * Shapley value represents the "fair" contribution of each channel,
 * accounting for all possible orderings and coalition formations.
 *
 * Formula: φᵢ = Σ (|S|! × (n-|S|-1)!) / n! × [v(S ∪ {i}) - v(S)]
 *
 * Where:
 * - S is a subset of channels not including i
 * - v(S) is the value (conversion rate) achieved by coalition S
 * - n is the total number of channels
 *
 * @param conversionPaths Paths that converted
 * @param nonConversionPaths Paths that didn't convert
 * @param maxChannels Max channels to consider (Shapley is O(2^n), limit for performance)
 */
export function calculateShapleyAttribution(
  conversionPaths: ConversionPath[],
  nonConversionPaths: ConversionPath[],
  maxChannels: number = 10
): ShapleyAttributionResult[] {
  // Collect all unique channels
  const channelSet = new Set<string>();
  [...conversionPaths, ...nonConversionPaths].forEach(path => {
    path.touchpoints.forEach(tp => {
      channelSet.add(tp.utm_source);
    });
  });

  let channels = Array.from(channelSet);

  // Limit channels for performance (Shapley is exponential)
  if (channels.length > maxChannels) {
    // Keep top channels by frequency
    const channelCounts = new Map<string, number>();
    [...conversionPaths, ...nonConversionPaths].forEach(path => {
      path.touchpoints.forEach(tp => {
        channelCounts.set(tp.utm_source, (channelCounts.get(tp.utm_source) || 0) + 1);
      });
    });
    channels = channels
      .sort((a, b) => (channelCounts.get(b) || 0) - (channelCounts.get(a) || 0))
      .slice(0, maxChannels);
  }

  const n = channels.length;
  if (n === 0) return [];

  const nFactorial = factorial(n);
  const results: ShapleyAttributionResult[] = [];

  // Calculate Shapley value for each channel
  for (const channel of channels) {
    let shapleyValue = 0;

    // Other channels (excluding current one)
    const otherChannels = channels.filter(c => c !== channel);

    // Iterate over all subsets of other channels
    for (const subset of generateSubsets(otherChannels)) {
      const s = subset.length; // |S|

      // Weight for this subset: |S|! × (n-|S|-1)! / n!
      const weight = (factorial(s) * factorial(n - s - 1)) / nFactorial;

      // v(S ∪ {i}) - v(S): marginal contribution of channel i to coalition S
      const withoutChannel = new Set(subset);
      const withChannel = new Set([...subset, channel]);

      const valueWithout = calculateSubsetConversionRate(
        conversionPaths, nonConversionPaths, withoutChannel
      );
      const valueWith = calculateSubsetConversionRate(
        conversionPaths, nonConversionPaths, withChannel
      );

      const marginalContribution = valueWith - valueWithout;

      shapleyValue += weight * marginalContribution;
    }

    results.push({
      channel,
      shapley_value: Math.max(0, shapleyValue), // Clamp negative values
      attributed_credit: shapleyValue
    });
  }

  // Normalize credits to sum to 1
  const totalValue = results.reduce((sum, r) => sum + Math.max(0, r.shapley_value), 0);
  if (totalValue > 0) {
    results.forEach(r => {
      r.attributed_credit = Math.max(0, r.shapley_value) / totalValue;
    });
  } else {
    // Equal distribution if no positive values
    results.forEach(r => {
      r.attributed_credit = 1 / results.length;
    });
  }

  return results.sort((a, b) => b.attributed_credit - a.attributed_credit);
}

/**
 * Approximate Shapley Values using sampling (for large channel counts)
 *
 * Monte Carlo sampling approach - randomly sample permutations
 * and calculate marginal contributions.
 *
 * @param conversionPaths Paths that converted
 * @param nonConversionPaths Paths that didn't convert
 * @param sampleSize Number of random permutations to sample
 */
export function approximateShapleyAttribution(
  conversionPaths: ConversionPath[],
  nonConversionPaths: ConversionPath[],
  sampleSize: number = 1000
): ShapleyAttributionResult[] {
  // Collect all unique channels
  const channelSet = new Set<string>();
  [...conversionPaths, ...nonConversionPaths].forEach(path => {
    path.touchpoints.forEach(tp => {
      channelSet.add(tp.utm_source);
    });
  });

  const channels = Array.from(channelSet);
  const n = channels.length;
  if (n === 0) return [];

  // Track marginal contributions
  const marginalSums = new Map<string, number>();
  const marginalCounts = new Map<string, number>();
  channels.forEach(c => {
    marginalSums.set(c, 0);
    marginalCounts.set(c, 0);
  });

  // Sample random permutations
  for (let sample = 0; sample < sampleSize; sample++) {
    // Fisher-Yates shuffle
    const permutation = [...channels];
    for (let i = permutation.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
    }

    // Calculate marginal contribution for each channel in this ordering
    const coalition = new Set<string>();
    let prevValue = 0;

    for (const channel of permutation) {
      coalition.add(channel);
      const currentValue = calculateSubsetConversionRate(
        conversionPaths, nonConversionPaths, coalition
      );
      const marginal = currentValue - prevValue;

      marginalSums.set(channel, marginalSums.get(channel)! + marginal);
      marginalCounts.set(channel, marginalCounts.get(channel)! + 1);

      prevValue = currentValue;
    }
  }

  // Average marginal contributions = Shapley values
  const results: ShapleyAttributionResult[] = channels.map(channel => {
    const count = marginalCounts.get(channel) || 1;
    const shapleyValue = (marginalSums.get(channel) || 0) / count;
    return {
      channel,
      shapley_value: Math.max(0, shapleyValue),
      attributed_credit: shapleyValue
    };
  });

  // Normalize
  const totalValue = results.reduce((sum, r) => sum + Math.max(0, r.shapley_value), 0);
  if (totalValue > 0) {
    results.forEach(r => {
      r.attributed_credit = Math.max(0, r.shapley_value) / totalValue;
    });
  } else {
    results.forEach(r => {
      r.attributed_credit = 1 / results.length;
    });
  }

  return results.sort((a, b) => b.attributed_credit - a.attributed_credit);
}

/**
 * Apply Shapley attribution credits to a single conversion path
 */
export function shapleyValueAttribution(
  touchpoints: Touchpoint[],
  conversionValue: number,
  shapleyCredits: ShapleyAttributionResult[]
): AttributedTouchpoint[] {
  if (touchpoints.length === 0) return [];

  // Build credit lookup
  const creditByChannel = new Map(shapleyCredits.map(r => [r.channel, r.attributed_credit]));

  // Get channels in this path
  const pathChannels = new Set(touchpoints.map(tp => tp.utm_source));

  // Filter to channels that appear in this path
  const relevantCredits = shapleyCredits.filter(r => pathChannels.has(r.channel));

  // Normalize credits for this specific path
  const pathTotalCredit = relevantCredits.reduce((sum, r) => sum + r.attributed_credit, 0);

  const sorted = [...touchpoints].sort((a, b) =>
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  return sorted.map(tp => {
    const globalCredit = creditByChannel.get(tp.utm_source) || 0;
    const normalizedCredit = pathTotalCredit > 0 ? globalCredit / pathTotalCredit : 1 / touchpoints.length;

    return {
      ...tp,
      credit: normalizedCredit * conversionValue,
      credit_percentage: normalizedCredit * 100
    };
  });
}

// ===== Main Attribution Function =====

/**
 * Calculate attribution for a conversion path using specified model
 */
export function calculateAttribution(
  path: ConversionPath,
  config: AttributionConfig
): AttributionResult {
  const { model, time_decay_half_life_days } = config;

  let attributedTouchpoints: AttributedTouchpoint[];

  switch (model) {
    case 'first_touch':
      attributedTouchpoints = firstTouchAttribution(path.touchpoints, path.conversion_value);
      break;
    case 'last_touch':
      attributedTouchpoints = lastTouchAttribution(path.touchpoints, path.conversion_value);
      break;
    case 'linear':
      attributedTouchpoints = linearAttribution(path.touchpoints, path.conversion_value);
      break;
    case 'time_decay':
      attributedTouchpoints = timeDecayAttribution(
        path.touchpoints,
        path.conversion_value,
        path.conversion_timestamp,
        time_decay_half_life_days
      );
      break;
    case 'position_based':
      attributedTouchpoints = positionBasedAttribution(
        path.touchpoints,
        path.conversion_value,
        config.position_based_weights
      );
      break;
    case 'data_driven':
      // Data-driven requires aggregate analysis, use linear as fallback for single path
      attributedTouchpoints = linearAttribution(path.touchpoints, path.conversion_value);
      break;
    case 'markov_chain':
      // Requires pre-computed markov credits
      if (config.markovCredits && config.markovCredits.length > 0) {
        attributedTouchpoints = markovChainAttribution(
          path.touchpoints,
          path.conversion_value,
          config.markovCredits
        );
      } else {
        // Fallback to linear if no markov credits provided
        attributedTouchpoints = linearAttribution(path.touchpoints, path.conversion_value);
      }
      break;
    case 'shapley_value':
      // Requires pre-computed shapley credits
      if (config.shapleyCredits && config.shapleyCredits.length > 0) {
        attributedTouchpoints = shapleyValueAttribution(
          path.touchpoints,
          path.conversion_value,
          config.shapleyCredits
        );
      } else {
        // Fallback to linear if no shapley credits provided
        attributedTouchpoints = linearAttribution(path.touchpoints, path.conversion_value);
      }
      break;
    default:
      attributedTouchpoints = lastTouchAttribution(path.touchpoints, path.conversion_value);
  }

  // Calculate days to convert
  const firstTouch = path.touchpoints.length > 0
    ? Math.min(...path.touchpoints.map(tp => tp.timestamp.getTime()))
    : path.conversion_timestamp.getTime();
  const daysToConvert =
    (path.conversion_timestamp.getTime() - firstTouch) / (1000 * 60 * 60 * 24);

  return {
    conversion_id: path.conversion_id,
    model,
    touchpoints: attributedTouchpoints,
    conversion_value: path.conversion_value,
    path_length: path.touchpoints.length,
    days_to_convert: Math.max(0, daysToConvert)
  };
}

// ===== Aggregation Helpers =====

export interface AggregatedAttribution {
  utm_source: string;
  utm_medium: string | null;
  utm_campaign: string | null;
  touchpoints: number;
  conversions_in_path: number;
  attributed_conversions: number;
  attributed_revenue: number;
  avg_position_in_path: number;
}

/**
 * Aggregate attribution results by channel (source/medium/campaign)
 */
export function aggregateAttributionByChannel(
  results: AttributionResult[]
): AggregatedAttribution[] {
  const channelMap = new Map<string, {
    utm_source: string;
    utm_medium: string | null;
    utm_campaign: string | null;
    touchpoints: number;
    conversions_in_path: Set<string>;
    attributed_conversions: number;
    attributed_revenue: number;
    positions: number[];
  }>();

  results.forEach(result => {
    result.touchpoints.forEach((tp, index) => {
      const key = `${tp.utm_source}|${tp.utm_medium || ''}|${tp.utm_campaign || ''}`;

      if (!channelMap.has(key)) {
        channelMap.set(key, {
          utm_source: tp.utm_source,
          utm_medium: tp.utm_medium,
          utm_campaign: tp.utm_campaign,
          touchpoints: 0,
          conversions_in_path: new Set(),
          attributed_conversions: 0,
          attributed_revenue: 0,
          positions: []
        });
      }

      const channel = channelMap.get(key)!;
      channel.touchpoints++;
      channel.conversions_in_path.add(result.conversion_id);
      channel.attributed_conversions += tp.credit_percentage / 100;
      channel.attributed_revenue += tp.credit;
      channel.positions.push(index + 1); // 1-indexed position
    });
  });

  return Array.from(channelMap.values()).map(channel => ({
    utm_source: channel.utm_source,
    utm_medium: channel.utm_medium,
    utm_campaign: channel.utm_campaign,
    touchpoints: channel.touchpoints,
    conversions_in_path: channel.conversions_in_path.size,
    attributed_conversions: channel.attributed_conversions,
    attributed_revenue: channel.attributed_revenue,
    avg_position_in_path: channel.positions.length > 0
      ? channel.positions.reduce((a, b) => a + b, 0) / channel.positions.length
      : 0
  })).sort((a, b) => b.attributed_revenue - a.attributed_revenue);
}

/**
 * Build conversion paths from raw events
 * Groups events by session/user and identifies conversions
 */
export function buildConversionPaths(
  events: any[],
  identityMap: Map<string, string[]>, // user_id → anonymous_ids
  attributionWindowDays: number = 30
): { conversionPaths: ConversionPath[]; nonConversionPaths: ConversionPath[] } {
  const conversionPaths: ConversionPath[] = [];
  const nonConversionPaths: ConversionPath[] = [];

  // Group events by effective user (using identity stitching)
  const userEvents = new Map<string, any[]>();

  events.forEach(event => {
    // Try to find user_id for this anonymous_id
    let effectiveUserId = event.user_id;

    if (!effectiveUserId && event.anonymous_id) {
      // Look through identity map to find matching user
      for (const [userId, anonymousIds] of identityMap.entries()) {
        if (anonymousIds.includes(event.anonymous_id)) {
          effectiveUserId = userId;
          break;
        }
      }
    }

    // If still no user, use anonymous_id as fallback
    const key = effectiveUserId || event.anonymous_id || event.session_id;
    if (!key) return;

    if (!userEvents.has(key)) {
      userEvents.set(key, []);
    }
    userEvents.get(key)!.push(event);
  });

  // Build paths for each user
  userEvents.forEach((userEventList, userId) => {
    // Sort by timestamp
    const sorted = userEventList.sort((a, b) =>
      new Date(a.event_timestamp || a.timestamp).getTime() -
      new Date(b.event_timestamp || b.timestamp).getTime()
    );

    // Find conversions
    const conversions = sorted.filter(e =>
      e.event_type === 'conversion' || e.event_type === 'purchase'
    );

    if (conversions.length === 0) {
      // Non-converting path
      const touchpoints = sorted
        .filter(e => e.utm_source)
        .map(e => eventToTouchpoint(e));

      if (touchpoints.length > 0) {
        nonConversionPaths.push({
          conversion_id: `non-${userId}`,
          user_id: userId,
          anonymous_ids: [...new Set(sorted.map(e => e.anonymous_id).filter(Boolean))],
          touchpoints,
          conversion_timestamp: new Date(),
          conversion_value: 0,
          conversion_type: 'none'
        });
      }
    } else {
      // Build path for each conversion
      conversions.forEach((conversion, idx) => {
        const conversionTime = new Date(conversion.event_timestamp || conversion.timestamp);
        const windowStart = new Date(conversionTime.getTime() - attributionWindowDays * 24 * 60 * 60 * 1000);

        // Get touchpoints within attribution window before this conversion
        const touchpoints = sorted
          .filter(e => {
            const eventTime = new Date(e.event_timestamp || e.timestamp);
            return eventTime >= windowStart &&
              eventTime <= conversionTime &&
              e.utm_source;
          })
          .map(e => eventToTouchpoint(e));

        conversionPaths.push({
          conversion_id: conversion.event_id || `conv-${userId}-${idx}`,
          user_id: userId,
          anonymous_ids: [...new Set(sorted.map(e => e.anonymous_id).filter(Boolean))],
          touchpoints,
          conversion_timestamp: conversionTime,
          conversion_value: conversion.revenue || conversion.value || 0,
          conversion_type: conversion.event_type
        });
      });
    }
  });

  return { conversionPaths, nonConversionPaths };
}

function eventToTouchpoint(event: any): Touchpoint {
  return {
    id: event.event_id || crypto.randomUUID(),
    session_id: event.session_id,
    anonymous_id: event.anonymous_id,
    timestamp: new Date(event.event_timestamp || event.timestamp),
    utm_source: event.utm_source || '(direct)',
    utm_medium: event.utm_medium || null,
    utm_campaign: event.utm_campaign || null,
    event_type: event.event_type,
    page_url: event.page_url
  };
}
