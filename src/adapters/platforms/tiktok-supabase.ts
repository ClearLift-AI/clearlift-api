/**
 * TikTok Ads Data Adapter for Supabase
 *
 * Handles querying TikTok Ads data from Supabase tiktok_ads schema
 * Schema reference: clearlift-cron/schemas/tiktok-ads/01-complete-schema.sql
 */

import { SupabaseClient } from '../../services/supabase';

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
}

export interface TikTokCampaign {
  id: string;
  organization_id: string;
  advertiser_id: string;
  campaign_id: string;
  campaign_name: string;
  campaign_status: 'ACTIVE' | 'PAUSED' | 'DELETED';
  objective_type?: string;
  budget_cents?: number;
  budget_mode?: string;
  created_at: string;
  updated_at: string;
  last_synced_at?: string;
}

export interface TikTokAdGroup {
  id: string;
  organization_id: string;
  advertiser_id: string;
  campaign_id: string;
  ad_group_id: string;
  ad_group_name: string;
  ad_group_status: 'ACTIVE' | 'PAUSED' | 'DELETED';
  budget_cents?: number;
  bid_price_cents?: number;
  optimization_goal?: string;
  targeting?: any;
  created_at: string;
  updated_at: string;
  last_synced_at?: string;
}

export interface TikTokAd {
  id: string;
  organization_id: string;
  advertiser_id: string;
  campaign_id: string;
  ad_group_id: string;
  ad_id: string;
  ad_name?: string;
  ad_status: 'ACTIVE' | 'PAUSED' | 'DELETED';
  ad_text?: string;
  call_to_action?: string;
  video_id?: string;
  image_ids?: any;
  landing_page_url?: string;
  created_at: string;
  updated_at: string;
}

export interface TikTokDailyMetrics {
  id: string;
  organization_id: string;
  metric_date: string;
  impressions: number;
  clicks: number;
  spend_cents: number;
  reach?: number;
  conversions?: number;
  conversion_value_cents?: number;
  ctr: number;
  cpc_cents: number;
  cpm_cents: number;
  video_views?: number;
  video_p25_rate?: number;
  video_p50_rate?: number;
  video_p75_rate?: number;
  video_p100_rate?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  profile_visits?: number;
  created_at: string;
}

export class TikTokAdsSupabaseAdapter {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Get campaigns for an organization
   */
  async getCampaigns(
    orgId: string,
    options: {
      dateRange?: DateRange;
      limit?: number;
      offset?: number;
      status?: string;
    } = {}
  ): Promise<TikTokCampaign[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `deleted_at.is.null`
    ];

