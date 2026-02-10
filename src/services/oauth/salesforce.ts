/**
 * Salesforce OAuth Provider
 *
 * Implements OAuth 2.0 Web Server Flow for Salesforce API access.
 * Uses PKCE for enhanced security.
 *
 * Salesforce OAuth specifics:
 * - Uses instance URLs that vary per customer org
 * - Refresh tokens don't expire but can be revoked
 * - Access tokens expire after ~2 hours (session timeout)
 *
 * @see https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm
 * @see https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_oauth_and_connected_apps.htm
 */

import { OAuthProvider, OAuthTokens, OAuthUserInfo, PKCEChallenge } from './base';
import { structuredLog } from '../../utils/structured-logger';

/**
 * Salesforce-specific token response
 */
export interface SalesforceTokens extends OAuthTokens {
  access_token: string;
  refresh_token: string;
  instance_url: string;  // e.g., https://na1.salesforce.com
  id: string;            // Identity URL
  token_type: 'Bearer';
  issued_at: string;     // Unix timestamp in milliseconds
  signature: string;     // HMAC-SHA256 signature
}

/**
 * Salesforce user identity information
 */
export interface SalesforceUserIdentity {
  id: string;                    // Full identity URL
  asserted_user: boolean;
  user_id: string;               // User ID (15 or 18 char)
  organization_id: string;       // Org ID (15 or 18 char)
  username: string;
  nick_name: string;
  display_name: string;
  email: string;
  email_verified: boolean;
  first_name: string;
  last_name: string;
  timezone: string;
  photos: {
    picture: string;
    thumbnail: string;
  };
  addr_street: string | null;
  addr_city: string | null;
  addr_state: string | null;
  addr_country: string;
  addr_zip: string | null;
  mobile_phone: string | null;
  mobile_phone_verified: boolean;
  is_lightning_login_user: boolean;
  status: {
    created_date: string | null;
    body: string | null;
  };
  urls: {
    enterprise: string;
    metadata: string;
    partner: string;
    rest: string;
    sobjects: string;
    search: string;
    query: string;
    recent: string;
    profile: string;
  };
  active: boolean;
  user_type: string;
  language: string;
  locale: string;
  utcOffset: number;
  last_modified_date: string;
}

/**
 * Salesforce org/account information
 */
export interface SalesforceOrgInfo {
  Id: string;
  Name: string;
  Division: string | null;
  InstanceName: string;
  IsSandbox: boolean;
  LanguageLocaleKey: string;
  NamespacePrefix: string | null;
  OrganizationType: string;
  TimeZoneSidKey: string;
  DefaultCurrencyIsoCode: string;
}

/**
 * Salesforce CRM scopes for objects access
 * Full access scope covers most read operations
 */
export const SALESFORCE_CRM_SCOPES = [
  'api',                    // Access Salesforce APIs
  'refresh_token',          // Obtain refresh token
  'offline_access',         // Same as refresh_token (alias)
  'id',                     // Access identity URL
  'profile',                // Access user profile
  'email',                  // Access user email
  'openid',                 // OpenID Connect
] as const;

export class SalesforceOAuthProvider extends OAuthProvider {
  // Salesforce uses different base URLs for sandbox vs production
  private readonly LOGIN_URL = 'https://login.salesforce.com';
  private readonly SANDBOX_LOGIN_URL = 'https://test.salesforce.com';

  private isSandbox: boolean;

