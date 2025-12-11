/**
 * Revenue Reconciliation Endpoints
 *
 * Compare platform-reported conversions (claims) against actual verified revenue.
 * Calculates discrepancies, true ROAS, and platform trust levels.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";
import { D1Adapter } from "../../../adapters/d1";
import {
  ReconciliationService,
  AdPlatform,
  PlatformClaim,
  ActualConversion,
  PlatformClaimInput,
} from "../../../services/reconciliation";

const AdPlatformEnum = z.enum([
  'google_ads',
  'meta_ads',
  'tiktok_ads',
  'microsoft_ads',
  'linkedin_ads',
  'all'
]);

const reconciliationService = new ReconciliationService();

/**
 * GET /v1/analytics/reconciliation
 *
 * Get revenue reconciliation comparing platform claims vs actual conversions.
 */
export class GetReconciliation extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get revenue reconciliation",
    description: `
Compare ad platform claims against actual verified revenue from payment platforms.

**What this endpoint does:**
- Matches click IDs (gclid, fbclid, ttclid) from platform claims to actual conversions
- Calculates discrepancy between claimed and verified revenue
- Computes true ROAS vs platform-reported ROAS
- Identifies unmatched claims and potential reasons

**Use cases:**
- Audit ad platform reporting accuracy
- Identify over-reporting/under-reporting by platform
- Calculate true attribution for budget allocation
    `.trim(),
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
        platform: AdPlatformEnum.optional().default('all').describe("Ad platform to reconcile (default: all)")
      })
    },
    responses: {
      "200": {
        description: "Reconciliation results",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                platform: AdPlatformEnum,
                date_range: z.object({
                  start: z.string(),
                  end: z.string()
                }),
                summary: z.object({
                  total_claims: z.number(),
                  matched_claims: z.number(),
                  unmatched_claims: z.number(),
                  match_rate: z.number().describe("Percentage of claims matched (0-100)")
                }),
                revenue: z.object({
                  claimed_cents: z.number(),
                  verified_cents: z.number(),
                  discrepancy_cents: z.number(),
                  discrepancy_percentage: z.number()
                }),
                roas: z.object({
                  claimed: z.number(),
                  actual: z.number(),
                  inflation_percentage: z.number()
                }),
                by_campaign: z.array(z.object({
                  campaign_id: z.string().nullable(),
                  campaign_name: z.string().nullable(),
                  claimed_revenue_cents: z.number(),
                  verified_revenue_cents: z.number(),
                  discrepancy_cents: z.number(),
                  match_rate: z.number()
                }))
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const query = c.req.query();

    const dateFrom = query.date_from;
    const dateTo = query.date_to;
    const platform = (query.platform || 'all') as AdPlatform | 'all';

    const d1 = new D1Adapter(c.env.DB);
    const org = await d1.getOrganizationById(orgId);
    if (!org) {
      return error(c, "NOT_FOUND", "Organization not found", 404);
    }

    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      return success(c, {
        platform,
        date_range: { start: dateFrom, end: dateTo },
        summary: {
          total_claims: 0,
          matched_claims: 0,
          unmatched_claims: 0,
          match_rate: 0
        },
        revenue: {
          claimed_cents: 0,
          verified_cents: 0,
          discrepancy_cents: 0,
          discrepancy_percentage: 0
        },
        roas: {
          claimed: 0,
          actual: 0,
          inflation_percentage: 0
        },
        by_campaign: []
      });
    }

    try {
      const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
      if (!supabaseKey) {
        return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
      }

      const supabase = new SupabaseClient({
        url: c.env.SUPABASE_URL,
        serviceKey: supabaseKey
      });

      // Fetch platform claims from Supabase
      const claimsParams = new URLSearchParams();
      claimsParams.append('organization_id', `eq.${orgId}`);
      claimsParams.append('claim_timestamp', `gte.${dateFrom}T00:00:00Z`);
      claimsParams.append('claim_timestamp', `lte.${dateTo}T23:59:59Z`);
      if (platform !== 'all') {
        claimsParams.append('platform', `eq.${platform}`);
      }

      const claimsData = await supabase.queryWithSchema<any[]>(
        `revenue.platform_conversion_claims?${claimsParams.toString()}`,
        'revenue',
        { method: 'GET' }
      ) || [];

      const claims: PlatformClaim[] = claimsData.map(c => ({
        id: c.id,
        organization_id: c.organization_id,
        platform: c.platform,
        click_id: c.click_id,
        click_id_type: c.click_id_type,
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        ad_group_id: c.ad_group_id,
        ad_id: c.ad_id,
        claimed_conversion_value_cents: c.claimed_conversion_value_cents,
        claimed_conversion_count: c.claimed_conversion_count || 1,
        claim_timestamp: new Date(c.claim_timestamp),
        reconciliation_status: c.reconciliation_status || 'pending',
        matched_conversion_id: c.matched_conversion_id,
        verified_revenue_cents: c.verified_revenue_cents,
        discrepancy_cents: c.discrepancy_cents,
        reconciled_at: c.reconciled_at ? new Date(c.reconciled_at) : null,
        created_at: new Date(c.created_at),
        updated_at: new Date(c.updated_at)
      }));

      // Fetch actual conversions from revenue.conversions
      const conversionsParams = new URLSearchParams();
      conversionsParams.append('organization_id', `eq.${orgId}`);
      conversionsParams.append('conversion_timestamp', `gte.${dateFrom}T00:00:00Z`);
      conversionsParams.append('conversion_timestamp', `lte.${dateTo}T23:59:59Z`);

      const conversionsData = await supabase.queryWithSchema<any[]>(
        `revenue.conversions?${conversionsParams.toString()}`,
        'revenue',
        { method: 'GET' }
      ) || [];

      const conversions: ActualConversion[] = conversionsData.map(c => ({
        id: c.id,
        organization_id: c.organization_id,
        source_platform: c.source_platform,
        external_order_id: c.external_order_id,
        revenue_cents: c.revenue_cents,
        conversion_timestamp: new Date(c.conversion_timestamp),
        attributed_click_id: c.attributed_click_id,
        attributed_click_id_type: c.attributed_click_id_type,
        utm_source: c.utm_source,
        utm_medium: c.utm_medium,
        utm_campaign: c.utm_campaign,
        customer_email_hash: c.customer_email_hash
      }));

      // Fetch ad spend for ROAS calculation
      let adSpendCents = 0;
      try {
        const spendParams = new URLSearchParams();
        spendParams.append('org_tag', `eq.${tagMapping.short_tag}`);
        spendParams.append('date', `gte.${dateFrom}`);
        spendParams.append('date', `lte.${dateTo}`);

        // Try to get spend from platform-specific tables
        const platforms = platform === 'all'
          ? ['google_ads', 'meta_ads', 'tiktok_ads']
          : [platform];

        for (const plat of platforms) {
          let tableName = '';
          if (plat === 'google_ads') tableName = 'google_ads_daily';
          else if (plat === 'meta_ads') tableName = 'facebook_ads_daily';
          else if (plat === 'tiktok_ads') tableName = 'tiktok_ads_daily';

          if (tableName) {
            const spendData = await supabase.queryWithSchema<any[]>(
              `${tableName}?${spendParams.toString()}&select=spend`,
              tableName.split('_')[0],
              { method: 'GET' }
            ) || [];

            adSpendCents += spendData.reduce((sum: number, row: any) =>
              sum + Math.round((row.spend || 0) * 100), 0);
          }
        }
      } catch {
        // Ad spend fetch is optional, continue with 0
      }

      // Run reconciliation
      const result = reconciliationService.reconcile(
        orgId,
        platform,
        { start: dateFrom, end: dateTo },
        claims,
        conversions,
        adSpendCents
      );

      return success(c, {
        platform: result.platform,
        date_range: result.date_range,
        summary: {
          total_claims: result.total_claims,
          matched_claims: result.matched_claims,
          unmatched_claims: result.unmatched_claims,
          match_rate: result.total_claims > 0
            ? Math.round((result.matched_claims / result.total_claims) * 100)
            : 0
        },
        revenue: {
          claimed_cents: result.claimed_revenue_cents,
          verified_cents: result.verified_revenue_cents,
          discrepancy_cents: result.discrepancy_cents,
          discrepancy_percentage: Math.round(result.discrepancy_percentage * 10) / 10
        },
        roas: {
          claimed: Math.round(result.claimed_roas * 100) / 100,
          actual: Math.round(result.actual_roas * 100) / 100,
          inflation_percentage: Math.round(result.roas_inflation_percentage * 10) / 10
        },
        by_campaign: result.by_campaign.slice(0, 20).map(c => ({
          campaign_id: c.campaign_id,
          campaign_name: c.campaign_name,
          claimed_revenue_cents: c.claimed_revenue_cents,
          verified_revenue_cents: c.verified_revenue_cents,
          discrepancy_cents: c.discrepancy_cents,
          match_rate: Math.round(c.match_rate * 100) / 100
        }))
      });
    } catch (err: any) {
      console.error("Reconciliation query error:", err);
      return error(c, "INTERNAL_ERROR", "Failed to run reconciliation", 500);
    }
  }
}

