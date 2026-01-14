/**
 * Attribution Analytics Endpoints
 *
 * Multi-touch attribution with identity stitching support.
 * Supports: first_touch, last_touch, linear, time_decay, position_based
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";
import { D1Adapter } from "../../../adapters/d1";
import { GoogleAdsSupabaseAdapter } from "../../../adapters/platforms/google-supabase";
import { FacebookSupabaseAdapter } from "../../../adapters/platforms/facebook-supabase";
import { TikTokAdsSupabaseAdapter } from "../../../adapters/platforms/tiktok-supabase";
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

// Helper: Query connector conversions from conversions.unified table
async function queryConnectorConversions(
  supabase: SupabaseClient,
  orgId: string,
  dateRange: { start: string; end: string }
): Promise<ConnectorConversion[]> {
  try {
    // Query conversions.unified table via Supabase REST API
    const params = new URLSearchParams();
    params.append('organization_id', `eq.${orgId}`);
    params.append('conversion_timestamp', `gte.${dateRange.start}T00:00:00Z`);
    params.append('conversion_timestamp', `lte.${dateRange.end}T23:59:59Z`);
    params.append('select', '*');
    params.append('order', 'conversion_timestamp.desc');
    params.append('limit', '10000');

    const conversions = await supabase.queryWithSchema<ConnectorConversion[]>(
      `unified?${params.toString()}`,
      'conversions',
      { method: 'GET' }
    ) || [];

    console.log(`[Attribution] queryConnectorConversions: ${conversions.length} conversions found for orgId=${orgId}`);
    return conversions;
  } catch (err) {
    console.error('[Attribution] queryConnectorConversions error:', err);
    return [];
  }
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
 * GET /v1/analytics/attribution
 *
 * Multi-touch attribution with identity stitching.
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

    // Handle 'all' source - combine data from all available sources
    if (conversionSource === 'all') {
      console.log(`[Attribution] source=all, combining all data sources`);

      try {
        const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
        if (!supabaseKey) {
          return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
        }

        const supabase = new SupabaseClient({
          url: c.env.SUPABASE_URL,
          secretKey: supabaseKey
        });

        // Get org settings for attribution window
        const attributionWindowDays = query.attribution_window
          ? parseInt(query.attribution_window)
          : org.attribution_window_days;
        const timeDecayHalfLifeDays = query.time_decay_half_life
          ? parseInt(query.time_decay_half_life)
          : org.time_decay_half_life_days;

        // Collect attributions from all sources
        const allAttributions: Map<string, {
          utm_source: string;
          utm_medium: string | null;
          utm_campaign: string | null;
          touchpoints: number;
          conversions_in_path: number;
          attributed_conversions: number;
          attributed_revenue: number;
          avg_position_in_path: number;
          source_type: string;
        }> = new Map();

        let totalConversions = 0;
        let totalRevenue = 0;
        const dataQualityWarnings: DataWarning[] = [];
        let eventCount = 0;
        let conversionCount = 0;

        // 1. Query ad platform data
        const connections = await c.env.DB.prepare(`
          SELECT DISTINCT platform FROM platform_connections
          WHERE organization_id = ? AND is_active = 1
        `).bind(orgId).all<{ platform: string }>();

        const platforms = connections.results?.map(r => r.platform) || [];
        console.log(`[Attribution all] Found ${platforms.length} connected platforms`);

        for (const platform of platforms) {
          try {
            if (platform === 'google') {
              const adapter = new GoogleAdsSupabaseAdapter(supabase);
              const campaigns = await adapter.getCampaignsWithMetrics(orgId, { start: dateFrom, end: dateTo });
              for (const campaign of campaigns) {
                const conversions = campaign.metrics.conversions || 0;
                const revenue = (campaign.metrics.conversion_value_cents || 0) / 100;
                const key = `google|cpc|${campaign.campaign_name}`;
                if (!allAttributions.has(key)) {
                  allAttributions.set(key, {
                    utm_source: 'google', utm_medium: 'cpc', utm_campaign: campaign.campaign_name,
                    touchpoints: 0, conversions_in_path: 0, attributed_conversions: conversions,
                    attributed_revenue: revenue, avg_position_in_path: 0, source_type: 'ad_platform'
                  });
                } else {
                  const existing = allAttributions.get(key)!;
                  existing.attributed_conversions += conversions;
                  existing.attributed_revenue += revenue;
                }
                totalConversions += conversions;
                totalRevenue += revenue;
              }
            } else if (platform === 'facebook') {
              const adapter = new FacebookSupabaseAdapter(supabase);
              const campaigns = await adapter.getCampaignsWithMetrics(orgId, { start: dateFrom, end: dateTo });
              for (const campaign of campaigns) {
                const conversions = campaign.metrics.conversions || 0;
                const revenue = ((campaign.metrics as any).conversion_value_cents || 0) / 100;
                const key = `facebook|paid|${campaign.campaign_name}`;
                if (!allAttributions.has(key)) {
                  allAttributions.set(key, {
                    utm_source: 'facebook', utm_medium: 'paid', utm_campaign: campaign.campaign_name,
                    touchpoints: 0, conversions_in_path: 0, attributed_conversions: conversions,
                    attributed_revenue: revenue, avg_position_in_path: 0, source_type: 'ad_platform'
                  });
                } else {
                  const existing = allAttributions.get(key)!;
                  existing.attributed_conversions += conversions;
                  existing.attributed_revenue += revenue;
                }
                totalConversions += conversions;
                totalRevenue += revenue;
              }
            } else if (platform === 'tiktok') {
              const adapter = new TikTokAdsSupabaseAdapter(supabase);
              const campaigns = await adapter.getCampaigns(orgId);
              const metrics = await adapter.getCampaignDailyMetrics(orgId, { start: dateFrom, end: dateTo });
              const metricsByCampaign: Record<string, { conversions: number; revenue: number }> = {};
              for (const m of metrics) {
                const ref = (m as any).campaign_ref;
                if (!metricsByCampaign[ref]) metricsByCampaign[ref] = { conversions: 0, revenue: 0 };
                metricsByCampaign[ref].conversions += m.conversions || 0;
                metricsByCampaign[ref].revenue += (m.conversion_value_cents || 0) / 100;
              }
              for (const campaign of campaigns) {
                const cm = metricsByCampaign[campaign.id] || { conversions: 0, revenue: 0 };
                const key = `tiktok|paid|${campaign.campaign_name}`;
                if (!allAttributions.has(key)) {
                  allAttributions.set(key, {
                    utm_source: 'tiktok', utm_medium: 'paid', utm_campaign: campaign.campaign_name,
                    touchpoints: 0, conversions_in_path: 0, attributed_conversions: cm.conversions,
                    attributed_revenue: cm.revenue, avg_position_in_path: 0, source_type: 'ad_platform'
                  });
                } else {
                  const existing = allAttributions.get(key)!;
                  existing.attributed_conversions += cm.conversions;
                  existing.attributed_revenue += cm.revenue;
                }
                totalConversions += cm.conversions;
                totalRevenue += cm.revenue;
              }
            }
          } catch (err) {
            console.warn(`[Attribution all] Failed to fetch ${platform}:`, err);
          }
        }

        // 2. Query connector conversions (Stripe, Shopify, etc.)
        const connectorConversions = await queryConnectorConversions(supabase, orgId, { start: dateFrom, end: dateTo });
        if (connectorConversions.length > 0) {
          const { attributions: connectorAttrs, summary } = attributeConnectorConversions(connectorConversions);
          for (const attr of connectorAttrs) {
            const key = `${attr.utm_source}|${attr.utm_medium || 'unknown'}|${attr.utm_campaign || 'unknown'}|connector`;
            if (!allAttributions.has(key)) {
              allAttributions.set(key, {
                utm_source: attr.utm_source,
                utm_medium: attr.utm_medium,
                utm_campaign: attr.utm_campaign,
                touchpoints: attr.touchpoints,
                conversions_in_path: attr.conversions_in_path,
                attributed_conversions: attr.attributed_conversions,
                attributed_revenue: attr.attributed_revenue,
                avg_position_in_path: attr.avg_position_in_path,
                source_type: 'connector'
              });
            } else {
              const existing = allAttributions.get(key)!;
              existing.attributed_conversions += attr.attributed_conversions;
              existing.attributed_revenue += attr.attributed_revenue;
            }
          }
          // Don't add to totalConversions/totalRevenue to avoid double counting
          // Platform conversions may overlap with connector conversions
          conversionCount += summary.total_conversions;
        }

        // 3. Query tag-based tracked events if tag mapping exists
        const tagMapping = await c.env.DB.prepare(`
          SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
        `).bind(orgId).first<{ short_tag: string }>();

        if (tagMapping) {
          const params = new URLSearchParams();
          params.append('org_tag', `eq.${tagMapping.short_tag}`);
          params.append('conversion_timestamp', `gte.${dateFrom}T00:00:00Z`);
          params.append('conversion_timestamp', `lte.${dateTo}T23:59:59Z`);
          params.append('limit', '10000');

          const events = await supabase.queryWithSchema<any[]>(
            `conversion_attribution?${params.toString()}`,
            'events',
            { method: 'GET' }
          ) || [];

          eventCount = events.length;
          console.log(`[Attribution all] Tag events: ${eventCount}`);

          if (events.length > 0) {
            // Note: Tag-based attribution is included in the event count for data quality
            // but we don't add to totalConversions to avoid double counting
          }
        }

        // Build final attributions array
        const attributionsArray = Array.from(allAttributions.values())
          .sort((a, b) => b.attributed_conversions - a.attributed_conversions)
          .map(a => ({
            utm_source: a.utm_source,
            utm_medium: a.utm_medium,
            utm_campaign: a.utm_campaign,
            touchpoints: a.touchpoints,
            conversions_in_path: a.conversions_in_path,
            attributed_conversions: Math.round(a.attributed_conversions * 100) / 100,
            attributed_revenue: Math.round(a.attributed_revenue * 100) / 100,
            avg_position_in_path: a.avg_position_in_path
          }));

        // Determine overall data quality
        const hasAdPlatforms = platforms.length > 0;
        const hasConnectors = connectorConversions.length > 0;
        const hasTagEvents = eventCount > 0;

        let dataQuality: DataQuality = 'platform_reported';
        if (hasConnectors && hasTagEvents) {
          dataQuality = 'verified';
        } else if (hasConnectors) {
          dataQuality = 'connector_only';
        } else if (hasTagEvents) {
          dataQuality = 'tracked';
        }

        console.log(`[Attribution all] Combined: ${attributionsArray.length} channels, ${totalConversions} conversions, quality=${dataQuality}`);

        return success(c, {
          model: 'platform' as AttributionModel,  // Combined view uses platform aggregation
          config: {
            attribution_window_days: attributionWindowDays,
            time_decay_half_life_days: timeDecayHalfLifeDays,
            identity_stitching_enabled: query.use_identity_stitching !== 'false'
          },
          data_quality: {
            quality: dataQuality,
            warnings: dataQualityWarnings,
            event_count: eventCount,
            conversion_count: conversionCount,
            fallback_source: 'all',
            conversion_source_setting: settingsSource
          },
          attributions: attributionsArray,
          summary: {
            total_conversions: totalConversions,
            total_revenue: Math.round(totalRevenue * 100) / 100,
            avg_path_length: 0,
            avg_days_to_convert: 0,
            identified_users: conversionCount,  // Use connector count as proxy
            anonymous_sessions: eventCount
          }
        });
      } catch (err) {
        console.error('[Attribution all] Error:', err);
        return error(c, "INTERNAL_ERROR", "Failed to fetch attribution data", 500);
      }
    }

    // Build config from query params and org defaults
    // If conversion_source is 'ad_platforms', we'll use platform model regardless of what's requested
    const requestedModel = (query.model || org.default_attribution_model || 'last_touch') as AttributionModel;
    const model = conversionSource === 'ad_platforms' ? 'platform' as AttributionModel : requestedModel;
    const attributionWindowDays = query.attribution_window
      ? parseInt(query.attribution_window)
      : org.attribution_window_days;
    const timeDecayHalfLifeDays = query.time_decay_half_life
      ? parseInt(query.time_decay_half_life)
      : org.time_decay_half_life_days;

    const config: AttributionConfig = {
      model,
      attribution_window_days: attributionWindowDays,
      time_decay_half_life_days: timeDecayHalfLifeDays
    };

    // If conversion_source is 'ad_platforms', skip event queries entirely and use platform data
    if (conversionSource === 'ad_platforms') {
      console.log(`[Attribution] conversion_source=ad_platforms, using platform model directly`);
      try {
        const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
        if (supabaseKey) {
          const supabase = new SupabaseClient({
            url: c.env.SUPABASE_URL,
            secretKey: supabaseKey
          });

          // Define buildPlatformFallback inline for this early return path
          const connections = await c.env.DB.prepare(`
            SELECT DISTINCT platform FROM platform_connections
            WHERE organization_id = ? AND is_active = 1
          `).bind(orgId).all<{ platform: string }>();

          const platforms = connections.results?.map(r => r.platform) || [];
          const allCampaigns: any[] = [];
          let totalConversions = 0;
          let totalRevenue = 0;

          for (const platform of platforms) {
            try {
              if (platform === 'google') {
                const adapter = new GoogleAdsSupabaseAdapter(supabase);
                const campaigns = await adapter.getCampaignsWithMetrics(orgId, { start: dateFrom, end: dateTo });
                for (const campaign of campaigns) {
                  const conversions = campaign.metrics.conversions || 0;
                  const revenue = (campaign.metrics.conversion_value_cents || 0) / 100;
                  allCampaigns.push({
                    utm_source: 'google', utm_medium: 'cpc', utm_campaign: campaign.campaign_name,
                    touchpoints: 0, conversions_in_path: 0, attributed_conversions: conversions,
                    attributed_revenue: revenue, avg_position_in_path: 0
                  });
                  totalConversions += conversions;
                  totalRevenue += revenue;
                }
              } else if (platform === 'facebook') {
                const adapter = new FacebookSupabaseAdapter(supabase);
                const campaigns = await adapter.getCampaignsWithMetrics(orgId, { start: dateFrom, end: dateTo });
                for (const campaign of campaigns) {
                  const conversions = campaign.metrics.conversions || 0;
                  // Facebook adapter doesn't include conversion_value_cents in aggregated metrics
                  const revenue = ((campaign.metrics as any).conversion_value_cents || 0) / 100;
                  allCampaigns.push({
                    utm_source: 'facebook', utm_medium: 'paid', utm_campaign: campaign.campaign_name,
                    touchpoints: 0, conversions_in_path: 0, attributed_conversions: conversions,
                    attributed_revenue: revenue, avg_position_in_path: 0
                  });
                  totalConversions += conversions;
                  totalRevenue += revenue;
                }
              } else if (platform === 'tiktok') {
                const adapter = new TikTokAdsSupabaseAdapter(supabase);
                const campaigns = await adapter.getCampaigns(orgId);
                const metrics = await adapter.getCampaignDailyMetrics(orgId, { start: dateFrom, end: dateTo });
                const metricsByCampaign: Record<string, { conversions: number; revenue: number }> = {};
                for (const m of metrics) {
                  const ref = (m as any).campaign_ref;
                  if (!metricsByCampaign[ref]) metricsByCampaign[ref] = { conversions: 0, revenue: 0 };
                  metricsByCampaign[ref].conversions += m.conversions || 0;
                  metricsByCampaign[ref].revenue += (m.conversion_value_cents || 0) / 100;
                }
                for (const campaign of campaigns) {
                  const cm = metricsByCampaign[campaign.id] || { conversions: 0, revenue: 0 };
                  allCampaigns.push({
                    utm_source: 'tiktok', utm_medium: 'paid', utm_campaign: campaign.campaign_name,
                    touchpoints: 0, conversions_in_path: 0, attributed_conversions: cm.conversions,
                    attributed_revenue: cm.revenue, avg_position_in_path: 0
                  });
                  totalConversions += cm.conversions;
                  totalRevenue += cm.revenue;
                }
              }
            } catch (err) {
              console.warn(`[Attribution] Failed to fetch ${platform} for ad_platforms mode:`, err);
            }
          }

          allCampaigns.sort((a, b) => b.attributed_conversions - a.attributed_conversions);

          return success(c, {
            model: 'platform' as AttributionModel,
            config: {
              attribution_window_days: attributionWindowDays,
              time_decay_half_life_days: timeDecayHalfLifeDays,
              identity_stitching_enabled: useIdentityStitching
            },
            data_quality: {
              quality: 'platform_reported' as DataQuality,
              warnings: ['using_platform_conversions'] as DataWarning[],
              event_count: 0,
              conversion_count: 0,
              fallback_source: 'ad_platforms',
              conversion_source_setting: conversionSource
            },
            attributions: allCampaigns,
            summary: {
              total_conversions: totalConversions,
              total_revenue: totalRevenue,
              avg_path_length: 0,
              avg_days_to_convert: 0,
              identified_users: 0,
              anonymous_sessions: 0
            }
          });
        }
      } catch (err) {
        console.error('[Attribution] Error in ad_platforms mode:', err);
      }
    }

    // If conversion_source is 'connectors', use connector revenue data
    if (conversionSource === 'connectors') {
      console.log(`[Attribution] conversion_source=connectors, querying revenue.conversions`);
      try {
        const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
        if (supabaseKey) {
          const supabase = new SupabaseClient({
            url: c.env.SUPABASE_URL,
            secretKey: supabaseKey
          });

          // Query connector conversions
          const connectorConversions = await queryConnectorConversions(supabase, orgId, { start: dateFrom, end: dateTo });

          if (connectorConversions.length === 0) {
            // No connector conversions found - fall back to platform data
            console.log(`[Attribution] No connector conversions found, falling back to platforms`);
            const connections = await c.env.DB.prepare(`
              SELECT DISTINCT platform FROM platform_connections
              WHERE organization_id = ? AND is_active = 1
            `).bind(orgId).all<{ platform: string }>();

            const platforms = connections.results?.map(r => r.platform) || [];
            const allCampaigns: any[] = [];
            let totalConversions = 0;
            let totalRevenue = 0;

            for (const platform of platforms) {
              try {
                if (platform === 'google') {
                  const adapter = new GoogleAdsSupabaseAdapter(supabase);
                  const campaigns = await adapter.getCampaignsWithMetrics(orgId, { start: dateFrom, end: dateTo });
                  for (const campaign of campaigns) {
                    const conversions = campaign.metrics.conversions || 0;
                    const revenue = (campaign.metrics.conversion_value_cents || 0) / 100;
                    allCampaigns.push({
                      utm_source: 'google', utm_medium: 'cpc', utm_campaign: campaign.campaign_name,
                      touchpoints: 0, conversions_in_path: 0, attributed_conversions: conversions,
                      attributed_revenue: revenue, avg_position_in_path: 0
                    });
                    totalConversions += conversions;
                    totalRevenue += revenue;
                  }
                } else if (platform === 'facebook') {
                  const adapter = new FacebookSupabaseAdapter(supabase);
                  const campaigns = await adapter.getCampaignsWithMetrics(orgId, { start: dateFrom, end: dateTo });
                  for (const campaign of campaigns) {
                    const conversions = campaign.metrics.conversions || 0;
                    const revenue = ((campaign.metrics as any).conversion_value_cents || 0) / 100;
                    allCampaigns.push({
                      utm_source: 'facebook', utm_medium: 'paid', utm_campaign: campaign.campaign_name,
                      touchpoints: 0, conversions_in_path: 0, attributed_conversions: conversions,
                      attributed_revenue: revenue, avg_position_in_path: 0
                    });
                    totalConversions += conversions;
                    totalRevenue += revenue;
                  }
                } else if (platform === 'tiktok') {
                  const adapter = new TikTokAdsSupabaseAdapter(supabase);
                  const campaigns = await adapter.getCampaigns(orgId);
                  const metrics = await adapter.getCampaignDailyMetrics(orgId, { start: dateFrom, end: dateTo });
                  const metricsByCampaign: Record<string, { conversions: number; revenue: number }> = {};
                  for (const m of metrics) {
                    const ref = (m as any).campaign_ref;
                    if (!metricsByCampaign[ref]) metricsByCampaign[ref] = { conversions: 0, revenue: 0 };
                    metricsByCampaign[ref].conversions += m.conversions || 0;
                    metricsByCampaign[ref].revenue += (m.conversion_value_cents || 0) / 100;
                  }
                  for (const campaign of campaigns) {
                    const cm = metricsByCampaign[campaign.id] || { conversions: 0, revenue: 0 };
                    allCampaigns.push({
                      utm_source: 'tiktok', utm_medium: 'paid', utm_campaign: campaign.campaign_name,
                      touchpoints: 0, conversions_in_path: 0, attributed_conversions: cm.conversions,
                      attributed_revenue: cm.revenue, avg_position_in_path: 0
                    });
                    totalConversions += cm.conversions;
                    totalRevenue += cm.revenue;
                  }
                }
              } catch (err) {
                console.warn(`[Attribution] Failed to fetch ${platform} for connector fallback:`, err);
              }
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
                warnings: ['no_connector_conversions', 'using_platform_conversions'] as DataWarning[],
                event_count: 0,
                conversion_count: 0,
                fallback_source: 'ad_platforms',
                conversion_source_setting: conversionSource
              },
              attributions: allCampaigns,
              summary: {
                total_conversions: totalConversions,
                total_revenue: totalRevenue,
                avg_path_length: 0,
                avg_days_to_convert: 0,
                identified_users: 0,
                anonymous_sessions: 0
              }
            });
          }

          // We have connector conversions - try to get tracked events for email hash matching
          let trackedEvents: any[] = [];
          const tagMapping = await c.env.DB.prepare(`
            SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
          `).bind(orgId).first<{ short_tag: string }>();

          if (tagMapping) {
            try {
              const params = new URLSearchParams();
              params.append('org_tag', `eq.${tagMapping.short_tag}`);
              params.append('event_timestamp', `gte.${dateFrom}T00:00:00Z`);
              params.append('event_timestamp', `lte.${dateTo}T23:59:59Z`);
              params.append('select', 'user_email_hash,utm_source,utm_medium,utm_campaign,event_timestamp');
              params.append('order', 'event_timestamp.desc');
              params.append('limit', '10000');

              trackedEvents = await supabase.queryWithSchema<any[]>(
                `events?${params.toString()}`,
                'events',
                { method: 'GET' }
              ) || [];
              console.log(`[Attribution] Found ${trackedEvents.length} tracked events for email hash matching`);
            } catch (err) {
              console.warn('[Attribution] Failed to fetch tracked events for email matching:', err);
            }
          }

          // Attribute connector conversions
          const { attributions, summary } = attributeConnectorConversions(connectorConversions, trackedEvents);

          // Determine data quality based on attribution methods used
          const hasTrackedEvents = trackedEvents.length > 0;
          const dataQuality: DataQuality = hasTrackedEvents && summary.attributed_count > 0 ? 'verified' : 'connector_only';
          const warnings: DataWarning[] = [];

          if (summary.unattributed_count > 0 && summary.unattributed_count === summary.total_conversions) {
            warnings.push('no_events');  // All conversions unattributed
          }

          console.log(`[Attribution] Connector attribution complete: ${summary.total_conversions} conversions, ${summary.attributed_count} attributed, quality=${dataQuality}`);

          return success(c, {
            model: model,  // Use requested model (though connector doesn't use multi-touch)
            config: {
              attribution_window_days: attributionWindowDays,
              time_decay_half_life_days: timeDecayHalfLifeDays,
              identity_stitching_enabled: useIdentityStitching
            },
            data_quality: {
              quality: dataQuality,
              warnings,
              event_count: trackedEvents.length,
              conversion_count: summary.total_conversions,
              fallback_source: 'connectors',
              conversion_source_setting: conversionSource
            },
            attributions: attributions.map(a => ({
              utm_source: a.utm_source,
              utm_medium: a.utm_medium,
              utm_campaign: a.utm_campaign,
              touchpoints: a.touchpoints,
              conversions_in_path: a.conversions_in_path,
              attributed_conversions: a.attributed_conversions,
              attributed_revenue: a.attributed_revenue,
              avg_position_in_path: a.avg_position_in_path,
              // Include attribution method for transparency
              attribution_method: a.attribution_method
            })),
            summary: {
              total_conversions: summary.total_conversions,
              total_revenue: summary.total_revenue,
              avg_path_length: 0,
              avg_days_to_convert: 0,
              identified_users: summary.attributed_count,  // Use attributed as "identified"
              anonymous_sessions: summary.unattributed_count
            }
          });
        }
      } catch (err) {
        console.error('[Attribution] Error in connectors mode:', err);
        // Fall through to standard flow
      }
    }

    // Get org tag for querying events
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    console.log(`[Attribution] orgId=${orgId}, tagMapping=${tagMapping?.short_tag || 'NONE'}, conversionSource=${conversionSource}`);

    // Helper function to build platform fallback attributions
    // Uses platform-specific adapters with correct schema/table names
    const buildPlatformFallback = async (supabase: SupabaseClient, dateRange?: { start: string; end: string }): Promise<{
      attributions: any[];
      summary: { total_conversions: number; total_revenue: number };
    }> => {
      try {
        // Get active platform connections
        const connections = await c.env.DB.prepare(`
          SELECT DISTINCT platform FROM platform_connections
          WHERE organization_id = ? AND is_active = 1
        `).bind(orgId).all<{ platform: string }>();

        const platforms = connections.results?.map(r => r.platform) || [];
        console.log(`[Attribution Fallback] orgId=${orgId}, platforms=${JSON.stringify(platforms)}`);
        if (platforms.length === 0) {
          console.log(`[Attribution Fallback] No platforms connected`);
          return { attributions: [], summary: { total_conversions: 0, total_revenue: 0 } };
        }

        // Build date range for queries (default: last 30 days)
        const effectiveDateRange = dateRange || {
          start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          end: new Date().toISOString().split('T')[0]
        };

        // Fetch campaign data from each platform using correct adapters
        const allCampaigns: any[] = [];
        let totalConversions = 0;
        let totalRevenue = 0;

        for (const platform of platforms) {
          try {
            if (platform === 'google') {
              // Use GoogleAdsSupabaseAdapter with google_ads schema
              const adapter = new GoogleAdsSupabaseAdapter(supabase);
              const campaigns = await adapter.getCampaignsWithMetrics(orgId, effectiveDateRange);

              for (const campaign of campaigns) {
                const conversions = campaign.metrics.conversions || 0;
                const revenue = (campaign.metrics.conversion_value_cents || 0) / 100;

                allCampaigns.push({
                  utm_source: 'google',
                  utm_medium: 'cpc',
                  utm_campaign: campaign.campaign_name,
                  touchpoints: 0,
                  conversions_in_path: 0,
                  attributed_conversions: conversions,
                  attributed_revenue: revenue,
                  avg_position_in_path: 0
                });

                totalConversions += conversions;
                totalRevenue += revenue;
              }
            } else if (platform === 'facebook') {
              // Use FacebookSupabaseAdapter with facebook_ads schema
              const adapter = new FacebookSupabaseAdapter(supabase);
              const campaigns = await adapter.getCampaignsWithMetrics(orgId, effectiveDateRange);

              for (const campaign of campaigns) {
                const conversions = campaign.metrics.conversions || 0;
                // Facebook adapter doesn't include conversion_value_cents in aggregated metrics
                const revenue = ((campaign.metrics as any).conversion_value_cents || 0) / 100;

                allCampaigns.push({
                  utm_source: 'facebook',
                  utm_medium: 'paid',
                  utm_campaign: campaign.campaign_name,
                  touchpoints: 0,
                  conversions_in_path: 0,
                  attributed_conversions: conversions,
                  attributed_revenue: revenue,
                  avg_position_in_path: 0
                });

                totalConversions += conversions;
                totalRevenue += revenue;
              }
            } else if (platform === 'tiktok') {
              // Use TikTokAdsSupabaseAdapter with tiktok_ads schema
              const adapter = new TikTokAdsSupabaseAdapter(supabase);
              const campaigns = await adapter.getCampaigns(orgId);
              const metrics = await adapter.getCampaignDailyMetrics(orgId, effectiveDateRange);

              // Aggregate metrics by campaign
              const metricsByCampaign: Record<string, { conversions: number; revenue: number }> = {};
              for (const m of metrics) {
                const ref = (m as any).campaign_ref;
                if (!metricsByCampaign[ref]) {
                  metricsByCampaign[ref] = { conversions: 0, revenue: 0 };
                }
                metricsByCampaign[ref].conversions += m.conversions || 0;
                metricsByCampaign[ref].revenue += (m.conversion_value_cents || 0) / 100;
              }

              for (const campaign of campaigns) {
                const campaignMetrics = metricsByCampaign[campaign.id] || { conversions: 0, revenue: 0 };

                allCampaigns.push({
                  utm_source: 'tiktok',
                  utm_medium: 'paid',
                  utm_campaign: campaign.campaign_name,
                  touchpoints: 0,
                  conversions_in_path: 0,
                  attributed_conversions: campaignMetrics.conversions,
                  attributed_revenue: campaignMetrics.revenue,
                  avg_position_in_path: 0
                });

                totalConversions += campaignMetrics.conversions;
                totalRevenue += campaignMetrics.revenue;
              }
            }
          } catch (err) {
            console.warn(`Failed to fetch ${platform} campaigns for fallback:`, err);
          }
        }

        // Sort by attributed_conversions descending
        allCampaigns.sort((a, b) => b.attributed_conversions - a.attributed_conversions);

        console.log(`[Attribution Fallback] Returning ${allCampaigns.length} campaigns, ${totalConversions} conversions`);
        return {
          attributions: allCampaigns,
          summary: { total_conversions: totalConversions, total_revenue: totalRevenue }
        };
      } catch (err) {
        console.error('[Attribution Fallback] Error:', err);
        return { attributions: [], summary: { total_conversions: 0, total_revenue: 0 } };
      }
    };

    if (!tagMapping) {
      // No tag mapping = can't query events, fall back to platform data
      try {
        const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
        if (supabaseKey) {
          const supabase = new SupabaseClient({
            url: c.env.SUPABASE_URL,
            secretKey: supabaseKey
          });
          const fallback = await buildPlatformFallback(supabase, { start: dateFrom, end: dateTo });

          return success(c, {
            model: 'platform' as AttributionModel,
            config: {
              attribution_window_days: attributionWindowDays,
              time_decay_half_life_days: timeDecayHalfLifeDays,
              identity_stitching_enabled: useIdentityStitching
            },
            data_quality: {
              quality: 'platform_reported' as DataQuality,
              warnings: ['no_events', 'using_platform_conversions'] as DataWarning[],
              event_count: 0,
              conversion_count: 0,
              fallback_source: 'ad_platforms',
              conversion_source_setting: conversionSource
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
      } catch (err) {
        console.warn('Failed to fetch platform fallback:', err);
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
          warnings: ['no_events', 'no_conversion_source'] as DataWarning[],
          event_count: 0,
          conversion_count: 0,
          fallback_source: null,
          conversion_source_setting: conversionSource
        },
        attributions: [],
        summary: {
          total_conversions: 0,
          total_revenue: 0,
          avg_path_length: 0,
          avg_days_to_convert: 0,
          identified_users: 0,
          anonymous_sessions: 0
        }
      });
    }

    try {
      // Initialize Supabase
      const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
      if (!supabaseKey) {
        return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
      }

      const supabase = new SupabaseClient({
        url: c.env.SUPABASE_URL,
        secretKey: supabaseKey
      });

      // Build identity map if stitching is enabled
      const identityMap = new Map<string, string[]>();
      if (useIdentityStitching) {
        const identities = await c.env.DB.prepare(`
          SELECT user_id, anonymous_id FROM identity_mappings
          WHERE organization_id = ?
        `).bind(orgId).all<{ user_id: string; anonymous_id: string }>();

        // Group anonymous_ids by user_id
        (identities.results || []).forEach(row => {
          if (!identityMap.has(row.user_id)) {
            identityMap.set(row.user_id, []);
          }
          identityMap.get(row.user_id)!.push(row.anonymous_id);
        });
      }

      // Query conversion attribution data from Supabase
      const params = new URLSearchParams();
      params.append('org_tag', `eq.${tagMapping.short_tag}`);
      params.append('conversion_timestamp', `gte.${dateFrom}T00:00:00Z`);
      params.append('conversion_timestamp', `lte.${dateTo}T23:59:59Z`);
      params.append('limit', '10000');

      const events = await supabase.queryWithSchema<any[]>(
        `conversion_attribution?${params.toString()}`,
        'events',
        { method: 'GET' }
      ) || [];

      const eventCount = events.length;
      console.log(`[Attribution] Events query returned ${eventCount} events`);

      // Check for no events scenario - fall back to platform data
      if (eventCount === 0) {
        console.log(`[Attribution] No events found, calling buildPlatformFallback`);
        const fallback = await buildPlatformFallback(supabase, { start: dateFrom, end: dateTo });
        return success(c, {
          model: 'platform' as AttributionModel,
          config: {
            attribution_window_days: attributionWindowDays,
            time_decay_half_life_days: timeDecayHalfLifeDays,
            identity_stitching_enabled: useIdentityStitching
          },
          data_quality: {
            quality: 'platform_reported' as DataQuality,
            warnings: ['no_events', 'using_platform_conversions'] as DataWarning[],
            event_count: 0,
            conversion_count: 0,
            fallback_source: 'ad_platforms',
            conversion_source_setting: conversionSource
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

      // Build conversion paths with identity stitching
      // Note: nonConversionPaths reserved for future data-driven attribution
      const { conversionPaths } = buildConversionPaths(
        events,
        identityMap,
        attributionWindowDays
      );

      const conversionCount = conversionPaths.length;

      // Check for no conversions scenario - events exist but no conversion events tracked
      // This is the "estimated" quality - we have journey data but using platform conversion counts
      if (conversionCount === 0) {
        const fallback = await buildPlatformFallback(supabase, { start: dateFrom, end: dateTo });
        return success(c, {
          model: 'platform' as AttributionModel,  // Platform model since we're using platform conversions
          config: {
            attribution_window_days: attributionWindowDays,
            time_decay_half_life_days: timeDecayHalfLifeDays,
            identity_stitching_enabled: useIdentityStitching
          },
          data_quality: {
            quality: 'estimated' as DataQuality,
            warnings: ['no_tracked_conversions', 'using_platform_conversions'] as DataWarning[],
            event_count: eventCount,
            conversion_count: 0,
            fallback_source: 'ad_platforms',
            conversion_source_setting: conversionSource
          },
          attributions: fallback.attributions,
          summary: {
            total_conversions: fallback.summary.total_conversions,
            total_revenue: fallback.summary.total_revenue,
            avg_path_length: 0,
            avg_days_to_convert: 0,
            identified_users: 0,
            anonymous_sessions: eventCount // Use event count as proxy for sessions
          }
        });
      }

      // Determine data quality based on event/conversion counts
      // 'tracked' = using tag-tracked conversions (good)
      // 'verified' = using connector revenue + tracked events (best) - reserved for Phase 3
      let dataQuality: DataQualityInfo = {
        quality: 'tracked',  // Using tracked conversion events
        warnings: [],
        event_count: eventCount,
        conversion_count: conversionCount,
        fallback_source: null,
        conversion_source_setting: conversionSource
      };

      // Check for insufficient events (less than 10 is unreliable)
      if (eventCount < 10) {
        dataQuality.warnings.push('insufficient_events');
      }

      // Calculate attribution for each conversion path
      const attributionResults = conversionPaths.map(path =>
        calculateAttribution(path, config)
      );

      // Aggregate by channel
      const attributions = aggregateAttributionByChannel(attributionResults);

      // Calculate summary stats
      const totalConversions = conversionPaths.length;
      const totalRevenue = conversionPaths.reduce((sum, p) => sum + p.conversion_value, 0);
      const avgPathLength = totalConversions > 0
        ? attributionResults.reduce((sum, r) => sum + r.path_length, 0) / totalConversions
        : 0;
      const avgDaysToConvert = totalConversions > 0
        ? attributionResults.reduce((sum, r) => sum + r.days_to_convert, 0) / totalConversions
        : 0;

      // Count identified vs anonymous
      const identifiedUsers = new Set(
        conversionPaths.filter(p => p.user_id && identityMap.has(p.user_id)).map(p => p.user_id)
      ).size;
      const anonymousSessions = conversionPaths.filter(p => !p.user_id || !identityMap.has(p.user_id!)).length;

      return success(c, {
        model,
        config: {
          attribution_window_days: attributionWindowDays,
          time_decay_half_life_days: timeDecayHalfLifeDays,
          identity_stitching_enabled: useIdentityStitching
        },
        data_quality: dataQuality,
        attributions,
        summary: {
          total_conversions: totalConversions,
          total_revenue: totalRevenue,
          avg_path_length: Math.round(avgPathLength * 10) / 10,
          avg_days_to_convert: Math.round(avgDaysToConvert * 10) / 10,
          identified_users: identifiedUsers,
          anonymous_sessions: anonymousSessions
        }
      });
    } catch (err: any) {
      console.error("[Attribution] Query error in main try block:", err.message || err);

      // Try platform fallback on error (e.g., events table doesn't exist)
      console.log("[Attribution] Attempting platform fallback from catch block...");
      try {
        const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
        if (supabaseKey) {
          const supabase = new SupabaseClient({
            url: c.env.SUPABASE_URL,
            secretKey: supabaseKey
          });
          const fallback = await buildPlatformFallback(supabase, { start: dateFrom, end: dateTo });

          return success(c, {
            model: 'platform' as AttributionModel,
            config: {
              attribution_window_days: attributionWindowDays,
              time_decay_half_life_days: timeDecayHalfLifeDays,
              identity_stitching_enabled: useIdentityStitching
            },
            data_quality: {
              quality: 'platform_reported' as DataQuality,
              warnings: ['no_events', 'using_platform_conversions'] as DataWarning[],
              event_count: 0,
              conversion_count: 0,
              fallback_source: 'ad_platforms',
              conversion_source_setting: conversionSource
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
      } catch (fallbackErr) {
        console.warn('Platform fallback also failed:', fallbackErr);
      }

      // Return empty data only if fallback also fails
      return success(c, {
        model: 'platform' as AttributionModel,
        config: {
          attribution_window_days: attributionWindowDays,
          time_decay_half_life_days: timeDecayHalfLifeDays,
          identity_stitching_enabled: useIdentityStitching
        },
        data_quality: {
          quality: 'platform_reported' as DataQuality,
          warnings: ['no_events'] as DataWarning[],
          event_count: 0,
          conversion_count: 0,
          fallback_source: null,
          conversion_source_setting: conversionSource
        },
        attributions: [],
        summary: {
          total_conversions: 0,
          total_revenue: 0,
          avg_path_length: 0,
          avg_days_to_convert: 0,
          identified_users: 0,
          anonymous_sessions: 0
        }
      });
    }
  }
}

/**
 * GET /v1/analytics/attribution/compare
 *
 * Compare attribution across multiple models side-by-side.
 */
