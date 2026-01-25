/**
 * Platform Configuration
 *
 * Mirror of clearlift-cron/shared/config/platforms.ts (CANONICAL SOURCE)
 * Keep in sync when adding new platforms.
 *
 * @see clearlift-cron/docs/SHARED_CODE.md §20 for connector roadmap
 */

// =============================================================================
// Platform ID Constants (use these for filtering and logic)
// =============================================================================

/**
 * Ad platforms that drive traffic and have spend metrics.
 * Used for: filtering connected platforms, attribution, spend analysis
 */
export const AD_PLATFORM_IDS = [
  'google',
  'facebook',
  'tiktok',
  'microsoft',  // Future: Microsoft Ads
  'linkedin',   // Future: LinkedIn Marketing
] as const;

/**
 * Revenue platforms that track conversions and payments.
 * Used for: filtering connected platforms, revenue attribution
 */
export const REVENUE_PLATFORM_IDS = [
  'stripe',
  'shopify',
  'jobber',
  'attentive',      // Future
  'lemon_squeezy',  // Future
  'paddle',         // Future
  'chargebee',      // Future
  'recurly',        // Future
] as const;

/**
 * Currently active/implemented ad platforms.
 * Use this when you only want platforms that are fully functional.
 */
export const ACTIVE_AD_PLATFORM_IDS = [
  'google',
  'facebook',
  'tiktok',
] as const;

/**
 * Currently active/implemented revenue platforms.
 * Use this when you only want platforms that are fully functional.
 */
export const ACTIVE_REVENUE_PLATFORM_IDS = [
  'stripe',
  'shopify',
  'jobber',
] as const;

/**
 * All platform IDs (ad + revenue).
 */
export const ALL_PLATFORM_IDS = [
  ...AD_PLATFORM_IDS,
  ...REVENUE_PLATFORM_IDS,
] as const;

// =============================================================================
// Type Definitions
// =============================================================================

export type AdPlatformId = typeof AD_PLATFORM_IDS[number];
export type RevenuePlatformId = typeof REVENUE_PLATFORM_IDS[number];
export type ActiveAdPlatformId = typeof ACTIVE_AD_PLATFORM_IDS[number];
export type ActiveRevenuePlatformId = typeof ACTIVE_REVENUE_PLATFORM_IDS[number];
export type PlatformId = typeof ALL_PLATFORM_IDS[number];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a platform ID is an ad platform.
 */
export function isAdPlatform(platformId: string): platformId is AdPlatformId {
  return AD_PLATFORM_IDS.includes(platformId as AdPlatformId);
}

/**
 * Check if a platform ID is a revenue platform.
 */
export function isRevenuePlatform(platformId: string): platformId is RevenuePlatformId {
  return REVENUE_PLATFORM_IDS.includes(platformId as RevenuePlatformId);
}

/**
 * Check if a platform is currently active/implemented.
 */
export function isPlatformActive(platformId: string): boolean {
  return (
    ACTIVE_AD_PLATFORM_IDS.includes(platformId as ActiveAdPlatformId) ||
    ACTIVE_REVENUE_PLATFORM_IDS.includes(platformId as ActiveRevenuePlatformId)
  );
}

/**
 * Filter platforms by type.
 */
export function filterPlatformsByType(
  platforms: string[],
  type: 'ad_platform' | 'revenue_platform'
): string[] {
  if (type === 'ad_platform') {
    return platforms.filter(p => isAdPlatform(p));
  }
  return platforms.filter(p => isRevenuePlatform(p));
}

/**
 * Filter to only active platforms.
 */
export function filterActivePlatforms(platforms: string[]): string[] {
  return platforms.filter(p => isPlatformActive(p));
}
