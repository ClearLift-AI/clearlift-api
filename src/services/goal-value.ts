/**
 * Goal Value Service
 *
 * Calculates conversion goal values based on different value types:
 * - from_source: Value comes from the source (Stripe charge amount, etc.)
 * - fixed: Fixed value in cents
 * - calculated: Formula-based (avg_deal_value * close_rate)
 * - none: No monetary value
 */

export interface ConversionGoal {
  id: string;
  name: string;
  value_type?: 'from_source' | 'fixed' | 'calculated' | 'none';
  fixed_value_cents?: number;
  avg_deal_value_cents?: number;
  close_rate_percent?: number;
  default_value_cents?: number;
}

export interface CalculatedValueResult {
  value_cents: number;
  formula_used: string | null;
  inputs?: {
    avg_deal_value_cents?: number;
    close_rate_percent?: number;
    fixed_value_cents?: number;
  };
}

/**
 * Calculate the value of a conversion goal based on its value_type
 *
 * @param goal - The conversion goal
 * @param sourceValue - Optional value from the source (e.g., Stripe charge amount)
 * @returns The calculated value in cents and formula details
 */
export function calculateGoalValue(
  goal: ConversionGoal,
  sourceValue?: number
): CalculatedValueResult {
  const valueType = goal.value_type || 'from_source';

  switch (valueType) {
    case 'from_source':
      // Use source value if available, otherwise fall back to default_value_cents
      return {
        value_cents: sourceValue ?? (goal.default_value_cents || 0),
        formula_used: sourceValue !== undefined ? 'source_value' : 'default_value',
        inputs: sourceValue !== undefined ? undefined : { fixed_value_cents: goal.default_value_cents },
      };

    case 'fixed':
      return {
        value_cents: goal.fixed_value_cents ?? 0,
        formula_used: 'fixed_value',
        inputs: { fixed_value_cents: goal.fixed_value_cents },
      };

    case 'calculated':
      // Formula: avg_deal_value_cents * (close_rate_percent / 100)
      const avgDeal = goal.avg_deal_value_cents ?? 0;
      const closeRate = (goal.close_rate_percent ?? 0) / 100;
      const calculatedValue = Math.round(avgDeal * closeRate);

      return {
        value_cents: calculatedValue,
        formula_used: 'avg_deal_value * close_rate',
        inputs: {
          avg_deal_value_cents: goal.avg_deal_value_cents,
          close_rate_percent: goal.close_rate_percent,
        },
      };

    case 'none':
    default:
      return {
        value_cents: 0,
        formula_used: null,
      };
  }
}

/**
 * Calculate the effective value for display (e.g., in goal configuration UI)
 *
 * @param goal - The conversion goal
 * @returns The calculated value in cents
 */
export function getEffectiveGoalValue(goal: ConversionGoal): number {
  return calculateGoalValue(goal).value_cents;
}

/**
 * Validate goal value configuration
 *
 * @param goal - The conversion goal to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateGoalValueConfig(goal: Partial<ConversionGoal>): string[] {
  const errors: string[] = [];
  const valueType = goal.value_type || 'from_source';

  switch (valueType) {
    case 'fixed':
      if (goal.fixed_value_cents === undefined || goal.fixed_value_cents < 0) {
        errors.push('Fixed value must be a non-negative number');
      }
      break;

    case 'calculated':
      if (goal.avg_deal_value_cents === undefined || goal.avg_deal_value_cents <= 0) {
        errors.push('Average deal value must be a positive number');
      }
      if (goal.close_rate_percent === undefined || goal.close_rate_percent < 0 || goal.close_rate_percent > 100) {
        errors.push('Close rate must be between 0 and 100');
      }
      break;
  }

  return errors;
}
