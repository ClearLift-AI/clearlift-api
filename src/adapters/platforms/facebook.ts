import {
  PlatformAdapter,
  Campaign,
  AdPerformance,
  PlatformSummary,
  DateRange,
  aggregateMetrics,
  groupByPeriod
} from "./base";

export interface FacebookAdsRow {
  org_id: string;
  ad_id: number;
  campaign_id: number;
  date_reported: string;
  ad_name: string;
  adset_name: string;
  campaign_name: string;
  impressions: number;
  spend: number;
  link_clicks: number;
  total_clicks: number;
  engagement_clicks: number;
  reach: number;
  frequency: number;
  cpc: number;
  cpm: number;
  ctr_pct: number;
  desktop_impressions: number;
  mobile_app_impressions: number;
  mobile_web_impressions: number;
  desktop_clicks: number;
  mobile_app_clicks: number;
  mobile_web_clicks: number;
  desktop_spend: number;
  mobile_app_spend: number;
  mobile_web_spend: number;
  landing_views: number;
  checkouts: number;
  purchases: number;
  add_to_carts: number;
  registrations: number;
  leads: number;
  post_engagements: number;
  page_engagements: number;
  video_views: number;
  purchases_7d_click: number;
  purchases_1d_view: number;
  checkouts_7d_click: number;
  checkouts_1d_view: number;
  landing_rate_pct: number;
  checkout_rate_pct: number;
  purchase_rate_pct: number;
  cost_per_purchase: number;
  campaign_objective: string;
  campaign_status: string;
  bid_strategy: string;
  optimization_goal: string;
  billing_event: string;
  budget: number;
  ad_status: string;
  created_at: string;
  updated_at: string;
}

export class FacebookAdapter implements PlatformAdapter {
  private supabaseUrl: string;
  private supabaseKey: string;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.supabaseUrl = supabaseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.supabaseKey = supabaseKey;
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

    const data = await this.supabaseRequest("facebook_ads_performance", params);

    // Aggregate by campaign
    const campaignMap = new Map<string, any>();

    data.forEach((row: FacebookAdsRow) => {
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

    const data = await this.supabaseRequest("facebook_ads_performance", params);

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

    data.forEach((row: FacebookAdsRow) => {
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

    const data = await this.supabaseRequest("facebook_ads_performance", params);

    return data.map((row: FacebookAdsRow) => ({
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

    const data = await this.supabaseRequest("facebook_ads_performance", params);
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

    const data = await this.supabaseRequest("facebook_ads_performance", params);

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
    return data.map((row: FacebookAdsRow) => ({
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