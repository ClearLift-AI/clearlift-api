/**
 * HubSpot OAuth Provider
 *
 * Implements OAuth 2.0 authorization code grant for HubSpot CRM API access.
 * Uses PKCE for enhanced security per RFC 7636.
 *
 * HubSpot OAuth specifics:
 * - Standard OAuth 2.0 with PKCE support
 * - Refresh tokens that don't expire (but can be revoked)
 * - Scopes are granular per object type
 *
 * @see https://developers.hubspot.com/docs/api/oauth-quickstart-guide
 * @see https://developers.hubspot.com/docs/api/working-with-oauth
 */

import { OAuthProvider, OAuthTokens, OAuthUserInfo, PKCEChallenge } from './base';
import { structuredLog } from '../../utils/structured-logger';

/**
 * HubSpot-specific token response
 */
export interface HubSpotTokens extends OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number; // Access token expires in ~6 hours
  token_type: 'bearer';
}

/**
 * HubSpot account information
 */
export interface HubSpotAccountInfo {
  portalId: number;
  hubId: number;
  hubDomain: string;
  companyName?: string;
  timeZone: string;
  currency: string;
  utcOffsetMilliseconds: number;
}

/**
 * HubSpot user information
 */
export interface HubSpotUserInfo {
  user: string; // email
  hub_domain: string;
  hub_id: number;
  user_id: number;
  token_type: string;
  scopes: string[];
}

/**
 * HubSpot CRM scopes for contact/deal/activity access
 */
export const HUBSPOT_CRM_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.companies.read',
  'crm.objects.deals.read',
  'crm.objects.owners.read',
  'crm.schemas.contacts.read',
  'crm.schemas.companies.read',
  'crm.schemas.deals.read',
  'timeline',
  'oauth',
] as const;

export class HubSpotOAuthProvider extends OAuthProvider {
  private readonly API_BASE = 'https://api.hubapi.com';

  constructor(clientId: string, clientSecret: string, redirectUri: string, scopes?: string[]) {
    super({
      clientId,
      clientSecret,
      redirectUri,
      scopes: scopes || [...HUBSPOT_CRM_SCOPES],
      authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
      tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    });
  }

  /**
   * Generate authorization URL with PKCE
   *
   * @param state - CSRF protection state token
   * @param pkce - PKCE challenge pair
   * @param additionalParams - Optional additional parameters
   * @returns Authorization URL
   */
  getAuthorizationUrl(
    state: string,
    pkce: PKCEChallenge,
    additionalParams?: Record<string, string>
  ): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes.join(' '),
      state,
      // HubSpot supports PKCE
      code_challenge: pkce.codeChallenge,
      code_challenge_method: pkce.codeChallengeMethod,
      ...additionalParams,
    });

    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token with PKCE verification
   *
   * @param code - Authorization code from callback
   * @param codeVerifier - PKCE code verifier
   * @returns HubSpot tokens
   */
  async exchangeCodeForToken(code: string, codeVerifier: string): Promise<HubSpotTokens> {
    structuredLog('INFO', 'Exchanging HubSpot code for token', {
      service: 'hubspot-oauth',
      hasCode: !!code,
      hasCodeVerifier: !!codeVerifier,
    });

    try {
      const response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: this.config.redirectUri,
          code,
          code_verifier: codeVerifier,
        }).toString(),
        signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        structuredLog('ERROR', 'HubSpot token exchange failed', { service: 'hubspot-oauth', method: 'exchangeCodeForToken', status: response.status, error: errorText });

        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.message || errorJson.error || errorText;
        } catch {
          // Use raw error text
        }

        throw new Error(`HubSpot token exchange failed (${response.status}): ${errorMessage}`);
      }

      const tokens = (await response.json()) as HubSpotTokens;

      structuredLog('INFO', 'HubSpot token exchange successful', {
        service: 'hubspot-oauth',
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
        expiresIn: tokens.expires_in,
      });

      return tokens;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('HubSpot token exchange timed out');
      }
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token
   *
   * HubSpot access tokens expire after ~6 hours.
   * Refresh tokens don't expire but can be revoked.
   *
   * @param refreshToken - Refresh token from initial authorization
   * @returns New tokens
   */
  async refreshAccessToken(refreshToken: string): Promise<HubSpotTokens> {
    structuredLog('INFO', 'Refreshing HubSpot access token', { service: 'hubspot-oauth' });

    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'HubSpot token refresh failed', { service: 'hubspot-oauth', method: 'refreshAccessToken', status: response.status, error: errorText });

      throw new Error(`HubSpot token refresh failed (${response.status}): ${errorText}`);
    }

    const tokens = (await response.json()) as HubSpotTokens;

    structuredLog('INFO', 'HubSpot token refresh successful', {
      service: 'hubspot-oauth',
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return tokens;
  }

  /**
   * Get user/account information from HubSpot
   */
  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const tokenInfo = await this.getTokenInfo(accessToken);

    return {
      id: String(tokenInfo.hub_id),
      email: tokenInfo.user,
      name: tokenInfo.hub_domain,
      raw: tokenInfo,
    };
  }

  /**
   * Get token info (includes scopes and hub info)
   */
  async getTokenInfo(accessToken: string): Promise<HubSpotUserInfo> {
    const response = await fetch(`${this.API_BASE}/oauth/v1/access-tokens/${accessToken}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get HubSpot token info: ${errorText}`);
    }

    return (await response.json()) as HubSpotUserInfo;
  }

  /**
   * Get HubSpot account details
   */
  async getAccountInfo(accessToken: string): Promise<HubSpotAccountInfo> {
    const response = await fetch(`${this.API_BASE}/account-info/v3/details`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get HubSpot account info: ${errorText}`);
    }

    return (await response.json()) as HubSpotAccountInfo;
  }

  /**
   * Validate access token by making a simple API call
   */
  async validateToken(accessToken: string): Promise<boolean> {
    try {
      await this.getTokenInfo(accessToken);
      return true;
    } catch {
      return false;
    }
  }
}
