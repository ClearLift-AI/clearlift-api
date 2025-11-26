/**
 * Unified Platform Data Adapter for Supabase
 *
 * Handles querying the unified_ad_daily_performance materialized view
 * Schema reference: clearlift-cron/schemas/clearlift/02-unified-ad-performance.sql
 */

import { SupabaseClient } from '../../services/supabase';

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
}

export interface UnifiedDailyPerformance {
  organization_id: string;
  connection_id: string;
  platform: 'google_ads' | 'facebook_ads' | 'tiktok_ads';
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  metric_date: string;
  spend_cents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value_cents: number;
  ctr: number;
  cpc_cents: number;
  cpm_cents: number;
  roas: number;
  cpa_cents: number;
  reach?: number;
  frequency?: number;
  video_views?: number;
  last_updated: string;
}

export interface PlatformSummary {
  spend_cents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  campaigns: number;
}

export interface UnifiedSummary {
  total_spend_cents: number;
  total_impressions: number;
  total_clicks: number;
  total_conversions: number;
  average_ctr: number;
  average_cpc_cents: number;
  platforms_active: string[];
}

export class UnifiedSupabaseAdapter {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Get unified metrics for all platforms
   */
  async getUnifiedMetrics(
    orgId: string,
    dateRange?: DateRange,
    options: {
      platform?: string;
      limit?: number;
    } = {}
  ): Promise<UnifiedDailyPerformance[]> {
    const filters: string[] = [`organization_id.eq.${orgId}`];

    if (dateRange) {
      filters.push(`metric_date.gte.${dateRange.start}`, `metric_date.lte.${dateRange.end}`);
    }

    if (options.platform) {
      filters.push(`platform.eq.${options.platform}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<UnifiedDailyPerformance>(
      'unified_ad_daily_performance',
      query,
      {
        limit: options.limit || 10000,
        order: 'metric_date.desc'
      }
    );

    return result || [];
  }

  /**
   * Get metrics aggregated by platform
   */
  async getMetricsByPlatform(
    orgId: string,
    dateRange?: DateRange
  ): Promise<Record<string, PlatformSummary>> {
    const metrics = await this.getUnifiedMetrics(orgId, dateRange);

    const byPlatform: Record<string, PlatformSummary> = {};

    for (const metric of metrics) {
      const platform = metric.platform;

      if (!byPlatform[platform]) {
        byPlatform[platform] = {
          spend_cents: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          campaigns: 0
        };
      }

      byPlatform[platform].spend_cents += metric.spend_cents || 0;
      byPlatform[platform].impressions += metric.impressions || 0;
      byPlatform[platform].clicks += metric.clicks || 0;
      byPlatform[platform].conversions += metric.conversions || 0;
    }

    // Count unique campaigns per platform
    for (const platform of Object.keys(byPlatform)) {
      const platformMetrics = metrics.filter(m => m.platform === platform);
      const uniqueCampaigns = new Set(platformMetrics.map(m => m.campaign_id));
      byPlatform[platform].campaigns = uniqueCampaigns.size;
    }

    return byPlatform;
  }

  /**
   * Get time series data grouped by date
   */
  async getTimeSeries(
    orgId: string,
    dateRange?: DateRange
  ): Promise<Array<{
    date: string;
    total_spend_cents: number;
    total_impressions: number;
    total_clicks: number;
    total_conversions: number;
    by_platform: Record<string, {
      spend_cents: number;
      impressions: number;
      clicks: number;
      conversions: number;
    }>;
  }>> {
    const metrics = await this.getUnifiedMetrics(orgId, dateRange);

    const timeSeriesByDate: Record<string, any> = {};

    for (const metric of metrics) {
      const date = metric.metric_date;

      if (!timeSeriesByDate[date]) {
        timeSeriesByDate[date] = {
          date,
          total_spend_cents: 0,
          total_impressions: 0,
          total_clicks: 0,
          total_conversions: 0,
          by_platform: {}
        };
      }

      timeSeriesByDate[date].total_spend_cents += metric.spend_cents || 0;
      timeSeriesByDate[date].total_impressions += metric.impressions || 0;
      timeSeriesByDate[date].total_clicks += metric.clicks || 0;
      timeSeriesByDate[date].total_conversions += metric.conversions || 0;

      if (!timeSeriesByDate[date].by_platform[metric.platform]) {
        timeSeriesByDate[date].by_platform[metric.platform] = {
          spend_cents: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0
        };
      }

      timeSeriesByDate[date].by_platform[metric.platform].spend_cents += metric.spend_cents || 0;
      timeSeriesByDate[date].by_platform[metric.platform].impressions += metric.impressions || 0;
      timeSeriesByDate[date].by_platform[metric.platform].clicks += metric.clicks || 0;
      timeSeriesByDate[date].by_platform[metric.platform].conversions += metric.conversions || 0;
    }

    return Object.values(timeSeriesByDate).sort((a: any, b: any) =>
      a.date.localeCompare(b.date)
    );
  }

  /**
   * Get overall summary across all platforms
   */
  async getSummary(
    orgId: string,
    dateRange?: DateRange
  ): Promise<UnifiedSummary> {
    const metrics = await this.getUnifiedMetrics(orgId, dateRange);

    const summary = metrics.reduce(
      (acc, metric) => ({
        total_spend_cents: acc.total_spend_cents + (metric.spend_cents || 0),
        total_impressions: acc.total_impressions + (metric.impressions || 0),
        total_clicks: acc.total_clicks + (metric.clicks || 0),
        total_conversions: acc.total_conversions + (metric.conversions || 0),
        average_ctr: 0,
        average_cpc_cents: 0,
        platforms_active: acc.platforms_active
      }),
      {
        total_spend_cents: 0,
        total_impressions: 0,
        total_clicks: 0,
        total_conversions: 0,
        average_ctr: 0,
        average_cpc_cents: 0,
        platforms_active: [] as string[]
      }
    );

    // Calculate averages
    if (summary.total_impressions > 0) {
      summary.average_ctr = (summary.total_clicks / summary.total_impressions) * 100;
    }
    if (summary.total_clicks > 0) {
      summary.average_cpc_cents = Math.round(summary.total_spend_cents / summary.total_clicks);
    }

    // Get unique platforms
    const uniquePlatforms = new Set(metrics.map(m => m.platform));
    summary.platforms_active = Array.from(uniquePlatforms);

    return summary;
  }
}
