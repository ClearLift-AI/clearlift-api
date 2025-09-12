import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";

export class ConnectGoogleAds extends OpenAPIRoute {
  schema = {
    method: "POST",
    path: "/connect/google-ads",
    security: "session",
    summary: "Initialize Google Ads OAuth connection",
    description: "Generate OAuth URL for connecting Google Ads account",
    request: {
      body: contentJson(z.object({
        session_token: z.string().optional().describe("Session token for state validation"),
        redirect_uri: z.string().optional().describe("OAuth redirect URI")
      }))
    },
    responses: {
      200: {
        description: "OAuth URL generated successfully",
        ...contentJson(z.object({
          oauth_url: z.string().describe("OAuth authorization URL"),
          state: z.string().describe("OAuth state token for validation")
        }))
      },
      400: {
        description: "Invalid request",
        ...contentJson(z.object({
          error: z.string()
        }))
      },
      500: {
        description: "Failed to generate OAuth URL",
        ...contentJson(z.object({
          error: z.string()
        }))
      }
    }
  }

  async handle(c: AppContext) {
    const organizationId = c.get('organizationId');
    const userId = c.get('user')?.id;
    
    if (!organizationId) {
      return c.json({ 
        error: 'No organization selected. Please select an organization first.' 
      }, 400);
    }

    if (!userId) {
      return c.json({ 
        error: 'User not authenticated' 
      }, 401);
    }

    try {
      const body = await c.req.json();
      const { redirect_uri } = body;

      // Check for Google OAuth credentials in environment
      const googleClientId = c.env.GOOGLE_CLIENT_ID;
      const googleClientSecret = c.env.GOOGLE_CLIENT_SECRET;
      
      if (!googleClientId || !googleClientSecret) {
        console.error('Google OAuth credentials not configured');
        return c.json({ 
          error: 'Google OAuth not configured. Please contact support.' 
        }, 500);
      }

      // Generate state token for CSRF protection
      const state = crypto.randomUUID();
      
      // Store state in database for validation on callback
      await c.env.DB.prepare(`
        INSERT INTO platform_connections (
          id, organization_id, platform, state, created_at, is_active
        ) VALUES (?, ?, ?, ?, datetime('now'), 0)
        ON CONFLICT(organization_id, platform) DO UPDATE SET
          state = excluded.state,
          updated_at = datetime('now')
      `).bind(
        crypto.randomUUID(),
        organizationId,
        'google-ads',
        state
      ).run();

      // Build Google OAuth URL
      const oauthBaseUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
      const params = new URLSearchParams({
        client_id: googleClientId,
        redirect_uri: redirect_uri || 'https://dashboard.clearlift.ai/onboarding',
        response_type: 'code',
        scope: [
          'https://www.googleapis.com/auth/adwords',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile'
        ].join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state: state
      });

      const oauthUrl = `${oauthBaseUrl}?${params.toString()}`;

      return c.json({
        oauth_url: oauthUrl,
        state: state
      });

    } catch (error) {
      console.error('Google Ads OAuth error:', error);
      return c.json({ 
        error: error instanceof Error ? error.message : 'Failed to initialize OAuth'
      }, 500);
    }
  }
}

export class HandleOAuthCallback extends OpenAPIRoute {
  schema = {
    method: "GET",
    path: "/connect/callback",
    summary: "Handle OAuth callback",
    description: "Process OAuth callback from Google",
    request: {
      query: z.object({
        code: z.string().optional().describe("OAuth authorization code"),
        state: z.string().describe("OAuth state token"),
        error: z.string().optional().describe("OAuth error code"),
        error_description: z.string().optional().describe("OAuth error description")
      })
    },
    responses: {
      302: {
        description: "Redirect to dashboard with result"
      },
      400: {
        description: "Invalid callback",
        ...contentJson(z.object({
          error: z.string()
        }))
      }
    }
  }

  async handle(c: AppContext) {
    const { code, state, error, error_description } = c.req.query();
    
    // Handle OAuth errors
    if (error) {
      const redirectUrl = new URL('https://dashboard.clearlift.ai/onboarding');
      redirectUrl.searchParams.set('error', error);
      if (error_description) {
        redirectUrl.searchParams.set('error_description', error_description);
      }
      return c.redirect(redirectUrl.toString());
    }

    if (!state) {
      return c.json({ error: 'Missing state parameter' }, 400);
    }

    try {
      // Validate state token
      const connection = await c.env.DB.prepare(`
        SELECT organization_id, platform 
        FROM platform_connections 
        WHERE state = ? AND platform = 'google-ads'
      `).bind(state).first();

      if (!connection) {
        return c.json({ error: 'Invalid state token' }, 400);
      }

      if (code) {
        // Exchange code for tokens
        const googleClientId = c.env.GOOGLE_CLIENT_ID;
        const googleClientSecret = c.env.GOOGLE_CLIENT_SECRET;
        
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            code,
            client_id: googleClientId,
            client_secret: googleClientSecret,
            redirect_uri: 'https://dashboard.clearlift.ai/onboarding',
            grant_type: 'authorization_code'
          })
        });

        if (tokenResponse.ok) {
          const tokens = await tokenResponse.json();
          
          // Store tokens securely (encrypted in production)
          await c.env.DB.prepare(`
            UPDATE platform_connections 
            SET 
              access_token = ?,
              refresh_token = ?,
              is_active = 1,
              connected_at = datetime('now'),
              updated_at = datetime('now')
            WHERE organization_id = ? AND platform = 'google-ads'
          `).bind(
            tokens.access_token,
            tokens.refresh_token,
            connection.organization_id
          ).run();

          // Redirect to dashboard with success
          const redirectUrl = new URL('https://dashboard.clearlift.ai/onboarding');
          redirectUrl.searchParams.set('success', 'true');
          redirectUrl.searchParams.set('platform', 'google-ads');
          return c.redirect(redirectUrl.toString());
        }
      }

      // Something went wrong
      const redirectUrl = new URL('https://dashboard.clearlift.ai/onboarding');
      redirectUrl.searchParams.set('error', 'oauth_failed');
      return c.redirect(redirectUrl.toString());

    } catch (error) {
      console.error('OAuth callback error:', error);
      const redirectUrl = new URL('https://dashboard.clearlift.ai/onboarding');
      redirectUrl.searchParams.set('error', 'internal_error');
      return c.redirect(redirectUrl.toString());
    }
  }
}