/**
 * Shopify OAuth Provider
 *
 * Implements OAuth 2.0 flow for Shopify API access.
 * Scopes: read_products, read_orders, read_customers, read_analytics
 */

import { OAuthProvider, OAuthUserInfo, OAuthConfig } from './base';

export class ShopifyOAuthProvider extends OAuthProvider {
  private shopDomain: string;

  constructor(clientId: string, clientSecret: string, redirectUri: string, shopDomain: string) {
    super({
      clientId,
      clientSecret,
      redirectUri,
      scopes: [
        'read_products',
        'read_orders',
        'read_customers',
        'read_analytics',
        'read_content',
        'read_script_tags',
        'read_themes',
        'read_price_rules',
        'read_discounts',
        'read_marketing_events',
        'read_fulfillments',
        'read_shipping'
      ],
      authorizeUrl: `https://${shopDomain}/admin/oauth/authorize`,
      tokenUrl: `https://${shopDomain}/admin/oauth/access_token`
    });
    this.shopDomain = shopDomain;
  }

  /**
   * Get authorization URL with Shopify-specific parameters and PKCE
   *
   * @param state - CSRF token
   * @param pkce - PKCE challenge from generatePKCEChallenge()
   * @returns Authorization URL
   */
  getAuthorizationUrl(state: string, pkce: import('./base').PKCEChallenge): string {
    return super.getAuthorizationUrl(state, pkce);
  }

  /**
   * Exchange authorization code for access token (Shopify-specific)
   * Shopify doesn't use PKCE in the same way, but we'll include it for consistency
   */
  async exchangeCodeForToken(code: string, codeVerifier: string): Promise<import('./base').OAuthTokens> {
    // console.log('Exchanging code for token with Shopify', {
    //   tokenUrl: this.config.tokenUrl,
    //   redirectUri: this.config.redirectUri,
    //   hasClientId: !!this.config.clientId,
    //   hasClientSecret: !!this.config.clientSecret,
    //   hasCode: !!code,
    //   shopDomain: this.shopDomain
    // });

    try {
      const requestBody = {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.redirectUri
      };

      const response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Shopify token exchange failed:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });

        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error) {
            errorMessage = typeof errorJson.error === 'string'
              ? errorJson.error
              : errorJson.error.message || JSON.stringify(errorJson.error);
          }
        } catch (e) {
          // Use raw error text
        }

        throw new Error(`Token exchange failed (${response.status}): ${errorMessage}`);
      }

      const data = await response.json() as any;

      // Shopify returns access_token directly, not in nested structure
      const tokens: import('./base').OAuthTokens = {
        access_token: data.access_token,
        scope: data.scope,
        expires_in: undefined, // Shopify tokens don't expire
        token_type: 'Bearer'
      };

      console.log('Shopify token exchange successful', {
        hasAccessToken: !!tokens.access_token,
        scope: tokens.scope
      });

      return tokens;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('OAuth token exchange timed out');
        }
        throw error;
      }
      throw new Error('OAuth token exchange failed');
    }
  }

  /**
   * Get shop information from Shopify
   */
  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const response = await fetch(
      `https://${this.shopDomain}/admin/api/2024-10/shop.json`,
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Shopify getUserInfo failed:', errorText);
      throw new Error(`Failed to fetch Shopify shop info: ${response.statusText}`);
    }

    const data = await response.json() as any;
    const shop = data.shop;

    return {
      id: shop.id?.toString() || this.shopDomain,
      email: shop.email,
      name: shop.name || this.shopDomain,
      raw: shop
    };
  }

  /**
   * Validate Shopify access token by making a simple API call
   */
  async validateToken(accessToken: string): Promise<boolean> {
    try {
      const response = await fetch(
        `https://${this.shopDomain}/admin/api/2024-10/shop.json`,
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get shop domain (useful for connection identification)
   */
  getShopDomain(): string {
    return this.shopDomain;
  }
}

