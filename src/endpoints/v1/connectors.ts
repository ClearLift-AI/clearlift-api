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
    const connectorService = new ConnectorService(c.env.DB);
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

      const connectorService = new ConnectorService(c.env.DB);
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

    // Create OAuth state
    const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
    const connectorService = new ConnectorService(c.env.DB, encryptionKey);
    const state = await connectorService.createOAuthState(
      session.user_id,
      organization_id,
      provider,
      redirect_uri
    );

    // Get OAuth provider
    const oauthProvider = await this.getOAuthProvider(provider, c);
    const authorizationUrl = oauthProvider.getAuthorizationUrl(state);

    return success(c, {
      authorization_url: authorizationUrl,
      state
    });
  }

  private async getOAuthProvider(provider: string, c: AppContext) {
    const redirectUri = `https://api.clearlift.ai/v1/connectors/${provider}/callback`;

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

    // Handle OAuth error
    if (oauthError) {
      return c.redirect(`https://app.clearlift.ai/onboarding?error=${oauthError}`);
    }

    try {
      // Validate state
      const connectorService = new ConnectorService(c.env.DB, c.env.ENCRYPTION_KEY);
      const oauthState = await connectorService.validateOAuthState(state);

      if (!oauthState) {
        return c.redirect(`https://app.clearlift.ai/onboarding?error=invalid_state`);
      }

      // Exchange code for token
      const oauthProvider = await this.getOAuthProvider(provider, c);
      const tokens = await oauthProvider.exchangeCodeForToken(code);

      // Get user info from provider
      const userInfo = await oauthProvider.getUserInfo(tokens.access_token);

      // Store token and user info in oauth_states metadata for account selection
      const metadata = {
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
      const redirectUri = oauthState.redirect_uri || 'https://app.clearlift.ai/oauth/callback';
      return c.redirect(`${redirectUri}?code=${code}&state=${state}&step=select_account&provider=${provider}`);

    } catch (err) {
      console.error('OAuth callback error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      const errorDetails = encodeURIComponent(errorMessage);
      return c.redirect(`https://app.clearlift.ai/onboarding?error=connection_failed&error_description=${errorDetails}`);
    }
  }

  private async getOAuthProvider(provider: string, c: AppContext) {
    const redirectUri = `https://api.clearlift.ai/v1/connectors/${provider}/callback`;

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
      // Validate OAuth state
      const connectorService = new ConnectorService(c.env.DB, c.env.ENCRYPTION_KEY);
      const oauthState = await connectorService.validateOAuthState(state);

      if (!oauthState) {
        return error(c, "INVALID_STATE", "OAuth state is invalid or expired", 400);
      }

      // Get access token from state metadata
      const metadata = typeof oauthState.metadata === 'string'
        ? JSON.parse(oauthState.metadata)
        : oauthState.metadata;

      const accessToken = metadata?.access_token;
      if (!accessToken) {
        return error(c, "NO_TOKEN", "No access token found in OAuth state", 400);
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
            hasDeveloperToken: !!developerToken
          });

          accounts = await googleProvider.getAdAccounts(accessToken, developerToken || '');
          break;
        }
        case 'facebook': {
          const appId = await getSecret(c.env.FACEBOOK_APP_ID);
          const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
          const redirectUri = `https://api.clearlift.ai/v1/connectors/facebook/callback`;
          const facebookProvider = new FacebookAdsOAuthProvider(appId, appSecret, redirectUri);

          const userInfo = metadata?.user_info;
          if (!userInfo?.id) {
            return error(c, "NO_USER_ID", "Facebook user ID not found", 400);
          }
          accounts = await facebookProvider.getAdAccounts(accessToken, userInfo.id);
          break;
        }
        case 'tiktok': {
          // TikTok implementation will be added later
          return error(c, "NOT_IMPLEMENTED", "TikTok account fetching not yet implemented", 501);
        }
      }

      return success(c, { accounts });

    } catch (err: any) {
      console.error('Get OAuth accounts error:', err);
      return error(c, "FETCH_FAILED", err.message || "Failed to fetch ad accounts", 500);
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
          account_name: z.string()
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
    const { state, account_id, account_name } = data.body;

    try {
      // Validate OAuth state
      const connectorService = new ConnectorService(c.env.DB, c.env.ENCRYPTION_KEY);
      const oauthState = await connectorService.validateOAuthState(state);

      if (!oauthState) {
        return error(c, "INVALID_STATE", "OAuth state is invalid or expired", 400);
      }

      // Get tokens from state metadata
      const metadata = typeof oauthState.metadata === 'string'
        ? JSON.parse(oauthState.metadata)
        : oauthState.metadata;

      const accessToken = metadata?.access_token;
      const refreshToken = metadata?.refresh_token;
      const expiresIn = metadata?.expires_in;
      const scope = metadata?.scope;

      if (!accessToken) {
        return error(c, "NO_TOKEN", "No access token found in OAuth state", 400);
      }

      // Create connection with selected account
      const connectionId = await connectorService.createConnection({
        organizationId: oauthState.organization_id,
        platform: provider,
        accountId: account_id,
        accountName: account_name,
        connectedBy: oauthState.user_id,
        accessToken: accessToken,
        refreshToken: refreshToken,
        expiresIn: expiresIn,
        scopes: scope?.split(' ')
      });

      // Update onboarding progress
      const onboarding = new OnboardingService(c.env.DB);
      await onboarding.incrementServicesConnected(oauthState.user_id);

      // Trigger sync job
      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

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
          sync_window: {
            type: 'full',
            start: sevenDaysAgo,
            end: now
          },
          created_by: 'oauth_flow'
        }),
        now
      ).run();

      // Send to queue if available
      if (c.env.SYNC_QUEUE) {
        try {
          await c.env.SYNC_QUEUE.send({
            job_id: jobId,
            connection_id: connectionId,
            organization_id: oauthState.organization_id,
            platform: provider,
            account_id: account_id,
            sync_window: {
              type: 'full',
              start: sevenDaysAgo,
              end: now
            }
          });
        } catch (queueErr) {
          console.error('Failed to send sync job to queue:', queueErr);
          // Don't fail the connection if queue send fails
        }
      }

      // Clean up OAuth state
      await c.env.DB.prepare(`
        DELETE FROM oauth_states WHERE state = ?
      `).bind(state).run();

      return success(c, { connection_id: connectionId });

    } catch (err: any) {
      console.error('Finalize OAuth connection error:', err);
      return error(c, "FINALIZE_FAILED", err.message || "Failed to finalize connection", 500);
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

    const connectorService = new ConnectorService(c.env.DB, c.env.ENCRYPTION_KEY);
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

    return success(c, { message: "Platform disconnected successfully" });
  }
}
