/**
 * Google Ads OAuth Provider
 *
 * Implements OAuth 2.0 flow for Google Ads API access.
 * Scopes: https://www.googleapis.com/auth/adwords
 */

import { OAuthProvider, OAuthUserInfo, OAuthConfig } from './base';
import { structuredLog } from '../../utils/structured-logger';

export class GoogleAdsOAuthProvider extends OAuthProvider {
  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    super({
      clientId,
      clientSecret,
      redirectUri,
      scopes: [
        'https://www.googleapis.com/auth/adwords', // Google Ads API
        'https://www.googleapis.com/auth/userinfo.email', // User email
        'https://www.googleapis.com/auth/userinfo.profile' // User profile
      ],
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token'
    });
  }

  /**
   * Get authorization URL with Google-specific parameters and PKCE
   *
   * @param state - CSRF token
   * @param pkce - PKCE challenge from generatePKCEChallenge()
   * @returns Authorization URL
   */
  getAuthorizationUrl(state: string, pkce: import('./base').PKCEChallenge): string {
    return super.getAuthorizationUrl(state, pkce, {
      access_type: 'offline', // Request refresh token
      prompt: 'consent', // Force consent to get refresh token
      include_granted_scopes: 'true' // Incremental authorization
    });
  }

  /**
   * Get user information from Google
   */
  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Google user info: ${response.statusText}`);
    }

    const data = await response.json() as { id: string; email: string; name: string };

    return {
      id: data.id,
      email: data.email,
      name: data.name,
      raw: data
    };
  }

  /**
   * Validate Google access token
   */
  async validateToken(accessToken: string): Promise<boolean> {
    try {
      const response = await fetch(
        `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${accessToken}`
      );

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as { scope?: string };

      // Check if token has required scope
      return data.scope ? data.scope.includes('adwords') : false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get Google Ads customer accounts accessible with this token
   * Uses Google Ads API to fetch accessible customer accounts
   */
  async getAdAccounts(accessToken: string, developerToken: string): Promise<any[]> {
    if (!developerToken || developerToken.trim() === '') {
      structuredLog('ERROR', 'Google Ads Developer Token is missing or empty', { service: 'google-oauth', method: 'getAdAccounts' });
      throw new Error('DEVELOPER_TOKEN_MISSING: Google Ads Developer Token is required. Get yours at: https://developers.google.com/google-ads/api/docs/get-started/dev-token');
    }

    try {
      // Get user info first to identify the user
      const userInfo = await this.getUserInfo(accessToken);
      structuredLog('INFO', 'Retrieved user info for Google Ads account fetch', { service: 'google-oauth' });

      // Call Google Ads API to list accessible customer accounts
      // https://developers.google.com/google-ads/api/rest/reference/rest/v22/customers/listAccessibleCustomers
      const apiUrl = 'https://googleads.googleapis.com/v22/customers:listAccessibleCustomers';
      structuredLog('INFO', 'Calling Google Ads listAccessibleCustomers API', {
        service: 'google-oauth',
        hasAccessToken: !!accessToken,
      });

      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        structuredLog('ERROR', 'Google Ads API listAccessibleCustomers error', { service: 'google-oauth', method: 'getAdAccounts', status: response.status, error: errorText });

        // Parse error for better messaging
        let errorMessage = `Google Ads API returned ${response.status}`;
        let errorDetails = '';
        try {
          const errorData = JSON.parse(errorText);
          if (errorData.error?.message) {
            errorMessage = errorData.error.message;
            errorDetails = errorData.error.status || '';

            // Provide helpful context for common errors
            if (errorMessage.includes('test accounts')) {
              errorMessage += ' Your developer token is only approved for test accounts. Apply for Basic or Standard access in the Google Ads API Center.';
            } else if (errorMessage.includes('developer token')) {
              errorMessage += ' Check that your developer token is valid in the Google Ads API Center.';
            } else if (errorMessage.includes('PERMISSION_DENIED')) {
              errorMessage += ' Make sure your Google account has access to Google Ads accounts and the OAuth consent has been granted with the correct scopes.';
            }
          }
        } catch (e) {
          errorMessage = errorText;
        }

        throw new Error(`${errorMessage}${errorDetails ? ' (' + errorDetails + ')' : ''}`);
      }

      const data = await response.json() as any;

      // Response format: { "resourceNames": ["customers/123456789", ...] }
      const customerIds = (data.resourceNames || []).map((resourceName: string) => {
        // Extract customer ID from "customers/123456789" format
        return resourceName.split('/')[1];
      });

      if (customerIds.length === 0) {
        structuredLog('INFO', 'No Google Ads accounts found for user', { service: 'google-oauth' });
        return [];
      }

      // Fetch details for each customer account using Google Ads search API
      const accounts = await Promise.all(
        customerIds.map(async (customerId: string) => {
          try {
            // Use the Google Ads search API to get customer details
            const searchUrl = `https://googleads.googleapis.com/v22/customers/${customerId}/googleAds:search`;
            const query = `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer`;

            const detailResponse = await fetch(searchUrl, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'developer-token': developerToken,
                'login-customer-id': customerId,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ query })
            });

            if (detailResponse.ok) {
              const data = await detailResponse.json() as any;
              const result = data.results?.[0];
              const customer = result?.customer;

              if (customer) {
                // Test accounts have IDs ending in -0 (e.g., 123-456-7890)
                const isTestAccount = customerId.endsWith('0');

                return {
                  id: customerId,
                  name: customer.descriptiveName || `Account ${customerId}`,
                  currency: customer.currencyCode || 'USD',
                  timezone: customer.timeZone || 'America/Los_Angeles',
                  manager: customer.manager || false,
                  isTestAccount: isTestAccount,
                  status: isTestAccount ? 'TEST_ACCOUNT' : 'ACTIVE'
                };
              }
            } else {
              // Log the error response
              const errorText = await detailResponse.text();
              structuredLog('ERROR', 'Failed to get customer details', { service: 'google-oauth', method: 'getAdAccounts', customer_id: customerId, status: detailResponse.status, error: errorText });
            }

            // If we can't get details, return basic info
            const isTestAccount = customerId.endsWith('0');
            return {
              id: customerId,
              name: `Google Ads Account ${customerId}`,
              currency: 'USD',
              timezone: 'America/Los_Angeles',
              isTestAccount: isTestAccount,
              status: isTestAccount ? 'TEST_ACCOUNT' : 'ACTIVE'
            };
          } catch (error) {
            structuredLog('ERROR', 'Exception getting customer details', { service: 'google-oauth', method: 'getAdAccounts', customer_id: customerId, error: error instanceof Error ? error.message : String(error) });
            const isTestAccount = customerId.endsWith('0');
            return {
              id: customerId,
              name: `Google Ads Account ${customerId}`,
              currency: 'USD',
              timezone: 'America/Los_Angeles',
              isTestAccount: isTestAccount,
              status: isTestAccount ? 'TEST_ACCOUNT' : 'ACTIVE'
            };
          }
        })
      );

      return accounts;

    } catch (error) {
      structuredLog('ERROR', 'Failed to fetch Google Ads accounts', { service: 'google-oauth', method: 'getAdAccounts', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  // ============================================================================
  // Google Ads Mutation Methods (for AI decision execution)
  // ============================================================================

  /**
   * Update campaign status (ENABLED, PAUSED, REMOVED)
   */
  async updateCampaignStatus(
    accessToken: string,
    developerToken: string,
    customerId: string,
    campaignId: string,
    status: 'ENABLED' | 'PAUSED' | 'REMOVED'
  ): Promise<any> {
    const url = `https://googleads.googleapis.com/v22/customers/${customerId}/campaigns:mutate`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': developerToken,
        'login-customer-id': customerId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        operations: [{
          update: {
            resourceName: `customers/${customerId}/campaigns/${campaignId}`,
            status
          },
          updateMask: 'status'
        }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update Google campaign status: ${error}`);
    }

    return response.json();
  }

  /**
   * Update campaign budget (daily budget in micros)
   */
  async updateCampaignBudget(
    accessToken: string,
    developerToken: string,
    customerId: string,
    campaignId: string,
    budgetAmountMicros: number
  ): Promise<any> {
    // First, get the campaign's budget resource name
    const searchUrl = `https://googleads.googleapis.com/v22/customers/${customerId}/googleAds:search`;
    const query = `SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = ${campaignId}`;

    const searchResponse = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': developerToken,
        'login-customer-id': customerId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    if (!searchResponse.ok) {
      const error = await searchResponse.text();
      throw new Error(`Failed to get campaign budget: ${error}`);
    }

    const searchData = await searchResponse.json() as any;
    const budgetResourceName = searchData.results?.[0]?.campaign?.campaignBudget;

    if (!budgetResourceName) {
      throw new Error('Campaign has no budget resource');
    }

    // Update the budget via the campaignBudgets:mutate endpoint
    const url = `https://googleads.googleapis.com/v22/customers/${customerId}/campaignBudgets:mutate`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': developerToken,
        'login-customer-id': customerId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        operations: [{
          update: {
            resourceName: budgetResourceName,
            amountMicros: budgetAmountMicros.toString()
          },
          updateMask: 'amount_micros'
        }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update Google campaign budget: ${error}`);
    }

    return response.json();
  }

  /**
   * Update ad group status
   */
  async updateAdGroupStatus(
    accessToken: string,
    developerToken: string,
    customerId: string,
    adGroupId: string,
    status: 'ENABLED' | 'PAUSED' | 'REMOVED'
  ): Promise<any> {
    const url = `https://googleads.googleapis.com/v22/customers/${customerId}/adGroups:mutate`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': developerToken,
        'login-customer-id': customerId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        operations: [{
          update: {
            resourceName: `customers/${customerId}/adGroups/${adGroupId}`,
            status
          },
          updateMask: 'status'
        }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update Google ad group status: ${error}`);
    }

    return response.json();
  }

  /**
   * Update campaign bidding strategy
   *
   * Google Ads standard bidding strategies are set directly on the campaign
   * via the campaign_bidding_strategy union field:
   *   maximize_conversions — optional target_cpa_micros
   *   maximize_conversion_value — optional target_roas
   *   manual_cpc — optional enhanced_cpc_enabled
   *   target_impression_share — location, fraction, cpc_bid_ceiling_micros
   *
   * ECPC deprecated March 2025 — now equivalent to manual CPC.
   */
  async updateCampaignBiddingStrategy(
    accessToken: string,
    developerToken: string,
    customerId: string,
    campaignId: string,
    strategy: {
      type: 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE' | 'MANUAL_CPC' | 'TARGET_IMPRESSION_SHARE';
      target_cpa_micros?: number;  // for maximize_conversions
      target_roas?: number;        // for maximize_conversion_value (e.g. 2.0 = 200% ROAS)
    }
  ): Promise<any> {
    const url = `https://googleads.googleapis.com/v22/customers/${customerId}/campaigns:mutate`;

    // Build the bidding strategy field based on type
    const campaignUpdate: any = {
      resourceName: `customers/${customerId}/campaigns/${campaignId}`,
    };
    let updateMask = '';

    switch (strategy.type) {
      case 'MAXIMIZE_CONVERSIONS':
        campaignUpdate.maximizeConversions = {};
        if (strategy.target_cpa_micros) {
          campaignUpdate.maximizeConversions.targetCpaMicros = strategy.target_cpa_micros.toString();
        }
        updateMask = 'maximize_conversions';
        break;
      case 'MAXIMIZE_CONVERSION_VALUE':
        campaignUpdate.maximizeConversionValue = {};
        if (strategy.target_roas) {
          campaignUpdate.maximizeConversionValue.targetRoas = strategy.target_roas;
        }
        updateMask = 'maximize_conversion_value';
        break;
      case 'MANUAL_CPC':
        campaignUpdate.manualCpc = {};
        updateMask = 'manual_cpc';
        break;
      case 'TARGET_IMPRESSION_SHARE':
        campaignUpdate.targetImpressionShare = {};
        updateMask = 'target_impression_share';
        break;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': developerToken,
        'login-customer-id': customerId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        operations: [{
          update: campaignUpdate,
          updateMask
        }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update Google campaign bidding strategy: ${error}`);
    }

    return response.json();
  }

  /**
   * Read current campaign budget amount
   * Returns budget in micros (1 dollar = 1,000,000 micros)
   */
  async readCampaignBudget(
    accessToken: string,
    developerToken: string,
    customerId: string,
    campaignId: string
  ): Promise<{ budget_amount_micros: number; budget_resource_name: string }> {
    const searchUrl = `https://googleads.googleapis.com/v22/customers/${customerId}/googleAds:search`;
    const query = `SELECT campaign.campaign_budget, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${campaignId}`;

    const response = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': developerToken,
        'login-customer-id': customerId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to read Google campaign budget: ${error}`);
    }

    const data = await response.json() as any;
    const result = data.results?.[0];
    if (!result?.campaign?.campaignBudget || !result?.campaignBudget?.amountMicros) {
      throw new Error('Campaign has no budget resource');
    }

    return {
      budget_amount_micros: parseInt(result.campaignBudget.amountMicros, 10),
      budget_resource_name: result.campaign.campaignBudget
    };
  }
}
