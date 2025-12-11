/**
 * Revenue Reconciliation Service
 *
 * Compares platform-reported conversions (claims) against actual verified revenue
 * to identify discrepancies and calculate true ROAS.
 *
 * Use cases:
 * - Google/Meta/TikTok claim they drove X conversions, verify against Stripe/Shopify
 * - Calculate true ROAS vs platform-reported ROAS
 * - Identify over-reporting/under-reporting by platform
 * - Find unmatched claims (conversions platforms claim but no matching order)
 */

// =============================================================================
// TYPES
// =============================================================================

export type AdPlatform = 'google_ads' | 'meta_ads' | 'tiktok_ads' | 'microsoft_ads' | 'linkedin_ads';

export type ReconciliationStatus =
  | 'matched'        // Click ID found in actual conversion
  | 'unmatched'      // No matching conversion found
  | 'duplicate'      // Multiple platforms claim same conversion
  | 'over_reported'  // Platform claims higher value than actual
  | 'under_reported' // Platform claims lower value than actual
  | 'pending';       // Not yet reconciled

/**
 * Platform conversion claim (what ad platforms say they drove)
 */
export interface PlatformClaim {
  id: string;
  organization_id: string;
  platform: AdPlatform;

  // Claim identifiers
  click_id: string;
  click_id_type: 'gclid' | 'fbclid' | 'ttclid' | 'msclid' | 'li_fat_id';
  campaign_id: string | null;
  campaign_name: string | null;
  ad_group_id: string | null;
  ad_id: string | null;

  // Claimed conversion data
  claimed_conversion_value_cents: number;
  claimed_conversion_count: number;
  claim_timestamp: Date;

  // Reconciliation result
  reconciliation_status: ReconciliationStatus;
  matched_conversion_id: string | null;
  verified_revenue_cents: number | null;
  discrepancy_cents: number | null;
  reconciled_at: Date | null;

  // Metadata
  created_at: Date;
  updated_at: Date;
}

/**
 * Actual conversion record (from Stripe/Shopify/etc.)
 */
export interface ActualConversion {
  id: string;
  organization_id: string;
  source_platform: 'stripe' | 'shopify' | 'hubspot' | 'salesforce' | 'custom';
  external_order_id: string;
  revenue_cents: number;
  conversion_timestamp: Date;

  // Attribution data
  attributed_click_id: string | null;
  attributed_click_id_type: 'gclid' | 'fbclid' | 'ttclid' | 'msclid' | 'li_fat_id' | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;

  // Customer identity (for matching)
  customer_email_hash: string | null;
}

/**
 * Reconciliation result summary
 */
export interface ReconciliationResult {
  organization_id: string;
  platform: AdPlatform | 'all';
  date_range: { start: string; end: string };

  // Summary metrics
  total_claims: number;
  matched_claims: number;
  unmatched_claims: number;
  duplicate_claims: number;

  // Revenue metrics
  claimed_revenue_cents: number;
  verified_revenue_cents: number;
  discrepancy_cents: number;
  discrepancy_percentage: number;

  // ROAS comparison
  claimed_roas: number;        // What platform says
  actual_roas: number;         // True ROAS based on verified revenue
  roas_inflation_percentage: number;

  // Conversion metrics
  claimed_conversions: number;
  verified_conversions: number;
  conversion_inflation_percentage: number;

  // Ad spend (for ROAS calculation)
  ad_spend_cents: number;

  // Detailed breakdowns
  by_campaign: CampaignReconciliation[];
  unmatched_claim_ids: string[];

  // Metadata
  reconciled_at: Date;
}

export interface CampaignReconciliation {
  campaign_id: string | null;
  campaign_name: string | null;
  claimed_revenue_cents: number;
  verified_revenue_cents: number;
  discrepancy_cents: number;
  claimed_conversions: number;
  verified_conversions: number;
  match_rate: number;
}

/**
 * Input for importing platform claims
 */
