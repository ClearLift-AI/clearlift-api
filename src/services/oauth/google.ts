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
   */
  async getAdAccounts(accessToken: string, developerToken: string): Promise<any[]> {
    // Note: This requires the Google Ads API developer token
    // and manager account ID to be configured
    // Implementation would use Google Ads API to list accessible accounts

    // Placeholder for now
    return [];
  }
}
