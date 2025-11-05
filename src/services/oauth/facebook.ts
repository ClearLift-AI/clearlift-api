/**
 * Facebook Ads OAuth Provider
 *
 * Implements OAuth 2.0 flow for Facebook Marketing API access.
 * Scopes: ads_read, ads_management
 */

import { OAuthProvider, OAuthUserInfo, OAuthConfig } from './base';

export class FacebookAdsOAuthProvider extends OAuthProvider {
  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    super({
      clientId,
      clientSecret,
      redirectUri,
      scopes: [
        'ads_read',
        'ads_management',
        'email',
        'public_profile'
      ],
      authorizeUrl: 'https://www.facebook.com/v24.0/dialog/oauth',
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
   * Validate Facebook access token
   */
  async validateToken(accessToken: string): Promise<boolean> {
    try {
      const response = await fetch(
        `https://graph.facebook.com/v24.0/me?access_token=${accessToken}`
      );

      return response.ok;
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
}