  constructor(
    clientId: string,
    clientSecret: string,
    redirectUri: string,
    scopes?: string[],
    isSandbox: boolean = false
  ) {
    const loginUrl = isSandbox ? 'https://test.salesforce.com' : 'https://login.salesforce.com';

    super({
      clientId,
      clientSecret,
      redirectUri,
      scopes: scopes || [...SALESFORCE_CRM_SCOPES],
      authorizeUrl: `${loginUrl}/services/oauth2/authorize`,
      tokenUrl: `${loginUrl}/services/oauth2/token`,
    });

    this.isSandbox = isSandbox;
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
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes.join(' '),
      state,
      // Salesforce supports PKCE
      code_challenge: pkce.codeChallenge,
      code_challenge_method: pkce.codeChallengeMethod,
      // Prompt for login to ensure fresh auth
      prompt: 'login consent',
      ...additionalParams,
    });

    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token with PKCE verification
   *
   * @param code - Authorization code from callback
   * @param codeVerifier - PKCE code verifier
   * @returns Salesforce tokens including instance_url
   */
  async exchangeCodeForToken(code: string, codeVerifier: string): Promise<SalesforceTokens> {
    structuredLog('INFO', 'Exchanging Salesforce code for token', {
      service: 'salesforce-oauth',
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
        structuredLog('ERROR', 'Salesforce token exchange failed', { service: 'salesforce-oauth', method: 'exchangeCodeForToken', status: response.status, error: errorText });

        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error_description || errorJson.error || errorText;
        } catch {
          // Use raw error text
        }

        throw new Error(`Salesforce token exchange failed (${response.status}): ${errorMessage}`);
      }

      const tokens = (await response.json()) as SalesforceTokens;

      structuredLog('INFO', 'Salesforce token exchange successful', {
        service: 'salesforce-oauth',
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
      });

      return tokens;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Salesforce token exchange timed out');
      }
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token
   *
   * Salesforce access tokens expire based on session settings (~2 hours default).
   * Refresh tokens don't expire but can be revoked by admin.
   *
   * @param refreshToken - Refresh token from initial authorization
   * @returns New tokens (note: instance_url remains the same)
   */
  async refreshAccessToken(refreshToken: string): Promise<SalesforceTokens> {
    structuredLog('INFO', 'Refreshing Salesforce access token', { service: 'salesforce-oauth' });

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
      structuredLog('ERROR', 'Salesforce token refresh failed', { service: 'salesforce-oauth', method: 'refreshAccessToken', status: response.status, error: errorText });

      throw new Error(`Salesforce token refresh failed (${response.status}): ${errorText}`);
    }

    const tokens = (await response.json()) as SalesforceTokens;

    structuredLog('INFO', 'Salesforce token refresh successful', {
      service: 'salesforce-oauth',
      hasAccessToken: !!tokens.access_token,
    });

    return tokens;
  }

  /**
   * Get user/account information from Salesforce
   */
  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    // First get the identity URL from token introspection or use the id from tokens
    const identity = await this.getIdentity(accessToken);

    return {
      id: identity.organization_id,
      email: identity.email,
      name: identity.display_name,
      raw: identity,
    };
  }

  /**
   * Get Salesforce user identity
   */
  async getIdentity(accessToken: string, instanceUrl?: string): Promise<SalesforceUserIdentity> {
    // Use instance URL if provided, otherwise try to get from userinfo endpoint
    const baseUrl = instanceUrl || this.LOGIN_URL;

    // The /services/oauth2/userinfo endpoint works with the access token
    const response = await fetch(`${baseUrl}/services/oauth2/userinfo`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get Salesforce identity: ${errorText}`);
    }

    return (await response.json()) as SalesforceUserIdentity;
  }

  /**
   * Get Salesforce organization details
   */
  async getOrgInfo(accessToken: string, instanceUrl: string): Promise<SalesforceOrgInfo> {
    const response = await fetch(
      `${instanceUrl}/services/data/v59.0/sobjects/Organization`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get Salesforce org info: ${errorText}`);
    }

    const data = await response.json() as { records?: SalesforceOrgInfo[] };

    // Query returns results, get first (and only) org
    if (data.records && data.records.length > 0) {
      return data.records[0];
    }

    // Direct sobject access returns the org directly
    return data as unknown as SalesforceOrgInfo;
  }

  /**
   * Query Salesforce org info using SOQL
   */
  async queryOrgInfo(accessToken: string, instanceUrl: string): Promise<SalesforceOrgInfo> {
    const query = encodeURIComponent(
      'SELECT Id, Name, Division, InstanceName, IsSandbox, LanguageLocaleKey, ' +
      'NamespacePrefix, OrganizationType, TimeZoneSidKey, DefaultCurrencyIsoCode ' +
      'FROM Organization'
    );

    const response = await fetch(
      `${instanceUrl}/services/data/v59.0/query?q=${query}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to query Salesforce org info: ${errorText}`);
    }

    const data = await response.json() as { records: SalesforceOrgInfo[] };

    if (!data.records || data.records.length === 0) {
      throw new Error('No organization record found');
    }

    return data.records[0];
  }

  /**
   * Validate access token by making a simple API call
   */
  async validateToken(accessToken: string): Promise<boolean> {
    try {
      // Try to get userinfo - this validates the token
      await this.getIdentity(accessToken);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Revoke an access or refresh token
   */
  async revokeToken(token: string): Promise<void> {
    const loginUrl = this.isSandbox ? this.SANDBOX_LOGIN_URL : this.LOGIN_URL;

    const response = await fetch(`${loginUrl}/services/oauth2/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        token,
      }).toString(),
      signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to revoke Salesforce token: ${errorText}`);
    }
  }
}
