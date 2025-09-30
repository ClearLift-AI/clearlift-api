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
 * Generic platform adapter that dynamically queries any {platform}_ads_performance table
 * This allows adding new platforms without code changes - just create the table in Supabase
 */
export class GenericPlatformAdapter implements PlatformAdapter {
  private supabaseUrl: string;
  private supabaseKey: string;
  private tableName: string;

  constructor(supabaseUrl: string, supabaseKey: string, tableName: string) {
    this.supabaseUrl = supabaseUrl.replace(/\/$/, "");
    this.supabaseKey = supabaseKey;
    this.tableName = tableName;
  }

  /**
   * Make a request to Supabase PostgREST API
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
        "Prefer": "return=representation"
      }
    });

    if (!response.ok) {
      const error = await response.text();

      // Check if it's a table not found error
      if (response.status === 404 || error.includes("not found") || error.includes("does not exist")) {
        throw new Error(`PLATFORM_NOT_AVAILABLE: Table '${this.tableName}' does not exist`);
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
    params.append("org_id", `eq.${orgId}`);
    params.append("date_reported", `gte.${dateRange.start_date}`);
    params.append("date_reported", `lte.${dateRange.end_date}`);
    params.append("select", "campaign_id,campaign_name,campaign_status,campaign_objective,budget,date_reported,impressions,spend,total_clicks,purchases,cpc,cpm,ctr_pct,cost_per_purchase");

    if (options?.limit) {
      params.append("limit", options.limit.toString());
    }
    if (options?.offset) {
      params.append("offset", options.offset.toString());
    }

    const order = options?.sort_by || "spend";
    const direction = options?.order === "asc" ? ".asc" : ".desc";
    params.append("order", `${order}${direction}`);

    const data = await this.supabaseRequest(this.tableName, params);

    // Aggregate by campaign
    const campaignMap = new Map<string, any>();

    data.forEach((row: any) => {
      const key = `${row.campaign_id}`;
      if (!campaignMap.has(key)) {
        campaignMap.set(key, {
          campaign_id: row.campaign_id,
          campaign_name: row.campaign_name,
          status: row.campaign_status,
          objective: row.campaign_objective,
          budget: row.budget,
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
      campaign.metrics.clicks += row.total_clicks || 0;
      campaign.metrics.spend += row.spend || 0;
      campaign.metrics.conversions = (campaign.metrics.conversions || 0) + (row.purchases || 0);
      campaign.metrics.revenue = (campaign.metrics.revenue || 0) + ((row.purchases || 0) * (row.cost_per_purchase || 0));
    });

    // Calculate averages
    campaignMap.forEach((campaign) => {
      const m = campaign.metrics;
      if (m.impressions > 0) {
        m.ctr = (m.clicks / m.impressions) * 100;
        m.cpm = (m.spend / m.impressions) * 1000;
      }
      if (m.clicks > 0) {
        m.cpc = m.spend / m.clicks;
      }
      if (m.spend > 0) {
        m.roas = m.revenue / m.spend;
      }
    });

    return Array.from(campaignMap.values());
  }

  async getCampaign(
    orgId: string,
    campaignId: string,
    dateRange: DateRange
  ): Promise<Campaign | null> {
    const params = new URLSearchParams();
    params.append("org_id", `eq.${orgId}`);
    params.append("campaign_id", `eq.${campaignId}`);
    params.append("date_reported", `gte.${dateRange.start_date}`);
    params.append("date_reported", `lte.${dateRange.end_date}`);
    params.append("select", "*");

    const data = await this.supabaseRequest(this.tableName, params);

    if (!data || data.length === 0) {
      return null;
    }

    // Aggregate all rows for this campaign
    const campaign: Campaign = {
      campaign_id: data[0].campaign_id,
      campaign_name: data[0].campaign_name,
      status: data[0].campaign_status,
      objective: data[0].campaign_objective,
      budget: data[0].budget,
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
      campaign.metrics.clicks += row.total_clicks || 0;
      campaign.metrics.spend += row.spend || 0;
      campaign.metrics.conversions = (campaign.metrics.conversions || 0) + (row.purchases || 0);
      campaign.metrics.revenue = (campaign.metrics.revenue || 0) + ((row.purchases || 0) * (row.cost_per_purchase || 0));
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
    if (m.spend > 0 && m.revenue) {
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
    const params = new URLSearchParams();
    params.append("org_id", `eq.${orgId}`);
    params.append("date_reported", `gte.${dateRange.start_date}`);
    params.append("date_reported", `lte.${dateRange.end_date}`);

    if (options?.campaign_id) {
      params.append("campaign_id", `eq.${options.campaign_id}`);
    }

    params.append("select", "ad_id,ad_name,campaign_id,campaign_name,adset_name,ad_status,date_reported,impressions,spend,total_clicks,purchases,cpc,cpm,ctr_pct,cost_per_purchase");

    if (options?.limit) {
      params.append("limit", options.limit.toString());
    }
    if (options?.offset) {
      params.append("offset", options.offset.toString());
    }

    params.append("order", "spend.desc");

    const data = await this.supabaseRequest(this.tableName, params);

    return data.map((row: any) => ({
      ad_id: row.ad_id,
      ad_name: row.ad_name,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      adset_name: row.adset_name,
      status: row.ad_status,
      date_reported: row.date_reported,
      metrics: {
        impressions: row.impressions || 0,
        clicks: row.total_clicks || 0,
        spend: row.spend || 0,
        conversions: row.purchases || 0,
        revenue: (row.purchases || 0) * (row.cost_per_purchase || 0),
        ctr: row.ctr_pct || 0,
        cpc: row.cpc || 0,
        cpm: row.cpm || 0,
        roas: row.spend > 0 ? ((row.purchases || 0) * (row.cost_per_purchase || 0)) / row.spend : 0
      }
    }));
  }

  async getSummary(orgId: string, dateRange: DateRange): Promise<PlatformSummary> {
    const params = new URLSearchParams();
    params.append("org_id", `eq.${orgId}`);
    params.append("date_reported", `gte.${dateRange.start_date}`);
    params.append("date_reported", `lte.${dateRange.end_date}`);
    params.append("select", "campaign_id,ad_id,impressions,spend,total_clicks,purchases,cost_per_purchase");

    const data = await this.supabaseRequest(this.tableName, params);
    return aggregateMetrics(data);
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
    params.append("org_id", `eq.${orgId}`);
    params.append("date_reported", `gte.${dateRange.start_date}`);
    params.append("date_reported", `lte.${dateRange.end_date}`);

    if (options?.campaign_id) {
      params.append("campaign_id", `eq.${options.campaign_id}`);
    }

    params.append("select", "date_reported,impressions,spend,total_clicks,purchases,cpc,cpm,ctr_pct,cost_per_purchase");
    params.append("order", "date_reported.asc");

    const data = await this.supabaseRequest(this.tableName, params);

    // Group by period if requested
    if (options?.group_by && options.group_by !== "day") {
      const grouped = groupByPeriod(data, options.group_by);
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

        rows.forEach((row) => {
          aggregated.impressions += row.impressions || 0;
          aggregated.spend += row.spend || 0;
          aggregated.clicks += row.total_clicks || 0;
          aggregated.conversions += row.purchases || 0;
          aggregated.revenue += (row.purchases || 0) * (row.cost_per_purchase || 0);
        });

        result.push(aggregated);
      });

      return result;
    }

    // Return daily data
    return data.map((row: any) => ({
      date: row.date_reported,
      impressions: row.impressions || 0,
      spend: row.spend || 0,
      clicks: row.total_clicks || 0,
      conversions: row.purchases || 0,
      revenue: (row.purchases || 0) * (row.cost_per_purchase || 0),
      ctr: row.ctr_pct || 0,
      cpc: row.cpc || 0,
      cpm: row.cpm || 0
    }));
  }
}