/**
 * Base interface for platform adapters
 * All platform-specific adapters should implement this interface
 */

export interface CampaignMetrics {
  impressions: number;
  clicks: number;
  spend: number;
  conversions?: number;
  revenue?: number;
  ctr: number; // Click-through rate percentage
  cpc: number; // Cost per click
  cpm: number; // Cost per thousand impressions
  roas?: number; // Return on ad spend
}

export interface Campaign {
  campaign_id: string | number;
  campaign_name: string;
  status: string;
  objective?: string;
  budget?: number;
  metrics: CampaignMetrics;
  date_reported?: string;
}

export interface AdPerformance {
  ad_id: string | number;
  ad_name: string;
  campaign_id: string | number;
  campaign_name: string;
  adset_name?: string;
  status: string;
  metrics: CampaignMetrics;
  date_reported: string;
}

export interface PlatformSummary {
  total_spend: number;
  total_impressions: number;
  total_clicks: number;
  total_conversions: number;
  total_revenue: number;
  avg_ctr: number;
  avg_cpc: number;
  avg_cpm: number;
  avg_roas: number;
  campaigns_count: number;
  ads_count: number;
}

export interface DateRange {
  start_date: string; // YYYY-MM-DD
  end_date: string; // YYYY-MM-DD
}

export interface PlatformAdapter {
  /**
   * Get campaigns for an organization
   */
  getCampaigns(
    orgId: string,
    dateRange: DateRange,
    options?: {
      limit?: number;
      offset?: number;
      sort_by?: string;
      order?: "asc" | "desc";
    }
  ): Promise<Campaign[]>;

  /**
   * Get specific campaign details
   */
  getCampaign(
    orgId: string,
    campaignId: string,
    dateRange: DateRange
  ): Promise<Campaign | null>;