/**
 * GET /v1/analytics/reconciliation/insights
 *
 * Get platform-specific reconciliation insights and recommendations.
 */
export class GetReconciliationInsights extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get platform reconciliation insights",
    description: "Analyze platform reporting reliability and get recommendations",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)")
      })
    },
    responses: {
      "200": {
        description: "Platform insights",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                insights: z.array(z.object({
                  platform: AdPlatformEnum,
                  avg_discrepancy_percentage: z.number(),
                  avg_match_rate: z.number(),
                  total_claimed_cents: z.number(),
                  total_verified_cents: z.number(),
                  trust_level: z.enum(['high', 'medium', 'low']),
                  recommendation: z.string()
                }))
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const query = c.req.query();

    const dateFrom = query.date_from;
    const dateTo = query.date_to;

    try {
      const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
      if (!supabaseKey) {
        return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
      }

      const supabase = new SupabaseClient({
        url: c.env.SUPABASE_URL,
        serviceKey: supabaseKey
      });

      // Get reconciliation results for each platform
      const platforms: AdPlatform[] = ['google_ads', 'meta_ads', 'tiktok_ads'];
      const results = [];

      for (const platform of platforms) {
        // Fetch claims
        const claimsParams = new URLSearchParams();
        claimsParams.append('organization_id', `eq.${orgId}`);
        claimsParams.append('claim_timestamp', `gte.${dateFrom}T00:00:00Z`);
        claimsParams.append('claim_timestamp', `lte.${dateTo}T23:59:59Z`);
        claimsParams.append('platform', `eq.${platform}`);

        const claimsData = await supabase.queryWithSchema<any[]>(
          `revenue.platform_conversion_claims?${claimsParams.toString()}`,
          'revenue',
          { method: 'GET' }
        ) || [];

        if (claimsData.length === 0) continue;

        const claims: PlatformClaim[] = claimsData.map(c => ({
          id: c.id,
          organization_id: c.organization_id,
          platform: c.platform,
          click_id: c.click_id,
          click_id_type: c.click_id_type,
          campaign_id: c.campaign_id,
          campaign_name: c.campaign_name,
          ad_group_id: c.ad_group_id,
          ad_id: c.ad_id,
          claimed_conversion_value_cents: c.claimed_conversion_value_cents,
          claimed_conversion_count: c.claimed_conversion_count || 1,
          claim_timestamp: new Date(c.claim_timestamp),
          reconciliation_status: c.reconciliation_status || 'pending',
          matched_conversion_id: c.matched_conversion_id,
          verified_revenue_cents: c.verified_revenue_cents,
          discrepancy_cents: c.discrepancy_cents,
          reconciled_at: c.reconciled_at ? new Date(c.reconciled_at) : null,
          created_at: new Date(c.created_at),
          updated_at: new Date(c.updated_at)
        }));

        // Fetch conversions
        const conversionsParams = new URLSearchParams();
        conversionsParams.append('organization_id', `eq.${orgId}`);
        conversionsParams.append('conversion_timestamp', `gte.${dateFrom}T00:00:00Z`);
        conversionsParams.append('conversion_timestamp', `lte.${dateTo}T23:59:59Z`);

        const conversionsData = await supabase.queryWithSchema<any[]>(
          `revenue.conversions?${conversionsParams.toString()}`,
          'revenue',
          { method: 'GET' }
        ) || [];

        const conversions: ActualConversion[] = conversionsData.map(c => ({
          id: c.id,
          organization_id: c.organization_id,
          source_platform: c.source_platform,
          external_order_id: c.external_order_id,
          revenue_cents: c.revenue_cents,
          conversion_timestamp: new Date(c.conversion_timestamp),
          attributed_click_id: c.attributed_click_id,
          attributed_click_id_type: c.attributed_click_id_type,
          utm_source: c.utm_source,
          utm_medium: c.utm_medium,
          utm_campaign: c.utm_campaign,
          customer_email_hash: c.customer_email_hash
        }));

        const result = reconciliationService.reconcile(
          orgId,
          platform,
          { start: dateFrom, end: dateTo },
          claims,
          conversions,
          0 // No ad spend needed for insights
        );

        results.push(result);
      }

      const insights = reconciliationService.getPlatformInsights(results);

      return success(c, {
        insights: insights.map(i => ({
          platform: i.platform,
          avg_discrepancy_percentage: Math.round(i.avg_discrepancy_percentage * 10) / 10,
          avg_match_rate: Math.round(i.avg_match_rate * 100) / 100,
          total_claimed_cents: i.total_claimed_cents,
          total_verified_cents: i.total_verified_cents,
          trust_level: i.trust_level,
          recommendation: i.recommendation
        }))
      });
    } catch (err: any) {
      console.error("Reconciliation insights error:", err);
      return error(c, "INTERNAL_ERROR", "Failed to generate insights", 500);
    }
  }
}

