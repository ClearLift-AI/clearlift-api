import { OpenAPIRoute, Str, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { ConnectorService } from "../../services/connectors";
import { OnboardingService } from "../../services/onboarding";
import { GoogleAdsOAuthProvider } from "../../services/oauth/google";
import { FacebookAdsOAuthProvider } from "../../services/oauth/facebook";
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
        provider: z.enum(['google', 'facebook', 'tiktok', 'stripe'])
      }),
      body: contentJson(
        z.object({
          organization_id: z.string(),
          redirect_uri: z.string().optional()
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
    const { organization_id, redirect_uri } = data.body;

    // Verify user has access to org
    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, organization_id);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    // Get OAuth provider and generate PKCE challenge
    const oauthProvider = await this.getOAuthProvider(provider, c);
    const pkce = await oauthProvider.generatePKCEChallenge();

    // Create OAuth state with PKCE verifier stored in metadata
    const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
    const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
    const state = await connectorService.createOAuthState(
      session.user_id,
      organization_id,
      provider,
      redirect_uri,
      { code_verifier: pkce.codeVerifier }  // Store verifier as object property
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

  private async getOAuthProvider(provider: string, c: AppContext) {
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
        provider: z.enum(['google', 'facebook', 'tiktok', 'stripe'])
      }),
      query: z.object({
        code: z.string(),
        state: z.string(),
        error: z.string().optional()
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
    const { code, state, error: oauthError } = data.query;

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

      // Get PKCE code verifier from state metadata
      const stateMetadata = typeof oauthState.metadata === 'string'
        ? JSON.parse(oauthState.metadata)
        : oauthState.metadata;

      const codeVerifier = stateMetadata?.code_verifier;
      if (!codeVerifier || typeof codeVerifier !== 'string') {
        console.error('PKCE code verifier not found in OAuth state', { hasMetadata: !!stateMetadata, metadataType: typeof stateMetadata });
        return c.redirect(`${appBaseUrl}/oauth/callback?error=invalid_state&error_description=PKCE+verifier+missing`);
      }

      // Exchange code for token with PKCE verification
      const oauthProvider = await this.getOAuthProvider(provider, c);
      const tokens = await oauthProvider.exchangeCodeForToken(code, codeVerifier);

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
      const metadata = {
        code_verifier: codeVerifier,  // Preserve PKCE verifier
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        user_info: userInfo
      };

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

  private async getOAuthProvider(provider: string, c: AppContext) {
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
        provider: z.enum(['google', 'facebook', 'tiktok', 'stripe'])
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
        provider: z.enum(['google', 'facebook', 'tiktok'])
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
        provider: z.enum(['google', 'facebook', 'tiktok'])
      }),
      body: contentJson(
        z.object({
          state: z.string(),
          account_id: z.string(),
          account_name: z.string(),
          selectedAccounts: z.array(z.string()).optional(), // For Google Ads manager accounts
          sync_config: z.object({
            timeframe: z.enum(['7_days', '90_days', 'all_time', 'custom']),
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

      // Store sync_config for cron scheduler to use if initial sync fails
      if (sync_config) {
        initialSettings = {
          ...initialSettings,
          sync_config: sync_config
        };
        console.log('Storing sync_config in connection settings:', sync_config);
      }

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

      // Update onboarding progress
      const onboarding = new OnboardingService(c.env.DB);
      await onboarding.incrementServicesConnected(oauthState.user_id);

      // Check if running in local development mode
      const isLocal = c.req.url.startsWith('http://localhost') || c.req.url.startsWith('http://127.0.0.1');

      // Trigger sync job
      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();

      // Calculate sync window based on user's selection
      const calculateSyncWindow = () => {
        const TIMEFRAME_DAYS: Record<string, number> = {
          '7_days': 7,
          '90_days': 90,
          'all_time': 730
        };

        // Default to 90 days if no sync_config provided
        if (!sync_config) {
          const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
          return { type: 'full', start: ninetyDaysAgo, end: now };
        }

        if (sync_config.timeframe === 'custom') {
          const defaultWindow = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
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
 * GET /v1/connectors/:connection_id/google-ads/accounts - List Google Ads client accounts
 */
export class ListGoogleAdsAccounts extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "List Google Ads client accounts",
    operationId: "list-google-ads-accounts",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "List of Google Ads client accounts",
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

      // Only works for Google Ads connections
      if (connection.platform !== 'google') {
        return error(c, "INVALID_PLATFORM", "This endpoint only works for Google Ads connections", 400);
      }

      // Get access token and developer token
      const accessToken = await connectorService.getAccessToken(connection_id);
      if (!accessToken) {
        return error(c, "NO_ACCESS_TOKEN", "No access token found for connection", 400);
      }

      const developerToken = await getSecret(c.env.GOOGLE_ADS_DEVELOPER_TOKEN);
      if (!developerToken) {
        return error(c, "MISSING_CONFIG", "Google Ads Developer Token not configured", 500);
      }

      // Dynamically import the connector to avoid bundling issues
      const { GoogleAdsConnector } = await import('../../services/connectors/google-ads');
      const connector = new GoogleAdsConnector(accessToken, connection.account_id, developerToken);

      // Check if it's a manager account
      const isManager = await connector.isManagerAccount();

      if (isManager) {
        // Fetch client accounts
        const accounts = await connector.listClientAccounts();
        return success(c, { isManagerAccount: true, accounts });
      } else {
        // Return the single account
        return success(c, {
          isManagerAccount: false,
          accounts: [{
            id: connection.account_id,
            name: connection.account_name || `Account ${connection.account_id}`,
            currencyCode: undefined,
            timeZone: undefined
          }]
        });
      }
    } catch (err: any) {
      console.error("ListGoogleAdsAccounts error:", err);
      return error(c, "INTERNAL_ERROR", `Failed to fetch Google Ads accounts: ${err.message}`, 500);
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

      // Update connection settings
      await c.env.DB.prepare(`
        UPDATE platform_connections
        SET settings = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(JSON.stringify(settings), connection_id).run();

      return success(c, { message: "Settings updated successfully", settings });
    } catch (err: any) {
      console.error("UpdateConnectorSettings error:", err);
      return error(c, "INTERNAL_ERROR", `Failed to update settings: ${err.message}`, 500);
    }
  }
}

/**
 * PUT /v1/connectors/:connection_id/google-ads/settings - Update Google Ads account selection settings
 * @deprecated Use PATCH /v1/connectors/:connection_id/settings instead
 */
export class UpdateGoogleAdsSettings extends OpenAPIRoute {
  public schema = {
    tags: ["Connectors"],
    summary: "Update Google Ads account selection settings",
    operationId: "update-google-ads-settings",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      }),
      body: contentJson(
        z.object({
          accountSelection: z.object({
            mode: z.enum(['all', 'selected']),
            selectedAccounts: z.array(z.string()).optional()
          })
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
      const { accountSelection } = data.body;

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

      // Only works for Google Ads connections
      if (connection.platform !== 'google') {
        return error(c, "INVALID_PLATFORM", "This endpoint only works for Google Ads connections", 400);
      }

      // Validate that if mode is 'selected', selectedAccounts must be provided
      if (accountSelection.mode === 'selected' && (!accountSelection.selectedAccounts || accountSelection.selectedAccounts.length === 0)) {
        return error(c, "INVALID_CONFIG", "When mode is 'selected', at least one account must be selected", 400);
      }

      // Update connection settings
      const settings = {
        accountSelection
      };

      await c.env.DB.prepare(`
        UPDATE platform_connections
        SET settings = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(JSON.stringify(settings), connection_id).run();

      return success(c, { message: "Settings updated successfully", settings });
    } catch (err: any) {
      console.error("UpdateGoogleAdsSettings error:", err);
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

      // Create sync job
      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();

      // Calculate sync window (last 30 days)
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);

      await c.env.DB.prepare(`
        INSERT INTO sync_jobs (
          id, connection_id, status, created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, ?)
      `).bind(jobId, connection_id, now, now).run();

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

    // Soft-delete synced data in Supabase for this connection
    try {
      const { SupabaseClient } = await import("../../services/supabase");
      const supabase = new SupabaseClient({
        url: c.env.SUPABASE_URL,
        serviceKey: await getSecret(c.env.SUPABASE_SECRET_KEY) || ''
      });

      const now = new Date().toISOString();

      if (connection.platform === 'stripe') {
        // Soft-delete Stripe records from both charges and subscriptions tables
        const filter = `connection_id.eq.${connection_id}&deleted_at.is.null`;

        await Promise.all([
          // Charges table has deletion_reason column
          supabase.updateWithSchema('charges', {
            deleted_at: now,
            deletion_reason: 'connection_deleted'
          }, filter, 'stripe'),
          // Subscriptions table only has deleted_at
          supabase.updateWithSchema('subscriptions', {
            deleted_at: now
          }, filter, 'stripe')
        ]);
        console.log(`Soft-deleted Stripe records for connection ${connection_id}`);
      } else if (connection.platform === 'google') {
        // Soft-delete Google Ads records
        const filter = `connection_id.eq.${connection_id}&deleted_at.is.null`;
        await supabase.updateWithSchema('campaigns', {
          deleted_at: now,
          updated_at: now
        }, filter, 'google_ads');
        console.log(`Soft-deleted Google Ads records for connection ${connection_id}`);
      } else if (connection.platform === 'facebook') {
        // Soft-delete Facebook Ads records
        const filter = `connection_id.eq.${connection_id}&deleted_at.is.null`;
        await Promise.all([
          supabase.updateWithSchema('campaigns', {
            deleted_at: now,
            updated_at: now
          }, filter, 'facebook_ads'),
          supabase.updateWithSchema('ad_sets', {
            deleted_at: now,
            updated_at: now
          }, filter, 'facebook_ads'),
          supabase.updateWithSchema('ads', {
            deleted_at: now,
            updated_at: now
          }, filter, 'facebook_ads')
        ]);
        console.log(`Soft-deleted Facebook Ads records for connection ${connection_id}`);
      }
      // Add tiktok as needed
    } catch (supabaseError) {
      console.error('Failed to soft-delete Supabase records:', supabaseError);
      // Don't fail the disconnect, just log the error
    }

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
