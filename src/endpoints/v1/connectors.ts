import { OpenAPIRoute, Str, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { ConnectorService } from "../../services/connectors";
import { OnboardingService } from "../../services/onboarding";
import { GoogleAdsOAuthProvider } from "../../services/oauth/google";
import { FacebookAdsOAuthProvider } from "../../services/oauth/facebook";
import { ShopifyOAuthProvider } from "../../services/oauth/shopify";
import { JobberOAuthProvider } from "../../services/oauth/jobber";
import { HubSpotOAuthProvider } from "../../services/oauth/hubspot";
import { SalesforceOAuthProvider } from "../../services/oauth/salesforce";
import { success, error } from "../../utils/response";
import { getSecret } from "../../utils/secrets";

/**
 * GET /v1/connectors - List available connectors
 */
export class ListConnectors extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "List available connectors",
    operationId: "list-connectors",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "Available connectors",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connectors: z.array(z.any())
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const connectorService = ConnectorService.createSync(c.env.DB);
    const connectors = await connectorService.getAvailableConnectors();

    return success(c, { connectors });
  }
}

/**
 * GET /v1/connectors/connected - List user's connected platforms
 */
export class ListConnectedPlatforms extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "List connected platforms",
    operationId: "list-connected-platforms",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Connected platforms"
      }
    }
  };

  public async handle(c: AppContext) {
    try {
      const session = c.get("session");
      const data = await this.getValidatedData<typeof this.schema>();
      const org_id = data.query.org_id;

      // Verify user has access to org
      const { D1Adapter } = await import("../../adapters/d1");
      const d1 = new D1Adapter(c.env.DB);
      const hasAccess = await d1.checkOrgAccess(session.user_id, org_id);

      if (!hasAccess) {
        return error(c, "FORBIDDEN", "No access to this organization", 403);
      }

      const connectorService = ConnectorService.createSync(c.env.DB);
      const connections = await connectorService.getOrganizationConnections(org_id);

      return success(c, { connections });
    } catch (err: any) {
      console.error("ListConnectedPlatforms error:", err);
      return error(c, "INTERNAL_ERROR", `Failed to fetch connections: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/connectors/needs-reauth - Get connections that need re-authentication
 *
 * Returns connections with expired/invalid OAuth tokens that require user action
 */
export class GetConnectionsNeedingReauth extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Get connections needing re-authentication",
    operationId: "get-connections-needing-reauth",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Connections needing re-authentication",
        content: {
          "application/json": {
            schema: z.object({
              connections: z.array(z.object({
                id: z.string(),
                platform: z.string(),
                account_id: z.string(),
                account_name: z.string().nullable(),
                reauth_reason: z.string().nullable(),
                reauth_detected_at: z.string().nullable(),
                consecutive_auth_failures: z.number()
              }))
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext): Promise<Response> {
    try {
      const session = c.get("session");
      const data = await this.getValidatedData<typeof this.schema>();
      const org_id = data.query.org_id;

      // Verify user has access to org
      const { D1Adapter } = await import("../../adapters/d1");
      const d1 = new D1Adapter(c.env.DB);
      const hasAccess = await d1.checkOrgAccess(session.user_id, org_id);

      if (!hasAccess) {
        return error(c, "FORBIDDEN", "No access to this organization", 403);
      }

      // Get connections needing reauth
      const result = await c.env.DB.prepare(`
        SELECT id, platform, account_id, account_name,
               reauth_reason, reauth_detected_at, consecutive_auth_failures
        FROM platform_connections
        WHERE organization_id = ?
          AND needs_reauth = TRUE
          AND is_active = TRUE
        ORDER BY reauth_detected_at DESC
      `).bind(org_id).all();

      return success(c, { connections: result.results || [] });
    } catch (err: any) {
      console.error("GetConnectionsNeedingReauth error:", err);
      return error(c, "INTERNAL_ERROR", `Failed to fetch connections: ${err.message}`, 500);
    }
  }
}

/**
 * POST /v1/connectors/:provider/connect - Initiate OAuth flow
 */
export class InitiateOAuthFlow extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Initiate OAuth connection",
    operationId: "initiate-oauth-flow",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        provider: z.enum(['google', 'facebook', 'tiktok', 'stripe', 'shopify', 'jobber', 'hubspot', 'salesforce'])
      }),
      body: contentJson(
        z.object({
          organization_id: z.string(),
          redirect_uri: z.string().optional(),
          shop_domain: z.string().optional() // Required for Shopify
        })
      )
    },
    responses: {
      "200": {
        description: "OAuth authorization URL",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                authorization_url: z.string(),
                state: z.string()
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const { provider } = data.params;
    const { organization_id, redirect_uri, shop_domain } = data.body;

    // BLOCKED: Jobber integration is not yet ready for production
    // The queue-consumer does not have sync handlers for Jobber data
    if (provider === 'jobber') {
      return error(c, "SERVICE_UNAVAILABLE", "Jobber integration is temporarily unavailable. This feature is coming soon.", 503);
    }

    // Shopify requires shop_domain
    if (provider === 'shopify') {
      if (!shop_domain) {
        return error(c, "MISSING_SHOP_DOMAIN", "Shopify requires a shop domain (e.g., your-store.myshopify.com)", 400);
      }
      if (!ShopifyOAuthProvider.isValidShopDomain(shop_domain)) {
        return error(c, "INVALID_SHOP_DOMAIN", "Invalid Shopify shop domain. Must end with .myshopify.com", 400);
      }
    }

    // Verify user has access to org
    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, organization_id);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    // Get OAuth provider and generate PKCE challenge (Shopify doesn't use PKCE)
    const oauthProvider = await this.getOAuthProvider(provider, c, shop_domain);
    const pkce = await oauthProvider.generatePKCEChallenge();

    // Create OAuth state with PKCE verifier stored in metadata
    const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
    const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);

    // Store metadata including shop_domain for Shopify
    const stateMetadata: Record<string, any> = { code_verifier: pkce.codeVerifier };
    if (provider === 'shopify' && shop_domain) {
      stateMetadata.shop_domain = ShopifyOAuthProvider.normalizeShopDomain(shop_domain);
    }

    const state = await connectorService.createOAuthState(
      session.user_id,
      organization_id,
      provider,
      redirect_uri,
      stateMetadata
    );

    // Generate authorization URL with PKCE challenge
    const authorizationUrl = oauthProvider.getAuthorizationUrl(state, pkce);

    // LOCAL DEVELOPMENT: Return mock callback URL unless OAUTH_CALLBACK_BASE is set (tunnel mode)
    const requestUrl = c.req.url;
    const isLocal = requestUrl.startsWith('http://localhost') || requestUrl.startsWith('http://127.0.0.1');
    const useTunnel = !!c.env.OAUTH_CALLBACK_BASE;

    if (isLocal && !useTunnel) {
      const mockUrl = `http://localhost:8787/v1/connectors/${provider}/mock-callback?state=${state}`;
      return success(c, {
        authorization_url: mockUrl,
        state
      });
    }

    return success(c, {
      authorization_url: authorizationUrl,
      state
    });
  }

  private async getOAuthProvider(provider: string, c: AppContext, shopDomain?: string) {
    // Use OAUTH_CALLBACK_BASE env var for local tunnel testing, otherwise production URL
    const callbackBase = c.env.OAUTH_CALLBACK_BASE || 'https://api.clearlift.ai';
    const redirectUri = `${callbackBase}/v1/connectors/${provider}/callback`;

    switch (provider) {
      case 'google': {
        const clientId = await getSecret(c.env.GOOGLE_CLIENT_ID);
        const clientSecret = await getSecret(c.env.GOOGLE_CLIENT_SECRET);
        if (!clientId || !clientSecret) {
          throw new Error('Google OAuth credentials not configured');
        }
        return new GoogleAdsOAuthProvider(
          clientId,
          clientSecret,
          redirectUri
        );
      }
      case 'facebook': {
        const appId = await getSecret(c.env.FACEBOOK_APP_ID);
        const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
        if (!appId || !appSecret) {
          throw new Error('Facebook OAuth credentials not configured');
        }
        return new FacebookAdsOAuthProvider(
          appId,
          appSecret,
          redirectUri
        );
      }
      case 'shopify': {
        if (!shopDomain) {
          throw new Error('Shopify requires a shop domain');
        }
        const clientId = await getSecret(c.env.SHOPIFY_CLIENT_ID);
        const clientSecret = await getSecret(c.env.SHOPIFY_CLIENT_SECRET);
        if (!clientId || !clientSecret) {
          throw new Error('Shopify OAuth credentials not configured');
        }
        return new ShopifyOAuthProvider(
          clientId,
          clientSecret,
          redirectUri,
          shopDomain
        );
      }
      case 'jobber': {
        const clientId = await getSecret(c.env.JOBBER_CLIENT_ID);
        const clientSecret = await getSecret(c.env.JOBBER_CLIENT_SECRET);
        if (!clientId || !clientSecret) {
          throw new Error('Jobber OAuth credentials not configured');
        }
        return new JobberOAuthProvider(
          clientId,
          clientSecret,
          redirectUri
        );
      }
      case 'hubspot': {
        const clientId = await getSecret(c.env.HUBSPOT_CLIENT_ID);
        const clientSecret = await getSecret(c.env.HUBSPOT_CLIENT_SECRET);
        if (!clientId || !clientSecret) {
          throw new Error('HubSpot OAuth credentials not configured');
        }
        return new HubSpotOAuthProvider(
          clientId,
          clientSecret,
          redirectUri
        );
      }
      case 'salesforce': {
        const clientId = await getSecret(c.env.SALESFORCE_CLIENT_ID);
        const clientSecret = await getSecret(c.env.SALESFORCE_CLIENT_SECRET);
        if (!clientId || !clientSecret) {
          throw new Error('Salesforce OAuth credentials not configured');
        }
        return new SalesforceOAuthProvider(
          clientId,
          clientSecret,
          redirectUri
        );
      }
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}

/**
 * GET /v1/connectors/:provider/callback - OAuth callback handler
 */
export class HandleOAuthCallback extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Handle OAuth callback",
    operationId: "handle-oauth-callback",
    request: {
      params: z.object({
        provider: z.enum(['google', 'facebook', 'tiktok', 'stripe', 'shopify', 'jobber', 'hubspot', 'salesforce'])
      }),
      query: z.object({
        code: z.string(),
        state: z.string(),
        error: z.string().optional(),
        // Shopify-specific params
        hmac: z.string().optional(),
        shop: z.string().optional(),
        timestamp: z.string().optional(),
        host: z.string().optional()
      })
    },
    responses: {
      "302": {
        description: "Redirect to app"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { provider } = data.params;
    const { code, state, error: oauthError, shop, hmac } = data.query;

    // Clean up expired OAuth states (based on expires_at, not created_at)
    try {
      const now = new Date().toISOString();
      console.log('[HandleOAuthCallback] Cleaning up expired states (expires_at < now):', now);
      const cleanupResult = await c.env.DB.prepare(`
        DELETE FROM oauth_states
        WHERE expires_at < datetime('now')
      `).run();
      console.log('[HandleOAuthCallback] Cleanup deleted expired rows:', cleanupResult.meta?.changes || 0);
    } catch (cleanupErr) {
      console.error('OAuth state cleanup error:', cleanupErr);
      // Don't fail the request if cleanup fails
    }

    // Get app base URL for redirects (configurable for local testing)
    const appBaseUrl = c.env.APP_BASE_URL || 'https://app.clearlift.ai';

    // Handle OAuth error
    if (oauthError) {
      return c.redirect(`${appBaseUrl}/oauth/callback?error=${oauthError}`);
    }

    try {
      // Get state (don't consume yet - needed for account selection)
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);

      console.log('[HandleOAuthCallback] Looking up OAuth state:', { state, provider });
      const oauthState = await connectorService.getOAuthState(state);

      if (!oauthState) {
        console.error('[HandleOAuthCallback] OAuth state not found in database:', { state, provider });
        return c.redirect(`${appBaseUrl}/oauth/callback?error=invalid_state`);
      }

      console.log('[HandleOAuthCallback] OAuth state found:', { userId: oauthState.user_id, organizationId: oauthState.organization_id });

      // Set organization_id in context for audit middleware
      c.set("org_id" as any, oauthState.organization_id);

      // Get metadata from state
      const stateMetadata = typeof oauthState.metadata === 'string'
        ? JSON.parse(oauthState.metadata)
        : oauthState.metadata;

      // Shopify-specific handling
      let shopDomain: string | undefined;
      if (provider === 'shopify') {
        // Get shop domain from query params (Shopify sends it) or state metadata
        shopDomain = shop || stateMetadata?.shop_domain;
        if (!shopDomain) {
          console.error('Shopify shop domain not found');
          return c.redirect(`${appBaseUrl}/oauth/callback?error=invalid_state&error_description=Shop+domain+missing`);
        }

        // Validate shop domain format
        if (!ShopifyOAuthProvider.isValidShopDomain(shopDomain)) {
          console.error('Invalid Shopify shop domain:', shopDomain);
          return c.redirect(`${appBaseUrl}/oauth/callback?error=invalid_shop&error_description=Invalid+shop+domain`);
        }

        // Validate HMAC signature if present
        if (hmac) {
          const clientSecret = await getSecret(c.env.SHOPIFY_CLIENT_SECRET);
          if (clientSecret) {
            const callbackBase = c.env.OAUTH_CALLBACK_BASE || 'https://api.clearlift.ai';
            const redirectUri = `${callbackBase}/v1/connectors/shopify/callback`;
            const shopifyProvider = new ShopifyOAuthProvider('', clientSecret, redirectUri, shopDomain);
            const queryParams = new URL(c.req.url).searchParams;
            const isValidHmac = await shopifyProvider.validateHmac(queryParams);
            if (!isValidHmac) {
              console.error('Shopify HMAC validation failed');
              return c.redirect(`${appBaseUrl}/oauth/callback?error=invalid_hmac&error_description=HMAC+validation+failed`);
            }
            console.log('Shopify HMAC validation passed');
          }
        }
      }

      // Get PKCE code verifier from state metadata (not used for Shopify)
      const codeVerifier = stateMetadata?.code_verifier;
      if (provider !== 'shopify' && (!codeVerifier || typeof codeVerifier !== 'string')) {
        console.error('PKCE code verifier not found in OAuth state', { hasMetadata: !!stateMetadata, metadataType: typeof stateMetadata });
        return c.redirect(`${appBaseUrl}/oauth/callback?error=invalid_state&error_description=PKCE+verifier+missing`);
      }

      // Exchange code for token
      const oauthProvider = await this.getOAuthProvider(provider, c, shopDomain);
      // Shopify doesn't use PKCE, pass undefined for code verifier
      const tokens = await oauthProvider.exchangeCodeForToken(code, provider === 'shopify' ? undefined : codeVerifier);

      // For Facebook, convert short-lived token to long-lived token (60 days)
      if (provider === 'facebook') {
        console.log('Converting Facebook short-lived token to long-lived token');
        const fbProvider = oauthProvider as FacebookAdsOAuthProvider;
        const longLivedTokens = await fbProvider.exchangeForLongLivedToken(tokens.access_token);
        tokens.access_token = longLivedTokens.access_token;
        tokens.expires_in = longLivedTokens.expires_in;
        console.log(`Facebook token expires in ${longLivedTokens.expires_in} seconds (~${Math.round(longLivedTokens.expires_in / 86400)} days)`);
      }

      // Get user info from provider
      const userInfo = await oauthProvider.getUserInfo(tokens.access_token);

      // Store token and user info in oauth_states (keep code_verifier, add tokens)
      const metadata: Record<string, any> = {
        code_verifier: codeVerifier,  // Preserve PKCE verifier
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        user_info: userInfo
      };

      // For Shopify, store the shop domain
      if (provider === 'shopify' && shopDomain) {
        metadata.shop_domain = shopDomain;
      }

      // For Salesforce, store instance_url from tokens (required for API calls)
      if (provider === 'salesforce' && (tokens as any).instance_url) {
        metadata.user_info = {
          ...metadata.user_info,
          instance_url: (tokens as any).instance_url
        };
        console.log('Salesforce - storing instance URL in metadata:', (tokens as any).instance_url);
      }

      await c.env.DB.prepare(`
        UPDATE oauth_states
        SET metadata = ?
        WHERE state = ?
      `).bind(JSON.stringify(metadata), state).run();

      // Redirect to callback page with state for account selection
      const redirectUri = oauthState.redirect_uri || `${appBaseUrl}/oauth/callback`;
      return c.redirect(`${redirectUri}?code=${code}&state=${state}&step=select_account&provider=${provider}`);

    } catch (err) {
      console.error('OAuth callback error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      const errorDetails = encodeURIComponent(errorMessage);

      // Clean up the failed OAuth state
      try {
        await c.env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(state).run();
      } catch (cleanupErr) {
        console.error('Failed to cleanup oauth state:', cleanupErr);
      }

      return c.redirect(`${appBaseUrl}/oauth/callback?error=connection_failed&error_description=${errorDetails}`);
    }
  }

  private async getOAuthProvider(provider: string, c: AppContext, shopDomain?: string) {
    // Use OAUTH_CALLBACK_BASE env var for local tunnel testing, otherwise production URL
    const callbackBase = c.env.OAUTH_CALLBACK_BASE || 'https://api.clearlift.ai';
    const redirectUri = `${callbackBase}/v1/connectors/${provider}/callback`;

    switch (provider) {
      case 'google': {
        const clientId = await getSecret(c.env.GOOGLE_CLIENT_ID);
        const clientSecret = await getSecret(c.env.GOOGLE_CLIENT_SECRET);
        if (!clientId || !clientSecret) {
          throw new Error('Google OAuth credentials not configured');
        }
        return new GoogleAdsOAuthProvider(
          clientId,
          clientSecret,
          redirectUri
        );
      }
      case 'facebook': {
        const appId = await getSecret(c.env.FACEBOOK_APP_ID);
        const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
        if (!appId || !appSecret) {
          throw new Error('Facebook OAuth credentials not configured');
        }
        return new FacebookAdsOAuthProvider(
          appId,
          appSecret,
          redirectUri
        );
      }
      case 'shopify': {
        if (!shopDomain) {
          throw new Error('Shopify requires a shop domain');
        }
        const clientId = await getSecret(c.env.SHOPIFY_CLIENT_ID);
        const clientSecret = await getSecret(c.env.SHOPIFY_CLIENT_SECRET);
        if (!clientId || !clientSecret) {
          throw new Error('Shopify OAuth credentials not configured');
        }
        return new ShopifyOAuthProvider(
          clientId,
          clientSecret,
          redirectUri,
          shopDomain
        );
      }
      case 'jobber': {
        const clientId = await getSecret(c.env.JOBBER_CLIENT_ID);
        const clientSecret = await getSecret(c.env.JOBBER_CLIENT_SECRET);
        if (!clientId || !clientSecret) {
          throw new Error('Jobber OAuth credentials not configured');
        }
        return new JobberOAuthProvider(
          clientId,
          clientSecret,
          redirectUri
        );
      }
      case 'hubspot': {
        const clientId = await getSecret(c.env.HUBSPOT_CLIENT_ID);
        const clientSecret = await getSecret(c.env.HUBSPOT_CLIENT_SECRET);
        if (!clientId || !clientSecret) {
          throw new Error('HubSpot OAuth credentials not configured');
        }
        return new HubSpotOAuthProvider(
          clientId,
          clientSecret,
          redirectUri
        );
      }
      case 'salesforce': {
        const clientId = await getSecret(c.env.SALESFORCE_CLIENT_ID);
        const clientSecret = await getSecret(c.env.SALESFORCE_CLIENT_SECRET);
        if (!clientId || !clientSecret) {
          throw new Error('Salesforce OAuth credentials not configured');
        }
        return new SalesforceOAuthProvider(
          clientId,
          clientSecret,
          redirectUri
        );
      }
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}

/**
 * GET /v1/connectors/:provider/mock-callback - Mock OAuth callback for local development
 * Creates fake tokens and redirects to account selection flow
 * ONLY works on localhost - production requests will fail
 */
export class MockOAuthCallback extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Mock OAuth callback (local development only)",
    operationId: "mock-oauth-callback",
    request: {
      params: z.object({
        provider: z.enum(['google', 'facebook', 'tiktok', 'stripe', 'shopify', 'jobber', 'hubspot', 'salesforce'])
      }),
      query: z.object({
        state: z.string()
      })
    },
    responses: {
      "302": {
        description: "Redirect to app with mock OAuth state"
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { provider } = data.params;
    const { state } = data.query;

    // SECURITY: Only allow on localhost
    const requestUrl = c.req.url;
    const isLocal = requestUrl.startsWith('http://localhost') || requestUrl.startsWith('http://127.0.0.1');

    if (!isLocal) {
      return error(c, "FORBIDDEN", "Mock OAuth callback only available in local development", 403);
    }

    try {
      // Get OAuth state
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const oauthState = await connectorService.getOAuthState(state);

      if (!oauthState) {
        return c.redirect(`http://localhost:3001/oauth/callback?error=invalid_state`);
      }

      console.log('[MockOAuthCallback] Creating mock OAuth tokens for:', { provider, userId: oauthState.user_id });

      // Create mock tokens and user info based on provider
      const mockData = this.getMockData(provider);

      // Get PKCE code verifier from state metadata
      const stateMetadata = typeof oauthState.metadata === 'string'
        ? JSON.parse(oauthState.metadata)
        : oauthState.metadata;

      const codeVerifier = stateMetadata?.code_verifier;

      // Update oauth_states with mock tokens (like real callback does)
      const metadata = {
        code_verifier: codeVerifier,
        access_token: mockData.access_token,
        refresh_token: mockData.refresh_token,
        expires_in: mockData.expires_in,
        scope: mockData.scope,
        user_info: mockData.user_info
      };

      await c.env.DB.prepare(`
        UPDATE oauth_states
        SET metadata = ?
        WHERE state = ?
      `).bind(JSON.stringify(metadata), state).run();

      // Redirect to callback page with state for account selection (same as real flow)
      const redirectUri = oauthState.redirect_uri || 'http://localhost:3001/oauth/callback';
      return c.redirect(`${redirectUri}?code=mock_code&state=${state}&step=select_account&provider=${provider}`);

    } catch (err) {
      console.error('Mock OAuth callback error:', err);
      return c.redirect(`http://localhost:3001/oauth/callback?error=mock_failed`);
    }
  }

  private getMockData(provider: string) {
    const now = Date.now();

    switch (provider) {
      case 'facebook':
        return {
          access_token: `mock_fb_token_${now}`,
          refresh_token: null,  // Facebook doesn't use refresh tokens
          expires_in: 5184000,  // 60 days like real long-lived token
          scope: 'ads_read,ads_management,business_management',
          user_info: {
            id: '10000000000000001',
            name: 'Test Facebook User',
            email: 'testfb@example.com'
          }
        };
      case 'google':
        return {
          access_token: `mock_google_token_${now}`,
          refresh_token: `mock_google_refresh_${now}`,
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/adwords',
          user_info: {
            id: '100000000000000000001',
            email: 'testgoogle@example.com',
            name: 'Test Google User'
          }
        };
      case 'tiktok':
        return {
          access_token: `mock_tiktok_token_${now}`,
          refresh_token: `mock_tiktok_refresh_${now}`,
          expires_in: 86400,
          scope: 'ad.read,ad.write',
          user_info: {
            id: 'tiktok_user_001',
            name: 'Test TikTok User'
          }
        };
      case 'shopify':
        return {
          access_token: `mock_shopify_token_${now}`,
          refresh_token: null,  // Shopify tokens don't expire
          expires_in: null,
          scope: 'read_orders,read_customers',
          user_info: {
            id: 'gid://shopify/Shop/12345678',
            name: 'Test Shopify Store',
            email: 'shop@example.com'
          }
        };
      case 'salesforce':
        return {
          access_token: `mock_salesforce_token_${now}`,
          refresh_token: `mock_salesforce_refresh_${now}`,
          expires_in: 7200,  // ~2 hours
          scope: 'api refresh_token id profile email',
          user_info: {
            id: '00D000000000000',
            organization_id: '00D000000000000',
            email: 'admin@testorg.com',
            name: 'Test Salesforce Org',
            instance_url: 'https://test.salesforce.com'
          }
        };
      case 'hubspot':
        return {
          access_token: `mock_hubspot_token_${now}`,
          refresh_token: `mock_hubspot_refresh_${now}`,
          expires_in: 21600,  // ~6 hours
          scope: 'crm.objects.contacts.read crm.objects.companies.read',
          user_info: {
            id: '12345678',
            hub_id: 12345678,
            email: 'admin@testhubspot.com',
            name: 'Test HubSpot Portal'
          }
        };
      default:
        return {
          access_token: `mock_token_${now}`,
          refresh_token: `mock_refresh_${now}`,
          expires_in: 3600,
          scope: 'read,write',
          user_info: { id: 'mock_user', name: 'Test User' }
        };
    }
  }
}

/**
 * GET /v1/connectors/:provider/accounts - Get available ad accounts for OAuth provider
 */
export class GetOAuthAccounts extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Get OAuth ad accounts",
    operationId: "get-oauth-accounts",
    request: {
      params: z.object({
        provider: z.enum(['google', 'facebook', 'tiktok', 'shopify', 'jobber', 'hubspot', 'salesforce'])
      }),
      query: z.object({
        state: z.string()
      })
    },
    responses: {
      "200": {
        description: "List of available ad accounts",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                accounts: z.array(z.any())
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { provider } = data.params;
    const { state } = data.query;

    try {
      // Get OAuth state (don't consume yet - still needed for finalize step)
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const oauthState = await connectorService.getOAuthState(state);

      if (!oauthState) {
        return error(c, "INVALID_STATE", "OAuth state is invalid or expired", 400);
      }

      // Set organization_id in context for audit middleware
      c.set("org_id" as any, oauthState.organization_id);

      // Get access token from state metadata
      const metadata = typeof oauthState.metadata === 'string'
        ? JSON.parse(oauthState.metadata)
        : oauthState.metadata;

      const accessToken = metadata?.access_token;
      if (!accessToken) {
        return error(c, "NO_TOKEN", "No access token found in OAuth state", 400);
      }

      // LOCAL DEVELOPMENT: Return mock accounts instead of calling real APIs
      const requestUrl = c.req.url;
      const isLocal = requestUrl.startsWith('http://localhost') || requestUrl.startsWith('http://127.0.0.1');

      if (isLocal && accessToken.startsWith('mock_')) {
        const mockAccounts = this.getMockAccounts(provider);
        console.log('[GetOAuthAccounts] Returning mock accounts for local dev:', { provider, count: mockAccounts.length });
        return success(c, { accounts: mockAccounts });
      }

      // Get ad accounts from provider
      let accounts: any[] = [];

      switch (provider) {
        case 'google': {
          const clientId = await getSecret(c.env.GOOGLE_CLIENT_ID);
          const clientSecret = await getSecret(c.env.GOOGLE_CLIENT_SECRET);
          const redirectUri = `https://api.clearlift.ai/v1/connectors/google/callback`;

          if (!clientId || !clientSecret) {
            return error(c, "MISSING_CREDENTIALS", "Google OAuth credentials not configured", 500);
          }

          const googleProvider = new GoogleAdsOAuthProvider(clientId, clientSecret, redirectUri);
          const developerToken = await getSecret(c.env.GOOGLE_ADS_DEVELOPER_TOKEN);

          console.log('Fetching Google Ads accounts with token:', {
            hasAccessToken: !!accessToken,
            hasDeveloperToken: !!developerToken,
            developerTokenLength: developerToken?.length || 0
          });

          if (!developerToken || developerToken.trim() === '') {
            console.error('GOOGLE_ADS_DEVELOPER_TOKEN is not configured');
            return error(c, "DEVELOPER_TOKEN_MISSING",
              "Google Ads Developer Token is not configured. Please add it to Cloudflare Secrets Store. " +
              "Get your token at: https://developers.google.com/google-ads/api/docs/get-started/dev-token",
              500);
          }

          accounts = await googleProvider.getAdAccounts(accessToken, developerToken);
          break;
        }
        case 'facebook': {
          const appId = await getSecret(c.env.FACEBOOK_APP_ID);
          const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
          const redirectUri = `https://api.clearlift.ai/v1/connectors/facebook/callback`;

          if (!appId || !appSecret) {
            return error(c, "MISSING_CREDENTIALS", "Facebook OAuth credentials not configured", 500);
          }

          const facebookProvider = new FacebookAdsOAuthProvider(appId, appSecret, redirectUri);

          const userInfo = metadata?.user_info;
          if (!userInfo?.id) {
            return error(c, "NO_USER_ID", "Facebook user ID not found", 400);
          }
          accounts = await facebookProvider.getAdAccounts(accessToken, userInfo.id);
          break;
        }
        case 'tiktok': {
          const { TikTokAdsOAuthProvider } = await import("../../services/oauth/tiktok");
          const appId = await getSecret(c.env.TIKTOK_APP_ID);
          const appSecret = await getSecret(c.env.TIKTOK_APP_SECRET);
          const redirectUri = `https://api.clearlift.ai/v1/connectors/tiktok/callback`;

          if (!appId || !appSecret) {
            return error(c, "MISSING_CREDENTIALS", "TikTok OAuth credentials not configured", 500);
          }

          const tiktokProvider = new TikTokAdsOAuthProvider(appId, appSecret, redirectUri);
          accounts = await tiktokProvider.getAdAccounts(accessToken);
          break;
        }
        case 'shopify': {
          // For Shopify, the "account" is the shop itself
          // Get shop info from user_info stored in metadata
          const userInfo = metadata?.user_info;
          const shopDomain = metadata?.shop_domain;

          if (!userInfo || !shopDomain) {
            return error(c, "NO_SHOP_INFO", "Shopify shop info not found", 400);
          }

          // Return the shop as the single "account"
          accounts = [{
            id: shopDomain,
            name: userInfo.name || shopDomain,
            domain: shopDomain,
            email: userInfo.email,
            currency: userInfo.raw?.currencyCode || 'USD',
            timezone: userInfo.raw?.ianaTimezone || 'America/New_York'
          }];
          break;
        }
        case 'jobber': {
          // For Jobber, the "account" is the Jobber account itself (single account per OAuth)
          // Get account info from user_info stored in metadata
          const userInfo = metadata?.user_info;

          if (!userInfo) {
            return error(c, "NO_ACCOUNT_INFO", "Jobber account info not found", 400);
          }

          // Return the Jobber account as the single "account"
          accounts = [{
            id: userInfo.id || userInfo.raw?.id,
            name: userInfo.name || userInfo.raw?.companyName || 'Jobber Account',
            companyName: userInfo.raw?.companyName,
            email: userInfo.email || userInfo.raw?.email,
            timezone: userInfo.raw?.timezone,
            country: userInfo.raw?.country
          }];
          break;
        }
        case 'hubspot': {
          // For HubSpot, the "account" is the HubSpot portal itself
          const userInfo = metadata?.user_info;

          if (!userInfo) {
            return error(c, "NO_ACCOUNT_INFO", "HubSpot account info not found", 400);
          }

          // Return the HubSpot portal as the single "account"
          accounts = [{
            id: String(userInfo.hub_id || userInfo.id),
            name: userInfo.name || userInfo.hub_domain || `HubSpot Portal ${userInfo.hub_id}`,
            hub_id: userInfo.hub_id,
            hub_domain: userInfo.hub_domain,
            email: userInfo.email || userInfo.user,
            timezone: userInfo.raw?.timeZone
          }];
          break;
        }
        case 'salesforce': {
          // For Salesforce, the "account" is the Salesforce org itself
          const userInfo = metadata?.user_info;

          if (!userInfo) {
            return error(c, "NO_ACCOUNT_INFO", "Salesforce account info not found", 400);
          }

          // Return the Salesforce org as the single "account"
          accounts = [{
            id: userInfo.organization_id || userInfo.id,
            name: userInfo.name || `Salesforce Org ${userInfo.organization_id}`,
            organization_id: userInfo.organization_id,
            email: userInfo.email,
            instance_url: userInfo.raw?.instance_url || userInfo.instance_url,
            is_sandbox: userInfo.raw?.IsSandbox
          }];
          break;
        }
      }

      return success(c, { accounts });

    } catch (err: any) {
      console.error('Get OAuth accounts error:', err);
      console.error('Error stack:', err.stack);
      const errorMessage = err.message || "Failed to fetch ad accounts";
      console.error('Returning error to client:', errorMessage);

      // Clean up the OAuth state on failure to prevent accumulation
      try {
        await c.env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(state).run();
        console.log('Cleaned up failed OAuth state');
      } catch (cleanupErr) {
        console.error('Failed to cleanup oauth state:', cleanupErr);
      }

      return error(c, "FETCH_FAILED", errorMessage, 500);
    }
  }

  private getMockAccounts(provider: string) {
    switch (provider) {
      case 'facebook':
        return [
          {
            id: 'act_123456789',
            name: 'Test Ad Account 1',
            account_status: 1,
            currency: 'USD',
            timezone_name: 'America/Los_Angeles'
          },
          {
            id: 'act_987654321',
            name: 'Test Ad Account 2',
            account_status: 1,
            currency: 'USD',
            timezone_name: 'America/New_York'
          }
        ];
      case 'google':
        return [
          {
            id: '1234567890',
            name: 'Test Google Ads Account',
            currencyCode: 'USD',
            timeZone: 'America/Los_Angeles',
            isManager: false
          },
          {
            id: '9876543210',
            name: 'Test Manager Account',
            currencyCode: 'USD',
            timeZone: 'America/New_York',
            isManager: true
          }
        ];
      case 'tiktok':
        return [
          {
            id: 'tt_adv_001',
            name: 'Test TikTok Advertiser',
            status: 'ACTIVE'
          }
        ];
      case 'shopify':
        return [
          {
            id: 'test-store.myshopify.com',
            name: 'Test Shopify Store',
            domain: 'test-store.myshopify.com',
            email: 'shop@example.com',
            currency: 'USD',
            timezone: 'America/New_York'
          }
        ];
      case 'jobber':
        return [
          {
            id: 'jobber_test_123',
            name: 'Test Jobber Account',
            companyName: 'Test Home Services LLC',
            email: 'admin@testhomeservices.com',
            timezone: 'America/Denver',
            country: 'US'
          }
        ];
      case 'hubspot':
        return [
          {
            id: '12345678',
            name: 'Test HubSpot Portal',
            hub_id: 12345678,
            hub_domain: 'test-company.hubspot.com',
            email: 'admin@testcompany.com',
            timezone: 'America/New_York'
          }
        ];
      case 'salesforce':
        return [
          {
            id: '00D000000000000',
            name: 'Test Salesforce Org',
            organization_id: '00D000000000000',
            email: 'admin@testsalesforce.com',
            instance_url: 'https://test.salesforce.com',
            is_sandbox: true
          }
        ];
      default:
        return [];
    }
  }
}

/**
 * GET /v1/connectors/:provider/accounts/:account_id/children - Get child accounts for a manager account
 */
export class GetChildAccounts extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Get child accounts for Google Ads manager account",
    operationId: "get-child-accounts",
    request: {
      params: z.object({
        provider: z.enum(['google']),
        account_id: z.string()
      }),
      query: z.object({
        state: z.string()
      })
    },
    responses: {
      "200": {
        description: "List of child accounts under manager account",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                isManagerAccount: z.boolean(),
                accounts: z.array(z.object({
                  id: z.string(),
                  name: z.string(),
                  currencyCode: z.string().optional(),
                  timeZone: z.string().optional()
                }))
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { provider, account_id } = data.params;
    const { state } = data.query;

    // Only Google Ads supports manager accounts
    if (provider !== 'google') {
      return error(c, "NOT_SUPPORTED", "This endpoint only supports Google Ads", 400);
    }

    try {
      // Get OAuth state (don't consume yet)
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const oauthState = await connectorService.getOAuthState(state);

      if (!oauthState) {
        return error(c, "INVALID_STATE", "OAuth state is invalid or expired", 400);
      }

      // Set organization_id in context for audit middleware
      c.set("org_id" as any, oauthState.organization_id);

      // Get access token from state metadata
      const metadata = typeof oauthState.metadata === 'string'
        ? JSON.parse(oauthState.metadata)
        : oauthState.metadata;

      const accessToken = metadata?.access_token;
      if (!accessToken) {
        return error(c, "NO_TOKEN", "No access token found in OAuth state", 400);
      }

      // Get developer token
      const developerToken = await getSecret(c.env.GOOGLE_ADS_DEVELOPER_TOKEN);
      if (!developerToken || developerToken.trim() === '') {
        return error(c, "DEVELOPER_TOKEN_MISSING",
          "Google Ads Developer Token is not configured",
          500);
      }

      // Use the Google Ads connector to check if manager and get child accounts
      const { GoogleAdsConnector } = await import('../../services/connectors/google-ads');
      const connector = new GoogleAdsConnector(accessToken, account_id, developerToken);

      const isManager = await connector.isManagerAccount();

      if (isManager) {
        const accounts = await connector.listClientAccounts();
        return success(c, { isManagerAccount: true, accounts });
      } else {
        // Not a manager account - return empty list
        return success(c, { isManagerAccount: false, accounts: [] });
      }

    } catch (err: any) {
      console.error('Get child accounts error:', err);
      return error(c, "FETCH_FAILED", err.message || "Failed to fetch child accounts", 500);
    }
  }
}

// =============================================================================
// Shopify Webhook Auto-Registration
// =============================================================================

const SHOPIFY_WEBHOOK_TOPICS = [
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'PRODUCTS_UPDATE',
  'CUSTOMERS_UPDATE',
  'APP_UNINSTALLED',
] as const;

const SHOPIFY_WEBHOOK_MUTATION = `
  mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Register webhook subscriptions with Shopify's GraphQL API and create
 * a local webhook_endpoints row for the organization.
 *
 * Called automatically after Shopify OAuth finalization.
 */
async function registerShopifyWebhooks(
  shopDomain: string,
  accessToken: string,
  organizationId: string,
  db: D1Database
): Promise<void> {
  const apiVersion = '2026-01';
  const graphqlUrl = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const callbackBase = 'https://api.clearlift.ai';

  // The webhook URL — Shopify will send X-Shopify-Shop-Domain header
  // which the receiver uses to look up the org (no org_id needed in URL)
  const webhookUrl = `${callbackBase}/v1/webhooks/shopify`;

  console.log(`[Shopify Webhooks] Registering ${SHOPIFY_WEBHOOK_TOPICS.length} webhooks for ${shopDomain}`);

  let registered = 0;
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    try {
      const response = await fetch(graphqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({
          query: SHOPIFY_WEBHOOK_MUTATION,
          variables: {
            topic,
            webhookSubscription: { uri: webhookUrl },
          },
        }),
      });

      if (!response.ok) {
        console.warn(`[Shopify Webhooks] HTTP ${response.status} for topic ${topic}`);
        continue;
      }

      const result = await response.json() as any;
      const userErrors = result?.data?.webhookSubscriptionCreate?.userErrors;

      if (userErrors?.length > 0) {
        // "has already been taken" means it's already registered — that's fine
        const alreadyExists = userErrors.some((e: any) =>
          e.message?.includes('already been taken') || e.message?.includes('already exists')
        );
        if (alreadyExists) {
          console.log(`[Shopify Webhooks] ${topic} already registered`);
          registered++;
        } else {
          console.warn(`[Shopify Webhooks] Error for ${topic}:`, userErrors);
        }
      } else {
        const subId = result?.data?.webhookSubscriptionCreate?.webhookSubscription?.id;
        console.log(`[Shopify Webhooks] Registered ${topic}: ${subId}`);
        registered++;
      }
    } catch (err) {
      console.warn(`[Shopify Webhooks] Failed to register ${topic}:`, err);
    }
  }

  console.log(`[Shopify Webhooks] ${registered}/${SHOPIFY_WEBHOOK_TOPICS.length} webhooks registered for ${shopDomain}`);

  // Create a local webhook_endpoints row so the receiver can find it
  // Use the app-level secret (HMAC is verified with SHOPIFY_CLIENT_SECRET)
  const endpointId = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO webhook_endpoints
     (id, organization_id, connector, endpoint_secret, is_active, events_subscribed, created_at, updated_at)
     VALUES (?, ?, 'shopify', 'shopify_app_secret', 1, ?, datetime('now'), datetime('now'))
     ON CONFLICT(organization_id, connector) DO UPDATE SET
       is_active = 1,
       updated_at = datetime('now')`
  ).bind(
    endpointId,
    organizationId,
    JSON.stringify(SHOPIFY_WEBHOOK_TOPICS.map(t => t.toLowerCase().replace('_', '/')))
  ).run();

  console.log(`[Shopify Webhooks] Webhook endpoint row created for org ${organizationId}`);
}

/**
 * POST /v1/connectors/:provider/finalize - Finalize OAuth connection with selected account
 */
export class FinalizeOAuthConnection extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Finalize OAuth connection",
    operationId: "finalize-oauth-connection",
    request: {
      params: z.object({
        provider: z.enum(['google', 'facebook', 'tiktok', 'shopify', 'jobber', 'hubspot', 'salesforce'])
      }),
      body: contentJson(
        z.object({
          state: z.string(),
          account_id: z.string(),
          account_name: z.string(),
          selectedAccounts: z.array(z.string()).optional(), // For Google Ads manager accounts
          sync_config: z.object({
            timeframe: z.enum(['7_days', '60_days', 'all_time', 'custom']),
            custom_start: z.string().optional(),
            custom_end: z.string().optional()
          }).optional()
        })
      )
    },
    responses: {
      "200": {
        description: "Connection finalized",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connection_id: z.string()
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { provider } = data.params;
    const { state, account_id, account_name, selectedAccounts, sync_config } = data.body;

    console.log('Finalize OAuth connection request:', { provider, account_id, account_name, state: state.substring(0, 10) + '...', sync_config });

    try {
      // Validate OAuth state
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const oauthState = await connectorService.validateOAuthState(state);

      if (!oauthState) {
        console.error('Invalid or expired OAuth state');
        return error(c, "INVALID_STATE", "OAuth state is invalid or expired", 400);
      }

      console.log('OAuth state validated:', { userId: oauthState.user_id, organizationId: oauthState.organization_id });

      // Set organization_id in context for audit middleware
      c.set("org_id" as any, oauthState.organization_id);

      // Get tokens from state metadata
      const metadata = typeof oauthState.metadata === 'string'
        ? JSON.parse(oauthState.metadata)
        : oauthState.metadata;

      const accessToken = metadata?.access_token;
      const refreshToken = metadata?.refresh_token;
      const expiresIn = metadata?.expires_in;
      const scope = metadata?.scope;

      if (!accessToken) {
        console.error('No access token in OAuth state metadata');
        return error(c, "NO_TOKEN", "No access token found in OAuth state", 400);
      }

      console.log('Creating connection in database...');

      // Prepare initial settings
      let initialSettings: Record<string, any> | undefined = undefined;

      // Google Ads: store selected accounts if specified
      if (provider === 'google' && selectedAccounts && selectedAccounts.length > 0) {
        initialSettings = {
          accountSelection: {
            mode: 'selected' as const,
            selectedAccounts: selectedAccounts
          }
        };
        console.log('Google Ads manager account - storing selected accounts:', selectedAccounts);
      }

      // Shopify: store shop_domain in settings
      const shopDomain = metadata?.shop_domain;
      if (provider === 'shopify' && shopDomain) {
        initialSettings = {
          ...initialSettings,
          shop_domain: shopDomain
        };
        console.log('Shopify - storing shop domain:', shopDomain);
      }

      // Salesforce: store instance_url in settings (required for API calls)
      const instanceUrl = metadata?.user_info?.instance_url || metadata?.user_info?.raw?.instance_url;
      if (provider === 'salesforce' && instanceUrl) {
        initialSettings = {
          ...initialSettings,
          instance_url: instanceUrl
        };
        console.log('Salesforce - storing instance URL:', instanceUrl);
      }

      // HubSpot: store hub_id in settings
      const hubId = metadata?.user_info?.hub_id;
      if (provider === 'hubspot' && hubId) {
        initialSettings = {
          ...initialSettings,
          hub_id: hubId,
          hub_domain: metadata?.user_info?.hub_domain
        };
        console.log('HubSpot - storing hub ID:', hubId);
      }

      // Store sync_config for cron scheduler to use if initial sync fails
      if (sync_config) {
        initialSettings = {
          ...initialSettings,
          sync_config: sync_config
        };
        console.log('Storing sync_config in connection settings:', sync_config);
      }

      // Set default data flow settings
      initialSettings = {
        ...initialSettings,
        emit_events: true,
        aggregation_mode: 'conversions_only',
        dedup_window_hours: 24,
      };

      // Create connection with selected account and optional settings
      const connectionId = await connectorService.createConnection({
        organizationId: oauthState.organization_id,
        platform: provider,
        accountId: account_id,
        accountName: account_name,
        connectedBy: oauthState.user_id,
        accessToken: accessToken,
        refreshToken: refreshToken,
        expiresIn: expiresIn,
        scopes: scope?.split(' '),
        settings: initialSettings
      });

      console.log('Connection created:', { connectionId });

      // Clear needs_reauth flag if this is a reconnection
      // This handles the case where user is re-authenticating after token expiration
      await c.env.DB.prepare(`
        UPDATE platform_connections
        SET needs_reauth = FALSE,
            reauth_reason = NULL,
            reauth_detected_at = NULL,
            consecutive_auth_failures = 0,
            sync_status = 'pending',
            last_synced_at = NULL
        WHERE id = ?
      `).bind(connectionId).run();
      console.log('Cleared needs_reauth flag and reset sync watermark for connection:', connectionId);

      // For Facebook, fetch connected pages (pages_read_engagement + read_insights for Page insights)
      if (provider === 'facebook') {
        try {
          console.log('Fetching Facebook connected pages for pages_read_engagement compliance...');
          const pagesResponse = await fetch(
            `https://graph.facebook.com/v24.0/me/accounts?fields=id,name,access_token,fan_count,category&access_token=${accessToken}`
          );

          if (pagesResponse.ok) {
            const pagesData = await pagesResponse.json() as any;
            const pages = pagesData.data || [];

            if (pages.length > 0) {
              console.log(`Found ${pages.length} connected Facebook pages`);

              // Store pages in ANALYTICS_DB facebook_pages table
              for (const page of pages) {
                try {
                  await c.env.ANALYTICS_DB.prepare(`
                    INSERT INTO facebook_pages (
                      organization_id, account_id, page_id, page_name,
                      category, fan_count, last_synced_at
                    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(organization_id, page_id)
                    DO UPDATE SET
                      page_name = excluded.page_name,
                      category = excluded.category,
                      fan_count = excluded.fan_count,
                      last_synced_at = datetime('now'),
                      updated_at = datetime('now')
                  `).bind(
                    oauthState.organization_id,
                    account_id,
                    page.id,
                    page.name,
                    page.category || null,
                    page.fan_count || 0
                  ).run();
                  console.log(`Stored Facebook page: ${page.name} (${page.id})`);
                } catch (pageErr) {
                  console.warn(`Failed to store page ${page.id}:`, pageErr);
                }
              }
              console.log(`Stored ${pages.length} Facebook pages in ANALYTICS_DB`);
            } else {
              console.log('No Facebook pages connected to this account');
            }
          } else {
            const errorText = await pagesResponse.text();
            console.warn('Failed to fetch Facebook pages:', errorText);
            // Don't fail the connection - pages are optional
          }
        } catch (pagesErr) {
          console.error('Error fetching Facebook pages:', pagesErr);
          // Don't fail the connection - pages are optional
        }
      }

      // For Shopify, also store shop domain and register webhooks
      if (provider === 'shopify' && shopDomain) {
        await c.env.DB.prepare(`
          UPDATE platform_connections
          SET shopify_shop_domain = ?, shopify_shop_id = ?
          WHERE id = ?
        `).bind(shopDomain, metadata?.user_info?.id || null, connectionId).run();
        console.log('Shopify shop domain stored in connection:', shopDomain);

        // Auto-register webhooks with Shopify via GraphQL API
        try {
          await registerShopifyWebhooks(
            shopDomain,
            accessToken,
            oauthState.organization_id,
            c.env.DB
          );
        } catch (webhookErr) {
          console.warn('[FinalizeOAuth] Shopify webhook registration failed (non-fatal):', webhookErr);
          // Non-fatal — batch sync still works, webhooks can be registered later
        }
      }

      // Update onboarding progress
      const onboarding = new OnboardingService(c.env.DB);
      await onboarding.incrementServicesConnected(oauthState.user_id);

      // Auto-register default conversion goal for revenue-capable connectors
      try {
        const { GoalService } = await import('../../services/goals/index');
        const goalService = new GoalService(c.env.DB, c.env.ANALYTICS_DB);
        await goalService.ensureDefaultGoalForPlatform(oauthState.organization_id, provider);
      } catch (goalErr) {
        console.warn(`[FinalizeOAuth] Failed to auto-register goal for ${provider}:`, goalErr);
      }

      // Check if running in local development mode
      const isLocal = c.req.url.startsWith('http://localhost') || c.req.url.startsWith('http://127.0.0.1');

      // Trigger sync job
      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();

      // Calculate sync window based on user's selection
      const calculateSyncWindow = () => {
        const TIMEFRAME_DAYS: Record<string, number> = {
          '7_days': 7,
          '60_days': 60,
          'all_time': 730
        };

        // Default to 60 days if no sync_config provided
        if (!sync_config) {
          const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
          return { type: 'full', start: sixtyDaysAgo, end: now };
        }

        if (sync_config.timeframe === 'custom') {
          const defaultWindow = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
          const customStart = sync_config.custom_start || defaultWindow;
          const customEnd = sync_config.custom_end || now;
          return { type: 'full', start: customStart, end: customEnd };
        }

        const days = TIMEFRAME_DAYS[sync_config.timeframe] || 90;
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        return { type: 'full', start: startDate, end: now };
      };

      const syncWindow = calculateSyncWindow();
      console.log('Calculated sync window:', syncWindow);

      await c.env.DB.prepare(`
        INSERT INTO sync_jobs (id, organization_id, connection_id, status, job_type, metadata, created_at)
        VALUES (?, ?, ?, 'pending', 'full', ?, ?)
      `).bind(
        jobId,
        oauthState.organization_id,
        connectionId,
        JSON.stringify({
          platform: provider,
          account_id: account_id,
          sync_window: syncWindow,
          sync_config: sync_config, // Store original config for reference
          created_by: 'oauth_flow'
        }),
        now
      ).run();

      // Send sync job to be processed
      const syncJobPayload = {
        job_id: jobId,
        connection_id: connectionId,
        organization_id: oauthState.organization_id,
        platform: provider,
        account_id: account_id,
        sync_window: syncWindow
      };

      if (isLocal) {
        // LOCAL DEV: Call queue consumer directly via HTTP (queues don't work locally)
        console.log('[LocalDev] Calling queue consumer directly at http://localhost:8789/test-sync');
        try {
          const response = await fetch('http://localhost:8789/test-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(syncJobPayload)
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error('[LocalDev] Queue consumer returned error:', errorText);
          } else {
            const result = await response.json();
            console.log('[LocalDev] Sync job processed by queue consumer:', result);
          }
        } catch (err) {
          console.error('[LocalDev] Failed to call queue consumer:', err);
          // Don't fail the connection - sync can be retried from connectors page
        }
      } else if (c.env.SYNC_QUEUE) {
        // PRODUCTION: Send to real Cloudflare Queue
        try {
          await c.env.SYNC_QUEUE.send(syncJobPayload);
          console.log('Sync job sent to queue with window:', syncWindow);
        } catch (queueErr) {
          console.error('Failed to send sync job to queue:', queueErr);
          // Don't fail the connection if queue send fails
        }
      } else {
        console.error('SYNC_QUEUE not available! Job will remain pending. isLocal:', isLocal, 'hasQueue:', !!c.env.SYNC_QUEUE);
      }

      // Clean up OAuth state
      await c.env.DB.prepare(`
        DELETE FROM oauth_states WHERE state = ?
      `).bind(state).run();

      console.log('Sending success response with connection_id:', connectionId);
      const response = success(c, { connection_id: connectionId });
      console.log('Response object created, returning to client');
      return response;

    } catch (err: any) {
      console.error('Finalize OAuth connection error:', err);
      return error(c, "FINALIZE_FAILED", err.message || "Failed to finalize connection", 500);
    }
  }
}

/**
 * GET /v1/connectors/:connection_id/settings - Get connector settings
 */
export class GetConnectorSettings extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Get connector settings and configuration",
    operationId: "get-connector-settings",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Connector settings",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connection_id: z.string(),
                platform: z.string(),
                account_id: z.string(),
                account_name: z.string().optional(),
                settings: z.any().optional(),
                metadata: z.object({
                  isManagerAccount: z.boolean().optional(),
                  availableAccounts: z.array(z.any()).optional()
                }).optional()
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    try {
      const session = c.get("session");
      const data = await this.getValidatedData<typeof this.schema>();
      const { connection_id } = data.params;

      // Get connection and verify access
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const connection = await connectorService.getConnection(connection_id);

      if (!connection) {
        return error(c, "NOT_FOUND", "Connection not found", 404);
      }

      // Verify user has access to org
      const { D1Adapter } = await import("../../adapters/d1");
      const d1 = new D1Adapter(c.env.DB);
      const hasAccess = await d1.checkOrgAccess(session.user_id, connection.organization_id);

      if (!hasAccess) {
        return error(c, "FORBIDDEN", "No access to this connection", 403);
      }

      // Parse settings if they exist
      let settings = null;
      if (connection.settings) {
        try {
          settings = JSON.parse(connection.settings);
        } catch (e) {
          console.error('Failed to parse connection settings:', e);
        }
      }

      const response: any = {
        connection_id: connection.id,
        platform: connection.platform,
        account_id: connection.account_id,
        account_name: connection.account_name,
        settings
      };

      // Add platform-specific metadata
      if (connection.platform === 'google') {
        try {
          const accessToken = await connectorService.getAccessToken(connection_id);
          if (accessToken) {
            const developerToken = await getSecret(c.env.GOOGLE_ADS_DEVELOPER_TOKEN);
            if (developerToken) {
              const { GoogleAdsConnector } = await import('../../services/connectors/google-ads');
              const connector = new GoogleAdsConnector(accessToken, connection.account_id, developerToken);

              const isManager = await connector.isManagerAccount();
              response.metadata = {
                isManagerAccount: isManager
              };

              if (isManager) {
                const accounts = await connector.listClientAccounts();
                response.metadata.availableAccounts = accounts;
              }
            }
          }
        } catch (err) {
          console.error('Failed to fetch Google Ads metadata:', err);
          // Don't fail the request, just omit metadata
        }
      }

      return success(c, response);
    } catch (err: any) {
      console.error("GetConnectorSettings error:", err);
      return error(c, "INTERNAL_ERROR", `Failed to fetch connector settings: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/connectors/:connection_id/settings - Update connector settings
 */
export class UpdateConnectorSettings extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Update connector settings",
    operationId: "update-connector-settings",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      }),
      body: contentJson(
        z.object({
          settings: z.any()
        })
      )
    },
    responses: {
      "200": {
        description: "Settings updated successfully"
      }
    }
  };

  public async handle(c: AppContext) {
    try {
      const session = c.get("session");
      const data = await this.getValidatedData<typeof this.schema>();
      const { connection_id } = data.params;
      const { settings } = data.body;

      // Get connection and verify access
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const connection = await connectorService.getConnection(connection_id);

      if (!connection) {
        return error(c, "NOT_FOUND", "Connection not found", 404);
      }

      // Verify user has access to org
      const { D1Adapter } = await import("../../adapters/d1");
      const d1 = new D1Adapter(c.env.DB);
      const hasAccess = await d1.checkOrgAccess(session.user_id, connection.organization_id);

      if (!hasAccess) {
        return error(c, "FORBIDDEN", "No access to this connection", 403);
      }

      // Platform-specific validation
      if (connection.platform === 'google' && settings.accountSelection) {
        if (settings.accountSelection.mode === 'selected' &&
            (!settings.accountSelection.selectedAccounts || settings.accountSelection.selectedAccounts.length === 0)) {
          return error(c, "INVALID_CONFIG", "When mode is 'selected', at least one account must be selected", 400);
        }
      }

      // Validate data flow settings
      if (settings.emit_events !== undefined && typeof settings.emit_events !== 'boolean') {
        return error(c, "INVALID_CONFIG", "emit_events must be a boolean", 400);
      }
      if (settings.aggregation_mode !== undefined) {
        const validModes = ['all', 'conversions_only', 'none'];
        if (!validModes.includes(settings.aggregation_mode)) {
          return error(c, "INVALID_CONFIG", `aggregation_mode must be one of: ${validModes.join(', ')}`, 400);
        }
      }
      if (settings.dedup_window_hours !== undefined) {
        const hours = Number(settings.dedup_window_hours);
        if (isNaN(hours) || hours < 1 || hours > 168) {
          return error(c, "INVALID_CONFIG", "dedup_window_hours must be between 1 and 168", 400);
        }
        settings.dedup_window_hours = hours;
      }

      // Merge with existing settings (preserve platform-specific settings)
      let existingSettings: Record<string, any> = {};
      if (connection.settings) {
        try {
          existingSettings = JSON.parse(connection.settings);
        } catch {}
      }
      const mergedSettings = { ...existingSettings, ...settings };

      // Update connection settings
      await c.env.DB.prepare(`
        UPDATE platform_connections
        SET settings = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(JSON.stringify(mergedSettings), connection_id).run();

      return success(c, { message: "Settings updated successfully", settings });
    } catch (err: any) {
      console.error("UpdateConnectorSettings error:", err);
      return error(c, "INTERNAL_ERROR", `Failed to update settings: ${err.message}`, 500);
    }
  }
}

/**
 * POST /v1/connectors/:connection_id/resync - Trigger a resync after settings change
 */
export class TriggerResync extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Trigger a resync of connector data",
    operationId: "trigger-resync",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Resync triggered successfully"
      }
    }
  };

  public async handle(c: AppContext) {
    try {
      const session = c.get("session");
      const data = await this.getValidatedData<typeof this.schema>();
      const { connection_id } = data.params;

      // Get connection and verify access
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const connection = await connectorService.getConnection(connection_id);

      if (!connection) {
        return error(c, "NOT_FOUND", "Connection not found", 404);
      }

      // Verify user has access to org
      const { D1Adapter } = await import("../../adapters/d1");
      const d1 = new D1Adapter(c.env.DB);
      const hasAccess = await d1.checkOrgAccess(session.user_id, connection.organization_id);

      if (!hasAccess) {
        return error(c, "FORBIDDEN", "No access to this connection", 403);
      }

      // Check for active sync to prevent duplicate jobs
      const activeSync = await c.env.DB.prepare(`
        SELECT id FROM sync_jobs
        WHERE connection_id = ?
          AND status IN ('pending', 'syncing')
          AND created_at > datetime('now', '-2 hours')
        LIMIT 1
      `).bind(connection_id).first<{ id: string }>();

      if (activeSync) {
        return c.json({
          success: false,
          error: 'SYNC_IN_PROGRESS',
          message: 'A sync is already in progress for this connection',
          existing_job_id: activeSync.id
        }, 409);
      }

      // Create sync job
      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();

      // Calculate sync window (last 30 days)
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);

      await c.env.DB.prepare(`
        INSERT INTO sync_jobs (
          id, connection_id, organization_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?)
      `).bind(jobId, connection_id, connection.organization_id, now, now).run();

      // Enqueue sync job
      await c.env.SYNC_QUEUE.send({
        job_id: jobId,
        connection_id: connection.id,
        organization_id: connection.organization_id,
        platform: connection.platform,
        account_id: connection.account_id,
        sync_window: {
          start: startDate.toISOString(),
          end: endDate.toISOString()
        }
      });

      return success(c, {
        message: "Resync triggered successfully",
        job_id: jobId
      });
    } catch (err: any) {
      console.error("TriggerResync error:", err);
      return error(c, "INTERNAL_ERROR", `Failed to trigger resync: ${err.message}`, 500);
    }
  }
}