/**
 * POST /v1/analytics/reconciliation/import-claims
 *
 * Import platform conversion claims for reconciliation.
 */
export class ImportPlatformClaims extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Import platform claims",
    description: "Import conversion claims reported by ad platforms for reconciliation",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID")
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              platform: z.enum(['google_ads', 'meta_ads', 'tiktok_ads', 'microsoft_ads', 'linkedin_ads']),
              claims: z.array(z.object({
                click_id: z.string().describe("Platform click ID (gclid, fbclid, ttclid)"),
                click_id_type: z.enum(['gclid', 'fbclid', 'ttclid', 'msclid', 'li_fat_id']),
                campaign_id: z.string().optional(),
                campaign_name: z.string().optional(),
                ad_group_id: z.string().optional(),
                ad_id: z.string().optional(),
                claimed_conversion_value_cents: z.number().describe("Conversion value in cents"),
                claimed_conversion_count: z.number().optional().default(1),
                claim_timestamp: z.string().describe("ISO timestamp of the claimed conversion")
              }))
            })
          }
        }
      }
    },
    responses: {
      "200": {
        description: "Import result",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                imported: z.number(),
                platform: z.string()
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const body = await c.req.json() as {
      platform: AdPlatform;
      claims: PlatformClaimInput[];
    };

    const { platform, claims: claimInputs } = body;

    if (!claimInputs || claimInputs.length === 0) {
      return error(c, "VALIDATION_ERROR", "No claims provided", 400);
    }

    try {
      const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
      if (!supabaseKey) {
        return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
      }

      const supabase = new SupabaseClient({
        url: c.env.SUPABASE_URL,
        serviceKey: supabaseKey
      });

      // Transform inputs to claims
      const claims = reconciliationService.importPlatformClaims(
        orgId,
        platform,
        claimInputs.map(c => ({
          ...c,
          claim_timestamp: new Date(c.claim_timestamp)
        }))
      );

      // Insert into Supabase
      const insertData = claims.map(claim => ({
        id: claim.id,
        organization_id: claim.organization_id,
        platform: claim.platform,
        click_id: claim.click_id,
        click_id_type: claim.click_id_type,
        campaign_id: claim.campaign_id,
        campaign_name: claim.campaign_name,
        ad_group_id: claim.ad_group_id,
        ad_id: claim.ad_id,
        claimed_conversion_value_cents: claim.claimed_conversion_value_cents,
        claimed_conversion_count: claim.claimed_conversion_count,
        claim_timestamp: claim.claim_timestamp.toISOString(),
        reconciliation_status: claim.reconciliation_status,
        created_at: claim.created_at.toISOString(),
        updated_at: claim.updated_at.toISOString()
      }));

      await supabase.upsert('revenue.platform_conversion_claims', insertData, 'revenue');

      return success(c, {
        imported: claims.length,
        platform
      });
    } catch (err: any) {
      console.error("Import claims error:", err);
      return error(c, "INTERNAL_ERROR", "Failed to import claims", 500);
    }
  }
}