  /**
   * Get ads performance
   */
  getAds(
    orgId: string,
    dateRange: DateRange,
    options?: {
      campaign_id?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<AdPerformance[]>;

  /**
   * Get platform summary statistics
   */
  getSummary(orgId: string, dateRange: DateRange): Promise<PlatformSummary>;

  /**
   * Get daily time series data
   */
  getDailyMetrics(
    orgId: string,
    dateRange: DateRange,
    options?: {
      campaign_id?: string;
      group_by?: "day" | "week" | "month";
    }
  ): Promise<any[]>;
}

/**
 * Helper to aggregate metrics
 */
export function aggregateMetrics(data: any[]): PlatformSummary {
  const summary: PlatformSummary = {
    total_spend: 0,
    total_impressions: 0,
    total_clicks: 0,
    total_conversions: 0,
    total_revenue: 0,
    avg_ctr: 0,
    avg_cpc: 0,
    avg_cpm: 0,
    avg_roas: 0,
    campaigns_count: 0,
    ads_count: 0
  };

  if (!data || data.length === 0) {
    return summary;
  }

  // Sum up totals
  data.forEach((row) => {
    summary.total_spend += row.spend || 0;
    summary.total_impressions += row.impressions || 0;
    summary.total_clicks += row.total_clicks || row.clicks || 0;
    summary.total_conversions += row.purchases || row.conversions || 0;
    summary.total_revenue += row.revenue || (row.purchases * (row.cost_per_purchase || 0)) || 0;
  });

  // Calculate averages
  if (summary.total_impressions > 0) {
    summary.avg_ctr = (summary.total_clicks / summary.total_impressions) * 100;
  }

  if (summary.total_clicks > 0) {
    summary.avg_cpc = summary.total_spend / summary.total_clicks;
  }

  if (summary.total_impressions > 0) {
    summary.avg_cpm = (summary.total_spend / summary.total_impressions) * 1000;
  }

  if (summary.total_spend > 0) {
    summary.avg_roas = summary.total_revenue / summary.total_spend;
  }

  // Count unique campaigns and ads
  const uniqueCampaigns = new Set(data.map((row) => row.campaign_id));
  const uniqueAds = new Set(data.map((row) => row.ad_id));

  summary.campaigns_count = uniqueCampaigns.size;
  summary.ads_count = uniqueAds.size;

  return summary;
}

/**
 * Group data by time period
 */
export function groupByPeriod(
  data: any[],
  period: "day" | "week" | "month"
): Map<string, any[]> {
  const grouped = new Map<string, any[]>();

  data.forEach((row) => {
    const date = new Date(row.date_reported);
    let key: string;

    switch (period) {
      case "week":
        // Get week number
        const weekNum = getWeekNumber(date);
        key = `${date.getFullYear()}-W${weekNum}`;
        break;
      case "month":
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        break;
      default:
        key = row.date_reported;
    }

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(row);
  });

  return grouped;
}

function getWeekNumber(date: Date): number {
  const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
  const pastDaysOfYear = (date.getTime() - firstDayOfYear.getTime()) / 86400000;
  return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

/**
 * Generic platform adapter that queries the unified_ad_daily_performance view
 * This allows querying all platforms (Google, Facebook, TikTok) using a single unified schema
 */
export class GenericPlatformAdapter implements PlatformAdapter {
  private supabaseUrl: string;
  private supabaseKey: string;
  private platform: string;
  private unifiedView: string = "unified_ad_daily_performance";

  constructor(supabaseUrl: string, supabaseKey: string, tableName: string) {
    this.supabaseUrl = supabaseUrl.replace(/\/$/, "");
    this.supabaseKey = supabaseKey;

    // Extract platform from table name (backwards compatibility)
    // tableName could be "facebook_ads_performance" or just "facebook"
    this.platform = tableName.replace(/_ads_performance$/, "").replace(/_ads$/, "");

    // Normalize platform names to match unified view
    // Map 'meta'/'facebook' to 'facebook_ads', 'google' to 'google_ads', etc.
    if (this.platform === 'meta' || this.platform === 'facebook') {
      this.platform = 'facebook_ads';
    } else if (this.platform === 'google') {
      this.platform = 'google_ads';
    } else if (this.platform === 'tiktok') {
      this.platform = 'tiktok_ads';
    } else if (!this.platform.endsWith('_ads')) {
      this.platform = `${this.platform}_ads`;
    }
  }

  /**
   * Make a request to Supabase PostgREST API with clearlift schema
   */
  private async supabaseRequest(
    endpoint: string,
    params?: URLSearchParams
  ): Promise<any> {
    const url = new URL(`${this.supabaseUrl}/rest/v1/${endpoint}`);
    if (params) {
      url.search = params.toString();
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "apikey": this.supabaseKey,
        "Authorization": `Bearer ${this.supabaseKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
        "Accept-Profile": "clearlift",  // ✅ Query clearlift schema
        "Content-Profile": "clearlift"   // ✅ Query clearlift schema
      }
    });

    if (!response.ok) {
      const error = await response.text();

      // Check if it's a table not found error
      if (response.status === 404 || error.includes("not found") || error.includes("does not exist")) {
        throw new Error(`PLATFORM_NOT_AVAILABLE: No data available for ${this.platform}. The connector may not be configured, or data hasn't been synced yet.`);
      }

      throw new Error(`Supabase request failed: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async getCampaigns(
    orgId: string,
    dateRange: DateRange,
    options?: {
      limit?: number;
      offset?: number;
      sort_by?: string;
      order?: "asc" | "desc";
    }
  ): Promise<Campaign[]> {
    const params = new URLSearchParams();
    params.append("organization_id", `eq.${orgId}`);
    params.append("platform", `eq.${this.platform}`);
    params.append("metric_date", `gte.${dateRange.start_date}`);
    params.append("metric_date", `lte.${dateRange.end_date}`);

    // Query the unified view
    const data = await this.supabaseRequest(this.unifiedView, params);

    if (!data || data.length === 0) {
      return [];
    }

    // Aggregate by campaign_id
    const campaignMap = new Map<string, any>();

    data.forEach((row: any) => {
      const key = row.campaign_id;
      if (!key) return;

      if (!campaignMap.has(key)) {
        campaignMap.set(key, {
          campaign_id: key,
          campaign_name: row.campaign_name || 'Unknown Campaign',
          status: row.campaign_status || 'ACTIVE',
          metrics: {
            impressions: 0,
            clicks: 0,
            spend: 0,
            conversions: 0,
            revenue: 0,
            ctr: 0,
            cpc: 0,
            cpm: 0,
            roas: 0
          }
        });
      }

      const campaign = campaignMap.get(key)!;
      campaign.metrics.impressions += row.impressions || 0;
      campaign.metrics.clicks += row.clicks || 0;
      campaign.metrics.spend += (row.spend_cents || 0) / 100; // Convert cents to dollars
      campaign.metrics.conversions += row.conversions || 0;
      campaign.metrics.revenue += (row.conversion_value_cents || 0) / 100;
    });

    // Calculate averages and convert to array
    const campaigns = Array.from(campaignMap.values());
    campaigns.forEach((campaign) => {
      const m = campaign.metrics;
      if (m.impressions > 0) {
        m.ctr = (m.clicks / m.impressions) * 100;
        m.cpm = (m.spend / m.impressions) * 1000;
      }
      if (m.clicks > 0) {
        m.cpc = m.spend / m.clicks;
      }
      if (m.spend > 0 && m.revenue > 0) {
        m.roas = m.revenue / m.spend;
      }
    });

    // Sort by spend (descending) by default
    const sortField = options?.sort_by || 'spend';
    const sortOrder = options?.order || 'desc';

    campaigns.sort((a, b) => {
      const aVal = a.metrics[sortField as keyof CampaignMetrics] || 0;
      const bVal = b.metrics[sortField as keyof CampaignMetrics] || 0;
      return sortOrder === 'asc' ? Number(aVal) - Number(bVal) : Number(bVal) - Number(aVal);
    });

    // Apply limit/offset if specified
    let result = campaigns;
    if (options?.offset) {
      result = result.slice(options.offset);
    }
    if (options?.limit) {
      result = result.slice(0, options.limit);
    }

    return result;
  }

  async getCampaign(
    orgId: string,
    campaignId: string,
    dateRange: DateRange
  ): Promise<Campaign | null> {
    const params = new URLSearchParams();
    params.append("organization_id", `eq.${orgId}`);
    params.append("platform", `eq.${this.platform}`);
    params.append("campaign_id", `eq.${campaignId}`);
    params.append("metric_date", `gte.${dateRange.start_date}`);
    params.append("metric_date", `lte.${dateRange.end_date}`);

    const data = await this.supabaseRequest(this.unifiedView, params);

    if (!data || data.length === 0) {
      return null;
    }

    // Aggregate all rows for this campaign
    const campaign: Campaign = {
      campaign_id: data[0].campaign_id,
      campaign_name: data[0].campaign_name,
      status: data[0].campaign_status,
      metrics: {
        impressions: 0,
        clicks: 0,
        spend: 0,
        conversions: 0,
        revenue: 0,
        ctr: 0,
        cpc: 0,
        cpm: 0,
        roas: 0
      }
    };

    data.forEach((row: any) => {
      campaign.metrics.impressions += row.impressions || 0;
      campaign.metrics.clicks += row.clicks || 0;
      campaign.metrics.spend += (row.spend_cents || 0) / 100;
      campaign.metrics.conversions += row.conversions || 0;
      campaign.metrics.revenue += (row.conversion_value_cents || 0) / 100;
    });

    // Calculate averages
    const m = campaign.metrics;
    if (m.impressions > 0) {
      m.ctr = (m.clicks / m.impressions) * 100;
      m.cpm = (m.spend / m.impressions) * 1000;
    }
    if (m.clicks > 0) {
      m.cpc = m.spend / m.clicks;
    }
    if (m.spend > 0 && m.revenue && m.revenue > 0) {
      m.roas = m.revenue / m.spend;
    }

    return campaign;
  }

  async getAds(
    orgId: string,
    dateRange: DateRange,
    options?: {
      campaign_id?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<AdPerformance[]> {
    // Note: The unified view is campaign-level only.
    // Ad-level data would require querying platform-specific schemas.
    // For now, return campaign-level data as ad performance.
    const params = new URLSearchParams();
    params.append("organization_id", `eq.${orgId}`);
    params.append("platform", `eq.${this.platform}`);
    params.append("metric_date", `gte.${dateRange.start_date}`);
    params.append("metric_date", `lte.${dateRange.end_date}`);

    if (options?.campaign_id) {
      params.append("campaign_id", `eq.${options.campaign_id}`);
    }

    if (options?.limit) {
      params.append("limit", options.limit.toString());
    }
    if (options?.offset) {
      params.append("offset", options.offset.toString());
    }

    params.append("order", "spend_cents.desc");

    const data = await this.supabaseRequest(this.unifiedView, params);

    return data.map((row: any) => ({
      ad_id: row.campaign_id, // Using campaign_id as ad_id fallback
      ad_name: row.campaign_name,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      status: row.campaign_status,
      date_reported: row.metric_date,
      metrics: {
        impressions: row.impressions || 0,
        clicks: row.clicks || 0,
        spend: (row.spend_cents || 0) / 100,
        conversions: row.conversions || 0,
        revenue: (row.conversion_value_cents || 0) / 100,
        ctr: row.ctr || 0,
        cpc: (row.cpc_cents || 0) / 100,
        cpm: (row.cpm_cents || 0) / 100,
        roas: row.roas || 0
      }
    }));
  }

  async getSummary(orgId: string, dateRange: DateRange): Promise<PlatformSummary> {
    const params = new URLSearchParams();
    params.append("organization_id", `eq.${orgId}`);
    params.append("platform", `eq.${this.platform}`);
    params.append("metric_date", `gte.${dateRange.start_date}`);
    params.append("metric_date", `lte.${dateRange.end_date}`);

    const data = await this.supabaseRequest(this.unifiedView, params);

    if (!data || data.length === 0) {
      return {
        total_spend: 0,
        total_impressions: 0,
        total_clicks: 0,
        total_conversions: 0,
        total_revenue: 0,
        avg_ctr: 0,
        avg_cpc: 0,
        avg_cpm: 0,
        avg_roas: 0,
        campaigns_count: 0,
        ads_count: 0
      };
    }

    // Aggregate metrics manually
    let totalSpend = 0;
    let totalImpressions = 0;
    let totalClicks = 0;
    let totalConversions = 0;
    let totalRevenue = 0;

    const uniqueCampaigns = new Set<string>();

    data.forEach((row: any) => {
      totalImpressions += row.impressions || 0;
      totalClicks += row.clicks || 0;
      totalSpend += (row.spend_cents || 0) / 100;
      totalConversions += row.conversions || 0;
      totalRevenue += (row.conversion_value_cents || 0) / 100;

      if (row.campaign_id) {
        uniqueCampaigns.add(row.campaign_id);
      }
    });

    return {
      total_spend: totalSpend,
      total_impressions: totalImpressions,
      total_clicks: totalClicks,
      total_conversions: totalConversions,
      total_revenue: totalRevenue,
      avg_ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
      avg_cpc: totalClicks > 0 ? totalSpend / totalClicks : 0,
      avg_cpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0,
      avg_roas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
      campaigns_count: uniqueCampaigns.size,
      ads_count: 0 // Ad-level data not available in unified view
    };
  }

  async getDailyMetrics(
    orgId: string,
    dateRange: DateRange,
    options?: {
      campaign_id?: string;
      group_by?: "day" | "week" | "month";
    }
  ): Promise<any[]> {
    const params = new URLSearchParams();
    params.append("organization_id", `eq.${orgId}`);
    params.append("platform", `eq.${this.platform}`);
    params.append("metric_date", `gte.${dateRange.start_date}`);
    params.append("metric_date", `lte.${dateRange.end_date}`);

    if (options?.campaign_id) {
      params.append("campaign_id", `eq.${options.campaign_id}`);
    }

    params.append("order", "metric_date.asc");

    const data = await this.supabaseRequest(this.unifiedView, params);

    if (!data || data.length === 0) {
      return [];
    }

    // Group by period if requested
    if (options?.group_by && options.group_by !== "day") {
      // Transform data to include date_reported field for groupByPeriod
      const transformedData = data.map((row: any) => ({
        ...row,
        date_reported: row.metric_date
      }));

      const grouped = groupByPeriod(transformedData, options.group_by);
      const result: any[] = [];

      grouped.forEach((rows, period) => {
        const aggregated = {
          period,
          impressions: 0,
          spend: 0,
          clicks: 0,
          conversions: 0,
          revenue: 0
        };

        rows.forEach((row: any) => {
          aggregated.impressions += row.impressions || 0;
          aggregated.spend += (row.spend_cents || 0) / 100;
          aggregated.clicks += row.clicks || 0;
          aggregated.conversions += row.conversions || 0;
          aggregated.revenue += (row.conversion_value_cents || 0) / 100;
        });

        result.push(aggregated);
      });

      return result;
    }

    // Return daily data, aggregated by date (multiple campaigns may have same date)
    const dailyMap = new Map<string, any>();

    data.forEach((row: any) => {
      const date = row.metric_date;
      if (!dailyMap.has(date)) {
        dailyMap.set(date, {
          date,
          impressions: 0,
          spend: 0,
          clicks: 0,
          conversions: 0,
          revenue: 0
        });
      }

      const daily = dailyMap.get(date)!;
      daily.impressions += row.impressions || 0;
      daily.spend += (row.spend_cents || 0) / 100;
      daily.clicks += row.clicks || 0;
      daily.conversions += row.conversions || 0;
      daily.revenue += (row.conversion_value_cents || 0) / 100;
    });

    return Array.from(dailyMap.values()).map((daily) => ({
      ...daily,
      ctr: daily.impressions > 0 ? (daily.clicks / daily.impressions) * 100 : 0,
      cpc: daily.clicks > 0 ? daily.spend / daily.clicks : 0,
      cpm: daily.impressions > 0 ? (daily.spend / daily.impressions) * 1000 : 0
    }));
  }
}