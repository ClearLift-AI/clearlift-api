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
import { AppContext, SetupStatus, DataQualityResponse, buildDataQualityResponse } from "../../../types";
import { success, error } from "../../../utils/response";
import { D1Adapter } from "../../../adapters/d1";
import { structuredLog } from "../../../utils/structured-logger";
import {
  AttributionModel,
  AttributionConfig,
  calculateAttribution,
  aggregateAttributionByChannel,
  buildConversionPaths
} from "../../../services/attribution-models";
// Import from providers to ensure all revenue sources are registered
import { getCombinedRevenueByDateRange, CombinedRevenueResult } from "../../../services/revenue-sources/providers";
import { AD_PLATFORM_IDS, ACTIVE_REVENUE_PLATFORM_IDS } from "../../../config/platforms";

/** Map API model names (markov_chain, shapley_value) to DB model names (markov, shapley). */
const apiToDbModel = (m: string) => m === 'markov_chain' ? 'markov' : m === 'shapley_value' ? 'shapley' : m;
/** Map DB model names (markov, shapley) back to API model names (markov_chain, shapley_value). */
const dbToApiModel = (m: string) => m === 'markov' ? 'markov_chain' : m === 'shapley' ? 'shapley_value' : m;

/**
 * Check organization setup status for attribution.
 * Returns what's configured and what's missing.
 */
async function checkSetupStatus(
  mainDb: D1Database,
  analyticsDb: D1Database,
  orgId: string,
  dateRange: { start: string; end: string }
): Promise<SetupStatus> {
  // Check tracking tag
  const tagMapping = await mainDb.prepare(`
    SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? LIMIT 1
  `).bind(orgId).first<{ short_tag: string }>();

  // Check connected platforms
  const platformsResult = await mainDb.prepare(`
    SELECT platform FROM platform_connections WHERE organization_id = ? AND is_active = 1
  `).bind(orgId).all<{ platform: string }>();
  const connectedPlatforms = (platformsResult.results || []).map(r => r.platform);

  // Separate ad platforms from revenue connectors
  const adPlatforms = connectedPlatforms.filter(p => AD_PLATFORM_IDS.includes(p as any));
  const revenueConnectors = connectedPlatforms.filter(p => ACTIVE_REVENUE_PLATFORM_IDS.includes(p as any));

  // Check for UTM data (only if tag is configured)
  let hasUtmData = false;
  if (tagMapping?.short_tag) {
    try {
      const utmCheck = await analyticsDb.prepare(`
        SELECT 1 FROM utm_performance
        WHERE organization_id = ? AND date >= ? AND date <= ?
        LIMIT 1
      `).bind(orgId, dateRange.start, dateRange.end).first();
      hasUtmData = !!utmCheck;
    } catch {
      // Table might not exist yet
    }
  }

  // Check for click IDs in conversions
  let hasClickIds = false;
  try {
    const clickIdCheck = await analyticsDb.prepare(`
      SELECT 1 FROM conversions
      WHERE organization_id = ?
        AND click_id IS NOT NULL
        AND conversion_timestamp >= ?
        AND conversion_timestamp <= ?
      LIMIT 1
    `).bind(orgId, dateRange.start, dateRange.end + 'T23:59:59Z').first();
    hasClickIds = !!clickIdCheck;
  } catch {
    // Table might not exist
  }

  return {
    hasTrackingTag: !!tagMapping?.short_tag,
    hasAdPlatforms: adPlatforms.length > 0,
    hasRevenueConnector: revenueConnectors.length > 0,
    hasClickIds,
    hasUtmData,
    trackingDomain: undefined,
    shortTag: tagMapping?.short_tag,
    connectedPlatforms: adPlatforms,
    connectedConnectors: revenueConnectors
  };
}

/**
 * Verification metrics for linked conversions
 */
interface VerificationMetrics {
  verified_count: number;
  avg_confidence: number;
  link_method_breakdown: { direct_link: number; email_hash: number; time_proximity: number };
  total_connector_conversions: number;
  verification_rate: number;
}

/**
 * Check verification status of conversions.
 * Returns metrics about linked conversions from ConversionLinkingWorkflow.
 */
async function checkVerificationStatus(
  analyticsDb: D1Database,
  orgId: string,
  dateRange: { start: string; end: string }
): Promise<VerificationMetrics> {
  try {
    // Get total connector conversions
    const totalResult = await analyticsDb.prepare(`
      SELECT COUNT(*) as total_count
      FROM conversions
      WHERE organization_id = ?
        AND source_platform IN ('stripe', 'shopify', 'jobber')
        AND conversion_timestamp >= ?
        AND conversion_timestamp <= ?
    `).bind(orgId, dateRange.start, dateRange.end + 'T23:59:59Z').first<{ total_count: number }>();

    const totalConnectorConversions = totalResult?.total_count || 0;

    if (totalConnectorConversions === 0) {
      return {
        verified_count: 0,
        avg_confidence: 0,
        link_method_breakdown: { direct_link: 0, email_hash: 0, time_proximity: 0 },
        total_connector_conversions: 0,
        verification_rate: 0
      };
    }

    // Get linked conversions (with link_confidence >= 0.7)
    const linkedResult = await analyticsDb.prepare(`
      SELECT
        COUNT(*) as verified_count,
        AVG(link_confidence) as avg_confidence
      FROM conversions
      WHERE organization_id = ?
        AND linked_goal_id IS NOT NULL
        AND link_confidence >= 0.7
        AND conversion_timestamp >= ?
        AND conversion_timestamp <= ?
    `).bind(orgId, dateRange.start, dateRange.end + 'T23:59:59Z').first<{
      verified_count: number;
      avg_confidence: number;
    }>();

    const verifiedCount = linkedResult?.verified_count || 0;
    const avgConfidence = linkedResult?.avg_confidence || 0;

    // Get link method breakdown
    const breakdownResult = await analyticsDb.prepare(`
      SELECT link_method, COUNT(*) as count
      FROM conversions
      WHERE organization_id = ?
        AND linked_goal_id IS NOT NULL
        AND link_confidence >= 0.7
        AND conversion_timestamp >= ?
        AND conversion_timestamp <= ?
      GROUP BY link_method
    `).bind(orgId, dateRange.start, dateRange.end + 'T23:59:59Z').all<{
      link_method: string;
      count: number;
    }>();

    const breakdown = { direct_link: 0, email_hash: 0, time_proximity: 0 };
    for (const row of breakdownResult.results || []) {
      if (row.link_method === 'direct_link') breakdown.direct_link = row.count;
      else if (row.link_method === 'email_hash') breakdown.email_hash = row.count;
      else if (row.link_method === 'time_proximity') breakdown.time_proximity = row.count;
    }

    const verificationRate = totalConnectorConversions > 0
      ? (verifiedCount / totalConnectorConversions) * 100
      : 0;

    return {
      verified_count: verifiedCount,
      avg_confidence: avgConfidence,
      link_method_breakdown: breakdown,
      total_connector_conversions: totalConnectorConversions,
      verification_rate: verificationRate
    };
  } catch (err) {
    // Table might not exist or query failed
    structuredLog('ERROR', 'Verification check failed', { endpoint: 'attribution', step: 'verification_check', error: err instanceof Error ? err.message : String(err) });
    return {
      verified_count: 0,
      avg_confidence: 0,
      link_method_breakdown: { direct_link: 0, email_hash: 0, time_proximity: 0 },
      total_connector_conversions: 0,
      verification_rate: 0
    };
  }
}

