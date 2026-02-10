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
      `${API_BASE_URL}/oauth2/advertiser/get/`,
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

    // Age targeting
    if (targeting.age && targeting.age.length > 0) {
      targetingSpec.age = targeting.age;
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
}
