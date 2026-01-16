/**
 * Attribution Analytics Endpoints
 *
 * Multi-touch attribution with identity stitching support.
 * Supports: first_touch, last_touch, linear, time_decay, position_based
 *
 * NOTE: Currently returns platform-reported data from D1.
 * Tag-based attribution requires conversion_attribution table to be populated in D1.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { D1Adapter } from "../../../adapters/d1";
import {
  AttributionModel,
  AttributionConfig,
  calculateAttribution,
  aggregateAttributionByChannel,
  buildConversionPaths
} from "../../../services/attribution-models";

const AttributionModelEnum = z.enum([
  'platform',       // Self-reported by ad platforms (no attribution calculation)
  'first_touch',
  'last_touch',
  'linear',
  'time_decay',
  'position_based'
]);

// Data quality levels for "best available data" approach
// Ordered from highest to lowest confidence
type DataQuality =
  | 'verified'          // Connector revenue + tracked events (highest)
  | 'connector_only'    // Connector revenue, no journey events
  | 'tracked'           // Tracked conversions from tag
  | 'estimated'         // Events exist, using platform conversion counts
  | 'platform_reported'; // No events, pure platform self-reporting (lowest)

// Warning codes for insufficient data scenarios
type DataWarning =
  | 'no_events'                    // No tracked events at all
  | 'no_tracked_conversions'       // Events exist but no conversion events
  | 'insufficient_events'          // Too few events for reliable attribution
  | 'using_platform_conversions'   // Using platform-reported conversions
  | 'no_conversion_source'         // No conversion source configured
  | 'no_connector_conversions';    // Connector mode but no conversions found

// Connector conversion from revenue.conversions table
interface ConnectorConversion {
  id: string;
  organization_id: string;
  source_platform: string;  // 'stripe', 'shopify', 'hubspot', etc.
  source_connection_id: string;
  stripe_payment_intent_id: string | null;
  attributed_click_id: string | null;
  attributed_click_id_type: string | null;  // 'gclid', 'fbclid', 'ttclid', etc.
  customer_email_hash: string | null;
  net_revenue_cents: number;
  gross_revenue_cents: number;
  currency: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  reconciliation_status: 'pending' | 'matched' | 'unmatched' | 'discrepancy';
  conversion_timestamp: string;
  created_at: string;
}

// Conversion goal types
interface TriggerConfig {
  event_type?: string;
  page_pattern?: string;
  revenue_min?: number;
  custom_event?: string;
}

interface ConversionGoal {
  id: string;
  name: string;
  type: 'conversion' | 'micro_conversion' | 'engagement';
  trigger_config: TriggerConfig;
  default_value_cents: number;
  is_primary: boolean;
  include_in_path: boolean;
  priority: number;
}

// Event filter types
interface FilterRule {
  field: string;
  operator: string;
  value?: string | number | string[];
}

interface EventFilter {
  id: string;
  name: string;
  filter_type: 'include' | 'exclude';
  rules: FilterRule[];
  is_active: boolean;
}

// Helper: Query conversion goals from D1
async function getConversionGoals(db: D1Database, orgId: string): Promise<ConversionGoal[]> {
  const result = await db.prepare(`
    SELECT id, name, type, trigger_config, default_value_cents,
           is_primary, include_in_path, priority
    FROM conversion_goals
    WHERE organization_id = ?
    ORDER BY priority ASC
  `).bind(orgId).all();

  return (result.results || []).map(row => ({
    id: row.id as string,
    name: row.name as string,
    type: row.type as 'conversion' | 'micro_conversion' | 'engagement',
    trigger_config: JSON.parse(row.trigger_config as string || '{}'),
    default_value_cents: row.default_value_cents as number,
    is_primary: Boolean(row.is_primary),
    include_in_path: Boolean(row.include_in_path),
    priority: row.priority as number,
  }));
}

// Helper: Query event filters from D1
async function getEventFilters(db: D1Database, orgId: string): Promise<EventFilter[]> {
  const result = await db.prepare(`
    SELECT id, name, filter_type, rules, is_active
    FROM event_filters
    WHERE organization_id = ? AND is_active = 1
  `).bind(orgId).all();

  return (result.results || []).map(row => ({
    id: row.id as string,
    name: row.name as string,
    filter_type: row.filter_type as 'include' | 'exclude',
    rules: JSON.parse(row.rules as string || '[]'),
    is_active: Boolean(row.is_active),
  }));
}

// Helper: Check if an event matches a conversion goal
function eventMatchesGoal(event: any, goal: ConversionGoal): boolean {
  const { trigger_config } = goal;

  if (trigger_config.event_type) {
    if (event.event_type !== trigger_config.event_type) return false;
  }

  if (trigger_config.page_pattern) {
    const pattern = trigger_config.page_pattern;
    const pagePath = event.page_path || event.page_url || '';
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (!regex.test(pagePath)) return false;
    } else {
      if (pagePath !== pattern) return false;
    }
  }

  if (trigger_config.custom_event) {
    if (event.custom_event !== trigger_config.custom_event) return false;
  }

  if (trigger_config.revenue_min !== undefined) {
    const eventValue = event.value_cents || event.revenue_cents || 0;
    if (eventValue < trigger_config.revenue_min * 100) return false;
  }

  return true;
}

// Helper: Check if an event passes the filter rules
function eventPassesFilter(event: any, filter: EventFilter): boolean {
  // All rules must match (AND logic)
  for (const rule of filter.rules) {
    const eventValue = event[rule.field];

    let matches = false;
    switch (rule.operator) {
      case 'equals':
        matches = eventValue === rule.value;
        break;
      case 'not_equals':
        matches = eventValue !== rule.value;
        break;
      case 'contains':
        matches = typeof eventValue === 'string' && eventValue.includes(String(rule.value));
        break;
      case 'not_contains':
        matches = typeof eventValue === 'string' && !eventValue.includes(String(rule.value));
        break;
      case 'starts_with':
        matches = typeof eventValue === 'string' && eventValue.startsWith(String(rule.value));
        break;
      case 'ends_with':
        matches = typeof eventValue === 'string' && eventValue.endsWith(String(rule.value));
        break;
      case 'exists':
        matches = eventValue !== undefined && eventValue !== null && eventValue !== '';
        break;
      case 'not_exists':
        matches = eventValue === undefined || eventValue === null || eventValue === '';
        break;
      case 'in':
        matches = Array.isArray(rule.value) && rule.value.includes(eventValue);
        break;
      case 'not_in':
        matches = Array.isArray(rule.value) && !rule.value.includes(eventValue);
        break;
      default:
        matches = true;
    }

    if (!matches) return false;
  }

  return true;
}

// Helper: Apply filters to events
function applyEventFilters(events: any[], filters: EventFilter[]): any[] {
  if (filters.length === 0) return events;

  const includeFilters = filters.filter(f => f.filter_type === 'include');
  const excludeFilters = filters.filter(f => f.filter_type === 'exclude');

  return events.filter(event => {
    // If there are include filters, event must match at least one
    if (includeFilters.length > 0) {
      const matchesInclude = includeFilters.some(f => eventPassesFilter(event, f));
      if (!matchesInclude) return false;
    }

    // Event must not match any exclude filter
    for (const filter of excludeFilters) {
      if (eventPassesFilter(event, filter)) return false;
    }

    return true;
  });
}

// Helper: Identify conversions using goals
function identifyConversions(events: any[], goals: ConversionGoal[]): any[] {
  if (goals.length === 0) {
    // Fallback: use events with event_type in ['conversion', 'purchase']
    return events.filter(e =>
      e.event_type === 'conversion' || e.event_type === 'purchase'
    );
  }

  const conversions: any[] = [];
  const primaryGoal = goals.find(g => g.is_primary) || goals[0];

  for (const event of events) {
    // Check primary goal first for main conversions
    if (eventMatchesGoal(event, primaryGoal)) {
      conversions.push({
        ...event,
        _matched_goal: primaryGoal.name,
        _goal_type: primaryGoal.type,
        _conversion_value: event.value_cents || primaryGoal.default_value_cents,
      });
    }
  }

  return conversions;
}

// Helper: Map click ID type to platform
function mapClickIdToPlatform(clickIdType: string | null): string | null {
  if (!clickIdType) return null;

  const mapping: Record<string, string> = {
    'gclid': 'google',
    'gbraid': 'google',
    'wbraid': 'google',
    'fbclid': 'facebook',
    'ttclid': 'tiktok',
    'msclkid': 'microsoft',
    'li_fat_id': 'linkedin',
    'twclid': 'twitter',
    'sccid': 'snapchat',
    'pnclid': 'pinterest'
  };

  return mapping[clickIdType.toLowerCase()] || null;
}

// Helper: Map click ID type to medium
function mapClickIdToMedium(clickIdType: string | null): string {
  if (!clickIdType) return 'unknown';

  const mapping: Record<string, string> = {
    'gclid': 'cpc',
    'gbraid': 'cpc',
    'wbraid': 'cpc',
    'fbclid': 'paid',
    'ttclid': 'paid',
    'msclkid': 'cpc',
    'li_fat_id': 'paid',
    'twclid': 'paid',
    'sccid': 'paid',
    'pnclid': 'paid'
  };

  return mapping[clickIdType.toLowerCase()] || 'paid';
}

// Attribution result for connector conversions
interface ConnectorAttributionResult {
  utm_source: string;
  utm_medium: string | null;
  utm_campaign: string | null;
  touchpoints: number;
  conversions_in_path: number;
  attributed_conversions: number;
  attributed_revenue: number;
  avg_position_in_path: number;
  attribution_method: 'click_id' | 'email_hash' | 'utm_params' | 'unattributed';
  connector_source: string;  // 'stripe', 'shopify', 'hubspot', etc.
}

// Helper: Attribute connector conversions to campaigns
function attributeConnectorConversions(
  conversions: ConnectorConversion[],
  trackedEvents?: any[]  // Optional: tracked events for email hash matching
): {
  attributions: ConnectorAttributionResult[];
  summary: { total_conversions: number; total_revenue: number; attributed_count: number; unattributed_count: number };
} {
  // Group conversions by attribution source
  const attributionGroups = new Map<string, {
    conversions: ConnectorConversion[];
    method: 'click_id' | 'email_hash' | 'utm_params' | 'unattributed';
    source: string;
    medium: string | null;
    campaign: string | null;
    connector_source: string;
  }>();

  // Build email-to-UTM map from tracked events for email hash matching
  const emailHashToUtm = new Map<string, { utm_source: string; utm_medium: string; utm_campaign: string }>();
  if (trackedEvents) {
    for (const event of trackedEvents) {
      if (event.user_email_hash && event.utm_source) {
        // Use the most recent event for this email hash
        if (!emailHashToUtm.has(event.user_email_hash)) {
          emailHashToUtm.set(event.user_email_hash, {
            utm_source: event.utm_source,
            utm_medium: event.utm_medium || 'unknown',
            utm_campaign: event.utm_campaign || 'unknown'
          });
        }
      }
    }
  }

  let attributedCount = 0;
  let unattributedCount = 0;

  for (const conversion of conversions) {
    let method: 'click_id' | 'email_hash' | 'utm_params' | 'unattributed' = 'unattributed';
    let source: string = 'unattributed';
    let medium: string | null = null;
    let campaign: string | null = null;

    // Priority 1: Click ID attribution (highest confidence)
    if (conversion.attributed_click_id && conversion.attributed_click_id_type) {
      const platform = mapClickIdToPlatform(conversion.attributed_click_id_type);
      if (platform) {
        method = 'click_id';
        source = platform;
        medium = mapClickIdToMedium(conversion.attributed_click_id_type);
        campaign = conversion.utm_campaign || 'unknown';
        attributedCount++;
      }
    }

    // Priority 2: UTM parameters from conversion
    if (method === 'unattributed' && conversion.utm_source) {
      method = 'utm_params';
      source = conversion.utm_source;
      medium = conversion.utm_medium;
      campaign = conversion.utm_campaign;
      attributedCount++;
    }

    // Priority 3: Email hash matching to tracked events
    if (method === 'unattributed' && conversion.customer_email_hash && emailHashToUtm.has(conversion.customer_email_hash)) {
      const utmData = emailHashToUtm.get(conversion.customer_email_hash)!;
      method = 'email_hash';
      source = utmData.utm_source;
      medium = utmData.utm_medium;
      campaign = utmData.utm_campaign;
      attributedCount++;
    }

    // If still unattributed, mark as such
    if (method === 'unattributed') {
      unattributedCount++;
    }

    // Get connector source from conversion (defaults to 'stripe' for backward compatibility)
    const connectorSource = conversion.source_platform || 'stripe';

    // Create group key - include connector_source for aggregation
    const groupKey = `${source}|${medium || 'unknown'}|${campaign || 'unknown'}|${method}|${connectorSource}`;

    if (!attributionGroups.has(groupKey)) {
      attributionGroups.set(groupKey, {
        conversions: [],
        method,
        source,
        medium,
        campaign,
        connector_source: connectorSource
      });
    }
    attributionGroups.get(groupKey)!.conversions.push(conversion);
  }

  // Build attribution results
  const attributions: ConnectorAttributionResult[] = [];
  let totalRevenue = 0;

  for (const [_, group] of attributionGroups) {
    const groupRevenue = group.conversions.reduce((sum, c) => sum + (c.net_revenue_cents / 100), 0);
    totalRevenue += groupRevenue;

    attributions.push({
      utm_source: group.source,
      utm_medium: group.medium,
      utm_campaign: group.campaign,
      touchpoints: 0,  // N/A for connector-only attribution
      conversions_in_path: group.conversions.length,
      attributed_conversions: group.conversions.length,
      attributed_revenue: Math.round(groupRevenue * 100) / 100,
      avg_position_in_path: 0,  // N/A for connector-only attribution
      attribution_method: group.method,
      connector_source: group.connector_source
    });
  }

  // Sort by attributed revenue descending
  attributions.sort((a, b) => b.attributed_revenue - a.attributed_revenue);

  return {
    attributions,
    summary: {
      total_conversions: conversions.length,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      attributed_count: attributedCount,
      unattributed_count: unattributedCount
    }
  };
}

interface DataQualityInfo {
  quality: DataQuality;
  warnings: DataWarning[];
  event_count: number;
  conversion_count: number;
  fallback_source?: 'ad_platforms' | 'connectors' | null;
  conversion_source_setting?: 'tag' | 'ad_platforms' | 'connectors';
}

/**
 * Helper: Build platform fallback attributions from D1 ANALYTICS_DB
 */
