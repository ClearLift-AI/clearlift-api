/**
 * Live API Executor
 *
 * Makes read-only live API calls to connected platforms during AI analysis.
 * Gives the LLM real-time data beyond what's synced to D1.
 *
 * Design:
 * - Token retrieval from platform_connections (DB) + decryption via FieldEncryption
 * - Per-connector dispatch with proper auth headers
 * - Read-only: no mutations
 * - Org-scoped: token lookup always filtered by organization_id
 * - No PII amplification: responses are summarized, raw customer data stripped
 * - No token exposure: decrypted tokens never in tool results
 * - 10s timeout per API call
 * - Max 3 API calls per agentic iteration (enforced externally)
 */

import { FieldEncryption } from '../../utils/crypto';
import { getSecret } from '../../utils/secrets';
import { GoogleAdsOAuthProvider } from '../oauth/google';
import { FacebookAdsOAuthProvider } from '../oauth/facebook';
import { TikTokAdsOAuthProvider } from '../oauth/tiktok';
import { ShopifyOAuthProvider } from '../oauth/shopify';
import { HubSpotOAuthProvider } from '../oauth/hubspot';
import { JobberOAuthProvider } from '../oauth/jobber';
import type { OAuthProvider } from '../oauth/base';

// Env type — matches worker-configuration.d.ts
interface LiveApiEnv {
  DB: D1Database;
  ENCRYPTION_KEY: any; // SecretsStoreSecret | string
  GOOGLE_ADS_DEVELOPER_TOKEN?: any;
  GOOGLE_CLIENT_ID?: any;
  GOOGLE_CLIENT_SECRET?: any;
  FACEBOOK_APP_ID?: any;
  FACEBOOK_APP_SECRET?: any;
  TIKTOK_APP_ID?: any;
  TIKTOK_APP_SECRET?: any;
  SHOPIFY_CLIENT_ID?: any;
  SHOPIFY_CLIENT_SECRET?: any;
  HUBSPOT_CLIENT_ID?: any;
  HUBSPOT_CLIENT_SECRET?: any;
  JOBBER_CLIENT_ID?: any;
  JOBBER_CLIENT_SECRET?: any;
}

// D1Database type
type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
};

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
}

interface QueryApiInput {
  connector: 'google_ads' | 'meta_ads' | 'tiktok_ads' | 'stripe' | 'shopify' | 'jobber' | 'hubspot';
  endpoint: string;
  params?: Record<string, any>;
}

interface ConnectionInfo {
  id: string;
  platform: string;
  account_id: string;
  account_name: string | null;
  credentials_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: string | null;
  scopes: string | null;
  settings: string | null;
}

const API_TIMEOUT_MS = 10_000;

export const QUERY_API_TOOL = {
  name: 'query_api',
  description: 'Make a live read-only API call to a connected platform. Use this for real-time data or details not available in D1 (keyword performance, audience breakdowns, recent transactions). Data is fresh but slower than D1 queries.',
  input_schema: {
    type: 'object' as const,
    properties: {
      connector: {
        type: 'string',
        enum: ['google_ads', 'meta_ads', 'tiktok_ads', 'stripe', 'shopify', 'jobber', 'hubspot'],
        description: 'Which connector to query'
      },
      endpoint: {
        type: 'string',
        enum: [
          // Ad platforms
          'campaign_details', 'keyword_performance', 'audience_breakdown',
          'geographic_performance', 'device_performance', 'ad_schedule_performance',
          'placement_performance',
          // Revenue
          'recent_transactions', 'subscription_details', 'customer_details',
          'refunds', 'product_performance',
          // CRM
          'deal_pipeline', 'contact_activity', 'deal_stage_history',
          // Field service
          'job_details', 'client_details', 'quote_pipeline'
        ],
        description: 'What data to fetch'
      },
      params: {
        type: 'object',
        description: 'Endpoint-specific parameters (entity_id, date_range, limit, etc.)'
      }
    },
    required: ['connector', 'endpoint']
  }
};

export class LiveApiExecutor {
  private db: D1Database;
  private env: LiveApiEnv;
  private encryption: FieldEncryption | null = null;

  constructor(db: D1Database, env: LiveApiEnv) {
    this.db = db;
    this.env = env;
  }

