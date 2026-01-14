/**
 * Revenue Reconciliation Endpoints
 *
 * Compare platform-reported conversions (claims) against actual verified revenue.
 * NOTE: This endpoint requires the platform_conversion_claims table to be populated
 * in D1 ANALYTICS_DB by the ad platform sync pipeline.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { D1Adapter } from "../../../adapters/d1";

const AdPlatformEnum = z.enum([
  'google_ads',
  'meta_ads',
  'tiktok_ads',
  'microsoft_ads',
  'linkedin_ads',
  'all'
]);

/**
 * GET /v1/analytics/reconciliation
 *
 * Get revenue reconciliation comparing platform claims vs actual conversions.
 * Currently returns empty results as the D1 platform_conversion_claims table
 * needs to be created and populated.
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

NOTE: Requires platform_conversion_claims data to be populated in D1.
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
    const platform = (query.platform || 'all') as string;

    const d1 = new D1Adapter(c.env.DB);
    const org = await d1.getOrganization(orgId);
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

    // TODO: Query D1 platform_conversion_claims table when available
    // For now, return empty results as this data is not yet populated in D1
    // The platform_conversion_claims table needs to be created and populated
    // by the ad platform sync pipeline.

    console.log(`[Reconciliation] Query for org ${orgId}, platform ${platform}, dates ${dateFrom} to ${dateTo} - returning empty (D1 table not yet populated)`);

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
}