async function buildPlatformFallbackD1(
  analyticsDb: D1Database,
  mainDb: D1Database,
  orgId: string,
  dateRange: { start: string; end: string }
): Promise<{
  attributions: any[];
  summary: { total_conversions: number; total_revenue: number };
}> {
  try {
    // Get active platform connections
    const connections = await mainDb.prepare(`
      SELECT DISTINCT platform FROM platform_connections
      WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).all<{ platform: string }>();

    const platforms = connections.results?.map(r => r.platform) || [];
    console.log(`[Attribution D1 Fallback] orgId=${orgId}, platforms=${JSON.stringify(platforms)}`);

    if (platforms.length === 0) {
      return { attributions: [], summary: { total_conversions: 0, total_revenue: 0 } };
    }

    const allCampaigns: any[] = [];
    let totalConversions = 0;
    let totalRevenue = 0;

    for (const platform of platforms) {
      try {
        const metricsTable = `${platform}_campaign_daily_metrics`;
        const campaignsTable = `${platform}_campaigns`;

        // Query aggregated metrics by campaign
        const metricsResult = await analyticsDb.prepare(`
          SELECT
            m.campaign_ref,
            c.name as campaign_name,
            SUM(m.conversions) as conversions,
            SUM(m.conversion_value_cents) as conversion_value_cents
          FROM ${metricsTable} m
          LEFT JOIN ${campaignsTable} c ON m.campaign_ref = c.id
          WHERE m.org_id = ?
            AND m.date >= ?
            AND m.date <= ?
          GROUP BY m.campaign_ref, c.name
        `).bind(orgId, dateRange.start, dateRange.end).all<{
          campaign_ref: string;
          campaign_name: string | null;
          conversions: number;
          conversion_value_cents: number;
        }>();

        for (const row of metricsResult.results || []) {
          const conversions = row.conversions || 0;
          const revenue = (row.conversion_value_cents || 0) / 100;
          const medium = platform === 'google' ? 'cpc' : 'paid';

          allCampaigns.push({
            utm_source: platform,
            utm_medium: medium,
            utm_campaign: row.campaign_name || row.campaign_ref,
            touchpoints: 0,
            conversions_in_path: 0,
            attributed_conversions: conversions,
            attributed_revenue: revenue,
            avg_position_in_path: 0
          });

          totalConversions += conversions;
          totalRevenue += revenue;
        }
      } catch (err) {
        // Table might not exist for this platform
        console.warn(`[Attribution D1 Fallback] Failed to query ${platform}:`, err);
      }
    }

    // Sort by attributed_conversions descending
    allCampaigns.sort((a, b) => b.attributed_conversions - a.attributed_conversions);

    console.log(`[Attribution D1 Fallback] Returning ${allCampaigns.length} campaigns, ${totalConversions} conversions`);
    return {
      attributions: allCampaigns,
      summary: { total_conversions: totalConversions, total_revenue: totalRevenue }
    };
  } catch (err) {
    console.error('[Attribution D1 Fallback] Error:', err);
    return { attributions: [], summary: { total_conversions: 0, total_revenue: 0 } };
  }
}

/**
 * GET /v1/analytics/attribution
 *
 * Multi-touch attribution with identity stitching.
 *
 * NOTE: Currently returns platform-reported data from D1 ANALYTICS_DB.
 * Tag-based multi-touch attribution requires the conversion_attribution
 * table to be populated in D1.
 */
export class GetAttribution extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get marketing attribution data",
    description: `
Analyze which marketing channels are driving conversions using multi-touch attribution.

**Attribution Models:**
- **first_touch**: 100% credit to first touchpoint
- **last_touch**: 100% credit to last touchpoint before conversion
- **linear**: Equal credit to all touchpoints
- **time_decay**: More credit to recent touchpoints (configurable half-life)
- **position_based**: 40% first, 40% last, 20% middle (U-shape)

**Identity Stitching:**
When enabled, links anonymous sessions to identified users for accurate cross-device attribution.

**NOTE:** Currently returns platform-reported data. Tag-based attribution requires D1 tables to be populated.
    `.trim(),
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
        model: AttributionModelEnum.optional().describe("Attribution model (default: from org settings or last_touch)"),
        attribution_window: z.coerce.number().min(1).max(180).optional().describe("Days to look back for touchpoints (default: from org settings or 30)"),
        time_decay_half_life: z.coerce.number().min(1).max(90).optional().describe("Half-life in days for time_decay model (default: from org settings or 7)"),
        use_identity_stitching: z.enum(['true', 'false']).optional().default('true').describe("Enable identity stitching for cross-device attribution"),
        source: z.enum(['auto', 'all', 'tag', 'connectors', 'ad_platforms']).optional().describe("Data source override: 'auto' uses org settings, 'all' combines all sources, or specify a specific source")
      })
    },
    responses: {
      "200": {
        description: "Attribution data with per-channel breakdown",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                model: AttributionModelEnum,
                config: z.object({
                  attribution_window_days: z.number(),
                  time_decay_half_life_days: z.number(),
                  identity_stitching_enabled: z.boolean()
                }),
                // Data quality info for "best available data" approach
                data_quality: z.object({
                  quality: z.enum(['verified', 'connector_only', 'tracked', 'estimated', 'platform_reported']),
                  warnings: z.array(z.string()),
                  event_count: z.number(),
                  conversion_count: z.number(),
                  fallback_source: z.string().nullable().optional(),
                  conversion_source_setting: z.enum(['tag', 'ad_platforms', 'connectors']).optional()
                }),
                attributions: z.array(z.object({
                  utm_source: z.string(),
                  utm_medium: z.string().nullable(),
                  utm_campaign: z.string().nullable(),
                  touchpoints: z.number(),
                  conversions_in_path: z.number(),
                  attributed_conversions: z.number(),
                  attributed_revenue: z.number(),
                  avg_position_in_path: z.number()
                })),
                summary: z.object({
                  total_conversions: z.number(),
                  total_revenue: z.number(),
                  avg_path_length: z.number(),
                  avg_days_to_convert: z.number(),
                  identified_users: z.number(),
                  anonymous_sessions: z.number()
                })
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;
    const query = c.req.query();

    const dateFrom = query.date_from;
    const dateTo = query.date_to;
    const useIdentityStitching = query.use_identity_stitching !== 'false';

    console.log(`[Attribution] Request: orgId=${orgId}, dateFrom=${dateFrom}, dateTo=${dateTo}, model=${query.model}`);

    // Get org settings for defaults
    const d1 = new D1Adapter(c.env.DB);
    const org = await d1.getOrganizationWithAttribution(orgId);
    if (!org) {
      return error(c, "NOT_FOUND", "Organization not found", 404);
    }

    // Get conversion_source setting from ai_optimization_settings
    const optimizationSettings = await c.env.DB.prepare(`
      SELECT conversion_source FROM ai_optimization_settings WHERE org_id = ?
    `).bind(orgId).first<{ conversion_source: string | null }>();

    // Check for source override from query parameter
    const sourceOverride = query.source as 'auto' | 'all' | 'tag' | 'connectors' | 'ad_platforms' | undefined;
    const settingsSource = (optimizationSettings?.conversion_source || 'tag') as 'tag' | 'ad_platforms' | 'connectors';

    // Use source override if provided and not 'auto', otherwise use org settings
    const conversionSource = (sourceOverride && sourceOverride !== 'auto')
      ? sourceOverride
      : settingsSource;
    console.log(`[Attribution] source override: ${sourceOverride}, settings: ${settingsSource}, using: ${conversionSource}`);

    // Build config from query params and org defaults
    const requestedModel = (query.model || org.default_attribution_model || 'last_touch') as AttributionModel;
    const model = conversionSource === 'ad_platforms' ? 'platform' as AttributionModel : requestedModel;
    const attributionWindowDays = query.attribution_window
      ? parseInt(query.attribution_window)
      : org.attribution_window_days;
    const timeDecayHalfLifeDays = query.time_decay_half_life
      ? parseInt(query.time_decay_half_life)
      : org.time_decay_half_life_days;

    // Get ANALYTICS_DB binding (with fallback to DB for backwards compat)
    const analyticsDb = (c.env as any).ANALYTICS_DB || c.env.DB;

    // For all sources, use D1 platform data as the source of truth
    // Tag-based and connector-based attribution require D1 tables to be populated
    console.log(`[Attribution] Using D1 platform data (conversion_source=${conversionSource})`);

    const fallback = await buildPlatformFallbackD1(
      analyticsDb,
      c.env.DB,
      orgId,
      { start: dateFrom, end: dateTo }
    );

    // Determine warnings based on conversion source setting
    const warnings: DataWarning[] = ['using_platform_conversions'];
    if (conversionSource === 'tag') {
      warnings.push('no_events');
    } else if (conversionSource === 'connectors') {
      warnings.push('no_connector_conversions');
    }

    return success(c, {
      model: 'platform' as AttributionModel,
      config: {
        attribution_window_days: attributionWindowDays,
        time_decay_half_life_days: timeDecayHalfLifeDays,
        identity_stitching_enabled: useIdentityStitching
      },
      data_quality: {
        quality: 'platform_reported' as DataQuality,
        warnings,
        event_count: 0,
        conversion_count: 0,
        fallback_source: 'ad_platforms',
        conversion_source_setting: conversionSource === 'all' ? settingsSource : conversionSource
      },
      attributions: fallback.attributions,
      summary: {
        total_conversions: fallback.summary.total_conversions,
        total_revenue: fallback.summary.total_revenue,
        avg_path_length: 0,
        avg_days_to_convert: 0,
        identified_users: 0,
        anonymous_sessions: 0
      }
    });
  }
}

/**
 * GET /v1/analytics/attribution/compare
 *
 * Compare attribution across multiple models side-by-side.
 *
 * NOTE: Currently returns platform-reported data. Model comparison
 * requires conversion_attribution table to be populated in D1.
 */
export class GetAttributionComparison extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Compare attribution models",
    description: "Run multiple attribution models and compare results side-by-side. NOTE: Currently returns platform data only.",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
        models: z.string().optional().describe("Comma-separated models to compare (default: all)")
      })
    },
    responses: {
      "200": {
        description: "Comparison of attribution models",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                models: z.array(z.object({
                  model: AttributionModelEnum,
                  attributions: z.array(z.object({
                    utm_source: z.string(),
                    attributed_conversions: z.number(),
                    attributed_revenue: z.number()
                  }))
                })),
                summary: z.object({
                  total_conversions: z.number(),
                  total_revenue: z.number()
                })
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;
    const query = c.req.query();

    const dateFrom = query.date_from;
    const dateTo = query.date_to;

    const modelsParam = query.models || 'first_touch,last_touch,linear,time_decay,position_based';
    const models = modelsParam.split(',').map(m => m.trim()) as AttributionModel[];

    const d1 = new D1Adapter(c.env.DB);
    const org = await d1.getOrganizationWithAttribution(orgId);
    if (!org) {
      return error(c, "NOT_FOUND", "Organization not found", 404);
    }

    // Get ANALYTICS_DB binding
    const analyticsDb = (c.env as any).ANALYTICS_DB || c.env.DB;

    // TODO: When conversion_attribution table is available in D1,
    // implement actual model comparison logic here.
    // For now, return the same platform data for all models.

    console.log(`[Attribution Compare] Returning platform data (D1 conversion_attribution not yet populated)`);

    const fallback = await buildPlatformFallbackD1(
      analyticsDb,
      c.env.DB,
      orgId,
      { start: dateFrom, end: dateTo }
    );

    // Return same data for all models (platform-reported doesn't support multi-touch)
    const modelResults = models.map(model => ({
      model,
      attributions: fallback.attributions.slice(0, 10).map(a => ({
        utm_source: a.utm_source,
        attributed_conversions: Math.round(a.attributed_conversions * 100) / 100,
        attributed_revenue: Math.round(a.attributed_revenue * 100) / 100
      }))
    }));

    return success(c, {
      models: modelResults,
      summary: {
        total_conversions: fallback.summary.total_conversions,
        total_revenue: Math.round(fallback.summary.total_revenue * 100) / 100
      }
    });
  }
}

/**
 * POST /v1/analytics/attribution/run
 *
 * Trigger Markov Chain and Shapley Value attribution workflow.
 * These models are compute-intensive and run as a background workflow.
 */
export class RunAttributionAnalysis extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Run attribution analysis workflow",
    description: "Trigger Markov Chain and Shapley Value attribution calculation. Returns a job ID to poll for completion.",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        days: z.coerce.number().optional().default(30).describe("Days of data to analyze")
      })
    },
    responses: {
      "200": {
        description: "Analysis job started",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                job_id: z.string(),
                status: z.enum(['pending', 'running', 'completed', 'failed'])
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();

    const orgId = c.get("org_id" as any) || data.query.org_id;
    const days = data.query.days || 30;
    const jobId = crypto.randomUUID().replace(/-/g, '');

    // Create job record
    await c.env.AI_DB.prepare(`
      INSERT INTO analysis_jobs (id, organization_id, type, status, created_at)
      VALUES (?, ?, 'attribution', 'pending', datetime('now'))
    `).bind(jobId, orgId).run();

    // Start the workflow
    try {
      const workflow = (c.env as any).ATTRIBUTION_WORKFLOW;
      if (!workflow) {
        return error(c, "WORKFLOW_NOT_CONFIGURED", "Attribution workflow not configured", 500);
      }

      await workflow.create({
        id: jobId,
        params: { orgId, jobId, days }
      });

      console.log(`[Attribution] Started workflow ${jobId} for org ${orgId} (${days} days)`);

      return success(c, {
        job_id: jobId,
        status: 'pending'
      });
    } catch (err: any) {
      // Update job status to failed
      await c.env.AI_DB.prepare(`
        UPDATE analysis_jobs SET status = 'failed', result = ?
        WHERE id = ?
      `).bind(JSON.stringify({ error: err.message }), jobId).run();

      console.error(`[Attribution] Failed to start workflow:`, err);
      return error(c, "WORKFLOW_START_FAILED", `Failed to start attribution analysis: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/attribution/status/:job_id
 *
 * Get the status of an attribution analysis job.
 */
export class GetAttributionJobStatus extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get attribution job status",
    description: "Check the status of an attribution analysis workflow",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        job_id: z.string().describe("Job ID from run endpoint")
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID")
      })
    },
    responses: {
      "200": {
        description: "Job status",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                job_id: z.string(),
                status: z.enum(['pending', 'running', 'completed', 'failed']),
                result: z.any().optional(),
                created_at: z.string(),
                completed_at: z.string().nullable()
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();

    const orgId = c.get("org_id" as any) || data.query.org_id;

    const job = await c.env.AI_DB.prepare(`
      SELECT id, status, result, created_at, completed_at
      FROM analysis_jobs
      WHERE id = ? AND organization_id = ? AND type = 'attribution'
    `).bind(data.params.job_id, orgId).first<{
      id: string;
      status: string;
      result: string | null;
      created_at: string;
      completed_at: string | null;
    }>();

    if (!job) {
      return error(c, "JOB_NOT_FOUND", "Job not found", 404);
    }

    return success(c, {
      job_id: job.id,
      status: job.status,
      result: job.result ? JSON.parse(job.result) : null,
      created_at: job.created_at,
      completed_at: job.completed_at
    });
  }
}

