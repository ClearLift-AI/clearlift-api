/**
 * Shopify OAuth Provider
 *
 * Implements OAuth 2.0 authorization code grant for Shopify Admin API access.
 * Uses GraphQL Admin API (2025-01 version).
 *
 * Key differences from standard OAuth:
 * - Dynamic URLs: Auth/token URLs are shop-specific
 * - No PKCE: Shopify doesn't support PKCE (uses HMAC validation instead)
 * - No refresh tokens: Access tokens don't expire (unless expiring tokens requested)
 * - HMAC validation: All requests from Shopify must be HMAC validated
 *
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 * @see https://shopify.dev/docs/api/admin-graphql
 */

import { OAuthProvider, OAuthTokens, OAuthUserInfo, OAuthConfig, PKCEChallenge } from './base';

/**
 * Shopify-specific token response
 */
export interface ShopifyTokens extends OAuthTokens {
  access_token: string;
  scope: string;
  expires_in?: number;
  associated_user_scope?: string;
  associated_user?: {
    id: number;
    email: string;
    email_verified: boolean;
    first_name?: string;
    last_name?: string;
  };
}

/**
 * Shop information from Shopify GraphQL API
 */
export interface ShopifyShopInfo {
  id: string;
  name: string;
  email: string;
  domain: string;
  myshopifyDomain: string;
  currencyCode: string;
  ianaTimezone: string;
  plan: {
    displayName: string;
  };
}

export class ShopifyOAuthProvider extends OAuthProvider {
  private shopDomain: string;
  private readonly API_VERSION = '2025-01';

  constructor(clientId: string, clientSecret: string, redirectUri: string, shopDomain: string) {
    // Validate shop domain before creating provider
    if (!ShopifyOAuthProvider.isValidShopDomain(shopDomain)) {
      throw new Error(`Invalid Shopify shop domain: ${shopDomain}. Must end with .myshopify.com`);
    }

    // Normalize shop domain (remove protocol, trailing slashes)
    const normalizedShop = ShopifyOAuthProvider.normalizeShopDomain(shopDomain);

    super({
      clientId,
      clientSecret,
      redirectUri,
      scopes: ['read_orders', 'read_customers', 'read_customer_events', 'read_products'],
      // Dynamic URLs based on shop
      authorizeUrl: `https://${normalizedShop}/admin/oauth/authorize`,
      tokenUrl: `https://${normalizedShop}/admin/oauth/access_token`
    });

    this.shopDomain = normalizedShop;
  }

  /**
   * Validate shop domain format
   *
   * Per Shopify docs: must end with myshopify.com and contain only
   * letters (a-z), numbers (0-9), periods, and hyphens.
   */
  static isValidShopDomain(shop: string): boolean {
    if (!shop) return false;

    // Remove protocol if present
    const cleaned = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // Must end with .myshopify.com
    if (!cleaned.endsWith('.myshopify.com')) {
      return false;
    }

    // Extract store name (before .myshopify.com)
    const storeName = cleaned.replace('.myshopify.com', '');

    // Store name must be alphanumeric with hyphens, start with letter/number
    const storeNameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
    return storeNameRegex.test(storeName);
  }

  /**
   * Normalize shop domain to consistent format
   */
  static normalizeShopDomain(shop: string): string {
    // Remove protocol and trailing slash
    let normalized = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // Add .myshopify.com if not present (user might enter just store name)
    if (!normalized.includes('.myshopify.com')) {
      normalized = `${normalized}.myshopify.com`;
    }

    return normalized.toLowerCase();
  }

