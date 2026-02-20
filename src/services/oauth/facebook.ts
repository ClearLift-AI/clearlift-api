/**
 * Facebook Ads OAuth Provider
 *
 * Implements OAuth 2.0 flow for Facebook Marketing API + Page Insights access.
 * Scopes:
 *   ads_read, ads_management  — Marketing API (ad campaigns, audience breakdowns)
 *   read_insights             — Page Insights API (follower growth, content views, demographics)
 *   pages_read_engagement     — Page content and engagement data
 *   pages_show_list           — List connected Pages
 */

import { OAuthProvider, OAuthUserInfo} from './base';
import { structuredLog } from '../../utils/structured-logger';
import {
  RATE_LIMITS,
  RATE_LIMIT_ERROR_CODES,
  ERROR_MESSAGES,
  BUDGET_LIMITS
} from '../../constants/facebook';

export class FacebookAdsOAuthProvider extends OAuthProvider {
  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    super({
      clientId,
      clientSecret,
      redirectUri,
      scopes: [
        'ads_read',
        'ads_management',
        'read_insights',       // Required for reading Page Insights (follower trends, content views, demographics)
        'business_management', // Required for managing business assets
        'pages_show_list',     // Required for listing connected pages
        'pages_read_engagement', // Required for reading page content & engagement data
        'email',
        'public_profile'
      ],
      authorizeUrl: 'https://www.facebook.com/dialog/oauth', // No version in auth URL
      tokenUrl: 'https://graph.facebook.com/v24.0/oauth/access_token'
    });
  }

  /**
   * Make a Facebook API request with automatic retry on rate limit errors
   * Implements exponential backoff for rate limit errors (codes 4, 17, 32, 613)
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
      const errorCode = errorData?.error?.code;

      if (RATE_LIMIT_ERROR_CODES.includes(errorCode) && retryCount < RATE_LIMITS.MAX_RETRIES) {
        // Calculate delay with exponential backoff
        const delay = RATE_LIMITS.INITIAL_RETRY_DELAY_MS * Math.pow(RATE_LIMITS.RETRY_BACKOFF_MULTIPLIER, retryCount);

        structuredLog('WARN', 'Facebook API rate limit hit', { service: 'facebook-oauth', error_code: errorCode, delay_ms: delay, attempt: retryCount + 1, max_retries: RATE_LIMITS.MAX_RETRIES });

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));

        // Retry the request
        return this.fetchWithRetry(url, options, retryCount + 1);
      }
    } catch (parseError) {
      // If we can't parse the error, just return the original response
    }

    // Return the response (which will be handled as an error by the caller)
    return response;
  }

  /**
   * Get authorization URL with Facebook-specific parameters and PKCE
   *
   * @param state - CSRF token
   * @param pkce - PKCE challenge from generatePKCEChallenge()
   * @returns Authorization URL
   */
  getAuthorizationUrl(state: string, pkce: import('./base').PKCEChallenge): string {
    return super.getAuthorizationUrl(state, pkce, {
      display: 'popup',
      auth_type: 'rerequest' // Force reauthorization to get all permissions
    });
  }

  /**
   * Get user information from Facebook
   */
  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const response = await fetch(
      `https://graph.facebook.com/v24.0/me?fields=id,name,email&access_token=${accessToken}`
    );

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Facebook getUserInfo failed', { service: 'facebook-oauth', method: 'getUserInfo', error: errorText });
      throw new Error(`Failed to fetch Facebook user info: ${response.statusText}`);
    }

    const data = await response.json() as any;

    return {
      id: data.id,
      email: data.email,
      name: data.name,
      raw: data
    };
  }

  /**
   * Validate Facebook access token using debug_token endpoint
   * This provides more detailed validation than the /me endpoint
   */
  async validateToken(accessToken: string): Promise<boolean> {
    try {
      // Use app access token to validate user token
      const appAccessToken = `${this.config.clientId}|${this.config.clientSecret}`;

      const response = await fetch(
        `https://graph.facebook.com/v24.0/debug_token?` +
        new URLSearchParams({
          input_token: accessToken,
          access_token: appAccessToken
        }).toString()
      );

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as any;

      // Check if token is valid and not expired
      return data.data?.is_valid === true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Exchange short-lived token for long-lived token (60 days)
   */
  async exchangeForLongLivedToken(shortLivedToken: string): Promise<{ access_token: string; expires_in: number }> {
    const response = await fetch(
      `https://graph.facebook.com/v24.0/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        fb_exchange_token: shortLivedToken
      }).toString()
    );

    if (!response.ok) {
      const error = await response.text();
      structuredLog('ERROR', 'Facebook token exchange failed', { service: 'facebook-oauth', method: 'exchangeForLongLivedToken', error });
      throw new Error(`Failed to exchange token: ${error}`);
    }

    return await response.json();
  }

  /**
   * Get Facebook Ad Accounts accessible with this token
   */
  async getAdAccounts(accessToken: string, userId: string): Promise<any[]> {
    const response = await fetch(
      `https://graph.facebook.com/v24.0/${userId}/adaccounts?` +
      new URLSearchParams({
        access_token: accessToken,
        fields: 'id,name,account_status,currency,timezone_name'
      }).toString()
    );

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Facebook getAdAccounts failed', { service: 'facebook-oauth', method: 'getAdAccounts', status: response.status, error: errorText });
      throw new Error(`Failed to fetch ad accounts (${response.status}): ${errorText}`);
    }

    const data = await response.json() as any;
    return data.data || [];
  }

  /**
   * Update campaign status (ACTIVE, PAUSED)
   */
  async updateCampaignStatus(
    accessToken: string,
    campaignId: string,
    status: 'ACTIVE' | 'PAUSED'
  ): Promise<{ success: boolean }> {
    // Use URL parameters for access token (Facebook API best practice)
    const url = new URL(`https://graph.facebook.com/v24.0/${campaignId}`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('status', status);

    const response = await this.fetchWithRetry(
      url.toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Facebook updateCampaignStatus failed', { service: 'facebook-oauth', method: 'updateCampaignStatus', campaign_id: campaignId, status, error: errorText });
      throw new Error(`Failed to update campaign status: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }

  /**
   * Update ad set status (ACTIVE, PAUSED)
   */
  async updateAdSetStatus(
    accessToken: string,
    adSetId: string,
    status: 'ACTIVE' | 'PAUSED'
  ): Promise<{ success: boolean }> {
    // Use URL parameters for access token (Facebook API best practice)
    const url = new URL(`https://graph.facebook.com/v24.0/${adSetId}`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('status', status);

    const response = await this.fetchWithRetry(
      url.toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Facebook updateAdSetStatus failed', { service: 'facebook-oauth', method: 'updateAdSetStatus', ad_set_id: adSetId, status, error: errorText });
      throw new Error(`Failed to update ad set status: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }

  /**
   * Update ad status (ACTIVE, PAUSED)
   */
  async updateAdStatus(
    accessToken: string,
    adId: string,
    status: 'ACTIVE' | 'PAUSED'
  ): Promise<{ success: boolean }> {
    // Use URL parameters for access token (Facebook API best practice)
    const url = new URL(`https://graph.facebook.com/v24.0/${adId}`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('status', status);

    const response = await this.fetchWithRetry(
      url.toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Facebook updateAdStatus failed', { service: 'facebook-oauth', method: 'updateAdStatus', ad_id: adId, status, error: errorText });
      throw new Error(`Failed to update ad status: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }

  /**
   * Update campaign budget
   * Note: Campaign can have EITHER daily_budget OR lifetime_budget, not both
   *
   * @param accessToken - Facebook access token
   * @param campaignId - Campaign ID to update
   * @param budget - Budget configuration
   * @param currentSpent - Optional: current amount spent (for 10% rule validation on lifetime budget decreases)
   */
  async updateCampaignBudget(
    accessToken: string,
    campaignId: string,
    budget: {
      daily_budget?: number;  // In cents (e.g., 5000 = $50.00)
      lifetime_budget?: number;  // In cents
      budget_type?: 'campaign' | 'adset';  // v24.0: Controls Campaign Budget Optimization
    },
    currentSpent?: number  // Current amount spent (in cents)
  ): Promise<{ success: boolean }> {
    // Validate that only one budget type is provided
    if (budget.daily_budget && budget.lifetime_budget) {
      throw new Error(ERROR_MESSAGES.BOTH_BUDGETS_SET);
    }

    if (!budget.daily_budget && !budget.lifetime_budget) {
      throw new Error(ERROR_MESSAGES.NO_BUDGET_SET);
    }

    // Validate minimum budgets
    if (budget.daily_budget && budget.daily_budget < BUDGET_LIMITS.DAILY_MIN_CENTS) {
      throw new Error(ERROR_MESSAGES.BUDGET_TOO_LOW);
    }

    if (budget.lifetime_budget && budget.lifetime_budget < BUDGET_LIMITS.LIFETIME_MIN_CENTS) {
      throw new Error(ERROR_MESSAGES.BUDGET_TOO_LOW);
    }

    // Validate 10% rule for lifetime budget decreases
    if (budget.lifetime_budget && currentSpent !== undefined) {
      const minimumAllowed = currentSpent * (1 + BUDGET_LIMITS.DECREASE_MARGIN_PERCENT / 100);
      if (budget.lifetime_budget < minimumAllowed) {
        throw new Error(
          `${ERROR_MESSAGES.BUDGET_DECREASE_VIOLATION}. ` +
          `Minimum allowed: $${(minimumAllowed / 100).toFixed(2)} (spent: $${(currentSpent / 100).toFixed(2)})`
        );
      }
    }

    // Use URL parameters for access token (Facebook API best practice)
    const url = new URL(`https://graph.facebook.com/v24.0/${campaignId}`);
    url.searchParams.set('access_token', accessToken);

    // Add budget parameters
    if (budget.daily_budget) {
      url.searchParams.set('daily_budget', budget.daily_budget.toString());
    }
    if (budget.lifetime_budget) {
      url.searchParams.set('lifetime_budget', budget.lifetime_budget.toString());
    }
    if (budget.budget_type) {
      url.searchParams.set('budget_type', budget.budget_type);
    }

    const response = await this.fetchWithRetry(
      url.toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Facebook updateCampaignBudget failed', { service: 'facebook-oauth', method: 'updateCampaignBudget', campaign_id: campaignId, error: errorText });
      throw new Error(`Failed to update campaign budget: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }

  /**
   * Update ad set budget
   * Note: Ad set can have EITHER daily_budget OR lifetime_budget, not both
   *
   * v24.0: Checks is_adset_budget_sharing_enabled on the parent campaign.
   * When CBO (Advantage Campaign Budget) is enabled, ad set budgets are
   * controlled at the campaign level and cannot be updated individually.
   *
   * @param accessToken - Facebook access token
   * @param adSetId - Ad Set ID to update
   * @param budget - Budget configuration
   * @param currentSpent - Optional: current amount spent (for 10% rule validation on lifetime budget decreases)
   */
  async updateAdSetBudget(
    accessToken: string,
    adSetId: string,
    budget: {
      daily_budget?: number;  // In cents (e.g., 2000 = $20.00)
      lifetime_budget?: number;  // In cents
    },
    currentSpent?: number  // Current amount spent (in cents)
  ): Promise<{ success: boolean }> {
    // Validate that only one budget type is provided
    if (budget.daily_budget && budget.lifetime_budget) {
      throw new Error(ERROR_MESSAGES.BOTH_BUDGETS_SET);
    }

    if (!budget.daily_budget && !budget.lifetime_budget) {
      throw new Error(ERROR_MESSAGES.NO_BUDGET_SET);
    }

    // Validate minimum budgets
    if (budget.daily_budget && budget.daily_budget < BUDGET_LIMITS.DAILY_MIN_CENTS) {
      throw new Error(ERROR_MESSAGES.BUDGET_TOO_LOW);
    }

    if (budget.lifetime_budget && budget.lifetime_budget < BUDGET_LIMITS.LIFETIME_MIN_CENTS) {
      throw new Error(ERROR_MESSAGES.BUDGET_TOO_LOW);
    }

    // Validate 10% rule for lifetime budget decreases
    if (budget.lifetime_budget && currentSpent !== undefined) {
      const minimumAllowed = currentSpent * (1 + BUDGET_LIMITS.DECREASE_MARGIN_PERCENT / 100);
      if (budget.lifetime_budget < minimumAllowed) {
        throw new Error(
          `${ERROR_MESSAGES.BUDGET_DECREASE_VIOLATION}. ` +
          `Minimum allowed: $${(minimumAllowed / 100).toFixed(2)} (spent: $${(currentSpent / 100).toFixed(2)})`
        );
      }
    }

    // v24.0: Check if parent campaign has CBO (Advantage Campaign Budget) enabled.
    // When is_adset_budget_sharing_enabled=true, ad set budgets are controlled at
    // the campaign level and cannot be updated individually.
    try {
      const adSetUrl = new URL(`https://graph.facebook.com/v24.0/${adSetId}`);
      adSetUrl.searchParams.set('access_token', accessToken);
      adSetUrl.searchParams.set('fields', 'campaign_id');
      const adSetResp = await this.fetchWithRetry(adSetUrl.toString(), { method: 'GET' });
      if (adSetResp.ok) {
        const adSetData = await adSetResp.json() as any;
        const campaignId = adSetData.campaign_id;
        if (campaignId) {
          const campUrl = new URL(`https://graph.facebook.com/v24.0/${campaignId}`);
          campUrl.searchParams.set('access_token', accessToken);
          campUrl.searchParams.set('fields', 'is_adset_budget_sharing_enabled');
          const campResp = await this.fetchWithRetry(campUrl.toString(), { method: 'GET' });
          if (campResp.ok) {
            const campData = await campResp.json() as any;
            if (campData.is_adset_budget_sharing_enabled === true) {
              throw new Error(
                'Cannot update ad set budget: parent campaign has Advantage Campaign Budget (CBO) enabled. ' +
                'Update the campaign budget instead.'
              );
            }
          }
        }
      }
    } catch (e) {
      // Re-throw CBO validation errors, but swallow fetch errors (budget update will
      // fail with a clearer Facebook API error if CBO is actually blocking it)
      if (e instanceof Error && e.message.includes('Advantage Campaign Budget')) {
        throw e;
      }
      structuredLog('WARN', 'Could not check CBO status for ad set budget update', {
        service: 'facebook-oauth', ad_set_id: adSetId,
        error: e instanceof Error ? e.message : String(e)
      });
    }

    // Use URL parameters for access token (Facebook API best practice)
    const url = new URL(`https://graph.facebook.com/v24.0/${adSetId}`);
    url.searchParams.set('access_token', accessToken);

    // Add budget parameters
    if (budget.daily_budget) {
      url.searchParams.set('daily_budget', budget.daily_budget.toString());
    }
    if (budget.lifetime_budget) {
      url.searchParams.set('lifetime_budget', budget.lifetime_budget.toString());
    }

    const response = await this.fetchWithRetry(
      url.toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Facebook updateAdSetBudget failed', { service: 'facebook-oauth', method: 'updateAdSetBudget', ad_set_id: adSetId, error: errorText });
      throw new Error(`Failed to update ad set budget: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }

  /**
   * Update ad set targeting
   * Targeting spec follows Facebook Marketing API v24.0 format
   *
   * @param accessToken - Facebook access token
   * @param adSetId - Ad Set ID to update
   * @param targeting - Targeting configuration
   * @param options - Optional v24.0 features (placement_soft_opt_out)
   */
  async updateAdSetTargeting(
    accessToken: string,
    adSetId: string,
    targeting: {
      geo_locations?: {
        countries?: string[];  // ISO country codes, e.g., ['US', 'CA']
        regions?: Array<{ key: string }>;  // Region IDs
        cities?: Array<{ key: string; radius?: number; distance_unit?: 'mile' | 'kilometer' }>;
        location_types?: Array<'home' | 'recent'>;
      };
      age_min?: number;  // 18-65 (Facebook requires 18+ for most ad targeting)
      age_max?: number;  // 18-65
      genders?: Array<1 | 2>;  // 1 = male, 2 = female
      interests?: Array<{ id: string; name?: string }>;
      behaviors?: Array<{ id: string; name?: string }>;
      flexible_spec?: Array<{
        interests?: Array<{ id: string; name?: string }>;
        behaviors?: Array<{ id: string; name?: string }>;
      }>;
      exclusions?: {
        interests?: Array<{ id: string; name?: string }>;
        behaviors?: Array<{ id: string; name?: string }>;
      };
      device_platforms?: Array<'mobile' | 'desktop'>;
      publisher_platforms?: Array<'facebook' | 'instagram' | 'audience_network' | 'messenger'>;
      facebook_positions?: Array<'feed' | 'right_hand_column' | 'instant_article' | 'instream_video' | 'marketplace' | 'story' | 'search'>;
      instagram_positions?: Array<'stream' | 'story' | 'explore'>;
    },
    options?: {
      placement_soft_opt_out?: boolean;  // v24.0: Allow 5% spend on excluded placements for better performance
    }
  ): Promise<{ success: boolean }> {
    // Use URL parameters for access token (Facebook API best practice)
    const url = new URL(`https://graph.facebook.com/v24.0/${adSetId}`);
    url.searchParams.set('access_token', accessToken);

    // Build request body with targeting and optional v24.0 features
    const body: any = { targeting };

    if (options?.placement_soft_opt_out !== undefined) {
      body.placement_soft_opt_out = options.placement_soft_opt_out;
    }

    const response = await this.fetchWithRetry(
      url.toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Facebook updateAdSetTargeting failed', { service: 'facebook-oauth', method: 'updateAdSetTargeting', ad_set_id: adSetId, error: errorText });
      throw new Error(`Failed to update ad set targeting: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }

  /**
   * Update ad set or campaign bid strategy
   *
   * Meta v24.0 bid strategies:
   *   LOWEST_COST_WITHOUT_CAP  — automatic, no controls
   *   COST_CAP                 — bid_amount is cost cap (billing_event must be IMPRESSIONS)
   *   LOWEST_COST_WITH_BID_CAP — bid_amount is max bid per auction
   *   LOWEST_COST_WITH_MIN_ROAS — bid_constraints.roas_average_floor (scaled 10000x)
   *
   * bid_amount is in the ad account's currency minimum denomination (cents for USD).
   * roas_average_floor: 10000 = 1.0x ROAS (100%). Valid range: [100, 10000000].
   */
  async updateBidStrategy(
    accessToken: string,
    entityId: string,
    bidConfig: {
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP' | 'LOWEST_COST_WITH_BID_CAP' | 'LOWEST_COST_WITH_MIN_ROAS';
      bid_amount?: number;        // cents — required for COST_CAP and LOWEST_COST_WITH_BID_CAP
      roas_average_floor?: number; // scaled 10000x — required for LOWEST_COST_WITH_MIN_ROAS
    }
  ): Promise<{ success: boolean }> {
    const { bid_strategy, bid_amount, roas_average_floor } = bidConfig;

    // Validate required companion fields
    if ((bid_strategy === 'COST_CAP' || bid_strategy === 'LOWEST_COST_WITH_BID_CAP') && (bid_amount == null || bid_amount <= 0)) {
      throw new Error(`${bid_strategy} requires a positive bid_amount`);
    }
    if (bid_strategy === 'LOWEST_COST_WITH_MIN_ROAS' && !roas_average_floor) {
      throw new Error('LOWEST_COST_WITH_MIN_ROAS requires roas_average_floor');
    }
    if (roas_average_floor !== undefined && (roas_average_floor < 100 || roas_average_floor > 10000000)) {
      throw new Error('roas_average_floor must be between 100 and 10000000');
    }

    const url = new URL(`https://graph.facebook.com/v24.0/${entityId}`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('bid_strategy', bid_strategy);

    // Build POST body — complex params go in body, not URL (consistent with updateAdSetTargeting)
    const body: Record<string, any> = {
      bid_strategy,
    };

    if (bid_strategy === 'LOWEST_COST_WITH_MIN_ROAS') {
      // Min ROAS uses bid_constraints, not bid_amount
      body.bid_constraints = JSON.stringify({ roas_average_floor });
    } else {
      if (bid_amount !== undefined) {
        body.bid_amount = bid_amount;
      }
      // Clear stale bid_constraints when switching away from MIN_ROAS
      body.bid_constraints = null;
    }

    const response = await this.fetchWithRetry(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Facebook updateBidStrategy failed', {
        service: 'facebook-oauth', method: 'updateBidStrategy',
        entity_id: entityId, bid_strategy, error: errorText
      });
      throw new Error(`Failed to update bid strategy: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }

  /**
   * Update ad set schedule (dayparting)
   *
   * Meta v24.0 ad scheduling:
   *   - Requires lifetime_budget (daily_budget does NOT support scheduling)
   *   - pacing_type must be set to ["day_parting"]
   *   - adset_schedule is an array of {start_minute, end_minute, days} objects
   *   - start_minute/end_minute: 0-based minute of day, must be on the hour, ≥1 hour apart
   *   - days: 0=Sunday, 1=Monday, ..., 6=Saturday
   *   - Pass empty array + standard pacing to remove scheduling
   */
  async updateAdSetSchedule(
    accessToken: string,
    adSetId: string,
    schedule: Array<{
      start_minute: number;  // 0-1440 in 60-minute increments
      end_minute: number;    // 0-1440 in 60-minute increments
      days: number[];        // 0=Sunday .. 6=Saturday
      timezone_type?: 'user' | 'advertiser';
    }>
  ): Promise<{ success: boolean }> {
    const url = new URL(`https://graph.facebook.com/v24.0/${adSetId}`);
    url.searchParams.set('access_token', accessToken);

    // Build POST body — complex schedule arrays go in body, not URL params
    const body: Record<string, any> = {};

    if (schedule.length === 0) {
      // Remove scheduling — revert to standard pacing
      body.pacing_type = ['standard'];
      body.adset_schedule = [];
    } else {
      // Validate each schedule entry
      for (const entry of schedule) {
        if (entry.start_minute % 60 !== 0 || entry.end_minute % 60 !== 0) {
          throw new Error('Schedule start_minute and end_minute must be on the hour (multiples of 60)');
        }
        // Support wrap-around schedules (e.g. 22:00-06:00 = start_minute 1320, end_minute 360)
        const duration = entry.end_minute > entry.start_minute
          ? entry.end_minute - entry.start_minute
          : (1440 - entry.start_minute) + entry.end_minute;
        if (duration < 60) {
          throw new Error('Schedule entries must span at least 1 hour');
        }
        if (!entry.days || entry.days.length === 0) {
          throw new Error('Schedule entries must specify at least one day');
        }
        for (const day of entry.days) {
          if (day < 0 || day > 6) {
            throw new Error('Schedule days must be 0-6 (0=Sunday, 6=Saturday)');
          }
        }
      }

      body.pacing_type = ['day_parting'];
      body.adset_schedule = schedule;
    }

    const response = await this.fetchWithRetry(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Facebook updateAdSetSchedule failed', {
        service: 'facebook-oauth', method: 'updateAdSetSchedule',
        ad_set_id: adSetId, error: errorText
      });
      throw new Error(`Failed to update ad set schedule: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }

  /**
   * Read current budget of a campaign or ad set
   * Used by reallocate_budget to validate before moving money
   *
   * Note: daily_budget and lifetime_budget are returned as numeric strings by the Graph API.
   * A value of "0" is a valid budget, so we use != null checks (not truthiness).
   */
  async readEntityBudget(
    accessToken: string,
    entityId: string
  ): Promise<{ daily_budget: number | null; lifetime_budget: number | null }> {
    const url = new URL(`https://graph.facebook.com/v24.0/${entityId}`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('fields', 'daily_budget,lifetime_budget');

    const response = await this.fetchWithRetry(url.toString(), { method: 'GET' });

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Facebook readEntityBudget failed', {
        service: 'facebook-oauth', method: 'readEntityBudget',
        entity_id: entityId, error: errorText
      });
      throw new Error(`Failed to read entity budget: ${errorText}`);
    }

    const data = await response.json() as any;
    return {
      daily_budget: data.daily_budget != null ? parseInt(data.daily_budget, 10) : null,
      lifetime_budget: data.lifetime_budget != null ? parseInt(data.lifetime_budget, 10) : null,
    };
  }
}