export interface PlatformClaimInput {
  click_id: string;
  click_id_type: 'gclid' | 'fbclid' | 'ttclid' | 'msclid' | 'li_fat_id';
  campaign_id?: string;
  campaign_name?: string;
  ad_group_id?: string;
  ad_id?: string;
  claimed_conversion_value_cents: number;
  claimed_conversion_count?: number;
  claim_timestamp: Date;
}

// =============================================================================
// RECONCILIATION SERVICE
// =============================================================================

export class ReconciliationService {
  /**
   * Reconcile platform claims against actual conversions
   *
   * @param organizationId Organization to reconcile
   * @param platform Ad platform to reconcile (or 'all')
   * @param dateRange Date range for reconciliation
   * @param claims Platform-reported claims
   * @param conversions Actual conversions from revenue platforms
   * @param adSpendCents Total ad spend for ROAS calculation
   */
  reconcile(
    organizationId: string,
    platform: AdPlatform | 'all',
    dateRange: { start: string; end: string },
    claims: PlatformClaim[],
    conversions: ActualConversion[],
    adSpendCents: number
  ): ReconciliationResult {
    // Filter claims by platform if specified
    const relevantClaims = platform === 'all'
      ? claims
      : claims.filter(c => c.platform === platform);

    // Build click_id lookup for conversions
    const conversionsByClickId = new Map<string, ActualConversion>();
    for (const conv of conversions) {
      if (conv.attributed_click_id) {
        conversionsByClickId.set(conv.attributed_click_id, conv);
      }
    }

    // Track which conversions have been matched
    const matchedConversionIds = new Set<string>();

    // Reconcile each claim
    const reconciledClaims: PlatformClaim[] = [];
    const campaignStats = new Map<string, {
      campaign_id: string | null;
      campaign_name: string | null;
      claimed_revenue_cents: number;
      verified_revenue_cents: number;
      claimed_conversions: number;
      verified_conversions: number;
    }>();

    let totalClaimedRevenue = 0;
    let totalVerifiedRevenue = 0;
    let totalClaimedConversions = 0;
    let totalVerifiedConversions = 0;
    let matchedCount = 0;
    let unmatchedCount = 0;
    let duplicateCount = 0;
    const unmatchedClaimIds: string[] = [];

    for (const claim of relevantClaims) {
      const reconciledClaim = { ...claim };
      totalClaimedRevenue += claim.claimed_conversion_value_cents;
      totalClaimedConversions += claim.claimed_conversion_count || 1;

      // Initialize campaign stats
      const campaignKey = claim.campaign_id || '(none)';
      if (!campaignStats.has(campaignKey)) {
        campaignStats.set(campaignKey, {
          campaign_id: claim.campaign_id,
          campaign_name: claim.campaign_name,
          claimed_revenue_cents: 0,
          verified_revenue_cents: 0,
          claimed_conversions: 0,
          verified_conversions: 0,
        });
      }
      const stats = campaignStats.get(campaignKey)!;
      stats.claimed_revenue_cents += claim.claimed_conversion_value_cents;
      stats.claimed_conversions += claim.claimed_conversion_count || 1;

      // Try to match by click_id
      const matchedConversion = conversionsByClickId.get(claim.click_id);

      if (matchedConversion) {
        // Check if this conversion was already matched (duplicate)
        if (matchedConversionIds.has(matchedConversion.id)) {
          reconciledClaim.reconciliation_status = 'duplicate';
          duplicateCount++;
        } else {
          matchedConversionIds.add(matchedConversion.id);

          // Calculate discrepancy
          const discrepancy = claim.claimed_conversion_value_cents - matchedConversion.revenue_cents;

          if (discrepancy > 0) {
            reconciledClaim.reconciliation_status = 'over_reported';
          } else if (discrepancy < 0) {
            reconciledClaim.reconciliation_status = 'under_reported';
          } else {
            reconciledClaim.reconciliation_status = 'matched';
          }

          reconciledClaim.matched_conversion_id = matchedConversion.id;
          reconciledClaim.verified_revenue_cents = matchedConversion.revenue_cents;
          reconciledClaim.discrepancy_cents = discrepancy;

          totalVerifiedRevenue += matchedConversion.revenue_cents;
          totalVerifiedConversions++;
          stats.verified_revenue_cents += matchedConversion.revenue_cents;
          stats.verified_conversions++;
          matchedCount++;
        }
      } else {
        reconciledClaim.reconciliation_status = 'unmatched';
        unmatchedCount++;
        unmatchedClaimIds.push(claim.id);
      }

      reconciledClaim.reconciled_at = new Date();
      reconciledClaims.push(reconciledClaim);
    }

    // Calculate overall metrics
    const discrepancyCents = totalClaimedRevenue - totalVerifiedRevenue;
    const discrepancyPercentage = totalClaimedRevenue > 0
      ? (discrepancyCents / totalClaimedRevenue) * 100
      : 0;

    // Calculate ROAS
    const claimedRoas = adSpendCents > 0
      ? totalClaimedRevenue / adSpendCents
      : 0;
    const actualRoas = adSpendCents > 0
      ? totalVerifiedRevenue / adSpendCents
      : 0;
    const roasInflation = claimedRoas > 0
      ? ((claimedRoas - actualRoas) / actualRoas) * 100
      : 0;

    const conversionInflation = totalVerifiedConversions > 0
      ? ((totalClaimedConversions - totalVerifiedConversions) / totalVerifiedConversions) * 100
      : 0;

    // Build campaign breakdown
    const byCampaign: CampaignReconciliation[] = Array.from(campaignStats.values()).map(stats => ({
      campaign_id: stats.campaign_id,
      campaign_name: stats.campaign_name,
      claimed_revenue_cents: stats.claimed_revenue_cents,
      verified_revenue_cents: stats.verified_revenue_cents,
      discrepancy_cents: stats.claimed_revenue_cents - stats.verified_revenue_cents,
      claimed_conversions: stats.claimed_conversions,
      verified_conversions: stats.verified_conversions,
      match_rate: stats.claimed_conversions > 0
        ? stats.verified_conversions / stats.claimed_conversions
        : 0,
    })).sort((a, b) => b.verified_revenue_cents - a.verified_revenue_cents);

    return {
      organization_id: organizationId,
      platform,
      date_range: dateRange,

      total_claims: relevantClaims.length,
      matched_claims: matchedCount,
      unmatched_claims: unmatchedCount,
      duplicate_claims: duplicateCount,

      claimed_revenue_cents: totalClaimedRevenue,
      verified_revenue_cents: totalVerifiedRevenue,
      discrepancy_cents: discrepancyCents,
      discrepancy_percentage: discrepancyPercentage,

      claimed_roas: claimedRoas,
      actual_roas: actualRoas,
      roas_inflation_percentage: roasInflation,

      claimed_conversions: totalClaimedConversions,
      verified_conversions: totalVerifiedConversions,
      conversion_inflation_percentage: conversionInflation,

      ad_spend_cents: adSpendCents,

      by_campaign: byCampaign,
      unmatched_claim_ids: unmatchedClaimIds,

      reconciled_at: new Date(),
    };
  }

