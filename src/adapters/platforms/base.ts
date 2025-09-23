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