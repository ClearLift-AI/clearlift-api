/**
 * Google Ads OAuth Provider
 *
 * Implements OAuth 2.0 flow for Google Ads API access.
 * Scopes: https://www.googleapis.com/auth/adwords
 */

import { OAuthProvider, OAuthUserInfo, OAuthConfig } from './base';

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
   * Get authorization URL with Google-specific parameters
   */
  getAuthorizationUrl(state: string): string {
    return super.getAuthorizationUrl(state, {
      access_type: 'offline',
      prompt: 'consent', // Force consent to get refresh token
      include_granted_scopes: 'true'
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

    const data = await response.json();

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

      const data = await response.json();

      // Check if token has required scope
      return data.scope && data.scope.includes('adwords');
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
      console.error('Google Ads Developer Token is missing or empty');
      throw new Error('DEVELOPER_TOKEN_MISSING: Google Ads Developer Token is required. Get yours at: https://developers.google.com/google-ads/api/docs/get-started/dev-token');
    }

    try {
      // Get user info first to identify the user
      const userInfo = await this.getUserInfo(accessToken);
      console.log('Got user info for Google Ads account fetch:', { userId: userInfo.id, email: userInfo.email });

      // Call Google Ads API to list accessible customer accounts
      // https://developers.google.com/google-ads/api/rest/reference/rest/v21/customers/listAccessibleCustomers
      const apiUrl = 'https://googleads.googleapis.com/v21/customers:listAccessibleCustomers';
      console.log('Calling Google Ads API:', {
        url: apiUrl,
        hasAccessToken: !!accessToken,
        developerTokenPrefix: developerToken.substring(0, 10) + '...'
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
        console.error('Google Ads API error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });

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
        console.log('No Google Ads accounts found for user');
        return [];
      }

      // Fetch details for each customer account
      const accounts = await Promise.all(
        customerIds.map(async (customerId: string) => {
          try {
            const detailResponse = await fetch(`https://googleads.googleapis.com/v21/customers/${customerId}`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'developer-token': developerToken,
                'Content-Type': 'application/json'
              }
            });

            if (detailResponse.ok) {
              const details = await detailResponse.json() as any;
              return {
                id: customerId,
                name: details.descriptiveName || `Account ${customerId}`,
                currency: details.currencyCode || 'USD',
                timezone: details.timeZone || 'America/Los_Angeles',
                manager: details.manager || false
              };
            } else {
              // If we can't get details, return basic info
              return {
                id: customerId,
                name: `Google Ads Account ${customerId}`,
                currency: 'USD',
                timezone: 'America/Los_Angeles'
              };
            }
          } catch (error) {
            console.error(`Failed to get details for customer ${customerId}:`, error);
            return {
              id: customerId,
              name: `Google Ads Account ${customerId}`,
              currency: 'USD',
              timezone: 'America/Los_Angeles'
            };
          }
        })
      );

      return accounts;

    } catch (error) {
      console.error('Failed to fetch Google Ads accounts:', error);
      throw error;
    }
  }
}