    if (options.status) {
      filters.push(`campaign_status.eq.${options.status}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<TikTokCampaign>(
      'campaigns',
      query,
      {
        limit: options.limit || 1000,
        offset: options.offset || 0,
        order: 'created_at.desc'
      }
    );

    return result || [];
  }

  /**
   * Get ad groups for an organization
   */
  async getAdGroups(
    orgId: string,
    options: {
      campaignId?: string;
      dateRange?: DateRange;
      limit?: number;
      offset?: number;
      status?: string;
    } = {}
  ): Promise<TikTokAdGroup[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `deleted_at.is.null`
    ];

    if (options.campaignId) {
      filters.push(`campaign_id.eq.${options.campaignId}`);
    }

    if (options.status) {
      filters.push(`ad_group_status.eq.${options.status}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<TikTokAdGroup>(
      'ad_groups',
      query,
      {
        limit: options.limit || 1000,
        offset: options.offset || 0,
        order: 'created_at.desc'
      }
    );

    return result || [];
  }

  /**
   * Get ads for an organization
   */
  async getAds(
    orgId: string,
    options: {
      campaignId?: string;
      adGroupId?: string;
      dateRange?: DateRange;
      limit?: number;
      offset?: number;
      status?: string;
    } = {}
  ): Promise<TikTokAd[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `deleted_at.is.null`
    ];

    if (options.campaignId) {
      filters.push(`campaign_id.eq.${options.campaignId}`);
    }

    if (options.adGroupId) {
      filters.push(`ad_group_id.eq.${options.adGroupId}`);
    }

    if (options.status) {
      filters.push(`ad_status.eq.${options.status}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<TikTokAd>(
      'ads',
      query,
      {
        limit: options.limit || 1000,
        offset: options.offset || 0,
        order: 'created_at.desc'
      }
    );

    return result || [];
  }

  /**
   * Get campaign daily metrics for an organization
   */
  async getCampaignDailyMetrics(
    orgId: string,
    dateRange: DateRange,
    options: {
      campaignId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<TikTokDailyMetrics[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `metric_date.gte.${dateRange.start}`,
      `metric_date.lte.${dateRange.end}`
    ];

    if (options.campaignId) {
      filters.push(`campaign_ref.eq.${options.campaignId}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<TikTokDailyMetrics>(
      'campaign_daily_metrics',
      query,
      {
        limit: options.limit || 10000,
        offset: options.offset || 0,
        order: 'metric_date.desc'
      }
    );

    return result || [];
  }

  /**
   * Get ad group daily metrics for an organization
   */
  async getAdGroupDailyMetrics(
    orgId: string,
    dateRange: DateRange,
    options: {
      adGroupId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<TikTokDailyMetrics[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `metric_date.gte.${dateRange.start}`,
      `metric_date.lte.${dateRange.end}`
    ];

    if (options.adGroupId) {
      filters.push(`ad_group_ref.eq.${options.adGroupId}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<TikTokDailyMetrics>(
      'ad_group_daily_metrics',
      query,
      {
        limit: options.limit || 10000,
        offset: options.offset || 0,
        order: 'metric_date.desc'
      }
    );

    return result || [];
  }

  /**
   * Get ad daily metrics for an organization
   */
  async getAdDailyMetrics(
    orgId: string,
    dateRange: DateRange,
    options: {
      adId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<TikTokDailyMetrics[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `metric_date.gte.${dateRange.start}`,
      `metric_date.lte.${dateRange.end}`
    ];

    if (options.adId) {
      filters.push(`ad_ref.eq.${options.adId}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<TikTokDailyMetrics>(
      'ad_daily_metrics',
      query,
      {
        limit: options.limit || 10000,
        offset: options.offset || 0,
        order: 'metric_date.desc'
      }
    );

    return result || [];
  }

  /**
   * Get aggregated metrics summary for an organization
   */
  async getMetricsSummary(
    orgId: string,
    dateRange: DateRange,
    level: 'campaign' | 'ad_group' | 'ad' = 'campaign'
  ): Promise<{
    total_spend_cents: number;
    total_impressions: number;
    total_clicks: number;
    total_conversions: number;
    total_conversion_value_cents: number;
    total_reach: number;
    average_ctr: number;
    average_cpc_cents: number;
    average_cpm_cents: number;
  }> {
    const tableName = level === 'campaign'
      ? 'campaign_daily_metrics'
      : level === 'ad_group'
      ? 'ad_group_daily_metrics'
      : 'ad_daily_metrics';

    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `metric_date.gte.${dateRange.start}`,
      `metric_date.lte.${dateRange.end}`
    ];

    const query = filters.join('&');

    const metrics = await this.supabase.select<TikTokDailyMetrics>(
      tableName,
      query,
      { limit: 10000 }
    );

    // Aggregate client-side (Supabase PostgREST doesn't support aggregation)
    const summary = (metrics || []).reduce(
      (acc, metric) => ({
        total_spend_cents: acc.total_spend_cents + (metric.spend_cents || 0),
        total_impressions: acc.total_impressions + (metric.impressions || 0),
        total_clicks: acc.total_clicks + (metric.clicks || 0),
        total_conversions: acc.total_conversions + (metric.conversions || 0),
        total_conversion_value_cents: acc.total_conversion_value_cents + (metric.conversion_value_cents || 0),
        total_reach: acc.total_reach + (metric.reach || 0),
        average_ctr: 0, // Calculate after
        average_cpc_cents: 0, // Calculate after
        average_cpm_cents: 0 // Calculate after
      }),
      {
        total_spend_cents: 0,
        total_impressions: 0,
        total_clicks: 0,
        total_conversions: 0,
        total_conversion_value_cents: 0,
        total_reach: 0,
        average_ctr: 0,
        average_cpc_cents: 0,
        average_cpm_cents: 0
      }
    );

    // Calculate averages
    if (summary.total_impressions > 0) {
      summary.average_ctr = (summary.total_clicks / summary.total_impressions) * 100;
    }
    if (summary.total_clicks > 0) {
      summary.average_cpc_cents = Math.round(summary.total_spend_cents / summary.total_clicks);
    }
    if (summary.total_impressions > 0) {
      summary.average_cpm_cents = Math.round((summary.total_spend_cents / summary.total_impressions) * 1000);
    }

    return summary;
  }
}