  /**
   * Parse platform claim imports
   * Validates and transforms raw input into PlatformClaim objects
   */
  importPlatformClaims(
    organizationId: string,
    platform: AdPlatform,
    inputs: PlatformClaimInput[]
  ): PlatformClaim[] {
    return inputs.map((input, index) => ({
      id: `claim_${organizationId}_${platform}_${Date.now()}_${index}`,
      organization_id: organizationId,
      platform,

      click_id: input.click_id,
      click_id_type: input.click_id_type,
      campaign_id: input.campaign_id || null,
      campaign_name: input.campaign_name || null,
      ad_group_id: input.ad_group_id || null,
      ad_id: input.ad_id || null,

      claimed_conversion_value_cents: input.claimed_conversion_value_cents,
      claimed_conversion_count: input.claimed_conversion_count || 1,
      claim_timestamp: input.claim_timestamp,

      reconciliation_status: 'pending' as ReconciliationStatus,
      matched_conversion_id: null,
      verified_revenue_cents: null,
      discrepancy_cents: null,
      reconciled_at: null,

      created_at: new Date(),
      updated_at: new Date(),
    }));
  }

  /**
   * Analyze unmatched claims to identify potential reasons
   */
  analyzeUnmatchedClaims(
    unmatchedClaims: PlatformClaim[],
    allConversions: ActualConversion[]
  ): UnmatchedClaimAnalysis[] {
    return unmatchedClaims.map(claim => {
      const analysis: UnmatchedClaimAnalysis = {
        claim_id: claim.id,
        click_id: claim.click_id,
        platform: claim.platform,
        claimed_value_cents: claim.claimed_conversion_value_cents,
        possible_reason: 'unknown',
        suggestion: '',
      };

      // Check if there are conversions near the claim timestamp
      const claimTime = claim.claim_timestamp.getTime();
      const nearbyConversions = allConversions.filter(conv => {
        const convTime = conv.conversion_timestamp.getTime();
        const hoursDiff = Math.abs(convTime - claimTime) / (1000 * 60 * 60);
        return hoursDiff <= 24; // Within 24 hours
      });

      if (nearbyConversions.length === 0) {
        analysis.possible_reason = 'no_conversion_in_window';
        analysis.suggestion = 'No conversions found within 24 hours of claim. The conversion may not have been tracked or may have a different timestamp.';
      } else {
        // Check if any nearby conversion has missing click_id
        const conversionsWithoutClickId = nearbyConversions.filter(c => !c.attributed_click_id);

        if (conversionsWithoutClickId.length > 0) {
          analysis.possible_reason = 'click_id_not_captured';
          analysis.suggestion = `Found ${conversionsWithoutClickId.length} conversion(s) without click_id attribution. The click_id may not be passing through your tracking correctly.`;
          analysis.potential_matches = conversionsWithoutClickId.map(c => ({
            conversion_id: c.id,
            revenue_cents: c.revenue_cents,
            timestamp: c.conversion_timestamp,
          }));
        } else {
          // All nearby conversions have different click_ids
          analysis.possible_reason = 'click_id_mismatch';
          analysis.suggestion = 'Conversions found but with different click_ids. This could indicate the conversion was attributed to a different click.';
        }
      }

      // Check for similar value conversions (possible matching)
      const similarValueConversions = allConversions.filter(conv =>
        Math.abs(conv.revenue_cents - claim.claimed_conversion_value_cents) <= 100 // Within $1
      );

      if (similarValueConversions.length > 0 && analysis.possible_reason === 'unknown') {
        analysis.possible_reason = 'value_match_no_click_id';
        analysis.suggestion = `Found ${similarValueConversions.length} conversion(s) with similar value but different/missing click_id.`;
        analysis.potential_matches = similarValueConversions.slice(0, 5).map(c => ({
          conversion_id: c.id,
          revenue_cents: c.revenue_cents,
          timestamp: c.conversion_timestamp,
        }));
      }

      return analysis;
    });
  }

