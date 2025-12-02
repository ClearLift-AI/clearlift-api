/**
 * Facebook Ads Data Adapter for Supabase
 *
 * Handles querying Facebook Ads data from Supabase facebook_ads schema
 * Schema reference: clearlift-cron/schemas/facebook-ads/01-complete-schema.sql
 */

import { SupabaseClient } from '../../services/supabase';

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
}

export interface FacebookCampaign {
  id: string;
  organization_id: string;
  account_id: string;
  campaign_id: string;
  campaign_name: string;
  campaign_status: 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';
  objective?: string;
  buying_type?: string;
  bid_strategy?: string;
  daily_budget_cents?: number;
  lifetime_budget_cents?: number;
  start_time?: string;
  stop_time?: string;
  created_at: string;
  updated_at: string;
  last_synced_at?: string;
}

export interface FacebookAdSet {
  id: string;
  organization_id: string;
  account_id: string;
  campaign_id: string;
  ad_set_id: string;
  ad_set_name: string;
  ad_set_status: 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';
  daily_budget_cents?: number;
  lifetime_budget_cents?: number;
  budget_remaining_cents?: number;
  bid_amount_cents?: number;
  optimization_goal?: string;
  billing_event?: string;
  targeting?: any;
  start_time?: string;
  end_time?: string;
  created_at: string;
  updated_at: string;
  last_synced_at?: string;
}

export interface FacebookCreative {
  id: string;
  organization_id: string;
  account_id: string;
  creative_id: string;
  creative_name?: string;
  title?: string;
  body?: string;
  link_url?: string;
  display_link?: string;
  call_to_action_type?: string;
  image_hash?: string;
  image_url?: string;
  video_id?: string;
  thumbnail_url?: string;
  created_at: string;
  updated_at: string;
  last_synced_at?: string;
}

export interface FacebookAd {
  id: string;
  organization_id: string;
  account_id: string;
  campaign_id: string;
  ad_set_id: string;
  ad_id: string;
  ad_name: string;
  ad_status: 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';
  created_at: string;
  updated_at: string;
  last_synced_at?: string;
}

export interface FacebookDailyMetrics {
  id: string;
  organization_id: string;
  metric_date: string;
  impressions: number;
  clicks: number;
  spend_cents: number;
  reach: number;
  frequency: number;
  conversions: number;
  conversion_value_cents: number;
  ctr: number;
  cpc_cents: number;
  cpm_cents: number;
  cpp_cents: number;
  post_engagements?: number;
  post_reactions?: number;
  post_comments?: number;
  post_shares?: number;
  link_clicks?: number;
  video_views?: number;
  created_at: string;
  updated_at: string;
}

