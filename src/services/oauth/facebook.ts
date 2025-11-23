/**
 * Facebook Ads OAuth Provider
 *
 * Implements OAuth 2.0 flow for Facebook Marketing API access.
 * Scopes: ads_read, ads_management
 */

import { OAuthProvider, OAuthUserInfo} from './base';

export class FacebookAdsOAuthProvider extends OAuthProvider {
  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    super({
      clientId,
      clientSecret,
      redirectUri,
      scopes: [
        'ads_read',
        'ads_management',
        'read_insights',       // Required for reading ad insights/metrics
        'business_management', // Required for managing business assets
        'email',
        'public_profile'
      ],
      authorizeUrl: 'https://www.facebook.com/dialog/oauth', // No version in auth URL
      tokenUrl: 'https://graph.facebook.com/v24.0/oauth/access_token'
    });
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
      console.error('Facebook getUserInfo failed:', errorText);
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
      console.error('Facebook token exchange failed:', error);
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
      console.error('Facebook getAdAccounts failed:', {
        status: response.status,
        error: errorText
      });
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
    const response = await fetch(
      `https://graph.facebook.com/v24.0/${campaignId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status,
          access_token: accessToken
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Facebook updateCampaignStatus failed:', {
        campaignId,
        status,
        error: errorText
      });
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
    const response = await fetch(
      `https://graph.facebook.com/v24.0/${adSetId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status,
          access_token: accessToken
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Facebook updateAdSetStatus failed:', {
        adSetId,
        status,
        error: errorText
      });
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
    const response = await fetch(
      `https://graph.facebook.com/v24.0/${adId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status,
          access_token: accessToken
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Facebook updateAdStatus failed:', {
        adId,
        status,
        error: errorText
      });
      throw new Error(`Failed to update ad status: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }

  /**
   * Update campaign budget
   * Note: Campaign can have EITHER daily_budget OR lifetime_budget, not both
   */
  async updateCampaignBudget(
    accessToken: string,
    campaignId: string,
    budget: {
      daily_budget?: number;  // In cents (e.g., 5000 = $50.00)
      lifetime_budget?: number;  // In cents
    }
  ): Promise<{ success: boolean }> {
    // Validate that only one budget type is provided
    if (budget.daily_budget && budget.lifetime_budget) {
      throw new Error('Campaign can have either daily_budget or lifetime_budget, not both');
    }

    if (!budget.daily_budget && !budget.lifetime_budget) {
      throw new Error('Must provide either daily_budget or lifetime_budget');
    }

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${campaignId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ...budget,
          access_token: accessToken
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Facebook updateCampaignBudget failed:', {
        campaignId,
        budget,
        error: errorText
      });
      throw new Error(`Failed to update campaign budget: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }

  /**
   * Update ad set budget
   * Note: Ad set can have EITHER daily_budget OR lifetime_budget, not both
   */
  async updateAdSetBudget(
    accessToken: string,
    adSetId: string,
    budget: {
      daily_budget?: number;  // In cents (e.g., 2000 = $20.00)
      lifetime_budget?: number;  // In cents
    }
  ): Promise<{ success: boolean }> {
    // Validate that only one budget type is provided
    if (budget.daily_budget && budget.lifetime_budget) {
      throw new Error('Ad set can have either daily_budget or lifetime_budget, not both');
    }

    if (!budget.daily_budget && !budget.lifetime_budget) {
      throw new Error('Must provide either daily_budget or lifetime_budget');
    }

    const response = await fetch(
      `https://graph.facebook.com/v24.0/${adSetId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ...budget,
          access_token: accessToken
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Facebook updateAdSetBudget failed:', {
        adSetId,
        budget,
        error: errorText
      });
      throw new Error(`Failed to update ad set budget: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }

  /**
   * Update ad set targeting
   * Targeting spec follows Facebook Marketing API v24.0 format
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
      age_min?: number;  // 13-65
      age_max?: number;  // 13-65
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
    }
  ): Promise<{ success: boolean }> {
    const response = await fetch(
      `https://graph.facebook.com/v24.0/${adSetId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          targeting,
          access_token: accessToken
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Facebook updateAdSetTargeting failed:', {
        adSetId,
        error: errorText
      });
      throw new Error(`Failed to update ad set targeting: ${errorText}`);
    }

    const data = await response.json() as any;
    return { success: data.success === true };
  }
}
