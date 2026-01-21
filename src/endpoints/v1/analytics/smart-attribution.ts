/**
 * Smart Attribution API Endpoint
 *
 * GET /v1/analytics/smart-attribution
 *
 * Intelligent attribution that uses BOTH ad platform data AND UTM/tag data
 * with a confidence-based signal hierarchy.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { SmartAttributionService, type SignalType, type DataQualityLevel } from "../../../services/smart-attribution";

// Schema definitions for OpenAPI documentation
const SignalTypeEnum = z.enum([
  'click_id',
  'utm_with_spend',
  'utm_no_spend',
  'utm_only',
  'platform_only',
  'direct'
]);

const DataQualityLevelEnum = z.enum([
  'verified',
  'corroborated',
  'single_source',
  'estimated'
]);

const SignalAvailabilitySchema = z.object({
  platform: z.string(),
  hasClickIds: z.boolean(),
  clickIdCount: z.number(),
  hasUtmMatches: z.boolean(),
  utmSessionCount: z.number(),
  hasActiveSpend: z.boolean(),
  spendAmount: z.number(),
  hasPlatformReported: z.boolean(),
  platformConversions: z.number(),
  platformRevenue: z.number(),
  hasTagData: z.boolean(),
  tagConversions: z.number(),
  tagRevenue: z.number()
});

const SmartAttributionSchema = z.object({
  channel: z.string(),
  platform: z.string().nullable(),
  medium: z.string().nullable(),
  campaign: z.string().nullable(),
  conversions: z.number(),
  revenue: z.number(),
  confidence: z.number(),
  signalType: SignalTypeEnum,
  dataQuality: DataQualityLevelEnum,
  signals: SignalAvailabilitySchema,
  explanation: z.string()
});

/**
 * GET /v1/analytics/smart-attribution
 *
 * Get intelligent attribution using confidence-based signal hierarchy.
 */
export class GetSmartAttribution extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get smart attribution with confidence scoring",
    description: `
Intelligent attribution that combines ad platform data, UTM tracking, click IDs, and connector revenue.

**Signal Hierarchy (by confidence):**
| Priority | Signal Type | Confidence | Rule |
|----------|-------------|------------|------|
| 1 | Click ID Match (gclid/fbclid/ttclid) | 100% | Ground truth |
| 2 | UTM matches platform WITH spend | 95% | Corroborated |
| 3 | UTM matches platform NO spend | 90% | Platform inactive |
| 4 | UTM only (no platform match) | 85% | Organic/other |
| 5 | Platform-reported only | 70% | Only available signal |
| 6 | No signals | 0% | Direct/Unattributed |

**Key Principle:** Never dilute with arbitrary splits. Use the best available signal.

**Returns:**
- Channel breakdown with confidence scores (0-100)
- Signal type badges explaining attribution method
- Data quality indicators
- Recommendations to improve attribution accuracy
    `.trim(),
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)")
      })
    },
    responses: {
      "200": {
        description: "Smart attribution data with confidence scores",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                attributions: z.array(SmartAttributionSchema),
                summary: z.object({
                  totalConversions: z.number(),
                  totalRevenue: z.number(),
                  dataCompleteness: z.number().describe("Percentage of conversions with high-confidence attribution (0-100)"),
                  signalBreakdown: z.record(z.object({
                    count: z.number(),
                    percentage: z.number()
                  }))
                }),
                dataQuality: z.object({
                  hasPlatformData: z.boolean(),
                  hasTagData: z.boolean(),
                  hasClickIds: z.boolean(),
                  hasConnectorData: z.boolean(),
                  recommendations: z.array(z.string())
                })
              })
            })
          }
        }
      },
      "400": {
        description: "Bad request - invalid parameters"
      },
      "404": {
        description: "Organization not found"
      }
    }
  };

  async handle(c: AppContext) {
    // Use resolved org_id from requireOrg middleware
    const orgId = c.get("org_id" as any) as string;
    const query = c.req.query();

    const startDate = query.start_date;
    const endDate = query.end_date;

    if (!startDate || !endDate) {
      return error(c, "INVALID_PARAMS", "start_date and end_date are required", 400);
    }

    console.log(`[SmartAttribution API] Request: orgId=${orgId}, startDate=${startDate}, endDate=${endDate}`);

    // Get ANALYTICS_DB binding
    const analyticsDb = (c.env as any).ANALYTICS_DB || c.env.DB;

    // Create service and get attribution
    const service = new SmartAttributionService(analyticsDb, c.env.DB);
    const result = await service.getSmartAttribution(orgId, startDate, endDate);

    console.log(`[SmartAttribution API] Returning ${result.attributions.length} channels, ${result.summary.totalConversions} conversions`);

    return success(c, result);
  }
}