const AttributionModelEnum = z.enum([
  'platform',       // Self-reported by ad platforms (no attribution calculation)
  'first_touch',
  'last_touch',
  'linear',
  'time_decay',
  'position_based',
  'markov_chain',
  'shapley_value'
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
  | 'no_connector_conversions'     // Connector mode but no conversions found
  | 'query_error';                 // Error querying data source (check logs)

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
  status_filter?: string;
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

// Helper: Query conversion config from platform_connections settings
async function getConversionGoals(db: D1Database, orgId: string): Promise<ConversionGoal[]> {
  const result = await db.prepare(`
    SELECT id, platform, settings
    FROM platform_connections
    WHERE organization_id = ? AND is_active = 1
      AND json_array_length(json_extract(settings, '$.conversion_events')) > 0
  `).bind(orgId).all();

  const goals: ConversionGoal[] = [];
  for (const row of result.results || []) {
    try {
      const settings = JSON.parse(row.settings as string || '{}');
      const conversionEvents = settings.conversion_events || [];
      for (const evt of conversionEvents) {
        goals.push({
          id: `${row.id}_${evt.event_type || 'default'}`,
          name: row.platform as string,
          type: 'conversion',
          trigger_config: {
            event_type: evt.event_type,
            page_pattern: evt.page_pattern,
            status_filter: evt.status_filter,
          },
          default_value_cents: evt.default_value_cents || 0,
          is_primary: true,
          include_in_path: true,
          priority: 0,
        });
      }
    } catch {
      // Skip connections with unparseable settings
    }
  }
  return goals;
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

    const allPlatforms = connections.results?.map(r => r.platform) || [];
    // Filter to only ad platforms that have campaign_daily_metrics tables
    // Stripe doesn't have campaigns, so we exclude it from this query
    const platforms = allPlatforms.filter(p => ['google', 'facebook', 'tiktok'].includes(p));
    console.log(`[Attribution D1 Fallback] orgId=${orgId}, platforms=${JSON.stringify(platforms)}`);

    if (platforms.length === 0) {
      return { attributions: [], summary: { total_conversions: 0, total_revenue: 0 } };
    }

    const allCampaigns: any[] = [];
    let totalConversions = 0;
    let totalRevenue = 0;

    // Use unified ad_metrics table
    try {
      const metricsResult = await analyticsDb.prepare(`
        SELECT
          m.platform,
          m.entity_ref,
          c.campaign_name,
          SUM(m.conversions) as conversions,
          SUM(m.conversion_value_cents) as conversion_value_cents
        FROM ad_metrics m
        LEFT JOIN ad_campaigns c ON m.entity_ref = c.id AND m.platform = c.platform
        WHERE m.organization_id = ?
          AND m.entity_type = 'campaign'
          AND m.metric_date >= ?
          AND m.metric_date <= ?
          AND m.platform IN (${platforms.map(() => '?').join(', ')})
        GROUP BY m.platform, m.entity_ref, c.campaign_name
      `).bind(orgId, dateRange.start, dateRange.end, ...platforms).all<{
        platform: string;
        entity_ref: string;
        campaign_name: string | null;
        conversions: number;
        conversion_value_cents: number;
      }>();

      for (const row of metricsResult.results || []) {
        const conversions = row.conversions || 0;
        const revenue = (row.conversion_value_cents || 0) / 100;
        const medium = row.platform === 'google' ? 'cpc' : 'paid';

        allCampaigns.push({
          utm_source: row.platform,
          utm_medium: medium,
          utm_campaign: row.campaign_name || row.entity_ref,
          touchpoints: 0,
          conversions_in_path: 0,
          attributed_conversions: conversions,
          attributed_revenue: revenue,
          credit: 0,
          avg_position_in_path: 0
        });

        totalConversions += conversions;
        totalRevenue += revenue;
      }
    } catch (err) {
      structuredLog('ERROR', 'Unified ad_metrics query failed (D1 fallback)', { endpoint: 'attribution', step: 'd1_fallback', error: err instanceof Error ? err.message : String(err) });
    }

    // Sort by attributed_conversions descending
    allCampaigns.sort((a, b) => b.attributed_conversions - a.attributed_conversions);

    console.log(`[Attribution D1 Fallback] Returning ${allCampaigns.length} campaigns, ${totalConversions} conversions`);
    return {
      attributions: allCampaigns,
      summary: { total_conversions: totalConversions, total_revenue: totalRevenue }
    };
  } catch (err) {
    structuredLog('ERROR', 'D1 fallback error', { endpoint: 'attribution', step: 'd1_fallback', error: err instanceof Error ? err.message : String(err) });
    return { attributions: [], summary: { total_conversions: 0, total_revenue: 0 } };
  }
}

/**
 * Helper: Build attributions from connector revenue data (Stripe, Shopify, Jobber, etc.)
 * Converts the unified revenue sources format into attribution format.
 */
function buildConnectorAttributions(
  revenueData: CombinedRevenueResult
): {
  attributions: any[];
  summary: { total_conversions: number; total_revenue: number };
} {
  const attributions: any[] = [];
  let totalConversions = 0;
  let totalRevenue = 0;

  // Convert each revenue source into an attribution entry
  // Note: Without tracking data, we can only attribute by payment source (not marketing channel)
  for (const [platform, data] of Object.entries(revenueData.summary.sources)) {
    totalConversions += data.conversions;
    totalRevenue += data.revenue;

    attributions.push({
      utm_source: platform,  // 'stripe', 'shopify', 'jobber'
      utm_medium: 'connector',
      utm_campaign: data.displayName,  // 'Stripe Payments', 'Shopify Orders', etc.
      touchpoints: 0,
      conversions_in_path: data.conversions,
      attributed_conversions: data.conversions,
      attributed_revenue: Math.round(data.revenue * 100) / 100,
      credit: 0,
      avg_position_in_path: 0
    });
  }

  // Sort by attributed revenue descending
  attributions.sort((a, b) => b.attributed_revenue - a.attributed_revenue);

  return {
    attributions,
    summary: {
      total_conversions: totalConversions,
      total_revenue: Math.round(totalRevenue * 100) / 100
    }
  };
}

/**
 * Helper: Merge ad platform attributions with connector revenue data
 * Used when source='all' to show complete picture
 */
function mergeAttributions(
  adPlatformData: { attributions: any[]; summary: { total_conversions: number; total_revenue: number } },
  connectorData: { attributions: any[]; summary: { total_conversions: number; total_revenue: number } }
): {
  attributions: any[];
  summary: { total_conversions: number; total_revenue: number };
} {
  // Combine attributions from both sources
  const allAttributions = [
    ...adPlatformData.attributions,
    ...connectorData.attributions
  ];

  // Sort by attributed revenue descending
  allAttributions.sort((a, b) => b.attributed_revenue - a.attributed_revenue);

  return {
    attributions: allAttributions,
    summary: {
      // For 'all' mode, we show connector conversions (ground truth) but include ad platform metrics
      total_conversions: connectorData.summary.total_conversions || adPlatformData.summary.total_conversions,
      total_revenue: connectorData.summary.total_revenue || adPlatformData.summary.total_revenue
    }
  };
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
                }),
                // Setup guidance when data is missing
                setup_guidance: z.object({
                  quality: z.enum(['complete', 'partial', 'limited', 'none']),
                  completeness: z.number(),
                  setup: z.object({
                    hasTrackingTag: z.boolean(),
                    hasAdPlatforms: z.boolean(),
                    hasRevenueConnector: z.boolean(),
                    hasClickIds: z.boolean(),
                    hasUtmData: z.boolean(),
                    trackingDomain: z.string().optional(),
                    connectedPlatforms: z.array(z.string()),
                    connectedConnectors: z.array(z.string())
                  }),
                  issues: z.array(z.string()),
                  recommendations: z.array(z.object({
                    action: z.string(),
                    description: z.string(),
                    setupUrl: z.string(),
                    priority: z.enum(['high', 'medium', 'low'])
                  }))
                }).optional()
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

    // Get ANALYTICS_DB binding
    const analyticsDb = c.env.ANALYTICS_DB;
    const dateRange = { start: dateFrom, end: dateTo };

    // Check setup status for guidance (non-blocking - failures shouldn't break attribution)
    let setupStatus: SetupStatus = {
      hasTrackingTag: false,
      hasAdPlatforms: false,
      hasRevenueConnector: false,
      hasClickIds: false,
      hasUtmData: false,
      connectedPlatforms: [],
      connectedConnectors: []
    };
    let setupGuidance: DataQualityResponse;

    try {
      setupStatus = await checkSetupStatus(c.env.DB, analyticsDb, orgId, dateRange);
      setupGuidance = buildDataQualityResponse(setupStatus);
      console.log(`[Attribution] Setup: tag=${setupStatus.hasTrackingTag}, platforms=${setupStatus.connectedPlatforms.join(',')}, connectors=${setupStatus.connectedConnectors.join(',')}, completeness=${setupGuidance.completeness}%`);
    } catch (setupErr) {
      structuredLog('WARN', 'Setup check failed, using defaults', { endpoint: 'attribution', step: 'setup_check', error: setupErr instanceof Error ? setupErr.message : String(setupErr) });
      setupGuidance = buildDataQualityResponse(setupStatus);
    }

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

    // Build attribution data based on conversion source
    let attributionData: { attributions: any[]; summary: { total_conversions: number; total_revenue: number } };
    let dataQuality: DataQuality = 'platform_reported';
    let fallbackSource: string | null = null;
    const warnings: DataWarning[] = [];
    let verificationMetrics: VerificationMetrics | null = null;

    // Fix 6: Run verification check unconditionally so pre-computed path can use it
    try {
      verificationMetrics = await checkVerificationStatus(analyticsDb, orgId, dateRange);
    } catch (err) {
      structuredLog('WARN', 'Verification check failed', { endpoint: 'attribution', step: 'verification_check', error: err instanceof Error ? err.message : String(err) });
    }

    // See SHARED_CODE.md §19.9 — Pre-computed attribution results
    if (requestedModel !== 'platform') {
      const cronModelName = apiToDbModel(requestedModel);

      try {
        const latestPeriod = await analyticsDb.prepare(`
          SELECT period_start FROM attribution_results
          WHERE organization_id = ? AND model = ?
          ORDER BY period_start DESC LIMIT 1
        `).bind(orgId, cronModelName).first() as { period_start: string } | null;

        if (latestPeriod) {
          const precomputed = await analyticsDb.prepare(`
            SELECT channel, credit, conversions, revenue_cents, removal_effect, shapley_value,
                   period_start, period_end
            FROM attribution_results
            WHERE organization_id = ? AND model = ? AND period_start = ?
            ORDER BY credit DESC
          `).bind(orgId, cronModelName, latestPeriod.period_start).all();

          const rows = (precomputed.results || []) as Array<{
            channel: string; credit: number; conversions: number; revenue_cents: number;
            removal_effect: number | null; shapley_value: number | null;
            period_start: string; period_end: string;
          }>;

          if (rows.length > 0) {
            const totalConv = rows.reduce((s, r) => s + r.conversions, 0);
            const totalRevCents = rows.reduce((s, r) => s + r.revenue_cents, 0);

            const isVerified = verificationMetrics &&
              verificationMetrics.verified_count >= 10 &&
              verificationMetrics.avg_confidence >= 0.7 &&
              verificationMetrics.verification_rate >= 50;

            console.log(`[Attribution] Using pre-computed results: ${rows.length} channels, model=${cronModelName}`);

            return success(c, {
              model: requestedModel,
              config: {
                attribution_window_days: attributionWindowDays,
                time_decay_half_life_days: timeDecayHalfLifeDays,
                identity_stitching_enabled: useIdentityStitching,
              },
              data_quality: {
                quality: isVerified ? 'verified' as DataQuality : 'tracked' as DataQuality,
                warnings: [] as DataWarning[],
                event_count: 0,
                conversion_count: Math.round(totalConv),
                fallback_source: null,
                conversion_source_setting: conversionSource,
                verification: verificationMetrics ? {
                  verified_conversion_count: verificationMetrics.verified_count,
                  avg_link_confidence: verificationMetrics.avg_confidence,
                  link_method_breakdown: verificationMetrics.link_method_breakdown,
                  verification_rate: verificationMetrics.verification_rate,
                } : undefined,
              },
              attributions: rows.map(r => ({
                utm_source: r.channel,
                utm_medium: null,
                utm_campaign: null,
                touchpoints: Math.round(r.conversions),
                conversions_in_path: Math.round(r.conversions),
                attributed_conversions: r.conversions,
                attributed_revenue: r.revenue_cents / 100,
                credit: r.credit,
                avg_position_in_path: 0,
              })),
              summary: {
                total_conversions: Math.round(totalConv),
                total_revenue: totalRevCents / 100,
                avg_path_length: 0,
                avg_days_to_convert: 0,
                identified_users: 0,
                anonymous_sessions: 0,
              },
              setup_guidance: setupGuidance.completeness < 100 ? setupGuidance : undefined,
            });
          }
        }
      } catch (err) {
        structuredLog('WARN', 'Pre-computed query failed, falling back to live query', { endpoint: 'attribution', step: 'precomputed_query', error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (conversionSource === 'connectors' || conversionSource === 'all') {
      // Query unified revenue sources (Stripe, Shopify, Jobber, etc.)
      console.log(`[Attribution] Querying unified revenue sources for connectors`);
      try {
        const revenueData = await getCombinedRevenueByDateRange(
          analyticsDb,
          orgId,
          dateRange
        );

        if (revenueData.summary.conversions > 0) {
          const connectorAttributions = buildConnectorAttributions(revenueData);

          // Verification metrics already fetched above (Fix 6)
          const isVerified = verificationMetrics &&
            verificationMetrics.verified_count >= 10 &&
            verificationMetrics.avg_confidence >= 0.7 &&
            verificationMetrics.verification_rate >= 50;

          if (isVerified) {
            dataQuality = 'verified' as DataQuality;
            console.log(`[Attribution] Data quality: VERIFIED (${verificationMetrics!.verified_count} linked conversions, ${verificationMetrics!.verification_rate.toFixed(1)}% rate)`);
          } else if (verificationMetrics) {
            console.log(`[Attribution] Data quality: connector_only (verification: ${verificationMetrics.verified_count} linked, ${verificationMetrics.verification_rate.toFixed(1)}% rate)`);
          }
          console.log(`[Attribution] Found ${connectorAttributions.summary.total_conversions} connector conversions, $${connectorAttributions.summary.total_revenue} revenue`);

          if (conversionSource === 'all') {
            // Get ad platform data too and merge
            const adPlatformData = await buildPlatformFallbackD1(
              analyticsDb,
              c.env.DB,
              orgId,
              dateRange
            );
            attributionData = mergeAttributions(adPlatformData, connectorAttributions);
            dataQuality = 'connector_only';
            fallbackSource = 'connectors+ad_platforms';
          } else {
            attributionData = connectorAttributions;
            dataQuality = 'connector_only';
            fallbackSource = 'connectors';
          }
        } else {
          // No connector data, fall back to ad platforms
          console.log(`[Attribution] No connector conversions found, falling back to ad platforms`);
          warnings.push('no_connector_conversions');
          attributionData = await buildPlatformFallbackD1(
            analyticsDb,
            c.env.DB,
            orgId,
            dateRange
          );
          dataQuality = 'platform_reported';
          fallbackSource = 'ad_platforms';
          warnings.push('using_platform_conversions');
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        structuredLog('ERROR', 'Error querying revenue sources', { endpoint: 'attribution', step: 'revenue_sources', error: err instanceof Error ? err.message : String(err) });
        // Fall back to ad platforms on error, but surface the issue
        attributionData = await buildPlatformFallbackD1(
          analyticsDb,
          c.env.DB,
          orgId,
          dateRange
        );
        dataQuality = 'platform_reported';
        fallbackSource = 'ad_platforms';
        warnings.push('query_error');
        warnings.push('using_platform_conversions');
        // Include error details in data_quality response
        (warnings as any).error_details = `Failed to query connector revenue: ${errMsg}. Using ad platform data instead.`;
      }
    } else if (conversionSource === 'ad_platforms') {
      // Use ad platform data directly
      console.log(`[Attribution] Using D1 ad platform data`);
      attributionData = await buildPlatformFallbackD1(
        analyticsDb,
        c.env.DB,
        orgId,
        dateRange
      );
      dataQuality = 'platform_reported';
      fallbackSource = 'ad_platforms';
      warnings.push('using_platform_conversions');
    } else {
      // 'tag' source - requires events table, fall back to ad platforms for now
      console.log(`[Attribution] Tag source requested but events table not available, falling back to ad platforms`);
      warnings.push('no_events');
      attributionData = await buildPlatformFallbackD1(
        analyticsDb,
        c.env.DB,
        orgId,
        dateRange
      );
      dataQuality = 'platform_reported';
      fallbackSource = 'ad_platforms';
      warnings.push('using_platform_conversions');
    }

    return success(c, {
      model: dataQuality === 'connector_only' ? model : ('platform' as AttributionModel),
      config: {
        attribution_window_days: attributionWindowDays,
        time_decay_half_life_days: timeDecayHalfLifeDays,
        identity_stitching_enabled: useIdentityStitching
      },
      data_quality: {
        quality: dataQuality,
        warnings,
        event_count: 0,
        conversion_count: attributionData.summary.total_conversions,
        fallback_source: fallbackSource,
        conversion_source_setting: conversionSource === 'all' ? settingsSource : conversionSource,
        // Verification metrics when conversions are linked to goals via ConversionLinkingWorkflow
        verification: verificationMetrics ? {
          verified_conversion_count: verificationMetrics.verified_count,
          avg_link_confidence: verificationMetrics.avg_confidence,
          link_method_breakdown: verificationMetrics.link_method_breakdown,
          verification_rate: verificationMetrics.verification_rate
        } : undefined
      },
      attributions: attributionData.attributions,
      summary: {
        total_conversions: attributionData.summary.total_conversions,
        total_revenue: attributionData.summary.total_revenue,
        avg_path_length: 0,
        avg_days_to_convert: 0,
        identified_users: 0,
        anonymous_sessions: 0
      },
      // Include setup guidance when data quality is poor or data is missing
      setup_guidance: setupGuidance.completeness < 100 ? setupGuidance : undefined
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

    const modelsParam = query.models || 'first_touch,last_touch,linear,time_decay,position_based,markov,shapley';
    const models = modelsParam.split(',').map(m => m.trim()) as AttributionModel[];

    const d1 = new D1Adapter(c.env.DB);
    const org = await d1.getOrganizationWithAttribution(orgId);
    if (!org) {
      return error(c, "NOT_FOUND", "Organization not found", 404);
    }

    // Get ANALYTICS_DB binding
    const analyticsDb = c.env.ANALYTICS_DB;

    // Query attribution_results from D1 ANALYTICS_DB
    let attributionResults: Array<{
      model: string;
      channel: string;
      credit: number;
      conversions: number;
      revenue_cents: number;
      removal_effect: number | null;
      shapley_value: number | null;
    }> = [];

    const dbModels = models.map(apiToDbModel);

    try {
      // Query attribution results — use only the latest period per model to avoid duplicates
      const modelsPlaceholder = dbModels.map(() => '?').join(',');
      const attrResult = await analyticsDb.prepare(`
        SELECT ar.model, ar.channel, ar.credit, ar.conversions, ar.revenue_cents, ar.removal_effect, ar.shapley_value
        FROM attribution_results ar
        INNER JOIN (
          SELECT model, MAX(period_start) as latest_start
          FROM attribution_results
          WHERE organization_id = ? AND model IN (${modelsPlaceholder})
          GROUP BY model
        ) latest ON ar.model = latest.model AND ar.period_start = latest.latest_start
        WHERE ar.organization_id = ?
          AND ar.model IN (${modelsPlaceholder})
        ORDER BY ar.model, ar.credit DESC
      `).bind(orgId, ...dbModels, orgId, ...dbModels).all();
      attributionResults = (attrResult.results || []) as Array<{
        model: string;
        channel: string;
        credit: number;
        conversions: number;
        revenue_cents: number;
        removal_effect: number | null;
        shapley_value: number | null;
      }>;
      console.log(`[Attribution Compare] Found ${attributionResults.length} results from attribution_results table`);
    } catch (err) {
      structuredLog('WARN', 'Failed to query attribution_results', { endpoint: 'attribution', step: 'compare', error: err instanceof Error ? err.message : String(err) });
    }

    // If we have D1 attribution results, use them
    if (attributionResults.length > 0) {
      // Group results by model
      const resultsByModel = new Map<string, typeof attributionResults>();
      for (const result of attributionResults) {
        const existing = resultsByModel.get(result.model) || [];
        existing.push(result);
        resultsByModel.set(result.model, existing);
      }

      // Build response with actual attribution data (map DB model names back to API names)
      const modelResults = models.map(model => {
        const dbName = apiToDbModel(model);
        const modelData = resultsByModel.get(dbName) || [];
        return {
          model,
          attributions: modelData.slice(0, 10).map(a => ({
            utm_source: a.channel,
            attributed_conversions: Math.round(a.conversions * 100) / 100,
            attributed_revenue: Math.round((a.revenue_cents || 0) / 100 * 100) / 100,
            credit: Math.round(a.credit * 100) / 100,
            removal_effect: a.removal_effect != null ? Math.round(a.removal_effect * 100) / 100 : null,
            shapley_value: a.shapley_value != null ? Math.round(a.shapley_value * 100) / 100 : null
          }))
        };
      });

      // Calculate summary from all results
      const allResults = Array.from(resultsByModel.values()).flat();
      const totalConversions = allResults.length > 0
        ? allResults.reduce((sum, r) => sum + r.conversions, 0) / models.length // Average across models
        : 0;
      const totalRevenue = allResults.length > 0
        ? allResults.reduce((sum, r) => sum + (r.revenue_cents || 0), 0) / models.length / 100
        : 0;

      return success(c, {
        models: modelResults,
        summary: {
          total_conversions: Math.round(totalConversions * 100) / 100,
          total_revenue: Math.round(totalRevenue * 100) / 100
        },
        data_source: 'attribution_workflow'
      });
    }

    // Fallback to platform-reported data if no attribution results
    console.log(`[Attribution Compare] No D1 attribution data, falling back to platform data`);

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
      },
      data_source: 'platform_reported'
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

    // The cron uses short model names: 'markov' / 'shapley'
    const cronModelName = apiToDbModel(model);
    const analyticsDb = c.env.ANALYTICS_DB;

    try {
      // Get the most recent period only
      const latestPeriod = await analyticsDb.prepare(`
        SELECT period_start FROM attribution_results
        WHERE organization_id = ? AND model = ?
        ORDER BY period_start DESC LIMIT 1
      `).bind(orgId, cronModelName).first();

      if (!latestPeriod) throw new Error('no results');

      const cronResults = await analyticsDb.prepare(`
        SELECT channel, credit, removal_effect, shapley_value,
               period_start, conversions
        FROM attribution_results
        WHERE organization_id = ?
          AND model = ?
          AND period_start = ?
        ORDER BY credit DESC
      `).bind(orgId, cronModelName, latestPeriod.period_start).all();

      const rows = (cronResults.results || []) as Array<{
        channel: string;
        credit: number;
        removal_effect: number | null;
        shapley_value: number | null;
        period_start: string;
        conversions: number;
      }>;

      if (rows.length > 0) {
        const first = rows[0];
        const totalConversions = rows.reduce((s: number, r: { conversions: number }) => s + (r.conversions || 0), 0);

        // Count journeys used in this attribution period
        const pathCountResult = await analyticsDb.prepare(
          `SELECT COUNT(*) as cnt FROM journeys WHERE organization_id = ? AND computed_at >= ?`
        ).bind(orgId, first.period_start).first<{ cnt: number }>();

        return success(c, {
          model,
          computation_date: first.period_start,
          attributions: rows.map((r: { channel: string; credit: number; removal_effect: number | null; shapley_value: number | null }) => ({
            channel: r.channel,
            attributed_credit: r.credit,
            removal_effect: r.removal_effect,
            shapley_value: r.shapley_value
          })),
          metadata: {
            conversion_count: Math.round(totalConversions),
            path_count: pathCountResult?.cnt || 0
          }
        });
      }
    } catch (err) {
      structuredLog('WARN', 'ANALYTICS_DB attribution query failed', { endpoint: 'attribution', step: 'get_computed', error: err instanceof Error ? err.message : String(err) });
    }

    return error(c, "NO_RESULTS", `No ${model} results available. Attribution data is computed automatically by the daily pipeline.`, 404);
  }
}

/**
 * GET /v1/analytics/attribution/blended
 *
 * Probabilistic attribution that combines ad platform data with connector revenue.
 * Works even when no click/event tracking is available.
 *
 * Returns:
 * - Ad platform spend and platform-reported conversions
 * - Connector (Stripe) revenue as actual conversions
 * - Spend gap analysis (ad spend vs actual revenue)
 * - Estimated ROAS and CPA
 * - Data quality warnings (e.g., non-overlapping time periods)
 */
export class GetBlendedAttribution extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get blended attribution with spend gap analysis",
    description: `
Combines ad platform data with connector revenue for probabilistic attribution.
Works even without click tracking or event data.

**Returns:**
- Ad platform spend and platform-reported conversions
- Connector (Stripe/Shopify) revenue
- Spend gap analysis (actual revenue vs ad spend)
- Estimated ROAS and CPA
- Data quality warnings

**Use case:** When you have ad platforms and payment connectors but no click tracking.
    `.trim(),
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
        description: "Blended attribution data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                ad_platforms: z.object({
                  total_spend: z.number(),
                  total_impressions: z.number(),
                  total_clicks: z.number(),
                  platform_reported_conversions: z.number(),
                  platform_reported_revenue: z.number(),
                  date_range: z.object({
                    start: z.string().nullable(),
                    end: z.string().nullable()
                  }),
                  by_platform: z.array(z.object({
                    platform: z.string(),
                    spend: z.number(),
                    impressions: z.number(),
                    clicks: z.number(),
                    conversions: z.number(),
                    revenue: z.number()
                  }))
                }),
                connectors: z.object({
                  total_revenue: z.number(),
                  total_transactions: z.number(),
                  unique_customers: z.number(),
                  date_range: z.object({
                    start: z.string().nullable(),
                    end: z.string().nullable()
                  }),
                  by_source: z.array(z.object({
                    source: z.string(),
                    revenue: z.number(),
                    transactions: z.number()
                  }))
                }),
                spend_gap: z.object({
                  ad_spend: z.number(),
                  actual_revenue: z.number(),
                  implied_roas: z.number().nullable(),
                  spend_to_revenue_ratio: z.number().nullable(),
                  estimated_cpa: z.number().nullable()
                }),
                data_quality: z.object({
                  has_overlapping_data: z.boolean(),
                  ad_platform_date_range: z.string().nullable(),
                  connector_date_range: z.string().nullable(),
                  warnings: z.array(z.string())
                }),
                probabilistic_attribution: z.array(z.object({
                  channel: z.string(),
                  estimated_revenue: z.number(),
                  confidence: z.enum(['high', 'medium', 'low', 'none']),
                  attribution_method: z.string()
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

    const analyticsDb = c.env.ANALYTICS_DB;

    // 1. Query ad platform data
    const adPlatformData = await this.getAdPlatformData(analyticsDb, c.env.DB, orgId, dateFrom, dateTo);

    // 2. Query connector revenue (Stripe, Shopify, etc.)
    const connectorData = await this.getConnectorData(analyticsDb, orgId, dateFrom, dateTo);

    // 3. Calculate spend gap
    const spendGap = this.calculateSpendGap(adPlatformData, connectorData);

    // 4. Determine data quality
    const dataQuality = this.assessDataQuality(adPlatformData, connectorData, dateFrom, dateTo);

    // 5. Build probabilistic attribution
    const attribution = this.buildProbabilisticAttribution(adPlatformData, connectorData, dataQuality);

    return success(c, {
      ad_platforms: adPlatformData,
      connectors: connectorData,
      spend_gap: spendGap,
      data_quality: dataQuality,
      probabilistic_attribution: attribution
    });
  }

  private async getAdPlatformData(
    analyticsDb: D1Database,
    mainDb: D1Database,
    orgId: string,
    dateFrom: string,
    dateTo: string
  ) {
    const platforms = ['google', 'facebook', 'tiktok'];
    const byPlatform: any[] = [];
    let totalSpend = 0;
    let totalImpressions = 0;
    let totalClicks = 0;
    let totalConversions = 0;
    let totalRevenue = 0;
    let minDate: string | null = null;
    let maxDate: string | null = null;

    try {
      const placeholders = platforms.map(() => '?').join(', ');
      const results = await analyticsDb.prepare(`
        SELECT
          platform,
          SUM(spend_cents) / 100.0 as spend,
          SUM(impressions) as impressions,
          SUM(clicks) as clicks,
          SUM(conversions) as conversions,
          SUM(conversion_value_cents) / 100.0 as revenue,
          MIN(metric_date) as min_date,
          MAX(metric_date) as max_date
        FROM ad_metrics
        WHERE organization_id = ?
          AND metric_date >= ?
          AND metric_date <= ?
          AND platform IN (${placeholders})
          AND entity_type = 'campaign'
        GROUP BY platform
      `).bind(orgId, dateFrom, dateTo, ...platforms).all<{
        platform: string;
        spend: number;
        impressions: number;
        clicks: number;
        conversions: number;
        revenue: number;
        min_date: string;
        max_date: string;
      }>();

      for (const result of results.results || []) {
        if (result.spend || result.impressions) {
          byPlatform.push({
            platform: result.platform,
            spend: result.spend || 0,
            impressions: result.impressions || 0,
            clicks: result.clicks || 0,
            conversions: result.conversions || 0,
            revenue: result.revenue || 0
          });

          totalSpend += result.spend || 0;
          totalImpressions += result.impressions || 0;
          totalClicks += result.clicks || 0;
          totalConversions += result.conversions || 0;
          totalRevenue += result.revenue || 0;

          if (result.min_date && (!minDate || result.min_date < minDate)) {
            minDate = result.min_date;
          }
          if (result.max_date && (!maxDate || result.max_date > maxDate)) {
            maxDate = result.max_date;
          }
        }
      }
    } catch (err) {
      structuredLog('ERROR', 'Failed to query unified ad_metrics', { endpoint: 'attribution', step: 'blended_ad_metrics', error: err instanceof Error ? err.message : String(err) });
    }

    return {
      total_spend: Math.round(totalSpend * 100) / 100,
      total_impressions: totalImpressions,
      total_clicks: totalClicks,
      platform_reported_conversions: Math.round(totalConversions * 100) / 100,
      platform_reported_revenue: Math.round(totalRevenue * 100) / 100,
      date_range: { start: minDate, end: maxDate },
      by_platform: byPlatform
    };
  }

  private async getConnectorData(
    analyticsDb: D1Database,
    orgId: string,
    dateFrom: string,
    dateTo: string
  ) {
    const bySource: any[] = [];
    let totalRevenue = 0;
    let totalTransactions = 0;
    let uniqueCustomers = 0;
    let minDate: string | null = null;
    let maxDate: string | null = null;

    // Query connector_events for all revenue sources
    try {
      const connectorResult = await analyticsDb.prepare(`
        SELECT
          source_platform,
          SUM(value_cents) / 100.0 as revenue,
          COUNT(*) as transactions,
          COUNT(DISTINCT customer_external_id) as unique_customers,
          MIN(DATE(transacted_at)) as min_date,
          MAX(DATE(transacted_at)) as max_date
        FROM connector_events
        WHERE organization_id = ?
          AND transacted_at >= ?
          AND transacted_at <= ?
          AND value_cents > 0
        GROUP BY source_platform
      `).bind(orgId, dateFrom, dateTo).all<{
        source_platform: string;
        revenue: number;
        transactions: number;
        unique_customers: number;
        min_date: string;
        max_date: string;
      }>();

      for (const row of connectorResult.results || []) {
        bySource.push({
          source: row.source_platform,
          revenue: row.revenue || 0,
          transactions: row.transactions || 0
        });

        totalRevenue += row.revenue || 0;
        totalTransactions += row.transactions || 0;
        uniqueCustomers += row.unique_customers || 0;

        if (row.min_date && (!minDate || row.min_date < minDate)) {
          minDate = row.min_date;
        }
        if (row.max_date && (!maxDate || row.max_date > maxDate)) {
          maxDate = row.max_date;
        }
      }
    } catch (err) {
      structuredLog('WARN', 'Failed to query connector_events', { endpoint: 'attribution', step: 'blended_connectors', error: err instanceof Error ? err.message : String(err) });
    }

    return {
      total_revenue: Math.round(totalRevenue * 100) / 100,
      total_transactions: totalTransactions,
      unique_customers: uniqueCustomers,
      date_range: { start: minDate, end: maxDate },
      by_source: bySource
    };
  }

  private calculateSpendGap(adPlatformData: any, connectorData: any) {
    const adSpend = adPlatformData.total_spend;
    const actualRevenue = connectorData.total_revenue;

    return {
      ad_spend: adSpend,
      actual_revenue: actualRevenue,
      implied_roas: adSpend > 0 ? Math.round((actualRevenue / adSpend) * 100) / 100 : null,
      spend_to_revenue_ratio: actualRevenue > 0 ? Math.round((adSpend / actualRevenue) * 100) / 100 : null,
      estimated_cpa: connectorData.total_transactions > 0
        ? Math.round((adSpend / connectorData.total_transactions) * 100) / 100
        : null
    };
  }

  private assessDataQuality(
    adPlatformData: any,
    connectorData: any,
    dateFrom: string,
    dateTo: string
  ) {
    const warnings: string[] = [];

    const adStart = adPlatformData.date_range.start;
    const adEnd = adPlatformData.date_range.end;
    const connStart = connectorData.date_range.start;
    const connEnd = connectorData.date_range.end;

    // Check for date range overlap
    let hasOverlap = false;
    if (adStart && adEnd && connStart && connEnd) {
      hasOverlap = !(adEnd < connStart || connEnd < adStart);
    }

    if (!hasOverlap && adStart && connStart) {
      warnings.push(`No date overlap: Ad data (${adStart} to ${adEnd}) vs Connector data (${connStart} to ${connEnd})`);
    }

    if (!adStart && !adEnd) {
      warnings.push('No ad platform data found in date range');
    }

    if (!connStart && !connEnd) {
      warnings.push('No connector revenue data found in date range');
    }

    if (adPlatformData.platform_reported_revenue === 0 && adPlatformData.platform_reported_conversions > 0) {
      warnings.push('Platform conversions have no revenue value - conversion tracking may not be configured');
    }

    // Check for tracking data
    warnings.push('No click tracking data - attribution is estimated based on spend distribution');

    return {
      has_overlapping_data: hasOverlap,
      ad_platform_date_range: adStart && adEnd ? `${adStart} to ${adEnd}` : null,
      connector_date_range: connStart && connEnd ? `${connStart} to ${connEnd}` : null,
      warnings
    };
  }

  private buildProbabilisticAttribution(
    adPlatformData: any,
    connectorData: any,
    dataQuality: any
  ): any[] {
    const attribution: any[] = [];
    const totalRevenue = connectorData.total_revenue;
    const totalSpend = adPlatformData.total_spend;

    // If we have overlapping data and both ad spend and revenue,
    // distribute revenue proportionally by platform spend
    if (dataQuality.has_overlapping_data && totalSpend > 0 && totalRevenue > 0) {
      for (const platform of adPlatformData.by_platform) {
        const spendShare = platform.spend / totalSpend;
        const estimatedRevenue = Math.round(totalRevenue * spendShare * 100) / 100;

        attribution.push({
          channel: platform.platform,
          estimated_revenue: estimatedRevenue,
          confidence: 'medium',
          attribution_method: 'spend_weighted'
        });
      }
    } else if (totalRevenue > 0) {
      // No overlap or no ad spend - all revenue is unattributed
      attribution.push({
        channel: 'unattributed',
        estimated_revenue: totalRevenue,
        confidence: 'none',
        attribution_method: 'no_tracking_data'
      });

      // Add platforms with zero estimated revenue but show they exist
      for (const platform of adPlatformData.by_platform) {
        if (platform.spend > 0) {
          attribution.push({
            channel: platform.platform,
            estimated_revenue: 0,
            confidence: 'low',
            attribution_method: 'no_date_overlap'
          });
        }
      }
    }

    // Sort by estimated revenue
    attribution.sort((a, b) => b.estimated_revenue - a.estimated_revenue);

    return attribution;
  }
}


/**
 * GET /v1/analytics/attribution/journey-analytics
 *
 * Get journey analytics data (Level 1 - always available).
 * Returns channel distribution, transition matrix, common paths, and data quality report.
 */
export class GetJourneyAnalytics extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get journey analytics",
    description: `
Get journey analytics data from probabilistic attribution.
This data is always available (Level 1) even when conversion matching fails.

**Returns:**
- Channel distribution (percentage of traffic by channel)
- Entry/exit channels (where users start and end their journeys)
- Common paths (most frequent user journeys)
- Transition matrix (Markov chain probabilities)
- Data quality report with recommendations

Run probabilistic attribution first to generate this data.
    `.trim(),
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date (YYYY-MM-DD)"),
        period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (YYYY-MM-DD)")
      })
    },
    responses: {
      "200": {
        description: "Journey analytics data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                channel_distribution: z.record(z.number()),
                total_sessions: z.number(),
                converting_sessions: z.number(),
                conversion_rate: z.number(),
                avg_path_length: z.number(),
                common_paths: z.array(z.object({
                  path: z.array(z.string()),
                  count: z.number(),
                  conversion_rate: z.number()
                })),
                entry_channels: z.record(z.number()),
                exit_channels: z.record(z.number()),
                transition_matrix: z.record(z.record(z.number())),
                data_quality: z.object({
                  level: z.number(),
                  level_name: z.string(),
                  total_conversions: z.number(),
                  matched_conversions: z.number(),
                  match_rate: z.number(),
                  recommendations: z.array(z.string())
                }),
                period: z.object({
                  start: z.string(),
                  end: z.string()
                }),
                computed_at: z.string()
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

    const analyticsDb = c.env.ANALYTICS_DB;
    if (!analyticsDb) {
      return error(c, "DATABASE_ERROR", "ANALYTICS_DB not configured", 500);
    }

    // Query journey analytics
    let query = `
      SELECT
        channel_distribution, total_sessions, converting_sessions,
        conversion_rate, avg_path_length, common_paths,
        entry_channels, exit_channels, transition_matrix,
        data_quality_level, data_quality_report, match_breakdown,
        total_conversions, matched_conversions,
        period_start, period_end, computed_at
      FROM journey_analytics
      WHERE organization_id = ?
    `;

    const params: any[] = [orgId];

    if (data.query.period_start && data.query.period_end) {
      query += ` AND period_start = ? AND period_end = ?`;
      params.push(data.query.period_start, data.query.period_end);
    }

    query += ` ORDER BY computed_at DESC LIMIT 1`;

    interface JourneyAnalyticsRow {
      channel_distribution: string;
      total_sessions: number;
      converting_sessions: number;
      conversion_rate: number;
      avg_path_length: number;
      common_paths: string;
      entry_channels: string;
      exit_channels: string;
      transition_matrix: string;
      data_quality_level: number;
      data_quality_report: string;
      match_breakdown: string;
      total_conversions: number;
      matched_conversions: number;
      period_start: string;
      period_end: string;
      computed_at: string;
    }
    const result = await analyticsDb.prepare(query).bind(...params).first() as JourneyAnalyticsRow | null;

    if (!result) {
      return error(c, "NO_DATA", "No journey analytics available. Run probabilistic attribution first.", 404);
    }

    // Parse JSON fields
    const dataQualityReport = JSON.parse(result.data_quality_report || '{}');

    return success(c, {
      channel_distribution: JSON.parse(result.channel_distribution || '{}'),
      total_sessions: result.total_sessions,
      converting_sessions: result.converting_sessions,
      conversion_rate: result.conversion_rate,
      avg_path_length: result.avg_path_length,
      common_paths: JSON.parse(result.common_paths || '[]'),
      entry_channels: JSON.parse(result.entry_channels || '{}'),
      exit_channels: JSON.parse(result.exit_channels || '{}'),
      transition_matrix: JSON.parse(result.transition_matrix || '{}'),
      data_quality: {
        level: result.data_quality_level,
        level_name: dataQualityReport.level_name || 'unknown',
        total_conversions: result.total_conversions,
        matched_conversions: result.matched_conversions,
        match_rate: dataQualityReport.match_rate || 0,
        recommendations: dataQualityReport.recommendations || []
      },
      period: {
        start: result.period_start,
        end: result.period_end
      },
      computed_at: result.computed_at
    });
  }
}

