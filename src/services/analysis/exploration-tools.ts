/**
 * Exploration Tools
 *
 * Read-only tools for the agentic loop to investigate data before making recommendations.
 * These tools have no caps (unlike recommendation tools) and allow the AI to:
 * - Query metrics for specific entities
 * - Compare multiple entities side-by-side
 * - Get creative details
 * - Get audience/targeting breakdowns
 */

import { SupabaseClient } from '../../services/supabase';

// Tool definitions for Anthropic API
export const EXPLORATION_TOOLS = {
  query_metrics: {
    name: 'query_metrics',
    description: 'Query performance metrics for a specific ad entity. Use this to investigate performance data before making recommendations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        platform: {
          type: 'string',
          enum: ['facebook', 'google', 'tiktok'],
          description: 'The ad platform'
        },
        entity_type: {
          type: 'string',
          enum: ['ad', 'adset', 'campaign', 'account'],
          description: 'Type of entity to query'
        },
        entity_id: {
          type: 'string',
          description: 'The entity ID to query'
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Metrics to retrieve: spend, impressions, clicks, conversions, ctr, cpc, cpm, roas, cpa'
        },
        days: {
          type: 'number',
          description: 'Number of days of historical data (1-90)',
          minimum: 1,
          maximum: 90
        }
      },
      required: ['platform', 'entity_type', 'entity_id', 'metrics', 'days']
    }
  },

  compare_entities: {
    name: 'compare_entities',
    description: 'Compare performance metrics across multiple entities of the same type. Useful for identifying winners and losers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        platform: {
          type: 'string',
          enum: ['facebook', 'google', 'tiktok'],
          description: 'The ad platform'
        },
        entity_type: {
          type: 'string',
          enum: ['ad', 'adset', 'campaign'],
          description: 'Type of entities to compare'
        },
        entity_ids: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 5,
          description: 'Entity IDs to compare (max 5)'
        },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Metrics to compare'
        },
        days: {
          type: 'number',
          description: 'Number of days of data',
          minimum: 1,
          maximum: 90
        }
      },
      required: ['platform', 'entity_type', 'entity_ids', 'metrics', 'days']
    }
  },

  get_creative_details: {
    name: 'get_creative_details',
    description: 'Get details about an ad creative including copy, media, and performance indicators.',
    input_schema: {
      type: 'object' as const,
      properties: {
        platform: {
          type: 'string',
          enum: ['facebook', 'google', 'tiktok'],
          description: 'The ad platform'
        },
        ad_id: {
          type: 'string',
          description: 'The ad ID to get creative details for'
        }
      },
      required: ['platform', 'ad_id']
    }
  },

  get_audience_breakdown: {
    name: 'get_audience_breakdown',
    description: 'Get targeting/audience breakdown for an ad set or campaign. Shows age, gender, placement, device, or geo performance.',
    input_schema: {
      type: 'object' as const,
      properties: {
        platform: {
          type: 'string',
          enum: ['facebook', 'google', 'tiktok'],
          description: 'The ad platform'
        },
        entity_type: {
          type: 'string',
          enum: ['adset', 'campaign'],
          description: 'Entity type'
        },
        entity_id: {
          type: 'string',
          description: 'Entity ID'
        },
        dimension: {
          type: 'string',
          enum: ['age', 'gender', 'placement', 'device', 'geo'],
          description: 'Breakdown dimension'
        },
        days: {
          type: 'number',
          minimum: 1,
          maximum: 90
        }
      },
      required: ['platform', 'entity_type', 'entity_id', 'dimension', 'days']
    }
  }
};

/**
 * Get exploration tools formatted for Anthropic API
 */
export function getExplorationTools(): Array<{
  name: string;
  description: string;
  input_schema: object;
}> {
  return Object.values(EXPLORATION_TOOLS);
}

/**
 * Check if a tool name is an exploration tool
 */
export function isExplorationTool(name: string): boolean {
  return name in EXPLORATION_TOOLS;
}

// Type definitions for tool inputs
interface QueryMetricsInput {
  platform: string;
  entity_type: string;
  entity_id: string;
  metrics: string[];
  days: number;
}

interface CompareEntitiesInput {
  platform: string;
  entity_type: string;
  entity_ids: string[];
  metrics: string[];
  days: number;
}

interface GetCreativeDetailsInput {
  platform: string;
  ad_id: string;
}

interface GetAudienceBreakdownInput {
  platform: string;
  entity_type: string;
  entity_id: string;
  dimension: string;
  days: number;
}

/**
 * Exploration Tool Executor
 */
