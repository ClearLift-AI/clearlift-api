/**
 * Facebook Marketing API v24.0 Constants and Limits
 *
 * Based on official Facebook Marketing API documentation and v24.0 updates
 * @see https://developers.facebook.com/docs/marketing-api
 */

/**
 * Age targeting limits
 * Facebook requires minimum age of 18 for ad targeting in most countries
 * Maximum is 65 (which means "65 and over")
 */
export const AGE_LIMITS = {
  MIN: 18,
  MAX: 65
} as const;

/**
 * Budget limits (in cents)
 * Daily budget minimum is typically $1.00 (100 cents)
 * Lifetime budget minimum depends on campaign duration
 */
export const BUDGET_LIMITS = {
  DAILY_MIN_CENTS: 100,      // $1.00
  LIFETIME_MIN_CENTS: 100,   // $1.00

  // When decreasing lifetime budget, new value must be at least 10% greater
  // than the amount already spent
  DECREASE_MARGIN_PERCENT: 10
} as const;

/**
 * Rate limiting
 * Facebook has specific rate limits for budget changes
 */
export const RATE_LIMITS = {
  BUDGET_CHANGE_MAX_PER_HOUR: 100,
  STATUS_CHANGE_MAX_PER_HOUR: 200,

  // Retry configuration
  MAX_RETRIES: 3,
  INITIAL_RETRY_DELAY_MS: 1000,
  RETRY_BACKOFF_MULTIPLIER: 2
} as const;

/**
 * v24.0 Specific Features
 */
export const V24_FEATURES = {
  // Ad set budget sharing allows up to 20% of budget to be shared
  BUDGET_SHARING_MAX_PERCENT: 20,

  // Daily budget flexibility allows up to 75% over on certain days
  DAILY_BUDGET_FLEXIBILITY_PERCENT: 75,

  // Excluded placements can receive up to 5% of budget
  PLACEMENT_SOFT_OPT_OUT_PERCENT: 5
} as const;

/**
 * Gender targeting values
 */
export const GENDERS = {
  MALE: 1,
  FEMALE: 2,
  ALL: [1, 2]
} as const;

/**
 * Campaign and Ad Set Status Values
 */
export const STATUS = {
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  DELETED: 'DELETED',
  ARCHIVED: 'ARCHIVED'
} as const;

/**
 * Budget types (mutually exclusive)
 */
export const BUDGET_TYPES = {
  DAILY: 'daily_budget',
  LIFETIME: 'lifetime_budget'
} as const;

/**
 * Optimization budget type for v24.0
 * Controls whether to use Campaign Budget Optimization or Ad Set budgets
 */
export const BUDGET_OPTIMIZATION_TYPE = {
  CAMPAIGN: 'campaign',  // Campaign Budget Optimization (CBO)
  ADSET: 'adset'        // Ad Set level budgets
} as const;

/**
 * Error codes that indicate rate limiting
 */
export const RATE_LIMIT_ERROR_CODES = [
  4,    // API Too Many Calls
  17,   // User Request Limit Reached
  32,   // Page Request Limit Reached
  613   // Calls Within One Hour Exceeded
] as const;

/**
 * Error messages
 */
export const ERROR_MESSAGES = {
  AGE_OUT_OF_RANGE: `Age must be between ${AGE_LIMITS.MIN} and ${AGE_LIMITS.MAX}`,
  BUDGET_TOO_LOW: `Budget must be at least $${BUDGET_LIMITS.DAILY_MIN_CENTS / 100}`,
  BOTH_BUDGETS_SET: 'Cannot set both daily_budget and lifetime_budget',
  NO_BUDGET_SET: 'Must set either daily_budget or lifetime_budget',
  BUDGET_DECREASE_VIOLATION: 'New lifetime budget must be at least 10% greater than amount spent',
  RATE_LIMIT_EXCEEDED: 'Facebook API rate limit exceeded. Please try again later.'
} as const;
