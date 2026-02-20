/**
 * TikTok Marketing API OAuth Provider
 *
 * Implements OAuth 2.0 flow for TikTok Marketing API access.
 * Includes write methods for AI recommendation execution (set_active, set_budget, set_audience).
 *
 * @see https://business-api.tiktok.com/portal/docs
 */

import { OAuthProvider, OAuthUserInfo, PKCEChallenge } from './base';
import { structuredLog } from '../../utils/structured-logger';
import {
  API_BASE_URL,
  RATE_LIMITS,
  RATE_LIMIT_ERROR_CODES,
  ERROR_MESSAGES,
  BUDGET_LIMITS,
  STATUS,
  BUDGET_MODE,
  GENDERS,
  AGE_GROUPS,
  OAUTH_ENDPOINTS
} from '../../constants/tiktok';

/**
 * TikTok targeting configuration for set_audience tool
 */
export interface TikTokTargeting {
  age?: string[];  // AGE_18_24, AGE_25_34, etc.
  gender?: 'MALE' | 'FEMALE' | 'UNLIMITED';
  interest_category_ids?: string[];
  location_ids?: string[];  // Country/region/city IDs
}

export class TikTokAdsOAuthProvider extends OAuthProvider {
  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    super({
      clientId,
      clientSecret,
      redirectUri,
      scopes: [
        'ad.read',
        'ad.write'
      ],
      authorizeUrl: OAUTH_ENDPOINTS.AUTHORIZE,
      tokenUrl: OAUTH_ENDPOINTS.TOKEN
    });
  }

  /**
   * Make a TikTok API request with automatic retry on rate limit errors
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retryCount = 0
  ): Promise<Response> {
    const response = await fetch(url, options);

    // If successful, return immediately
    if (response.ok) {
      return response;
    }

    // Check if it's a rate limit error
    try {
      const errorData = await response.clone().json() as any;
      const errorCode = errorData?.code;

      if (RATE_LIMIT_ERROR_CODES.includes(errorCode) && retryCount < RATE_LIMITS.MAX_RETRIES) {
        const delay = RATE_LIMITS.INITIAL_RETRY_DELAY_MS * Math.pow(RATE_LIMITS.RETRY_BACKOFF_MULTIPLIER, retryCount);

        structuredLog('WARN', 'TikTok API rate limit hit', { service: 'tiktok-oauth', error_code: errorCode, delay_ms: delay, attempt: retryCount + 1, max_retries: RATE_LIMITS.MAX_RETRIES });

        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchWithRetry(url, options, retryCount + 1);
      }
    } catch (parseError) {
      // If we can't parse the error, just return the original response
    }

    return response;
  }

  /**
   * Build headers for TikTok API requests
   * TikTok uses Access-Token header (not Bearer)
   */
  private buildHeaders(accessToken: string): Record<string, string> {
    return {
      'Access-Token': accessToken,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Get authorization URL with TikTok-specific parameters
   */
  getAuthorizationUrl(state: string, pkce: PKCEChallenge): string {
    // TikTok uses different parameter names
    const params = new URLSearchParams({
      app_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      state,
      scope: this.config.scopes.join(',')  // TikTok uses comma separator
    });

    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   * TikTok uses POST body format different from standard OAuth
   */
  async exchangeCodeForToken(code: string, _codeVerifier: string): Promise<any> {
    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        app_id: this.config.clientId,
        secret: this.config.clientSecret,
        auth_code: code
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`TikTok token exchange failed: ${errorText}`);
    }

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`TikTok API error: ${data.message}`);
    }

    return {
      access_token: data.data.access_token,
      refresh_token: data.data.refresh_token,
      refresh_token_expires_in: data.data.refresh_token_expires_in,
      expires_in: data.data.expires_in,
      scope: data.data.scope
    };
  }

  /**
   * Get user information from TikTok
   */
  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const response = await fetch(
      `${API_BASE_URL}/user/info/`,
      {
        method: 'GET',
        headers: this.buildHeaders(accessToken)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch TikTok user info: ${errorText}`);
    }

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`TikTok API error: ${data.message}`);
    }

    return {
      id: data.data.core_user_id || data.data.display_name,
      name: data.data.display_name,
      email: data.data.email,
      raw: data.data
    };
  }

  /**
   * Validate TikTok access token
   */
  async validateToken(accessToken: string): Promise<boolean> {
    try {
      await this.getUserInfo(accessToken);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get TikTok Ad Accounts (Advertisers)
   */
  async getAdAccounts(accessToken: string): Promise<any[]> {
    const response = await fetch(
      `${API_BASE_URL}/oauth2/advertiser/get/?app_id=${this.config.clientId}`,
      {
        method: 'GET',
        headers: this.buildHeaders(accessToken)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch TikTok advertisers: ${errorText}`);
    }

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`TikTok API error: ${data.message}`);
    }

    // Transform to common format
    return (data.data.list || []).map((advertiser: any) => ({
      id: advertiser.advertiser_id,
      name: advertiser.advertiser_name,
      status: 'ACTIVE'
    }));
  }

  // ===== Write Methods for AI Recommendation Tools =====

  /**
   * Update campaign status (ENABLE/DISABLE)
   * Implements set_active tool for campaigns
   */
  async updateCampaignStatus(
    accessToken: string,
    advertiserId: string,
    campaignId: string,
    status: 'ENABLE' | 'DISABLE'
  ): Promise<{ success: boolean }> {
    if (!advertiserId) {
      throw new Error(ERROR_MESSAGES.INVALID_ADVERTISER_ID);
    }

    const response = await this.fetchWithRetry(
      `${API_BASE_URL}/campaign/update/`,
      {
        method: 'POST',
        headers: this.buildHeaders(accessToken),
        body: JSON.stringify({
          advertiser_id: advertiserId,
          campaign_id: campaignId,
          operation_status: status === 'ENABLE' ? STATUS.ENABLE : STATUS.DISABLE
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update TikTok campaign status: ${errorText}`);
    }

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`TikTok API error: ${data.message}`);
    }

    return { success: true };
  }

  /**
   * Update ad group status (ENABLE/DISABLE)
   * Implements set_active tool for ad groups
   */
  async updateAdGroupStatus(
    accessToken: string,
    advertiserId: string,
    adGroupId: string,
    status: 'ENABLE' | 'DISABLE'
  ): Promise<{ success: boolean }> {
    if (!advertiserId) {
      throw new Error(ERROR_MESSAGES.INVALID_ADVERTISER_ID);
    }

    const response = await this.fetchWithRetry(
      `${API_BASE_URL}/adgroup/update/`,
      {
        method: 'POST',
        headers: this.buildHeaders(accessToken),
        body: JSON.stringify({
          advertiser_id: advertiserId,
          adgroup_id: adGroupId,
          operation_status: status === 'ENABLE' ? STATUS.ENABLE : STATUS.DISABLE
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update TikTok ad group status: ${errorText}`);
    }

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`TikTok API error: ${data.message}`);
    }

    return { success: true };
  }

  /**
   * Update campaign budget
   * Implements set_budget tool for campaigns
   *
   * @param budgetCents - Budget in cents (e.g., 5000 = $50.00)
   * @param budgetMode - BUDGET_MODE_DAY or BUDGET_MODE_TOTAL
   */
  async updateCampaignBudget(
    accessToken: string,
    advertiserId: string,
    campaignId: string,
    budgetCents: number,
    budgetMode: 'BUDGET_MODE_DAY' | 'BUDGET_MODE_TOTAL' = 'BUDGET_MODE_DAY'
  ): Promise<{ success: boolean }> {
    if (!advertiserId) {
      throw new Error(ERROR_MESSAGES.INVALID_ADVERTISER_ID);
    }

    if (budgetCents < BUDGET_LIMITS.DAILY_MIN_CENTS) {
      throw new Error(ERROR_MESSAGES.BUDGET_TOO_LOW);
    }

    // TikTok API expects budget in currency units (dollars), not cents
    const budgetDollars = budgetCents / 100;

    const response = await this.fetchWithRetry(
      `${API_BASE_URL}/campaign/update/`,
      {
        method: 'POST',
        headers: this.buildHeaders(accessToken),
        body: JSON.stringify({
          advertiser_id: advertiserId,
          campaign_id: campaignId,
          budget_mode: budgetMode,
          budget: budgetDollars
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update TikTok campaign budget: ${errorText}`);
    }

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`TikTok API error: ${data.message}`);
    }

    return { success: true };
  }

  /**
   * Update ad group budget
   * Implements set_budget tool for ad groups
   *
   * @param budgetCents - Budget in cents
   * @param budgetMode - BUDGET_MODE_DAY or BUDGET_MODE_TOTAL
   */
  async updateAdGroupBudget(
    accessToken: string,
    advertiserId: string,
    adGroupId: string,
    budgetCents: number,
    budgetMode: 'BUDGET_MODE_DAY' | 'BUDGET_MODE_TOTAL' = 'BUDGET_MODE_DAY'
  ): Promise<{ success: boolean }> {
    if (!advertiserId) {
      throw new Error(ERROR_MESSAGES.INVALID_ADVERTISER_ID);
    }

    if (budgetCents < BUDGET_LIMITS.DAILY_MIN_CENTS) {
      throw new Error(ERROR_MESSAGES.BUDGET_TOO_LOW);
    }

    // TikTok API expects budget in currency units (dollars), not cents
    const budgetDollars = budgetCents / 100;

    const response = await this.fetchWithRetry(
      `${API_BASE_URL}/adgroup/update/`,
      {
        method: 'POST',
        headers: this.buildHeaders(accessToken),
        body: JSON.stringify({
          advertiser_id: advertiserId,
          adgroup_id: adGroupId,
          budget_mode: budgetMode,
          budget: budgetDollars
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update TikTok ad group budget: ${errorText}`);
    }

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`TikTok API error: ${data.message}`);
    }

    return { success: true };
  }

  /**
   * Update ad group targeting
   * Implements set_audience tool
   */
  async updateAdGroupTargeting(
    accessToken: string,
    advertiserId: string,
    adGroupId: string,
    targeting: TikTokTargeting
  ): Promise<{ success: boolean }> {
    if (!advertiserId) {
      throw new Error(ERROR_MESSAGES.INVALID_ADVERTISER_ID);
    }

    // Build TikTok targeting spec
    const targetingSpec: any = {};

    // Age targeting — TikTok API field is age_groups, not age
    if (targeting.age && targeting.age.length > 0) {
      targetingSpec.age_groups = targeting.age;
    }

    // Gender targeting
    if (targeting.gender) {
      targetingSpec.gender = targeting.gender;
    }

    // Interest targeting
    if (targeting.interest_category_ids && targeting.interest_category_ids.length > 0) {
      targetingSpec.interest_category_ids = targeting.interest_category_ids;
    }

    // Location targeting
    if (targeting.location_ids && targeting.location_ids.length > 0) {
      targetingSpec.location_ids = targeting.location_ids;
    }

    const response = await this.fetchWithRetry(
      `${API_BASE_URL}/adgroup/update/`,
      {
        method: 'POST',
        headers: this.buildHeaders(accessToken),
        body: JSON.stringify({
          advertiser_id: advertiserId,
          adgroup_id: adGroupId,
          ...targetingSpec
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update TikTok ad group targeting: ${errorText}`);
    }

    const data = await response.json() as any;

    if (data.code !== 0) {
      throw new Error(`TikTok API error: ${data.message}`);
    }

    return { success: true };
  }

  /**
   * Update ad group bidding configuration
   *
   * TikTok bid_type values:
   *   BID_TYPE_NO_BID — automatic bidding (Maximum Delivery)
   *   BID_TYPE_CUSTOM — manual bid with bid amount
   *
   * bid_price is in the ad account's currency units (dollars for USD, NOT cents).
   * optimization_goal: CLICK, CONVERT, INSTALL, REACH, VIDEO_VIEW, LEAD_GENERATION, etc.
   */
  async updateAdGroupBidding(
    accessToken: string,
    advertiserId: string,
    adGroupId: string,
    bidConfig: {
      bid_type: 'BID_TYPE_NO_BID' | 'BID_TYPE_CUSTOM';
      bid_price?: number;           // in dollars (TikTok API uses currency units)
      optimization_goal?: string;   // e.g. CONVERT, CLICK, REACH
    }
  ): Promise<{ success: boolean }> {
    if (!advertiserId) {
      throw new Error(ERROR_MESSAGES.INVALID_ADVERTISER_ID);
    }

    if (bidConfig.bid_type === 'BID_TYPE_CUSTOM' && (bidConfig.bid_price == null || bidConfig.bid_price <= 0)) {
      throw new Error('BID_TYPE_CUSTOM requires a positive bid_price');
    }

    const body: any = {
      advertiser_id: advertiserId,
      adgroup_id: adGroupId,
      bid_type: bidConfig.bid_type,
    };

    if (bidConfig.bid_price !== undefined) {
      body.bid_price = bidConfig.bid_price;
    }
    if (bidConfig.optimization_goal) {
      body.optimization_goal = bidConfig.optimization_goal;
    }

    const response = await this.fetchWithRetry(
      `${API_BASE_URL}/adgroup/update/`,
      {
        method: 'POST',
        headers: this.buildHeaders(accessToken),
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update TikTok ad group bidding: ${errorText}`);
    }

    const data = await response.json() as any;
    if (data.code !== 0) {
      throw new Error(`TikTok API error: ${data.message}`);
    }

    return { success: true };
  }

  /**
   * Update ad group schedule
   *
   * TikTok schedule options:
   *   SCHEDULE_FROM_NOW — run continuously from now
   *   SCHEDULE_START_END — run between start_time and end_time
   *
   * dayparting is a 48-character string per day (30-minute slots): '0' = off, '1' = on
   * Represented as a JSON object: { "monday": "0000001111111100...", ... }
   */
  async updateAdGroupSchedule(
    accessToken: string,
    advertiserId: string,
    adGroupId: string,
    schedule: {
      schedule_type?: 'SCHEDULE_FROM_NOW' | 'SCHEDULE_START_END';
      schedule_start_time?: string;  // "YYYY-MM-DD HH:MM:SS"
      schedule_end_time?: string;    // "YYYY-MM-DD HH:MM:SS"
      dayparting?: Record<string, string>;  // day → 48-char string of 0/1
    }
  ): Promise<{ success: boolean }> {
    if (!advertiserId) {
      throw new Error(ERROR_MESSAGES.INVALID_ADVERTISER_ID);
    }

    const body: any = {
      advertiser_id: advertiserId,
      adgroup_id: adGroupId,
    };

    if (schedule.schedule_type) body.schedule_type = schedule.schedule_type;
    if (schedule.schedule_start_time) body.schedule_start_time = schedule.schedule_start_time;
    if (schedule.schedule_end_time) body.schedule_end_time = schedule.schedule_end_time;
    if (schedule.dayparting) body.dayparting = schedule.dayparting;

    const response = await this.fetchWithRetry(
      `${API_BASE_URL}/adgroup/update/`,
      {
        method: 'POST',
        headers: this.buildHeaders(accessToken),
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update TikTok ad group schedule: ${errorText}`);
    }

    const data = await response.json() as any;
    if (data.code !== 0) {
      throw new Error(`TikTok API error: ${data.message}`);
    }

    return { success: true };
  }
}