  async execute(
    input: QueryApiInput,
    orgId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const { connector, endpoint, params = {} } = input;

    try {
      // 1. Look up connection
      const platformMap: Record<string, string> = {
        google_ads: 'google',
        meta_ads: 'facebook',
        tiktok_ads: 'tiktok',
        stripe: 'stripe',
        shopify: 'shopify',
        jobber: 'jobber',
        hubspot: 'hubspot',
      };

      const platform = platformMap[connector];
      if (!platform) {
        return { success: false, error: `Unknown connector: ${connector}` };
      }

      const connection = await this.db.prepare(`
        SELECT id, platform, account_id, account_name,
               credentials_encrypted, refresh_token_encrypted,
               expires_at, scopes, settings
        FROM platform_connections
        WHERE organization_id = ? AND platform = ? AND is_active = 1
        LIMIT 1
      `).bind(orgId, platform).first<ConnectionInfo>();

      if (!connection) {
        return { success: false, error: `No active ${connector} connection found. Connect the platform first.` };
      }

      if (!connection.credentials_encrypted) {
        return { success: false, error: `${connector} connection has no credentials stored` };
      }

      // 2. Decrypt token
      if (!this.encryption) {
        const encKey = await getSecret(this.env.ENCRYPTION_KEY);
        if (!encKey) {
          return { success: false, error: 'Encryption key not available' };
        }
        this.encryption = await FieldEncryption.create(encKey);
      }

      let accessToken = await this.encryption.decrypt(connection.credentials_encrypted);

      // 3. Check token expiry and auto-refresh if possible
      if (connection.expires_at) {
        const expiresAt = new Date(connection.expires_at);
        if (expiresAt < new Date()) {
          // Attempt to refresh the token
          if (!connection.refresh_token_encrypted) {
            await this.markNeedsReauth(connection.id, 'Token expired, no refresh token available');
            return {
              success: false,
              error: `${connector} access token has expired and no refresh token is available. Please reconnect.`
            };
          }

          try {
            const refreshToken = await this.encryption.decrypt(connection.refresh_token_encrypted);
            const provider = await this.getOAuthProvider(platform, connection);

            if (!provider) {
              await this.markNeedsReauth(connection.id, 'Token expired, OAuth provider not configured');
              return {
                success: false,
                error: `${connector} access token has expired. OAuth provider secrets not configured for refresh.`
              };
            }

            const tokens = await provider.refreshAccessToken(refreshToken);
            accessToken = tokens.access_token;

            // Persist the new token
            const encryptedNewToken = await this.encryption.encrypt(tokens.access_token);
            const newExpiresAt = tokens.expires_in
              ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
              : null;

            await this.db.prepare(`
              UPDATE platform_connections
              SET credentials_encrypted = ?, expires_at = ?, needs_reauth = FALSE, reauth_reason = NULL
              WHERE id = ?
            `).bind(encryptedNewToken, newExpiresAt, connection.id).run();

          } catch (refreshErr) {
            // Refresh failed — mark connection for re-auth
            const reason = refreshErr instanceof Error ? refreshErr.message : 'Token refresh failed';
            await this.markNeedsReauth(connection.id, reason);
            return {
              success: false,
              error: `${connector} token refresh failed. Please reconnect the platform. (${reason})`
            };
          }
        }
      }

      // 4. Dispatch to connector-specific handler
      switch (connector) {
        case 'google_ads':
          return await this.queryGoogleAds(accessToken, connection, endpoint, params);
        case 'meta_ads':
          return await this.queryMetaAds(accessToken, connection, endpoint, params);
        case 'tiktok_ads':
          return await this.queryTikTokAds(accessToken, connection, endpoint, params);
        case 'stripe':
          return await this.queryStripe(accessToken, endpoint, params);
        case 'shopify':
          return await this.queryShopify(accessToken, connection, endpoint, params);
        case 'jobber':
          return await this.queryJobber(accessToken, endpoint, params);
        case 'hubspot':
          return await this.queryHubSpot(accessToken, endpoint, params);
        default:
          return { success: false, error: `Connector ${connector} not yet supported for live queries` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Live API query failed';
      if (msg.includes('CRYPTO_ERROR')) {
        return { success: false, error: 'Failed to decrypt credentials. Connection may need re-authentication.' };
      }
      return { success: false, error: msg };
    }
  }

  // ========================================================================
  // Google Ads (GAQL via REST API)
  // ========================================================================

  private async queryGoogleAds(
    token: string, connection: ConnectionInfo, endpoint: string, params: Record<string, any>
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const devToken = await getSecret(this.env.GOOGLE_ADS_DEVELOPER_TOKEN);
    if (!devToken) {
      return { success: false, error: 'Google Ads developer token not configured' };
    }

    const customerId = connection.account_id.replace(/-/g, '');
    const baseUrl = `https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:searchStream`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'developer-token': devToken,
      'Content-Type': 'application/json',
    };

    // Parse settings for manager account
    let loginCustomerId: string | null = null;
    if (connection.settings) {
      try {
        const settings = JSON.parse(connection.settings);
        loginCustomerId = settings.manager_customer_id || settings.login_customer_id;
      } catch { /* ignore */ }
    }
    if (loginCustomerId) {
      headers['login-customer-id'] = loginCustomerId.replace(/-/g, '');
    }

    let gaqlQuery: string;
    const dateRange = params.date_range || 'LAST_30_DAYS';
    const limit = params.limit || 25;

    switch (endpoint) {
      case 'campaign_details':
        gaqlQuery = `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date DURING ${dateRange} ORDER BY metrics.cost_micros DESC LIMIT ${limit}`;
        break;
      case 'keyword_performance':
        gaqlQuery = `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr, metrics.average_cpc FROM keyword_view WHERE segments.date DURING ${dateRange} ORDER BY metrics.cost_micros DESC LIMIT ${limit}`;
        break;
      case 'audience_breakdown':
        gaqlQuery = `SELECT ad_group_criterion.user_interest.user_interest_category, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM ad_group_audience_view WHERE segments.date DURING ${dateRange} ORDER BY metrics.impressions DESC LIMIT ${limit}`;
        break;
      case 'geographic_performance':
        gaqlQuery = `SELECT geographic_view.country_criterion_id, geographic_view.location_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM geographic_view WHERE segments.date DURING ${dateRange} ORDER BY metrics.cost_micros DESC LIMIT ${limit}`;
        break;
      case 'device_performance':
        gaqlQuery = `SELECT segments.device, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr FROM campaign WHERE segments.date DURING ${dateRange}`;
        break;
      default:
        return { success: false, error: `Endpoint '${endpoint}' not supported for Google Ads` };
    }

    const resp = await this.fetchWithTimeout(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: gaqlQuery }),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => 'unknown error');
      return { success: false, error: `Google Ads API error (${resp.status}): ${errBody.substring(0, 200)}` };
    }

    const data = await resp.json() as any;
    // Google searchStream returns array of result batches
    const results = (data || []).flatMap((batch: any) => batch.results || []);

    return {
      success: true,
      data: {
        connector: 'google_ads',
        endpoint,
        account: connection.account_name || connection.account_id,
        results: results.slice(0, limit).map((r: any) => this.sanitizeGoogleAdsResult(r)),
        total_results: results.length,
      }
    };
  }

  private sanitizeGoogleAdsResult(result: any): any {
    const out: any = {};
    if (result.campaign) {
      out.campaign = { id: result.campaign.id, name: result.campaign.name, status: result.campaign.status };
    }
    if (result.adGroupCriterion?.keyword) {
      out.keyword = { text: result.adGroupCriterion.keyword.text, match_type: result.adGroupCriterion.keyword.matchType };
    }
    if (result.metrics) {
      const m = result.metrics;
      out.metrics = {
        impressions: m.impressions,
        clicks: m.clicks,
        spend: m.costMicros ? '$' + (m.costMicros / 1_000_000).toFixed(2) : undefined,
        conversions: m.conversions,
        ctr: m.ctr,
        avg_cpc: m.averageCpc ? '$' + (m.averageCpc / 1_000_000).toFixed(2) : undefined,
      };
    }
    if (result.segments?.device) out.device = result.segments.device;
    return out;
  }

  // ========================================================================
  // Meta Ads (Graph API)
  // ========================================================================

  private async queryMetaAds(
    token: string, connection: ConnectionInfo, endpoint: string, params: Record<string, any>
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const accountId = connection.account_id.startsWith('act_') ? connection.account_id : `act_${connection.account_id}`;
    const limit = params.limit || 25;
    const datePreset = params.date_range || 'last_30d';

    let url: string;
    let fields: string;

    switch (endpoint) {
      case 'campaign_details':
        fields = 'campaign_name,impressions,clicks,spend,actions,ctr,cpc';
        url = `https://graph.facebook.com/v21.0/${accountId}/insights?fields=${fields}&level=campaign&date_preset=${datePreset}&limit=${limit}`;
        break;
      case 'audience_breakdown':
        fields = 'impressions,clicks,spend,actions';
        const breakdown = params.dimension === 'age' ? 'age' : params.dimension === 'gender' ? 'gender' : 'country';
        url = `https://graph.facebook.com/v21.0/${accountId}/insights?fields=${fields}&breakdowns=${breakdown}&date_preset=${datePreset}&limit=${limit}`;
        break;
      case 'placement_performance':
        fields = 'impressions,clicks,spend,actions';
        url = `https://graph.facebook.com/v21.0/${accountId}/insights?fields=${fields}&breakdowns=publisher_platform,platform_position&date_preset=${datePreset}&limit=${limit}`;
        break;
      case 'device_performance':
        fields = 'impressions,clicks,spend,actions';
        url = `https://graph.facebook.com/v21.0/${accountId}/insights?fields=${fields}&breakdowns=device_platform&date_preset=${datePreset}&limit=${limit}`;
        break;
      default:
        return { success: false, error: `Endpoint '${endpoint}' not supported for Meta Ads` };
    }

    const resp = await this.fetchWithTimeout(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => 'unknown error');
      return { success: false, error: `Meta API error (${resp.status}): ${errBody.substring(0, 200)}` };
    }

    const data = await resp.json() as any;

    return {
      success: true,
      data: {
        connector: 'meta_ads',
        endpoint,
        account: connection.account_name || connection.account_id,
        results: (data.data || []).slice(0, limit).map((r: any) => ({
          ...r,
          // Format spend
          spend: r.spend ? '$' + parseFloat(r.spend).toFixed(2) : undefined,
        })),
        total_results: data.data?.length || 0,
      }
    };
  }

  // ========================================================================
  // TikTok Ads (Business API)
  // ========================================================================

  private async queryTikTokAds(
    token: string, connection: ConnectionInfo, endpoint: string, params: Record<string, any>
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const advertiserId = connection.account_id;

    // Calculate date range
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - (params.days || 30) * 86400000).toISOString().split('T')[0];

    let url: string;
    const baseUrl = 'https://business-api.tiktok.com/open_api/v1.3';

    switch (endpoint) {
      case 'campaign_details':
        url = `${baseUrl}/report/integrated/get/?advertiser_id=${advertiserId}&report_type=BASIC&dimensions=["campaign_id"]&metrics=["spend","impressions","clicks","conversion","ctr","cpc"]&data_level=AUCTION_CAMPAIGN&start_date=${startDate}&end_date=${endDate}&page_size=${params.limit || 25}`;
        break;
      default:
        return { success: false, error: `Endpoint '${endpoint}' not supported for TikTok Ads` };
    }

    const resp = await this.fetchWithTimeout(url, {
      headers: { 'Access-Token': token },
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => 'unknown error');
      return { success: false, error: `TikTok API error (${resp.status}): ${errBody.substring(0, 200)}` };
    }

    const data = await resp.json() as any;
    const results = data.data?.list || [];

    return {
      success: true,
      data: {
        connector: 'tiktok_ads',
        endpoint,
        account: connection.account_name || advertiserId,
        results: results.slice(0, params.limit || 25),
        total_results: results.length,
      }
    };
  }

  // ========================================================================
  // Stripe (REST API)
  // ========================================================================

  private async queryStripe(
    token: string, endpoint: string, params: Record<string, any>
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const limit = params.limit || 25;
    let url: string;

    switch (endpoint) {
      case 'recent_transactions':
        url = `https://api.stripe.com/v1/charges?limit=${limit}`;
        if (params.status) url += `&status=${params.status}`;
        break;
      case 'subscription_details':
        url = `https://api.stripe.com/v1/subscriptions?limit=${limit}`;
        if (params.status) url += `&status=${params.status}`;
        break;
      case 'customer_details':
        if (params.customer_id) {
          url = `https://api.stripe.com/v1/customers/${params.customer_id}`;
        } else {
          url = `https://api.stripe.com/v1/customers?limit=${limit}`;
        }
        break;
      case 'refunds':
        url = `https://api.stripe.com/v1/refunds?limit=${limit}`;
        break;
      case 'product_performance':
        url = `https://api.stripe.com/v1/products?limit=${limit}&active=true`;
        break;
      default:
        return { success: false, error: `Endpoint '${endpoint}' not supported for Stripe` };
    }

    const resp = await this.fetchWithTimeout(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => 'unknown error');
      return { success: false, error: `Stripe API error (${resp.status}): ${errBody.substring(0, 200)}` };
    }

    const data = await resp.json() as any;
    const items = data.data || (data.id ? [data] : []);

    return {
      success: true,
      data: {
        connector: 'stripe',
        endpoint,
        results: items.slice(0, limit).map((item: any) => this.sanitizeStripeResult(item, endpoint)),
        total_results: items.length,
        has_more: data.has_more || false,
      }
    };
  }

  private sanitizeStripeResult(item: any, endpoint: string): any {
    // Strip PII — keep business-relevant fields only
    const base: any = { id: item.id, created: item.created };

    switch (endpoint) {
      case 'recent_transactions':
        return {
          ...base,
          amount: '$' + ((item.amount || 0) / 100).toFixed(2),
          currency: item.currency,
          status: item.status,
          paid: item.paid,
          description: item.description,
          metadata: item.metadata,
        };
      case 'subscription_details':
        return {
          ...base,
          status: item.status,
          current_period_start: item.current_period_start,
          current_period_end: item.current_period_end,
          plan_amount: item.plan?.amount ? '$' + (item.plan.amount / 100).toFixed(2) : null,
          plan_interval: item.plan?.interval,
          cancel_at_period_end: item.cancel_at_period_end,
        };
      case 'customer_details':
        return {
          ...base,
          // Strip email/name — only aggregates
          total_spend: item.metadata?.total_spend,
          subscriptions_count: item.subscriptions?.total_count,
          currency: item.currency,
          delinquent: item.delinquent,
        };
      case 'refunds':
        return {
          ...base,
          amount: '$' + ((item.amount || 0) / 100).toFixed(2),
          status: item.status,
          reason: item.reason,
        };
      case 'product_performance':
        return {
          ...base,
          name: item.name,
          active: item.active,
          type: item.type,
          default_price: item.default_price,
        };
      default:
        return base;
    }
  }

  // ========================================================================
  // Shopify (GraphQL Admin API)
  // ========================================================================

  private async queryShopify(
    token: string, connection: ConnectionInfo, endpoint: string, params: Record<string, any>
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    // Shopify store domain from account_id or settings
    let shopDomain = connection.account_id;
    if (connection.settings) {
      try {
        const s = JSON.parse(connection.settings);
        if (s.shop_domain) shopDomain = s.shop_domain;
      } catch { /* ignore */ }
    }
    if (!shopDomain.includes('.')) shopDomain = `${shopDomain}.myshopify.com`;

    const limit = params.limit || 10;
    let query: string;

    switch (endpoint) {
      case 'recent_transactions':
        query = `{ orders(first: ${limit}, sortKey: CREATED_AT, reverse: true) { edges { node { id name createdAt totalPriceSet { shopMoney { amount currencyCode } } displayFinancialStatus displayFulfillmentStatus } } } }`;
        break;
      case 'product_performance':
        query = `{ products(first: ${limit}, sortKey: BEST_SELLING) { edges { node { id title status totalInventory priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } } } } } }`;
        break;
      case 'customer_details':
        query = `{ customers(first: ${limit}, sortKey: TOTAL_SPENT, reverse: true) { edges { node { id numberOfOrders amountSpent { amount currencyCode } createdAt state } } } }`;
        break;
      case 'refunds':
        query = `{ orders(first: ${limit}, sortKey: CREATED_AT, reverse: true, query: "financial_status:refunded OR financial_status:partially_refunded") { edges { node { id name totalRefundedSet { shopMoney { amount currencyCode } } createdAt } } } }`;
        break;
      default:
        return { success: false, error: `Endpoint '${endpoint}' not supported for Shopify` };
    }

    const resp = await this.fetchWithTimeout(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => 'unknown error');
      return { success: false, error: `Shopify API error (${resp.status}): ${errBody.substring(0, 200)}` };
    }

    const data = await resp.json() as any;

    // Extract edges from GraphQL response
    const rootKey = Object.keys(data.data || {})[0];
    const edges = data.data?.[rootKey]?.edges || [];

    return {
      success: true,
      data: {
        connector: 'shopify',
        endpoint,
        shop: shopDomain,
        results: edges.map((e: any) => e.node),
        total_results: edges.length,
      }
    };
  }

  // ========================================================================
  // Jobber (GraphQL API)
  // ========================================================================

  private async queryJobber(
    token: string, endpoint: string, params: Record<string, any>
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const limit = params.limit || 10;
    let query: string;

    switch (endpoint) {
      case 'job_details':
        query = `{ jobs(first: ${limit}, sort: { key: CREATED_AT, direction: DESC }) { nodes { jobNumber title jobStatus startAt endAt total { raw } client { id name } } } }`;
        break;
      case 'client_details':
        query = `{ clients(first: ${limit}, sort: { key: CREATED_AT, direction: DESC }) { nodes { id name isCompany balance { raw } billingAddress { city state } } } }`;
        break;
      case 'quote_pipeline':
        query = `{ quotes(first: ${limit}, sort: { key: CREATED_AT, direction: DESC }) { nodes { quoteNumber quoteStatus title amounts { totalAmount { raw } } client { name } createdAt } } }`;
        break;
      default:
        return { success: false, error: `Endpoint '${endpoint}' not supported for Jobber` };
    }

    const resp = await this.fetchWithTimeout('https://api.getjobber.com/api/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-JOBBER-GRAPHQL-VERSION': '2024-12-17',
      },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => 'unknown error');
      return { success: false, error: `Jobber API error (${resp.status}): ${errBody.substring(0, 200)}` };
    }

    const data = await resp.json() as any;
    const rootKey = Object.keys(data.data || {})[0];
    const nodes = data.data?.[rootKey]?.nodes || [];

    return {
      success: true,
      data: {
        connector: 'jobber',
        endpoint,
        results: nodes.map((n: any) => ({
          ...n,
          // Strip raw client PII — keep name only
          client: n.client ? { name: n.client.name } : null,
        })),
        total_results: nodes.length,
      }
    };
  }

  // ========================================================================
  // HubSpot (REST v3 API)
  // ========================================================================

  private async queryHubSpot(
    token: string, endpoint: string, params: Record<string, any>
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const limit = params.limit || 25;
    let url: string;

    switch (endpoint) {
      case 'deal_pipeline':
        url = `https://api.hubapi.com/crm/v3/objects/deals?limit=${limit}&properties=dealname,dealstage,amount,closedate,pipeline,hubspot_owner_id&sorts=-createdate`;
        break;
      case 'contact_activity':
        if (params.contact_id) {
          url = `https://api.hubapi.com/crm/v3/objects/contacts/${params.contact_id}?properties=email,firstname,lastname,lifecyclestage,hs_lead_status`;
        } else {
          url = `https://api.hubapi.com/crm/v3/objects/contacts?limit=${limit}&properties=lifecyclestage,hs_lead_status,createdate&sorts=-createdate`;
        }
        break;
      case 'deal_stage_history':
        if (!params.deal_id) {
          return { success: false, error: 'deal_id parameter required for deal_stage_history' };
        }
        url = `https://api.hubapi.com/crm/v3/objects/deals/${params.deal_id}?properties=dealstage,amount,closedate&propertiesWithHistory=dealstage`;
        break;
      default:
        return { success: false, error: `Endpoint '${endpoint}' not supported for HubSpot` };
    }

    const resp = await this.fetchWithTimeout(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => 'unknown error');
      return { success: false, error: `HubSpot API error (${resp.status}): ${errBody.substring(0, 200)}` };
    }

    const data = await resp.json() as any;
    const results = data.results || (data.id ? [data] : []);

    return {
      success: true,
      data: {
        connector: 'hubspot',
        endpoint,
        results: results.slice(0, limit).map((r: any) => this.sanitizeHubSpotResult(r, endpoint)),
        total_results: results.length,
        paging: data.paging?.next ? { has_more: true } : undefined,
      }
    };
  }

  private sanitizeHubSpotResult(result: any, endpoint: string): any {
    const props = result.properties || {};
    switch (endpoint) {
      case 'deal_pipeline':
        return {
          id: result.id,
          name: props.dealname,
          stage: props.dealstage,
          amount: props.amount ? '$' + parseFloat(props.amount).toFixed(2) : null,
          close_date: props.closedate,
          pipeline: props.pipeline,
        };
      case 'contact_activity':
        return {
          id: result.id,
          lifecycle_stage: props.lifecyclestage,
          lead_status: props.hs_lead_status,
          created: props.createdate,
          // No email/name — PII stripped
        };
      case 'deal_stage_history':
        return {
          id: result.id,
          current_stage: props.dealstage,
          amount: props.amount ? '$' + parseFloat(props.amount).toFixed(2) : null,
          stage_history: result.propertiesWithHistory?.dealstage || [],
        };
      default:
        return { id: result.id, properties: props };
    }
  }

  // ========================================================================
  // Utilities
  // ========================================================================

  private async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      return resp;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`API call timed out after ${API_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get OAuth provider instance for token refresh.
   * Returns null if required secrets are not configured.
   */
  private async getOAuthProvider(platform: string, connection: ConnectionInfo): Promise<OAuthProvider | null> {
    // Dummy redirect URI — only used for auth flow, not refresh
    const redirectUri = 'https://api.adbliss.io/v1/connectors/callback';

    switch (platform) {
      case 'google': {
        const clientId = await getSecret(this.env.GOOGLE_CLIENT_ID);
        const clientSecret = await getSecret(this.env.GOOGLE_CLIENT_SECRET);
        if (!clientId || !clientSecret) return null;
        return new GoogleAdsOAuthProvider(clientId, clientSecret, redirectUri);
      }
      case 'facebook': {
        const clientId = await getSecret(this.env.FACEBOOK_APP_ID);
        const clientSecret = await getSecret(this.env.FACEBOOK_APP_SECRET);
        if (!clientId || !clientSecret) return null;
        return new FacebookAdsOAuthProvider(clientId, clientSecret, redirectUri);
      }
      case 'tiktok': {
        const clientId = await getSecret(this.env.TIKTOK_APP_ID);
        const clientSecret = await getSecret(this.env.TIKTOK_APP_SECRET);
        if (!clientId || !clientSecret) return null;
        return new TikTokAdsOAuthProvider(clientId, clientSecret, redirectUri);
      }
      case 'shopify': {
        const clientId = await getSecret(this.env.SHOPIFY_CLIENT_ID);
        const clientSecret = await getSecret(this.env.SHOPIFY_CLIENT_SECRET);
        if (!clientId || !clientSecret) return null;
        // Shopify requires shop domain — extract from account_id
        const shopDomain = connection.account_id?.includes('.myshopify.com')
          ? connection.account_id
          : `${connection.account_id}.myshopify.com`;
        return new ShopifyOAuthProvider(clientId, clientSecret, redirectUri, shopDomain);
      }
      case 'hubspot': {
        const clientId = await getSecret(this.env.HUBSPOT_CLIENT_ID);
        const clientSecret = await getSecret(this.env.HUBSPOT_CLIENT_SECRET);
        if (!clientId || !clientSecret) return null;
        return new HubSpotOAuthProvider(clientId, clientSecret, redirectUri);
      }
      case 'jobber': {
        const clientId = await getSecret(this.env.JOBBER_CLIENT_ID);
        const clientSecret = await getSecret(this.env.JOBBER_CLIENT_SECRET);
        if (!clientId || !clientSecret) return null;
        return new JobberOAuthProvider(clientId, clientSecret, redirectUri);
      }
      default:
        return null;
    }
  }

  /**
   * Mark a connection as needing re-authentication
   */
  private async markNeedsReauth(connectionId: string, reason: string): Promise<void> {
    try {
      await this.db.prepare(`
        UPDATE platform_connections
        SET needs_reauth = TRUE, reauth_reason = ?
        WHERE id = ?
      `).bind(reason, connectionId).run();
    } catch {
      // Non-critical — don't fail the main operation
    }
  }
}
