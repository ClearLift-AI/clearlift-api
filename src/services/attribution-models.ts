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
  | 'data_driven';

export interface AttributionConfig {
  model: AttributionModel;
  attribution_window_days: number;
  time_decay_half_life_days: number;
  position_based_weights?: {
    first: number;   // Default 0.4
    last: number;    // Default 0.4
    middle: number;  // Default 0.2
  };
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