export class FacebookSupabaseAdapter {
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
  ): Promise<FacebookCampaign[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `deleted_at.is.null`
    ];

    if (options.status) {
      filters.push(`campaign_status.eq.${options.status}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<FacebookCampaign>(
      'campaigns',
      query,
      {
        limit: options.limit || 1000,
        offset: options.offset || 0,
        order: 'created_at.desc',
        schema: 'facebook_ads'
      }
    );

    return result || [];
  }

  /**
   * Get ad sets for an organization
   */
  async getAdSets(
    orgId: string,
    options: {
      campaignId?: string;
      dateRange?: DateRange;
      limit?: number;
      offset?: number;
      status?: string;
    } = {}
  ): Promise<FacebookAdSet[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `deleted_at.is.null`
    ];

    if (options.campaignId) {
      filters.push(`campaign_id.eq.${options.campaignId}`);
    }

    if (options.status) {
      filters.push(`ad_set_status.eq.${options.status}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<FacebookAdSet>(
      'ad_sets',
      query,
      {
        limit: options.limit || 1000,
        offset: options.offset || 0,
        order: 'created_at.desc',
        schema: 'facebook_ads'
      }
    );

    return result || [];
  }

  /**
   * Get creatives for an organization
   */
  async getCreatives(
    orgId: string,
    options: {
      dateRange?: DateRange;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<FacebookCreative[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `deleted_at.is.null`
    ];

    const query = filters.join('&');

    const result = await this.supabase.select<FacebookCreative>(
      'creatives',
      query,
      {
        limit: options.limit || 1000,
        offset: options.offset || 0,
        order: 'created_at.desc',
        schema: 'facebook_ads'
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
      adSetId?: string;
      dateRange?: DateRange;
      limit?: number;
      offset?: number;
      status?: string;
    } = {}
  ): Promise<FacebookAd[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `deleted_at.is.null`
    ];

    if (options.campaignId) {
      filters.push(`campaign_id.eq.${options.campaignId}`);
    }

    if (options.adSetId) {
      filters.push(`ad_set_id.eq.${options.adSetId}`);
    }

    if (options.status) {
      filters.push(`ad_status.eq.${options.status}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<FacebookAd>(
      'ads',
      query,
      {
        limit: options.limit || 1000,
        offset: options.offset || 0,
        order: 'created_at.desc',
        schema: 'facebook_ads'
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
  ): Promise<FacebookDailyMetrics[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `metric_date.gte.${dateRange.start}`,
      `metric_date.lte.${dateRange.end}`
    ];

    if (options.campaignId) {
      filters.push(`campaign_ref.eq.${options.campaignId}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<FacebookDailyMetrics>(
      'campaign_daily_metrics',
      query,
      {
        limit: options.limit || 10000,
        offset: options.offset || 0,
        order: 'metric_date.desc',
        schema: 'facebook_ads'
      }
    );

    return result || [];
  }

  /**
   * Get ad set daily metrics for an organization
   */
  async getAdSetDailyMetrics(
    orgId: string,
    dateRange: DateRange,
    options: {
      adSetId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<FacebookDailyMetrics[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `metric_date.gte.${dateRange.start}`,
      `metric_date.lte.${dateRange.end}`
    ];

    if (options.adSetId) {
      filters.push(`ad_set_ref.eq.${options.adSetId}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<FacebookDailyMetrics>(
      'ad_set_daily_metrics',
      query,
      {
        limit: options.limit || 10000,
        offset: options.offset || 0,
        order: 'metric_date.desc',
        schema: 'facebook_ads'
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
  ): Promise<FacebookDailyMetrics[]> {
    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `metric_date.gte.${dateRange.start}`,
      `metric_date.lte.${dateRange.end}`
    ];

    if (options.adId) {
      filters.push(`ad_ref.eq.${options.adId}`);
    }

    const query = filters.join('&');

    const result = await this.supabase.select<FacebookDailyMetrics>(
      'ad_daily_metrics',
      query,
      {
        limit: options.limit || 10000,
        offset: options.offset || 0,
        order: 'metric_date.desc',
        schema: 'facebook_ads'
      }
    );

    return result || [];
  }

  /**
   * Get campaigns with aggregated metrics for an organization
   * Joins campaigns with campaign_daily_metrics for the date range
   */
  async getCampaignsWithMetrics(
    orgId: string,
    dateRange: DateRange,
    options: {
      status?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<Array<FacebookCampaign & {
    metrics: {
      impressions: number;
      clicks: number;
      spend_cents: number;
      conversions: number;
      reach: number;
      ctr: number;
      cpc_cents: number;
    };
  }>> {
    // Fetch campaigns
    const campaigns = await this.getCampaigns(orgId, {
      status: options.status,
      limit: options.limit,
      offset: options.offset
    });

    if (campaigns.length === 0) {
      return [];
    }

    // Fetch all campaign metrics for the date range
    const allMetrics = await this.getCampaignDailyMetrics(orgId, dateRange, {
      limit: 50000 // High limit to get all metrics
    });

    // Group metrics by campaign_ref (which is the campaign UUID)
    const metricsByCampaignRef: Record<string, {
      impressions: number;
      clicks: number;
      spend_cents: number;
      conversions: number;
      reach: number;
    }> = {};

    for (const metric of allMetrics) {
      const ref = (metric as any).campaign_ref;
      if (!ref) continue;

      if (!metricsByCampaignRef[ref]) {
        metricsByCampaignRef[ref] = {
          impressions: 0,
          clicks: 0,
          spend_cents: 0,
          conversions: 0,
          reach: 0
        };
      }

      metricsByCampaignRef[ref].impressions += metric.impressions || 0;
      metricsByCampaignRef[ref].clicks += metric.clicks || 0;
      metricsByCampaignRef[ref].spend_cents += metric.spend_cents || 0;
      metricsByCampaignRef[ref].conversions += metric.conversions || 0;
      metricsByCampaignRef[ref].reach += metric.reach || 0;
    }

    // Join campaigns with their aggregated metrics
    return campaigns.map(campaign => {
      const campaignMetrics = metricsByCampaignRef[campaign.id] || {
        impressions: 0,
        clicks: 0,
        spend_cents: 0,
        conversions: 0,
        reach: 0
      };

      const ctr = campaignMetrics.impressions > 0
        ? (campaignMetrics.clicks / campaignMetrics.impressions) * 100
        : 0;
      const cpc_cents = campaignMetrics.clicks > 0
        ? Math.round(campaignMetrics.spend_cents / campaignMetrics.clicks)
        : 0;

      return {
        ...campaign,
        metrics: {
          ...campaignMetrics,
          ctr,
          cpc_cents
        }
      };
    });
  }

  /**
   * Get aggregated metrics summary for an organization
   */
  async getMetricsSummary(
    orgId: string,
    dateRange: DateRange,
    level: 'campaign' | 'ad_set' | 'ad' = 'campaign'
  ): Promise<{
    total_spend_cents: number;
    total_impressions: number;
    total_clicks: number;
    total_conversions: number;
    total_reach: number;
    average_ctr: number;
    average_cpc_cents: number;
    average_cpm_cents: number;
  }> {
    const tableName = level === 'campaign'
      ? 'campaign_daily_metrics'
      : level === 'ad_set'
      ? 'ad_set_daily_metrics'
      : 'ad_daily_metrics';

    const filters: string[] = [
      `organization_id.eq.${orgId}`,
      `metric_date.gte.${dateRange.start}`,
      `metric_date.lte.${dateRange.end}`
    ];

    const query = filters.join('&');

    const metrics = await this.supabase.select<FacebookDailyMetrics>(
      tableName,
      query,
      { limit: 10000, schema: 'facebook_ads' }
    );

    // Aggregate client-side (Supabase PostgREST doesn't support aggregation)
    const summary = (metrics || []).reduce(
      (acc, metric) => ({
        total_spend_cents: acc.total_spend_cents + (metric.spend_cents || 0),
        total_impressions: acc.total_impressions + (metric.impressions || 0),
        total_clicks: acc.total_clicks + (metric.clicks || 0),
        total_conversions: acc.total_conversions + (metric.conversions || 0),
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