  /**
   * Generate authorization URL (no PKCE for Shopify)
   *
   * Shopify uses HMAC validation instead of PKCE.
   * The pkce parameter is ignored but kept for interface compatibility.
   *
   * @param state - CSRF protection nonce (store server-side)
   * @param _pkce - Ignored (Shopify doesn't support PKCE)
   * @param additionalParams - Optional additional parameters
   * @returns Authorization URL
   */
  getAuthorizationUrl(
    state: string,
    _pkce?: PKCEChallenge,
    additionalParams?: Record<string, string>
  ): string {
    // Shopify uses comma-separated scopes (not space-separated)
    const scopes = this.config.scopes.join(',');

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      scope: scopes,
      redirect_uri: this.config.redirectUri,
      state
    });

    // Offline access tokens (default): omit grant_options[] entirely.
    // Only set grant_options[]=per-user for online (session) tokens.

    // Add any additional params
    if (additionalParams) {
      for (const [key, value] of Object.entries(additionalParams)) {
        params.append(key, value);
      }
    }

    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Validate HMAC signature from Shopify callback
   *
   * Per Shopify docs:
   * 1. Remove hmac param from query string
   * 2. Sort remaining params alphabetically
   * 3. Compute HMAC-SHA256 with client_secret
   * 4. Compare with provided hmac (constant-time)
   *
   * @param queryParams - URL search params from callback
   * @returns true if HMAC is valid
   */
  async validateHmac(queryParams: URLSearchParams): Promise<boolean> {
    const hmac = queryParams.get('hmac');
    if (!hmac) {
      console.error('HMAC validation failed: no hmac parameter');
      return false;
    }

    // Build message by removing hmac and sorting alphabetically
    const params = new URLSearchParams();
    queryParams.forEach((value, key) => {
      if (key !== 'hmac') {
        params.append(key, value);
      }
    });

    // Sort parameters alphabetically by key
    const sortedParams = new URLSearchParams(
      [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    );

    const message = sortedParams.toString();

    // Compute HMAC-SHA256
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.config.clientSecret);
    const messageData = encoder.encode(message);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const computedHmac = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Constant-time comparison to prevent timing attacks
    return this.secureCompare(computedHmac, hmac);
  }

  /**
   * Constant-time string comparison to prevent timing attacks
   */
  private secureCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Exchange authorization code for access token
   *
   * Shopify doesn't use PKCE, so codeVerifier is ignored.
   *
   * @param code - Authorization code from callback
   * @param _codeVerifier - Ignored (Shopify doesn't support PKCE)
   * @returns Shopify tokens
   */
  async exchangeCodeForToken(code: string, _codeVerifier?: string): Promise<ShopifyTokens> {
    console.log('Exchanging Shopify code for token', {
      tokenUrl: this.config.tokenUrl,
      shopDomain: this.shopDomain,
      hasCode: !!code
    });

    try {
      const response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code
        }),
        signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Shopify token exchange failed:', {
          status: response.status,
          error: errorText
        });

        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error_description || errorJson.error || errorText;
        } catch {
          // Use raw error text
        }

        throw new Error(`Shopify token exchange failed (${response.status}): ${errorMessage}`);
      }

      const tokens = await response.json() as ShopifyTokens;

      console.log('Shopify token exchange successful', {
        hasAccessToken: !!tokens.access_token,
        scope: tokens.scope,
        hasAssociatedUser: !!tokens.associated_user
      });

      return tokens;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Shopify token exchange timed out');
      }
      throw error;
    }
  }

  /**
   * Get shop information from Shopify GraphQL API
   */
  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const shopInfo = await this.getShopInfo(accessToken);

    return {
      id: shopInfo.id,
      email: shopInfo.email,
      name: shopInfo.name,
      raw: shopInfo
    };
  }

  /**
   * Get detailed shop information via GraphQL
   */
  async getShopInfo(accessToken: string): Promise<ShopifyShopInfo> {
    const graphqlUrl = `https://${this.shopDomain}/admin/api/${this.API_VERSION}/graphql.json`;

    const query = `
      query {
        shop {
          id
          name
          email
          myshopifyDomain
          primaryDomain {
            url
          }
          currencyCode
          ianaTimezone
          plan {
            displayName
          }
        }
      }
    `;

    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch Shopify shop info: ${errorText}`);
    }

    const data = await response.json() as {
      data?: { shop?: any };
      errors?: any[];
    };

    if (data.errors && data.errors.length > 0) {
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(data.errors)}`);
    }

    const shop = data.data?.shop;
    if (!shop) {
      throw new Error('No shop data returned from Shopify');
    }

    return {
      id: shop.id,
      name: shop.name,
      email: shop.email,
      domain: shop.primaryDomain?.url || shop.myshopifyDomain,
      myshopifyDomain: shop.myshopifyDomain,
      currencyCode: shop.currencyCode,
      ianaTimezone: shop.ianaTimezone,
      plan: shop.plan
    };
  }

  /**
   * Validate access token by making a simple API call
   */
  async validateToken(accessToken: string): Promise<boolean> {
    try {
      const graphqlUrl = `https://${this.shopDomain}/admin/api/${this.API_VERSION}/graphql.json`;

      const response = await fetch(graphqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken
        },
        body: JSON.stringify({
          query: '{ shop { name } }'
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as { data?: any; errors?: any[] };
      return !data.errors && !!data.data?.shop;
    } catch {
      return false;
    }
  }

  /**
   * Get shop domain for this provider instance
   */
  getShopDomain(): string {
    return this.shopDomain;
  }

  /**
   * Shopify tokens don't expire by default, so refresh is not needed.
   * This method throws an error since Shopify uses permanent tokens.
   */
  async refreshAccessToken(_refreshToken: string): Promise<OAuthTokens> {
    throw new Error('Shopify access tokens do not expire and cannot be refreshed. Re-authenticate if the token was revoked.');
  }
}