  /**
   * Calculate reconciliation trends over time
   */
  calculateTrends(
    results: ReconciliationResult[]
  ): ReconciliationTrend[] {
    // Group by date
    const byDate = new Map<string, ReconciliationResult[]>();

    for (const result of results) {
      const dateKey = result.date_range.start;
      if (!byDate.has(dateKey)) {
        byDate.set(dateKey, []);
      }
      byDate.get(dateKey)!.push(result);
    }

    // Calculate trend for each date
    return Array.from(byDate.entries())
      .map(([date, dayResults]) => {
        const totalClaimed = dayResults.reduce((sum, r) => sum + r.claimed_revenue_cents, 0);
        const totalVerified = dayResults.reduce((sum, r) => sum + r.verified_revenue_cents, 0);
        const totalMatched = dayResults.reduce((sum, r) => sum + r.matched_claims, 0);
        const totalClaims = dayResults.reduce((sum, r) => sum + r.total_claims, 0);

        return {
          date,
          claimed_revenue_cents: totalClaimed,
          verified_revenue_cents: totalVerified,
          discrepancy_cents: totalClaimed - totalVerified,
          discrepancy_percentage: totalClaimed > 0
            ? ((totalClaimed - totalVerified) / totalClaimed) * 100
            : 0,
          match_rate: totalClaims > 0 ? totalMatched / totalClaims : 0,
          total_claims: totalClaims,
          matched_claims: totalMatched,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Get platform-specific insights
   */
  getPlatformInsights(results: ReconciliationResult[]): PlatformInsight[] {
    const byPlatform = new Map<string, ReconciliationResult[]>();

    for (const result of results) {
      if (result.platform === 'all') continue;

      if (!byPlatform.has(result.platform)) {
        byPlatform.set(result.platform, []);
      }
      byPlatform.get(result.platform)!.push(result);
    }

    return Array.from(byPlatform.entries()).map(([platform, platformResults]) => {
      const avgDiscrepancy = platformResults.reduce((sum, r) => sum + r.discrepancy_percentage, 0) / platformResults.length;
      const avgMatchRate = platformResults.reduce((sum, r) =>
        sum + (r.matched_claims / Math.max(r.total_claims, 1)), 0) / platformResults.length;
      const totalClaimed = platformResults.reduce((sum, r) => sum + r.claimed_revenue_cents, 0);
      const totalVerified = platformResults.reduce((sum, r) => sum + r.verified_revenue_cents, 0);

      let trustLevel: 'high' | 'medium' | 'low';
      if (avgMatchRate >= 0.9 && avgDiscrepancy <= 10) {
        trustLevel = 'high';
      } else if (avgMatchRate >= 0.7 && avgDiscrepancy <= 25) {
        trustLevel = 'medium';
      } else {
        trustLevel = 'low';
      }

      return {
        platform: platform as AdPlatform,
        avg_discrepancy_percentage: avgDiscrepancy,
        avg_match_rate: avgMatchRate,
        total_claimed_cents: totalClaimed,
        total_verified_cents: totalVerified,
        trust_level: trustLevel,
        recommendation: trustLevel === 'low'
          ? `${platform} shows high discrepancy. Consider auditing click_id tracking and conversion attribution.`
          : trustLevel === 'medium'
            ? `${platform} has moderate discrepancy. Review campaign-level attribution.`
            : `${platform} reporting is reliable within expected variance.`,
      };
    });
  }
}

// =============================================================================
// ADDITIONAL TYPES
// =============================================================================

export interface UnmatchedClaimAnalysis {
  claim_id: string;
  click_id: string;
  platform: AdPlatform;
  claimed_value_cents: number;
  possible_reason:
    | 'no_conversion_in_window'
    | 'click_id_not_captured'
    | 'click_id_mismatch'
    | 'value_match_no_click_id'
    | 'unknown';
  suggestion: string;
  potential_matches?: Array<{
    conversion_id: string;
    revenue_cents: number;
    timestamp: Date;
  }>;
}

export interface ReconciliationTrend {
  date: string;
  claimed_revenue_cents: number;
  verified_revenue_cents: number;
  discrepancy_cents: number;
  discrepancy_percentage: number;
  match_rate: number;
  total_claims: number;
  matched_claims: number;
}

export interface PlatformInsight {
  platform: AdPlatform;
  avg_discrepancy_percentage: number;
  avg_match_rate: number;
  total_claimed_cents: number;
  total_verified_cents: number;
  trust_level: 'high' | 'medium' | 'low';
  recommendation: string;
}

// Export singleton instance
export const reconciliationService = new ReconciliationService();