export class ExplorationToolExecutor {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Execute an exploration tool and return results
   */
  async execute(
    toolName: string,
    input: Record<string, any>,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      switch (toolName) {
        case 'query_metrics':
          return await this.queryMetrics(input as QueryMetricsInput, orgId);
        case 'compare_entities':
          return await this.compareEntities(input as CompareEntitiesInput, orgId);
        case 'get_creative_details':
          return await this.getCreativeDetails(input as GetCreativeDetailsInput, orgId);
        case 'get_audience_breakdown':
          return await this.getAudienceBreakdown(input as GetAudienceBreakdownInput, orgId);
        default:
          return { success: false, error: `Unknown exploration tool: ${toolName}` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Tool execution failed' };
    }
  }

  /**
   * Query metrics for a specific entity
   */
  private async queryMetrics(
    input: QueryMetricsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { platform, entity_type, entity_id, metrics, days } = input;

    const tableInfo = this.getMetricsTableInfo(platform, entity_type);
    if (!tableInfo) {
      return { success: false, error: `Unsupported platform/entity for metrics: ${platform}/${entity_type}` };
    }

    // Build date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    // Build query string for Supabase REST API
    const columns = ['metric_date', 'spend_cents', 'impressions', 'clicks', 'conversions', 'conversion_value_cents'].join(',');
    const filters = `${tableInfo.idColumn}=eq.${entity_id}&organization_id=eq.${orgId}&metric_date=gte.${startStr}&metric_date=lte.${endStr}`;
    const endpoint = `${tableInfo.table}?select=${columns}&${filters}&order=metric_date.asc`;

    try {
      const data = await this.supabase.queryWithSchema<any[]>(endpoint, tableInfo.schema);

      // Enrich with derived metrics
      const enrichedData = this.enrichMetrics(data || [], metrics);
      const summary = this.summarizeMetrics(enrichedData);

      return {
        success: true,
        data: {
          entity_id,
          entity_type,
          platform,
          days,
          time_series: enrichedData,
          summary
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  /**
   * Compare multiple entities
   */
  private async compareEntities(
    input: CompareEntitiesInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { platform, entity_type, entity_ids, metrics, days } = input;

    if (entity_ids.length > 5) {
      return { success: false, error: 'Maximum 5 entities can be compared' };
    }

    const tableInfo = this.getMetricsTableInfo(platform, entity_type);
    if (!tableInfo) {
      return { success: false, error: `Unsupported platform/entity for metrics: ${platform}/${entity_type}` };
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    const comparisons = await Promise.all(
      entity_ids.map(async (entityId) => {
        const columns = ['metric_date', 'spend_cents', 'impressions', 'clicks', 'conversions', 'conversion_value_cents'].join(',');
        const filters = `${tableInfo.idColumn}=eq.${entityId}&organization_id=eq.${orgId}&metric_date=gte.${startStr}&metric_date=lte.${endStr}`;
        const endpoint = `${tableInfo.table}?select=${columns}&${filters}`;

        try {
          const data = await this.supabase.queryWithSchema<any[]>(endpoint, tableInfo.schema);
          const enrichedData = this.enrichMetrics(data || [], metrics);
          const summary = this.summarizeMetrics(enrichedData);

          return { entity_id: entityId, name: entityId, summary };
        } catch {
          return { entity_id: entityId, name: entityId, summary: { error: 'Query failed' } };
        }
      })
    );

    const rankings = this.rankEntities(comparisons, metrics);

    return {
      success: true,
      data: { platform, entity_type, days, comparisons, rankings }
    };
  }

  /**
   * Get creative details for an ad
   */
  private async getCreativeDetails(
    input: GetCreativeDetailsInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { platform, ad_id } = input;

    const tableInfo = this.getEntityTableInfo(platform, 'ad');
    if (!tableInfo) {
      return { success: false, error: `Unsupported platform` };
    }

    const filters = `${tableInfo.idColumn}=eq.${ad_id}&organization_id=eq.${orgId}`;
    const endpoint = `${tableInfo.table}?${filters}&limit=1`;

    try {
      const data = await this.supabase.queryWithSchema<any[]>(endpoint, tableInfo.schema);

      if (!data || data.length === 0) {
        return { success: false, error: `Ad not found: ${ad_id}` };
      }

      const ad = data[0];
      const creativeInfo = this.extractCreativeInfo(ad, platform);

      return {
        success: true,
        data: {
          ad_id,
          platform,
          name: ad.name,
          status: ad.status,
          ...creativeInfo
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  /**
   * Get audience breakdown
   */
  private async getAudienceBreakdown(
    input: GetAudienceBreakdownInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { platform, entity_type, entity_id, dimension } = input;

    const tableInfo = this.getEntityTableInfo(platform, entity_type);
    if (!tableInfo) {
      return { success: false, error: 'Unsupported platform/entity' };
    }

    const filters = `${tableInfo.idColumn}=eq.${entity_id}&organization_id=eq.${orgId}`;
    const endpoint = `${tableInfo.table}?select=name,targeting&${filters}&limit=1`;

    try {
      const data = await this.supabase.queryWithSchema<any[]>(endpoint, tableInfo.schema);

      if (!data || data.length === 0) {
        return { success: false, error: `Entity not found: ${entity_id}` };
      }

      const entity = data[0];
      const targeting = this.parseTargeting(entity.targeting);

      return {
        success: true,
        data: {
          entity_id,
          entity_type,
          platform,
          name: entity.name,
          dimension,
          targeting,
          note: 'Full breakdown by dimension requires platform-specific data which may not be synced.'
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' };
    }
  }

  // Helper methods

  /**
   * Get METRICS table info (for queryMetrics, compareEntities)
   * These tables have daily performance data with metric_date column
   */
  private getMetricsTableInfo(platform: string, entityType: string): { table: string; idColumn: string; schema: string } | null {
    const tables: Record<string, Record<string, { table: string; idColumn: string; schema: string }>> = {
      facebook: {
        ad: { table: 'ad_daily_metrics', idColumn: 'ad_ref', schema: 'facebook_ads' },
        adset: { table: 'ad_set_daily_metrics', idColumn: 'ad_set_ref', schema: 'facebook_ads' },
        campaign: { table: 'campaign_daily_metrics', idColumn: 'campaign_ref', schema: 'facebook_ads' }
      },
      google: {
        ad: { table: 'ad_daily_metrics', idColumn: 'ad_ref', schema: 'google_ads' },
        adset: { table: 'ad_group_daily_metrics', idColumn: 'ad_group_ref', schema: 'google_ads' },
        campaign: { table: 'campaign_daily_metrics', idColumn: 'campaign_ref', schema: 'google_ads' }
      },
      tiktok: {
        ad: { table: 'ad_daily_metrics', idColumn: 'ad_ref', schema: 'tiktok_ads' },
        adset: { table: 'ad_group_daily_metrics', idColumn: 'ad_group_ref', schema: 'tiktok_ads' },
        campaign: { table: 'campaign_daily_metrics', idColumn: 'campaign_ref', schema: 'tiktok_ads' }
      }
    };

    return tables[platform]?.[entityType] || null;
  }

  /**
   * Get ENTITY table info (for getCreativeDetails, getAudienceBreakdown)
   * These tables have entity metadata like name, status, targeting
   */
  private getEntityTableInfo(platform: string, entityType: string): { table: string; idColumn: string; schema: string } | null {
    const tables: Record<string, Record<string, { table: string; idColumn: string; schema: string }>> = {
      facebook: {
        ad: { table: 'ads', idColumn: 'ad_id', schema: 'facebook_ads' },
        adset: { table: 'ad_sets', idColumn: 'ad_set_id', schema: 'facebook_ads' },
        campaign: { table: 'campaigns', idColumn: 'campaign_id', schema: 'facebook_ads' },
        account: { table: 'accounts', idColumn: 'account_id', schema: 'facebook_ads' }
      },
      google: {
        ad: { table: 'ads', idColumn: 'ad_id', schema: 'google_ads' },
        adset: { table: 'ad_groups', idColumn: 'ad_group_id', schema: 'google_ads' },
        campaign: { table: 'campaigns', idColumn: 'campaign_id', schema: 'google_ads' },
        account: { table: 'accounts', idColumn: 'customer_id', schema: 'google_ads' }
      },
      tiktok: {
        ad: { table: 'ads', idColumn: 'ad_id', schema: 'tiktok_ads' },
        adset: { table: 'ad_groups', idColumn: 'ad_group_id', schema: 'tiktok_ads' },
        campaign: { table: 'campaigns', idColumn: 'campaign_id', schema: 'tiktok_ads' },
        account: { table: 'advertisers', idColumn: 'advertiser_id', schema: 'tiktok_ads' }
      }
    };

    return tables[platform]?.[entityType] || null;
  }

  private enrichMetrics(data: any[], requestedMetrics: string[]): any[] {
    return data.map(row => {
      const enriched = { ...row };
      const spend = row.spend_cents || 0;
      const impressions = row.impressions || 0;
      const clicks = row.clicks || 0;
      const conversions = row.conversions || 0;
      const conversionValue = row.conversion_value_cents || 0;

      if (requestedMetrics.includes('ctr') && impressions > 0) {
        enriched.ctr = ((clicks / impressions) * 100).toFixed(2) + '%';
      }
      if (requestedMetrics.includes('cpc') && clicks > 0) {
        enriched.cpc = '$' + ((spend / 100) / clicks).toFixed(2);
      }
      if (requestedMetrics.includes('cpm') && impressions > 0) {
        enriched.cpm = '$' + (((spend / 100) / impressions) * 1000).toFixed(2);
      }
      if (requestedMetrics.includes('roas') && spend > 0) {
        enriched.roas = (conversionValue / spend).toFixed(2);
      }
      if (requestedMetrics.includes('cpa') && conversions > 0) {
        enriched.cpa = '$' + ((spend / 100) / conversions).toFixed(2);
      }

      if ('spend_cents' in enriched) {
        enriched.spend = '$' + (enriched.spend_cents / 100).toFixed(2);
        delete enriched.spend_cents;
      }
      if ('conversion_value_cents' in enriched) {
        enriched.conversion_value = '$' + (enriched.conversion_value_cents / 100).toFixed(2);
        delete enriched.conversion_value_cents;
      }

      return enriched;
    });
  }

  private summarizeMetrics(data: any[]): Record<string, any> {
    if (data.length === 0) return { days_with_data: 0 };

    let totalSpend = 0;
    let totalImpressions = 0;
    let totalClicks = 0;
    let totalConversions = 0;
    let totalConversionValue = 0;

    for (const row of data) {
      totalSpend += parseFloat(row.spend?.replace('$', '') || '0');
      totalImpressions += row.impressions || 0;
      totalClicks += row.clicks || 0;
      totalConversions += row.conversions || 0;
      totalConversionValue += parseFloat(row.conversion_value?.replace('$', '') || '0');
    }

    const summary: Record<string, any> = {
      days_with_data: data.length,
      total_spend: '$' + totalSpend.toFixed(2),
      total_impressions: totalImpressions,
      total_clicks: totalClicks,
      total_conversions: totalConversions,
      total_conversion_value: '$' + totalConversionValue.toFixed(2)
    };

    if (totalImpressions > 0) {
      summary.avg_ctr = ((totalClicks / totalImpressions) * 100).toFixed(2) + '%';
    }
    if (totalClicks > 0) {
      summary.avg_cpc = '$' + (totalSpend / totalClicks).toFixed(2);
    }
    if (totalConversions > 0) {
      summary.avg_cpa = '$' + (totalSpend / totalConversions).toFixed(2);
    }
    if (totalSpend > 0) {
      summary.roas = (totalConversionValue / totalSpend).toFixed(2);
    }

    return summary;
  }

  private rankEntities(
    comparisons: Array<{ entity_id: string; name: string; summary: Record<string, any> }>,
    metrics: string[]
  ): Record<string, Array<{ entity_id: string; name: string; value: string }>> {
    const rankings: Record<string, Array<{ entity_id: string; name: string; value: string }>> = {};

    if (metrics.includes('roas')) {
      rankings.by_roas = [...comparisons]
        .map(c => ({ entity_id: c.entity_id, name: c.name, value: c.summary.roas || '0' }))
        .sort((a, b) => parseFloat(b.value) - parseFloat(a.value));
    }

    if (metrics.includes('cpa')) {
      rankings.by_cpa = [...comparisons]
        .map(c => ({ entity_id: c.entity_id, name: c.name, value: c.summary.avg_cpa || '$0' }))
        .sort((a, b) => parseFloat(a.value.replace('$', '')) - parseFloat(b.value.replace('$', '')));
    }

    if (metrics.includes('ctr')) {
      rankings.by_ctr = [...comparisons]
        .map(c => ({ entity_id: c.entity_id, name: c.name, value: c.summary.avg_ctr || '0%' }))
        .sort((a, b) => parseFloat(b.value) - parseFloat(a.value));
    }

    return rankings;
  }

  private extractCreativeInfo(ad: any, platform: string): Record<string, any> {
    const info: Record<string, any> = {};

    if (platform === 'facebook') {
      info.creative_type = ad.creative_type || 'unknown';
      info.headline = ad.headline;
      info.body = ad.body;
      info.call_to_action = ad.call_to_action;
      info.image_url = ad.image_url;
      info.video_url = ad.video_url;
    } else if (platform === 'google') {
      info.ad_type = ad.type || 'unknown';
      info.headlines = ad.headlines;
      info.descriptions = ad.descriptions;
      info.final_urls = ad.final_urls;
    } else if (platform === 'tiktok') {
      info.ad_format = ad.ad_format || 'unknown';
      info.ad_text = ad.ad_text;
      info.video_id = ad.video_id;
      info.call_to_action = ad.call_to_action;
    }

    return info;
  }

  private parseTargeting(targeting: any): Record<string, any> {
    if (!targeting) return { raw: null };

    try {
      return typeof targeting === 'string' ? JSON.parse(targeting) : targeting;
    } catch {
      return { raw: targeting };
    }
  }
}
