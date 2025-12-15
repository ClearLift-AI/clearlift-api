/**
 * TikTok Marketing API v1.3 Constants and Limits
 *
 * Based on official TikTok Marketing API documentation
 * @see https://business-api.tiktok.com/portal/docs
 */

/**
 * TikTok API Base URLs
 */
export const API_BASE_URL = 'https://business-api.tiktok.com/open_api/v1.3';

/**
 * Age targeting values (TikTok uses age group enums)
 */
export const AGE_GROUPS = {
  AGE_13_17: 'AGE_13_17',
  AGE_18_24: 'AGE_18_24',
  AGE_25_34: 'AGE_25_34',
  AGE_35_44: 'AGE_35_44',
  AGE_45_54: 'AGE_45_54',
  AGE_55_PLUS: 'AGE_55_100'
} as const;

/**
 * Budget limits (in cents)
 * TikTok minimum daily budget is typically $20-50 depending on campaign type
 */
export const BUDGET_LIMITS = {
  DAILY_MIN_CENTS: 2000,      // $20.00 minimum daily budget
  LIFETIME_MIN_CENTS: 2000,   // $20.00 minimum lifetime budget
} as const;

/**
 * Budget mode values
 */
export const BUDGET_MODE = {
  BUDGET_MODE_DAY: 'BUDGET_MODE_DAY',
  BUDGET_MODE_TOTAL: 'BUDGET_MODE_TOTAL',
  BUDGET_MODE_INFINITE: 'BUDGET_MODE_INFINITE'
} as const;

/**
 * Rate limiting configuration
 */
export const RATE_LIMITS = {
  MAX_RETRIES: 3,
  INITIAL_RETRY_DELAY_MS: 1000,
  RETRY_BACKOFF_MULTIPLIER: 2
} as const;

/**
 * Status values for campaigns and ad groups
 * TikTok uses ENABLE/DISABLE instead of ACTIVE/PAUSED
 */
export const STATUS = {
  ENABLE: 'ENABLE',
  DISABLE: 'DISABLE',
  DELETE: 'DELETE'
} as const;

/**
 * Operation status values (returned from API)
 */
export const OPERATION_STATUS = {
  CAMPAIGN_STATUS_ENABLE: 'CAMPAIGN_STATUS_ENABLE',
  CAMPAIGN_STATUS_DISABLE: 'CAMPAIGN_STATUS_DISABLE',
  CAMPAIGN_STATUS_DELETE: 'CAMPAIGN_STATUS_DELETE',
  ADGROUP_STATUS_ENABLE: 'ADGROUP_STATUS_ENABLE',
  ADGROUP_STATUS_DISABLE: 'ADGROUP_STATUS_DISABLE',
  ADGROUP_STATUS_DELETE: 'ADGROUP_STATUS_DELETE'
} as const;

/**
 * Gender targeting values
 */
export const GENDERS = {
  MALE: 'MALE',
  FEMALE: 'FEMALE',
  UNLIMITED: 'UNLIMITED'  // All genders
} as const;

/**
 * Placement types
 */
export const PLACEMENTS = {
  PLACEMENT_TYPE_AUTOMATIC: 'PLACEMENT_TYPE_AUTOMATIC',
  PLACEMENT_TYPE_NORMAL: 'PLACEMENT_TYPE_NORMAL'  // Manual placement selection
} as const;

/**
 * Error codes that indicate rate limiting
 */
export const RATE_LIMIT_ERROR_CODES = [
  40100,  // Access token has expired
  40102,  // Access token is invalid
  40105,  // Request limit exceeded
  50000,  // System busy
  50002   // Too many requests
] as const;

/**
 * Error messages
 */
export const ERROR_MESSAGES = {
  BUDGET_TOO_LOW: `Budget must be at least $${BUDGET_LIMITS.DAILY_MIN_CENTS / 100}`,
  INVALID_STATUS: 'Status must be ENABLE or DISABLE',
  RATE_LIMIT_EXCEEDED: 'TikTok API rate limit exceeded. Please try again later.',
  INVALID_ADVERTISER_ID: 'Advertiser ID is required',
  INVALID_ACCESS_TOKEN: 'Access token is required'
} as const;

/**
 * TikTok OAuth endpoints
 */
export const OAUTH_ENDPOINTS = {
  AUTHORIZE: 'https://business-api.tiktok.com/portal/auth',
  TOKEN: `${API_BASE_URL}/oauth2/access_token/`,
  REFRESH: `${API_BASE_URL}/oauth2/refresh_token/`
} as const;