/**
 * GET /v1/analytics/attribution/computed
 *
 * Get pre-computed Markov Chain or Shapley Value attribution results.
 */
export class GetComputedAttribution extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get computed attribution results",
    description: "Retrieve pre-computed Markov Chain or Shapley Value attribution. Run the attribution workflow first.",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        model: z.enum(['markov_chain', 'shapley_value']).describe("Attribution model")
      })
    },
    responses: {
      "200": {
        description: "Computed attribution results",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                model: z.enum(['markov_chain', 'shapley_value']),
                computation_date: z.string(),
                attributions: z.array(z.object({
                  channel: z.string(),
                  attributed_credit: z.number(),
                  removal_effect: z.number().nullable(),
                  shapley_value: z.number().nullable()
                })),
                metadata: z.object({
                  conversion_count: z.number(),
                  path_count: z.number()
                })
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();

    const orgId = c.get("org_id" as any) || data.query.org_id;
    const model = data.query.model;

    // Get most recent computed results
    const results = await c.env.AI_DB.prepare(`
      SELECT channel, attributed_credit, removal_effect, shapley_value,
             computation_date, conversion_count, path_count
      FROM attribution_model_results
      WHERE organization_id = ?
        AND model = ?
        AND expires_at > datetime('now')
      ORDER BY computation_date DESC
    `).bind(orgId, model).all<{
      channel: string;
      attributed_credit: number;
      removal_effect: number | null;
      shapley_value: number | null;
      computation_date: string;
      conversion_count: number;
      path_count: number;
    }>();

    if (!results.results || results.results.length === 0) {
      return error(c, "NO_RESULTS", `No ${model} results available. Run attribution analysis first.`, 404);
    }

    const first = results.results[0];

    return success(c, {
      model,
      computation_date: first.computation_date,
      attributions: results.results.map(r => ({
        channel: r.channel,
        attributed_credit: r.attributed_credit,
        removal_effect: r.removal_effect,
        shapley_value: r.shapley_value
      })),
      metadata: {
        conversion_count: first.conversion_count,
        path_count: first.path_count
      }
    });
  }
}
