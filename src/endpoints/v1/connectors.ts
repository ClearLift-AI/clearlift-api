import { OpenAPIRoute, Str, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { ConnectorService } from "../../services/connectors";
import { OnboardingService } from "../../services/onboarding";
import { GoogleAdsOAuthProvider } from "../../services/oauth/google";
import { FacebookAdsOAuthProvider } from "../../services/oauth/facebook";
import { success, error } from "../../utils/response";

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
    const session = c.get("session");
    const { org_id } = await this.getValidatedData<typeof this.schema>();

    // Verify user has access to org
    const { D1Adapter } = await import("../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, org_id.query);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    const connectorService = new ConnectorService(c.env.DB);
    const connections = await connectorService.getOrganizationConnections(org_id.query);

    return success(c, { connections });
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
        provider: z.enum(['google', 'facebook', 'tiktok'])
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
    const connectorService = new ConnectorService(c.env.DB, c.env.ENCRYPTION_KEY);
    const state = await connectorService.createOAuthState(
      session.user_id,
      organization_id,
      provider,
      redirect_uri
    );

    // Get OAuth provider
    const oauthProvider = this.getOAuthProvider(provider, c);
    const authorizationUrl = oauthProvider.getAuthorizationUrl(state);

    return success(c, {
      authorization_url: authorizationUrl,
      state
    });
  }

  private getOAuthProvider(provider: string, c: AppContext) {
    // TODO: Get these from environment variables
    const redirectUri = `https://api.clearlift.ai/v1/connectors/${provider}/callback`;

    switch (provider) {
      case 'google':
        return new GoogleAdsOAuthProvider(
          'YOUR_GOOGLE_CLIENT_ID', // TODO: Add to env
          'YOUR_GOOGLE_CLIENT_SECRET', // TODO: Add to secrets
          redirectUri
        );
      case 'facebook':
        return new FacebookAdsOAuthProvider(
          'YOUR_FACEBOOK_APP_ID', // TODO: Add to env
          'YOUR_FACEBOOK_APP_SECRET', // TODO: Add to secrets
          redirectUri
        );
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
        provider: z.enum(['google', 'facebook', 'tiktok'])
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
      const oauthProvider = this.getOAuthProvider(provider, c);
      const tokens = await oauthProvider.exchangeCodeForToken(code);

      // Get user info from provider
      const userInfo = await oauthProvider.getUserInfo(tokens.access_token);

      // Store connection
      const connectionId = await connectorService.createConnection({
        organizationId: oauthState.organization_id,
        platform: provider,
        accountId: userInfo.id,
        accountName: userInfo.name || userInfo.email || userInfo.id,
        connectedBy: oauthState.user_id,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        scopes: tokens.scope?.split(' ')
      });

      // Update onboarding progress
      const onboarding = new OnboardingService(c.env.DB);
      await onboarding.incrementServicesConnected(oauthState.user_id);

      // Redirect to app
      const redirectUri = oauthState.redirect_uri || 'https://app.clearlift.ai/onboarding';
      return c.redirect(`${redirectUri}?success=true&connection_id=${connectionId}`);

    } catch (err) {
      console.error('OAuth callback error:', err);
      return c.redirect(`https://app.clearlift.ai/onboarding?error=connection_failed`);
    }
  }

  private getOAuthProvider(provider: string, c: AppContext) {
    const redirectUri = `https://api.clearlift.ai/v1/connectors/${provider}/callback`;

    switch (provider) {
      case 'google':
        return new GoogleAdsOAuthProvider(
          'YOUR_GOOGLE_CLIENT_ID',
          'YOUR_GOOGLE_CLIENT_SECRET',
          redirectUri
        );
      case 'facebook':
        return new FacebookAdsOAuthProvider(
          'YOUR_FACEBOOK_APP_ID',
          'YOUR_FACEBOOK_APP_SECRET',
          redirectUri
        );
      default:
        throw new Error(`Unsupported provider: ${provider}`);
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
