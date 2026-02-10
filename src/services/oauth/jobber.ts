/**
 * Jobber OAuth Provider
 *
 * Implements OAuth 2.0 authorization code grant for Jobber API access.
 * Uses GraphQL API (version 2025-01-20).
 *
 * Key features:
 * - Standard OAuth 2.0 with PKCE support
 * - GraphQL API for data access
 * - Access tokens expire and require refresh tokens
 *
 * Available scopes:
 * - read_jobs: Access job data (primary conversion events)
 * - read_invoices: Access invoice data (revenue)
 * - read_clients: Access client data (for attribution matching)
 * - read_quotes: Access quote data (lead pipeline)
 * - read_requests: Access request data (incoming leads)
 *
 * @see https://developer.getjobber.com/docs/building_your_app/app_authorization/
 * @see https://developer.getjobber.com/docs/using_jobbers_api/api_queries_and_mutations/
 */

import { OAuthProvider, OAuthTokens, OAuthUserInfo, PKCEChallenge } from './base';
import { structuredLog } from '../../utils/structured-logger';

/**
 * Jobber GraphQL API version
 */
const JOBBER_API_VERSION = '2025-01-20';

/**
 * Jobber OAuth endpoints
 */
const JOBBER_AUTH_URL = 'https://api.getjobber.com/api/oauth/authorize';
const JOBBER_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';

/**
 * Jobber account information
 */
export interface JobberAccountInfo {
  id: string;
  name: string;
  email: string;
  companyName?: string;
  timezone?: string;
  currency?: string;
  country?: string;
  plan?: string;
}

export class JobberOAuthProvider extends OAuthProvider {
  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    super({
      clientId,
      clientSecret,
      redirectUri,
      scopes: [
        'read_jobs',
        'read_invoices',
        'read_clients',
        'read_quotes',
        'read_requests'
      ],
      authorizeUrl: JOBBER_AUTH_URL,
      tokenUrl: JOBBER_TOKEN_URL
    });
  }

  /**
   * Generate authorization URL with PKCE
   *
   * @param state - CSRF protection state token
   * @param pkce - PKCE challenge
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
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: pkce.codeChallengeMethod,
      ...additionalParams
    });

    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   *
   * @param code - Authorization code from callback
   * @param codeVerifier - PKCE code verifier
   * @returns OAuth tokens
   */
  async exchangeCodeForToken(code: string, codeVerifier: string): Promise<OAuthTokens> {
    structuredLog('INFO', 'Exchanging Jobber code for token', {
      service: 'jobber-oauth',
      hasCode: !!code,
      hasCodeVerifier: !!codeVerifier,
    });

    try {
      const response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code,
          redirect_uri: this.config.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier
        }).toString(),
        signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS)
      });

      if (!response.ok) {
        const errorText = await response.text();
        structuredLog('ERROR', 'Jobber token exchange failed', { service: 'jobber-oauth', method: 'exchangeCodeForToken', status: response.status, error: errorText });

        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error_description || errorJson.error || errorText;
        } catch {
          // Use raw error text
        }

        throw new Error(`Jobber token exchange failed (${response.status}): ${errorMessage}`);
      }

      const tokens = await response.json() as OAuthTokens;

      structuredLog('INFO', 'Jobber token exchange successful', {
        service: 'jobber-oauth',
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
        expiresIn: tokens.expires_in,
      });

      return tokens;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Jobber token exchange timed out');
      }
      throw error;
    }
  }

  /**
   * Get user/account information via GraphQL
   */
  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const accountInfo = await this.getAccountInfo(accessToken);

    return {
      id: accountInfo.id,
      email: accountInfo.email,
      name: accountInfo.companyName || accountInfo.name,
      raw: accountInfo
    };
  }

  /**
   * Get detailed account information via GraphQL
   */
  async getAccountInfo(accessToken: string): Promise<JobberAccountInfo> {
    const query = `
      query {
        account {
          id
          name
          email
          companyName
          timezone
          countryCode
        }
      }
    `;

    const response = await fetch(JOBBER_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch Jobber account info: ${errorText}`);
    }

    const data = await response.json() as {
      data?: { account?: any };
      errors?: any[];
    };

    if (data.errors && data.errors.length > 0) {
      throw new Error(`Jobber GraphQL error: ${JSON.stringify(data.errors)}`);
    }

    const account = data.data?.account;
    if (!account) {
      throw new Error('No account data returned from Jobber');
    }

    return {
      id: account.id,
      name: account.name,
      email: account.email,
      companyName: account.companyName,
      timezone: account.timezone,
      country: account.countryCode
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    structuredLog('INFO', 'Refreshing Jobber access token', { service: 'jobber-oauth' });

    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }).toString(),
      signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jobber token refresh failed: ${errorText}`);
    }

    const tokens = await response.json() as OAuthTokens;

    structuredLog('INFO', 'Jobber token refresh successful', {
      service: 'jobber-oauth',
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return tokens;
  }

  /**
   * Validate access token by making a simple API call
   */
  async validateToken(accessToken: string): Promise<boolean> {
    try {
      const response = await fetch(JOBBER_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION
        },
        body: JSON.stringify({
          query: '{ account { id } }'
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as { data?: any; errors?: any[] };
      return !data.errors && !!data.data?.account;
    } catch {
      return false;
    }
  }

  /**
   * Test connection and return account info
   */
  async testConnection(accessToken: string): Promise<{ success: boolean; error?: string; account?: JobberAccountInfo }> {
    try {
      const account = await this.getAccountInfo(accessToken);
      return { success: true, account };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}