/**
 * DELETE /v1/connectors/:connection_id - Disconnect platform
 */
export class DisconnectPlatform extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Disconnect platform",
    operationId: "disconnect-platform",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Platform disconnected"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const { connection_id } = data.params;

    const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
    const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
    const connection = await connectorService.getConnection(connection_id);

    if (!connection) {
      return error(c, "NOT_FOUND", "Connection not found", 404);
    }

    // Verify user has access to org
    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, connection.organization_id);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this connection", 403);
    }

    await connectorService.disconnectPlatform(connection_id);

    // Clean up synced data in D1 ANALYTICS_DB for this connection
    // Note: D1 analytics tables use organization_id, not connection_id
    // For complete cleanup, we'd need to track which records came from which connection
    // For now, we skip data cleanup - reconnecting will sync fresh data
    console.log(`[Disconnect] Platform ${connection.platform} connection ${connection_id} disconnected. Data cleanup skipped (reconnect will sync fresh data).`);

    // Delete connector filter rules from D1
    try {
      await c.env.DB.prepare(`
        DELETE FROM connector_filter_rules WHERE connection_id = ?
      `).bind(connection_id).run();
      console.log(`Deleted filter rules for connection ${connection_id}`);
    } catch (filterError) {
      console.error('Failed to delete filter rules:', filterError);
      // Don't fail the disconnect, just log the error
    }

    // Update onboarding progress counter
    const { OnboardingService } = await import("../../services/onboarding");
    const onboarding = new OnboardingService(c.env.DB);
    await onboarding.decrementServicesConnected(session.user_id);

    return success(c, { message: "Platform disconnected successfully" });
  }
}