/**
 * GET /v1/analytics/attribution/assisted-direct
 *
 * Journey-aware direct attribution - shows how much "direct" traffic
 * is actually return visitors from prior ad campaigns.
 *
 * Uses time-decay to attribute direct visits to prior marketing touchpoints
 * within a 7-day lookback window.
 */
export class GetAssistedDirectStats extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get assisted direct traffic breakdown",
    description: `
Analyze direct traffic to distinguish between:
- **True Direct**: First-time visitors with no prior marketing touchpoints
- **Assisted Direct**: Return visitors who previously came from ad campaigns

Uses a 7-day lookback window with time-decay attribution (24-hour half-life)
to identify which marketing channels drove the original visit.

This helps understand the true value of ad spend - many "direct" visits
are actually return visitors influenced by earlier marketing.
    `.trim(),
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
        lookback_hours: z.coerce.number().min(1).max(720).optional().describe("Hours to look back for prior touchpoints (default: 168 = 7 days)")
      })
    },
    responses: {
      "200": {
        description: "Assisted direct traffic breakdown",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                total_direct_sessions: z.number().describe("Total sessions classified as 'direct'"),
                assisted_direct_sessions: z.number().describe("Direct sessions from return visitors"),
                true_direct_sessions: z.number().describe("Direct sessions with no prior touchpoints"),
                assisted_percent: z.number().describe("Percentage of direct traffic that was assisted"),
                assisted_by_channel: z.record(z.number()).describe("Breakdown by original marketing channel"),
                lookback_hours: z.number().describe("Lookback window used"),
                period: z.object({
                  start: z.string(),
                  end: z.string()
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
    const dateFrom = data.query.date_from;
    const dateTo = data.query.date_to;
    const lookbackHours = data.query.lookback_hours || 168; // 7 days default

    const analyticsDb = c.env.ANALYTICS_DB;
    if (!analyticsDb) {
      return error(c, "DATABASE_ERROR", "ANALYTICS_DB not configured", 500);
    }

    // Query touchpoints table to find direct sessions and their prior touchpoints
    const result = await analyticsDb.prepare(`
      WITH direct_sessions AS (
        SELECT DISTINCT
          t.session_id,
          t.anonymous_id,
          t.touchpoint_ts
        FROM touchpoints t
        WHERE t.organization_id = ?
          AND t.channel_group = 'direct'
          AND DATE(t.touchpoint_ts) >= ?
          AND DATE(t.touchpoint_ts) <= ?
      ),
      prior_touches AS (
        SELECT
          ds.session_id,
          ds.anonymous_id,
          (
            SELECT jt.channel_group
            FROM touchpoints jt
            WHERE jt.organization_id = ?
              AND jt.anonymous_id = ds.anonymous_id
              AND jt.channel_group != 'direct'
              AND jt.touchpoint_ts < ds.touchpoint_ts
              AND jt.touchpoint_ts >= datetime(ds.touchpoint_ts, '-' || ? || ' hours')
            ORDER BY jt.touchpoint_ts DESC
            LIMIT 1
          ) as assisted_by
        FROM direct_sessions ds
      )
      SELECT
        COUNT(DISTINCT session_id) as total_direct,
        COUNT(DISTINCT CASE WHEN assisted_by IS NOT NULL THEN session_id END) as assisted_direct,
        COUNT(DISTINCT CASE WHEN assisted_by IS NULL THEN session_id END) as true_direct,
        assisted_by,
        COUNT(DISTINCT CASE WHEN assisted_by IS NOT NULL THEN session_id END) as count_by_channel
      FROM prior_touches
      GROUP BY assisted_by
    `).bind(orgId, dateFrom, dateTo, orgId, lookbackHours).all();

    const stats = {
      total_direct_sessions: 0,
      assisted_direct_sessions: 0,
      true_direct_sessions: 0,
      assisted_by_channel: {} as Record<string, number>
    };

    for (const row of (result.results || []) as Array<{
      total_direct: number;
      assisted_direct: number;
      true_direct: number;
      assisted_by: string | null;
      count_by_channel: number;
    }>) {
      // The totals are the same across all rows due to the query structure
      stats.total_direct_sessions = row.total_direct;
      stats.assisted_direct_sessions += row.assisted_direct;
      stats.true_direct_sessions = row.true_direct;

      if (row.assisted_by) {
        stats.assisted_by_channel[row.assisted_by] = row.count_by_channel;
      }
    }

    const assistedPercent = stats.total_direct_sessions > 0
      ? (stats.assisted_direct_sessions / stats.total_direct_sessions) * 100
      : 0;

    return success(c, {
      total_direct_sessions: stats.total_direct_sessions,
      assisted_direct_sessions: stats.assisted_direct_sessions,
      true_direct_sessions: stats.true_direct_sessions,
      assisted_percent: Math.round(assistedPercent * 10) / 10,
      assisted_by_channel: stats.assisted_by_channel,
      lookback_hours: lookbackHours,
      period: {
        start: dateFrom,
        end: dateTo
      }
    });
  }
}

/**
 * GET /v1/analytics/pipeline-status
 *
 * Returns the status of automated data pipelines from sync_watermarks.
 * Replaces the manual "Run" buttons — pipelines now run automatically.
 */
export class GetPipelineStatus extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get data pipeline status",
    description: "Returns the status of automated data pipelines (attribution, click extraction, etc.) from sync watermarks.",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID")
      })
    },
    responses: {
      "200": {
        description: "Pipeline status",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                pipelines: z.array(z.object({
                  name: z.string(),
                  sync_type: z.string(),
                  last_run: z.string().nullable(),
                  records_processed: z.number(),
                  status: z.string()
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

    const analyticsDb = c.env.ANALYTICS_DB;

    try {
      const watermarks = await analyticsDb.prepare(`
        SELECT sync_type, last_synced_ts, records_synced, status, error_message, updated_at
        FROM sync_watermarks
        WHERE organization_id = ?
        ORDER BY sync_type
      `).bind(orgId).all<{
        sync_type: string;
        last_synced_ts: string | null;
        records_synced: number;
        status: string;
        error_message: string | null;
        updated_at: string;
      }>();

      const PIPELINE_NAMES: Record<string, string> = {
        aggregations: 'Conversion Aggregation',
        conversion_linking: 'Conversion Linking',
        click_extraction: 'Click Extraction',
        identity_extraction: 'Identity Resolution',
        probabilistic_attribution: 'Attribution Analysis',
        page_flow: 'Page Flow Graph',
        cac_refresh: 'CAC Refresh',
      };

      const pipelines = (watermarks.results || []).map(w => ({
        name: PIPELINE_NAMES[w.sync_type] || w.sync_type,
        sync_type: w.sync_type,
        last_run: w.last_synced_ts || w.updated_at,
        records_processed: w.records_synced || 0,
        status: w.status || 'unknown',
        error: w.error_message || null,
      }));

      return success(c, { pipelines });
    } catch (err) {
      structuredLog('WARN', 'Failed to query pipeline status', { endpoint: 'pipeline-status', error: err instanceof Error ? err.message : String(err) });
      return success(c, { pipelines: [] });
    }
  }
}