export class GetAttributionComparison extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Compare attribution models",
    description: "Run multiple attribution models and compare results side-by-side",
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

    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      return success(c, {
        models: models.map(model => ({ model, attributions: [] })),
        summary: { total_conversions: 0, total_revenue: 0 }
      });
    }

    try {
      const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
      if (!supabaseKey) {
        return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
      }

      const supabase = new SupabaseClient({
        url: c.env.SUPABASE_URL,
        secretKey: supabaseKey
      });

      // Get identity map
      const identities = await c.env.DB.prepare(`
        SELECT user_id, anonymous_id FROM identity_mappings WHERE organization_id = ?
      `).bind(orgId).all<{ user_id: string; anonymous_id: string }>();

      const identityMap = new Map<string, string[]>();
      (identities.results || []).forEach(row => {
        if (!identityMap.has(row.user_id)) {
          identityMap.set(row.user_id, []);
        }
        identityMap.get(row.user_id)!.push(row.anonymous_id);
      });

      // Query conversion attribution data
      const params = new URLSearchParams();
      params.append('org_tag', `eq.${tagMapping.short_tag}`);
      params.append('conversion_timestamp', `gte.${dateFrom}T00:00:00Z`);
      params.append('conversion_timestamp', `lte.${dateTo}T23:59:59Z`);
      params.append('limit', '10000');

      const events = await supabase.queryWithSchema<any[]>(
        `conversion_attribution?${params.toString()}`,
        'events',
        { method: 'GET' }
      ) || [];

      const { conversionPaths } = buildConversionPaths(
        events,
        identityMap,
        org.attribution_window_days
      );

      // Calculate attribution for each model
      const modelResults = models.map(model => {
        const config: AttributionConfig = {
          model,
          attribution_window_days: org.attribution_window_days,
          time_decay_half_life_days: org.time_decay_half_life_days
        };

        const attributionResults = conversionPaths.map(path =>
          calculateAttribution(path, config)
        );

        const attributions = aggregateAttributionByChannel(attributionResults)
          .slice(0, 10) // Top 10 channels
          .map(a => ({
            utm_source: a.utm_source,
            attributed_conversions: Math.round(a.attributed_conversions * 100) / 100,
            attributed_revenue: Math.round(a.attributed_revenue * 100) / 100
          }));

        return { model, attributions };
      });

      const totalConversions = conversionPaths.length;
      const totalRevenue = conversionPaths.reduce((sum, p) => sum + p.conversion_value, 0);

      return success(c, {
        models: modelResults,
        summary: {
          total_conversions: totalConversions,
          total_revenue: Math.round(totalRevenue * 100) / 100
        }
      });
    } catch (err: any) {
      console.error("Attribution comparison error:", err);
      return success(c, {
        models: models.map(model => ({ model, attributions: [] })),
        summary: { total_conversions: 0, total_revenue: 0 }
      });
    }
  }
}
